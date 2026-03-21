import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as devalue from 'devalue';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { mdxFromMarkdown } from 'mdast-util-mdx';
import type { MdxJsxFlowElement, MdxJsxTextElement } from 'mdast-util-mdx-jsx';
import { mdxjs } from 'micromark-extension-mdxjs';
import { glob } from 'tinyglobby';
import { visit } from 'unist-util-visit';
import xxhash from 'xxhash-wasm';
import { DATA_STORE_FILE } from '../../content/consts.js';
import type { DataEntry } from '../../content/data-store.js';
import type { AstroSettings, RoutesList } from '../../types/astro.js';
import type { Logger } from '../logger/core.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IncrementalBuildResult {
	/** Pathnames that need to be rebuilt. */
	dirtyPathnames: Set<string>;
	/** Pathnames that were deleted and should NOT be copied from previous dist. */
	cleanupPathnames: Set<string>;
	/** Dependency map (if partialResolver was configured). Persisted for next build. */
	depMap?: DepMap | null;
}

interface ComponentManifest {
	[relativePath: string]: string; // hash
}

interface DepMap {
	/** partial filePath → doc entry IDs whose pages depend on it (after transitive closure) */
	partialToPages: Record<string, string[]>;
	/** partial filePath → other partial filePaths it directly renders */
	partialToPartials: Record<string, string[]>;
	/** filePath → digest at time of scanning (for incremental rescan) */
	scannedDigests: Record<string, string>;
}

const DEP_MAP_FILE = 'dep-map.json';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Determine which pathnames need rebuilding by comparing the current data
 * store against the previous build's data store.
 *
 * Returns `null` when a full rebuild is required (e.g. non-content source
 * files changed, global config changed, etc.).
 */
export async function computeDirtyPathnames(opts: {
	settings: AstroSettings;
	routesList: RoutesList;
	logger: Logger;
	previousDist: string;
}): Promise<IncrementalBuildResult | null> {
	const { settings, logger, previousDist } = opts;
	const root = fileURLToPath(settings.config.root);

	// Resolve dist-meta/ sibling of previousDist
	const previousDistAbs = path.resolve(root, previousDist);
	const distMetaDir = path.join(path.dirname(previousDistAbs), 'dist-meta');

	// Check that dist-meta/ exists
	if (!fs.existsSync(distMetaDir)) {
		logger.info('build', 'Incremental: no dist-meta/ found — full rebuild.');
		return null;
	}

	const prevDataStorePath = path.join(distMetaDir, DATA_STORE_FILE);
	const prevManifestPath = path.join(distMetaDir, 'component-manifest.json');

	if (!fs.existsSync(prevDataStorePath) || !fs.existsSync(prevManifestPath)) {
		logger.info('build', 'Incremental: missing metadata files — full rebuild.');
		return null;
	}

	try {
		const { h64ToString } = await xxhash();

		// ---------------------------------------------------------------
		// 1. Load previous state
		// ---------------------------------------------------------------
		const prevDataStoreRaw = fs.readFileSync(prevDataStorePath, 'utf-8');
		const prevDataStore: Map<string, Map<string, DataEntry>> = devalue.unflatten(
			JSON.parse(prevDataStoreRaw),
		);
		const prevManifest: ComponentManifest = JSON.parse(fs.readFileSync(prevManifestPath, 'utf-8'));

		// ---------------------------------------------------------------
		// 2. Load current data store
		// ---------------------------------------------------------------
		const currentDataStorePath = path.join(
			fileURLToPath(settings.config.cacheDir),
			DATA_STORE_FILE,
		);
		if (!fs.existsSync(currentDataStorePath)) {
			logger.info('build', 'Incremental: no current data store — full rebuild.');
			return null;
		}
		const currentDataStoreRaw = fs.readFileSync(currentDataStorePath, 'utf-8');
		const currentDataStore: Map<string, Map<string, DataEntry>> = devalue.unflatten(
			JSON.parse(currentDataStoreRaw),
		);

		// ---------------------------------------------------------------
		// 3. Compute current component manifest
		// ---------------------------------------------------------------
		const currentManifest = await computeComponentManifest(root, settings, h64ToString);

		// ---------------------------------------------------------------
		// 4. Global files check
		// ---------------------------------------------------------------
		const globalPatterns = settings.config.incrementalBuild?.globalFiles ?? [
			'astro.config.*',
			'package.json',
		];
		for (const pattern of globalPatterns) {
			const files = await glob(pattern, { cwd: root, absolute: false });
			for (const file of files) {
				const prevHash = prevManifest[file];
				const currentHash = currentManifest[file];
				if (prevHash !== currentHash) {
					logger.info('build', `Incremental: global file changed (${file}) — full rebuild.`);
					return null;
				}
			}
		}

		// ---------------------------------------------------------------
		// 5. Non-content source file check (Phase 1: conservative)
		// ---------------------------------------------------------------
		// If ANY non-content src/ file changed, trigger full rebuild.
		const contentDirs = getContentCollectionDirs(currentDataStore, root);
		for (const [relPath, currentHash] of Object.entries(currentManifest)) {
			// Skip files that are under content collection directories
			if (isUnderContentDir(relPath, contentDirs)) continue;
			// Skip global files (already checked above)
			if (globalPatterns.some((p) => matchesGlobPattern(relPath, p))) continue;

			const prevHash = prevManifest[relPath];
			if (prevHash !== currentHash) {
				logger.info('build', `Incremental: source file changed (${relPath}) — full rebuild.`);
				return null;
			}
		}

		// Also check for deleted source files
		for (const relPath of Object.keys(prevManifest)) {
			if (isUnderContentDir(relPath, contentDirs)) continue;
			if (globalPatterns.some((p) => matchesGlobPattern(relPath, p))) continue;
			if (!(relPath in currentManifest)) {
				logger.info('build', `Incremental: source file deleted (${relPath}) — full rebuild.`);
				return null;
			}
		}

		// ---------------------------------------------------------------
		// 6. Build dependency map (if partialResolver is configured)
		// ---------------------------------------------------------------
		const partialResolver = settings.config.incrementalBuild?.partialResolver as
			| ((name: string, props: Record<string, string>) => string | null)
			| undefined;
		let depMap: DepMap | null = null;

		if (partialResolver) {
			depMap = await buildDependencyMap({
				root,
				currentDataStore,
				distMetaDir,
				partialResolver,
				logger,
			});
		}

		// ---------------------------------------------------------------
		// 7. Content entry diff
		// ---------------------------------------------------------------
		const dirtyPathnames = new Set<string>();
		const cleanupPathnames = new Set<string>();

		for (const [collectionName, currentEntries] of currentDataStore) {
			// Skip meta collections
			if (collectionName.startsWith('meta:')) continue;

			const prevEntries = prevDataStore.get(collectionName);

			// Handle partials collection via dep map when partialResolver is configured
			if (collectionName === 'partials' && depMap) {
				const changedPartialPaths = new Set<string>();
				// Find changed/new partials
				for (const [entryId, entry] of currentEntries) {
					const prevEntry = prevEntries?.get(entryId);
					if (!prevEntry || entry.digest !== prevEntry.digest) {
						if (entry.filePath) changedPartialPaths.add(entry.filePath);
					}
				}
				// Find deleted partials
				if (prevEntries) {
					for (const [entryId, prevEntry] of prevEntries) {
						if (!currentEntries.has(entryId) && prevEntry.filePath) {
							changedPartialPaths.add(prevEntry.filePath);
						}
					}
				}
				if (changedPartialPaths.size > 0) {
					// Expand through transitive closure
					const allAffected = expandTransitive(changedPartialPaths, depMap);
					for (const partialPath of allAffected) {
						const pageEntryIds = depMap.partialToPages[partialPath] ?? [];
						for (const pageEntryId of pageEntryIds) {
							dirtyPathnames.add(entryIdToPathname(pageEntryId));
						}
					}
					logger.info(
						'build',
						`Incremental: ${changedPartialPaths.size} partial(s) changed → ${dirtyPathnames.size} page(s) affected.`,
					);
				}
				continue;
			}

			// For docs collection: diff entry-by-entry
			if (collectionName === 'docs') {
				if (!prevEntries) {
					// Entire collection is new — all entries are dirty
					for (const [entryId] of currentEntries) {
						dirtyPathnames.add(entryIdToPathname(entryId));
					}
					continue;
				}

				// Check for new/changed entries
				for (const [entryId, entry] of currentEntries) {
					const prevEntry = prevEntries.get(entryId);
					if (!prevEntry) {
						dirtyPathnames.add(entryIdToPathname(entryId));
					} else if (entry.digest !== prevEntry.digest) {
						dirtyPathnames.add(entryIdToPathname(entryId));
					}
				}

				// Check for deleted entries
				for (const [entryId] of prevEntries) {
					if (!currentEntries.has(entryId)) {
						cleanupPathnames.add(entryIdToPathname(entryId));
					}
				}
				continue;
			}

			// For all other collections: any change triggers full rebuild
			if (hasCollectionChanged(currentEntries, prevEntries)) {
				logger.info('build', `Incremental: collection "${collectionName}" changed — full rebuild.`);
				return null;
			}
		}

		// Check for entirely deleted collections
		for (const [collectionName] of prevDataStore) {
			if (collectionName.startsWith('meta:')) continue;
			if (!currentDataStore.has(collectionName)) {
				if (collectionName === 'docs') {
					const prevEntries = prevDataStore.get(collectionName)!;
					for (const [entryId] of prevEntries) {
						cleanupPathnames.add(entryIdToPathname(entryId));
					}
				} else if (collectionName === 'partials' && depMap) {
					// Partials collection deleted — all pages that used partials are dirty
					// This is an unusual case; treat as full rebuild for safety
					logger.info('build', 'Incremental: partials collection deleted — full rebuild.');
					return null;
				} else {
					logger.info(
						'build',
						`Incremental: collection "${collectionName}" deleted — full rebuild.`,
					);
					return null;
				}
			}
		}

		return { dirtyPathnames, cleanupPathnames, depMap };
	} catch (err) {
		logger.warn('build', `Incremental: error during dirty computation — full rebuild. ${err}`);
		return null;
	}
}

/**
 * Copy unchanged HTML pages from the previous dist into the current outDir.
 * Skips regenerated assets (_astro/, sitemaps, etc.) and dirty/deleted pages.
 */
export async function copyCleanPages(opts: {
	previousDist: string;
	outDir: URL;
	result: IncrementalBuildResult;
	logger: Logger;
	settings: AstroSettings;
}): Promise<void> {
	const { previousDist, outDir, result, logger, settings } = opts;
	const root = fileURLToPath(settings.config.root);
	const previousDistAbs = path.resolve(root, previousDist);
	const outDirPath = fileURLToPath(outDir);

	if (!fs.existsSync(previousDistAbs)) {
		logger.warn('build', 'Incremental: previousDist does not exist — skipping copy.');
		return;
	}

	// Patterns to skip (regenerated by the build)
	const skipPrefixes = ['_astro/', '_headers', '__redirects'];
	const skipPatterns = [/^sitemap.*\.xml$/, /^robots\.txt$/, /^llms.*\.txt$/];

	let copiedCount = 0;
	let skippedCount = 0;

	await walkDir(previousDistAbs, async (absPath) => {
		const relPath = path.relative(previousDistAbs, absPath);

		// Skip non-HTML files in root that are regenerated
		if (skipPrefixes.some((prefix) => relPath.startsWith(prefix))) return;
		if (skipPatterns.some((pattern) => pattern.test(relPath))) return;

		// Only copy HTML files
		if (!relPath.endsWith('.html')) return;

		// Derive pathname from the HTML file path
		const pathname = htmlFileToPathname(relPath);

		// Skip dirty pages (they were rebuilt)
		if (result.dirtyPathnames.has(pathname)) {
			skippedCount++;
			return;
		}

		// Skip deleted pages
		if (result.cleanupPathnames.has(pathname)) {
			skippedCount++;
			return;
		}

		// Check if the new build already wrote this file (e.g., non-collection pages)
		const destPath = path.join(outDirPath, relPath);
		if (fs.existsSync(destPath)) {
			// New build already generated this page, don't overwrite
			return;
		}

		// Copy the clean page
		const destDir = path.dirname(destPath);
		fs.mkdirSync(destDir, { recursive: true });
		fs.copyFileSync(absPath, destPath);
		copiedCount++;
	});

	logger.info(
		'build',
		`Incremental: copied ${copiedCount} clean pages from previous build (skipped ${skippedCount} dirty/deleted).`,
	);
}

/**
 * Persist metadata artifacts for the next incremental build:
 * - data-store.json (copy from cache dir)
 * - component-manifest.json (hashes of all src/ files)
 *
 * Writes to the dist-meta/ sibling of outDir. When previousDist is provided
 * and differs from outDir, also updates the previousDist's dist-meta/ so the
 * cache stays current for the next incremental run.
 */
export async function persistBuildMetadata(opts: {
	settings: AstroSettings;
	logger: Logger;
	previousDist?: string;
	depMap?: DepMap | null;
}): Promise<void> {
	const { settings, logger, previousDist } = opts;
	let { depMap } = opts;
	const root = fileURLToPath(settings.config.root);
	const outDirPath = fileURLToPath(settings.config.outDir);

	// 1. Compute the manifest once (expensive — hashes all src/ files)
	const { h64ToString } = await xxhash();
	const manifest = await computeComponentManifest(root, settings, h64ToString);
	const manifestJson = JSON.stringify(manifest, null, 2);

	// 2. Read the current data store
	const currentDataStorePath = path.join(fileURLToPath(settings.config.cacheDir), DATA_STORE_FILE);
	if (!fs.existsSync(currentDataStorePath)) {
		logger.warn('build', 'Incremental: no data store found to persist.');
		return;
	}

	// 3. Build dep map if partialResolver is configured but no dep map was
	//    provided (happens on full rebuilds where computeDirtyPathnames
	//    returned null before building the dep map)
	const partialResolver = settings.config.incrementalBuild?.partialResolver as
		| ((name: string, props: Record<string, string>) => string | null)
		| undefined;

	if (!depMap && partialResolver) {
		const currentDataStoreRaw = fs.readFileSync(currentDataStorePath, 'utf-8');
		const currentDataStore: Map<string, Map<string, DataEntry>> = devalue.unflatten(
			JSON.parse(currentDataStoreRaw),
		);
		const distMetaDir = path.join(path.dirname(outDirPath), 'dist-meta');
		depMap = await buildDependencyMap({
			root,
			currentDataStore,
			distMetaDir,
			partialResolver,
			logger,
		});
	}

	// 4. Serialize dep map if available
	const depMapJson = depMap ? JSON.stringify(depMap) : null;

	// 5. Write to all target dist-meta/ directories
	const distMetaDirs = new Set<string>();
	distMetaDirs.add(path.join(path.dirname(outDirPath), 'dist-meta'));

	if (previousDist) {
		const previousDistAbs = path.resolve(root, previousDist);
		distMetaDirs.add(path.join(path.dirname(previousDistAbs), 'dist-meta'));
	}

	for (const distMetaDir of distMetaDirs) {
		fs.mkdirSync(distMetaDir, { recursive: true });
		fs.copyFileSync(currentDataStorePath, path.join(distMetaDir, DATA_STORE_FILE));
		fs.writeFileSync(path.join(distMetaDir, 'component-manifest.json'), manifestJson);
		if (depMapJson) {
			fs.writeFileSync(path.join(distMetaDir, DEP_MAP_FILE), depMapJson);
		}
		logger.debug('build', `Incremental: persisted metadata to ${distMetaDir}`);
	}
}

// ---------------------------------------------------------------------------
// Dependency map (Phase 2: partial→page reverse map)
// ---------------------------------------------------------------------------

/**
 * Build a dependency map that records which doc pages depend on which partials.
 * Uses the user-configured `partialResolver` to interpret JSX nodes in MDX files.
 *
 * Loads a cached dep map from dist-meta/ and only re-scans files whose digest
 * has changed, making subsequent runs fast (~1ms for a 1-file edit).
 */
async function buildDependencyMap(opts: {
	root: string;
	currentDataStore: Map<string, Map<string, DataEntry>>;
	distMetaDir: string;
	partialResolver: (name: string, props: Record<string, string>) => string | null;
	logger: Logger;
}): Promise<DepMap> {
	const { root, currentDataStore, distMetaDir, partialResolver, logger } = opts;

	// Load previous dep map (if it exists)
	let prevDepMap: DepMap | null = null;
	const depMapPath = path.join(distMetaDir, DEP_MAP_FILE);
	if (fs.existsSync(depMapPath)) {
		try {
			prevDepMap = JSON.parse(fs.readFileSync(depMapPath, 'utf-8'));
		} catch {
			logger.debug('build', 'Incremental: could not parse previous dep-map.json, doing full scan.');
		}
	}

	// Collect all MDX files from docs and partials collections with their digests
	const filesToScan: { filePath: string; digest: string; collection: string; entryId: string }[] =
		[];
	for (const collectionName of ['docs', 'partials']) {
		const entries = currentDataStore.get(collectionName);
		if (!entries) continue;
		for (const [entryId, entry] of entries) {
			if (entry.filePath && entry.filePath.endsWith('.mdx') && entry.digest) {
				filesToScan.push({
					filePath: entry.filePath,
					digest: String(entry.digest),
					collection: collectionName,
					entryId,
				});
			}
		}
	}

	// Forward dep map: filePath → [partialFilePaths it references]
	const forwardDeps = new Map<string, string[]>();
	// Track scanned digests for cache
	const scannedDigests: Record<string, string> = {};

	let rescannedCount = 0;
	let cachedCount = 0;

	for (const { filePath, digest, collection, entryId } of filesToScan) {
		scannedDigests[filePath] = digest;

		// Check if we can reuse cached deps for this file
		if (prevDepMap?.scannedDigests[filePath] === digest) {
			// Digest unchanged — reconstruct forward deps from the previous dep map
			const deps: string[] = [];
			if (collection === 'docs') {
				// Find which partials this page referenced in the old map
				for (const [partialPath, pageIds] of Object.entries(prevDepMap.partialToPages)) {
					if (pageIds.includes(entryId)) {
						deps.push(partialPath);
					}
				}
			} else if (collection === 'partials') {
				// Get partial-to-partial deps from old map
				const p2p = prevDepMap.partialToPartials[filePath];
				if (p2p) deps.push(...p2p);
			}
			if (deps.length > 0) forwardDeps.set(filePath, deps);
			cachedCount++;
			continue;
		}

		// Need to re-scan this file
		const absPath = path.join(root, filePath);
		if (!fs.existsSync(absPath)) continue;

		try {
			const content = fs.readFileSync(absPath, 'utf-8');
			const deps = scanMdxDependencies(content, partialResolver);
			if (deps.length > 0) forwardDeps.set(filePath, deps);
			rescannedCount++;
		} catch (err) {
			// Parse error — skip this file (conservative: don't track its deps)
			logger.debug('build', `Incremental: could not parse ${filePath} for dep scanning: ${err}`);
			rescannedCount++;
		}
	}

	logger.info(
		'build',
		`Incremental: dep map — scanned ${rescannedCount} file(s), reused cache for ${cachedCount}.`,
	);

	// Build reverse maps from forward deps
	const directPartialToPages: Record<string, Set<string>> = {};
	const partialToPartials: Record<string, string[]> = {};

	for (const { filePath, collection, entryId } of filesToScan) {
		const deps = forwardDeps.get(filePath);
		if (!deps) continue;

		if (collection === 'docs') {
			// This is a doc page → its deps are partial file paths
			for (const partialPath of deps) {
				if (!directPartialToPages[partialPath]) {
					directPartialToPages[partialPath] = new Set();
				}
				directPartialToPages[partialPath].add(entryId);
			}
		} else if (collection === 'partials') {
			// This is a partial → its deps are other partial file paths
			partialToPartials[filePath] = deps;
		}
	}

	// Compute transitive closure for partial-to-partial deps:
	// If partial A renders partial B, then all pages using A should also be
	// in B's page set (because if B changes, pages using A need rebuilding too).
	//
	// For each partial that has parent partials (is rendered by another partial),
	// propagate its direct pages upward through the chain.
	const finalPartialToPages: Record<string, string[]> = {};

	// Start with direct page mappings
	for (const [partialPath, pageSet] of Object.entries(directPartialToPages)) {
		finalPartialToPages[partialPath] = [...pageSet];
	}

	// Build reverse of partialToPartials: child → parents that render it
	const renderedBy = new Map<string, Set<string>>();
	for (const [parent, children] of Object.entries(partialToPartials)) {
		for (const child of children) {
			if (!renderedBy.has(child)) renderedBy.set(child, new Set());
			renderedBy.get(child)!.add(parent);
		}
	}

	// For each partial with direct pages, propagate pages to all ancestor partials
	for (const [partialPath, pages] of Object.entries(directPartialToPages)) {
		// BFS upward through rendering chain
		const visited = new Set<string>([partialPath]);
		const queue = [partialPath];
		while (queue.length > 0) {
			const current = queue.shift()!;
			const parents = renderedBy.get(current);
			if (!parents) continue;
			for (const parent of parents) {
				if (visited.has(parent)) continue;
				visited.add(parent);
				queue.push(parent);
				// Parent partial also serves these pages
				if (!finalPartialToPages[parent]) {
					finalPartialToPages[parent] = [];
				}
				for (const page of pages) {
					if (!finalPartialToPages[parent].includes(page)) {
						finalPartialToPages[parent].push(page);
					}
				}
			}
		}
	}

	return {
		partialToPages: finalPartialToPages,
		partialToPartials,
		scannedDigests,
	};
}

/**
 * Parse an MDX file and extract the partial file paths it depends on
 * by visiting JSX nodes and calling the partialResolver callback.
 */
function scanMdxDependencies(
	content: string,
	partialResolver: (name: string, props: Record<string, string>) => string | null,
): string[] {
	const deps: string[] = [];

	const tree = fromMarkdown(content, {
		extensions: [mdxjs()],
		mdastExtensions: [mdxFromMarkdown()],
	});

	visit(tree, ['mdxJsxFlowElement', 'mdxJsxTextElement'], (node) => {
		const jsxNode = node as MdxJsxFlowElement | MdxJsxTextElement;
		if (!jsxNode.name) return;

		// Extract literal string attributes into a props Record
		const props: Record<string, string> = {};
		for (const attr of jsxNode.attributes) {
			if (attr.type === 'mdxJsxAttribute' && typeof attr.value === 'string') {
				props[attr.name] = attr.value;
			}
		}

		const resolved = partialResolver(jsxNode.name, props);
		if (resolved && !deps.includes(resolved)) {
			deps.push(resolved);
		}
	});

	return deps;
}

/**
 * Expand a set of changed partial file paths through the transitive
 * dependency graph. Returns all partials that are affected (directly
 * changed + any partial that renders an affected partial).
 */
function expandTransitive(changedPartials: Set<string>, depMap: DepMap): Set<string> {
	// Build reverse map: partial → partials that render it
	const renderedBy = new Map<string, Set<string>>();
	for (const [parent, children] of Object.entries(depMap.partialToPartials)) {
		for (const child of children) {
			if (!renderedBy.has(child)) renderedBy.set(child, new Set());
			renderedBy.get(child)!.add(parent);
		}
	}

	// BFS upward from changed partials
	const visited = new Set(changedPartials);
	const queue = [...changedPartials];
	while (queue.length > 0) {
		const current = queue.shift()!;
		const parents = renderedBy.get(current);
		if (!parents) continue;
		for (const parent of parents) {
			if (!visited.has(parent)) {
				visited.add(parent);
				queue.push(parent);
			}
		}
	}

	return visited;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute a manifest of file hashes for all files in src/ and global file
 * patterns. This is used to detect non-content source file changes.
 */
async function computeComponentManifest(
	root: string,
	settings: AstroSettings,
	hashFn: (data: string) => string,
): Promise<ComponentManifest> {
	const manifest: ComponentManifest = {};
	const srcDir = fileURLToPath(settings.config.srcDir);

	// Hash all files under src/
	if (fs.existsSync(srcDir)) {
		const files = await glob('**/*', {
			cwd: srcDir,
			absolute: false,
			onlyFiles: true,
			// Ignore common non-source directories
			ignore: ['**/node_modules/**', '**/.git/**'],
		});

		for (const file of files) {
			const absPath = path.join(srcDir, file);
			const relPath = path.relative(root, absPath);
			try {
				const contents = fs.readFileSync(absPath, 'utf-8');
				manifest[relPath] = hashFn(contents);
			} catch {
				// Skip files that can't be read (binary, etc.)
				try {
					const buffer = fs.readFileSync(absPath);
					manifest[relPath] = hashFn(buffer.toString('base64'));
				} catch {
					// Skip entirely unreadable files
				}
			}
		}
	}

	// Hash global files
	const globalPatterns = settings.config.incrementalBuild?.globalFiles ?? [
		'astro.config.*',
		'package.json',
	];
	for (const pattern of globalPatterns) {
		const files = await glob(pattern, { cwd: root, absolute: false });
		for (const file of files) {
			if (file in manifest) continue; // Already hashed if under src/
			const absPath = path.join(root, file);
			try {
				const contents = fs.readFileSync(absPath, 'utf-8');
				manifest[file] = hashFn(contents);
			} catch {
				try {
					const buffer = fs.readFileSync(absPath);
					manifest[file] = hashFn(buffer.toString('base64'));
				} catch {
					// Skip
				}
			}
		}
	}

	return manifest;
}

/**
 * Map a docs collection entry ID to its URL pathname.
 *
 * For Starlight sites: entryId "workers/get-started/guide" → "/workers/get-started/guide"
 * For root index: entryId "" → "/"
 */
function entryIdToPathname(entryId: string): string {
	if (entryId === '' || entryId === 'index') return '/';
	// Strip trailing /index (Starlight normalizes these)
	const normalized = entryId.endsWith('/index') ? entryId.slice(0, -6) : entryId;
	return '/' + normalized;
}

/**
 * Convert an HTML output file path (relative to dist/) back to a pathname.
 *
 * "workers/get-started/guide/index.html" → "/workers/get-started/guide"
 * "index.html" → "/"
 * "404.html" → "/404"
 */
function htmlFileToPathname(relPath: string): string {
	// Normalize path separators
	const normalized = relPath.replace(/\\/g, '/');

	if (normalized === 'index.html') return '/';
	if (normalized.endsWith('/index.html')) {
		return '/' + normalized.slice(0, -'/index.html'.length);
	}
	if (normalized.endsWith('.html')) {
		return '/' + normalized.slice(0, -'.html'.length);
	}
	return '/' + normalized;
}

/**
 * Check if a collection has changed between current and previous data stores.
 * Used for non-docs collections where any change triggers full rebuild.
 */
function hasCollectionChanged(
	current: Map<string, DataEntry>,
	previous: Map<string, DataEntry> | undefined,
): boolean {
	if (!previous) return current.size > 0;
	if (current.size !== previous.size) return true;

	for (const [id, entry] of current) {
		const prevEntry = previous.get(id);
		if (!prevEntry) return true;
		if (entry.digest !== prevEntry.digest) return true;
	}

	// Check for deleted entries
	for (const id of previous.keys()) {
		if (!current.has(id)) return true;
	}

	return false;
}

/**
 * Get the set of content collection directory prefixes (relative to root).
 * These are directories like "src/content/docs/", "src/content/partials/", etc.
 */
function getContentCollectionDirs(
	dataStore: Map<string, Map<string, DataEntry>>,
	_root: string,
): Set<string> {
	const dirs = new Set<string>();
	for (const [collectionName, entries] of dataStore) {
		if (collectionName.startsWith('meta:')) continue;
		// Infer the content directory from the first entry's filePath
		for (const [, entry] of entries) {
			if (entry.filePath) {
				// filePath is like "src/content/docs/workers/get-started/guide.mdx"
				// We want "src/content/docs/"
				const parts = entry.filePath.split('/');
				// Find "content" in the path and take up to collection dir
				const contentIdx = parts.indexOf('content');
				if (contentIdx >= 0 && contentIdx + 2 <= parts.length) {
					dirs.add(parts.slice(0, contentIdx + 2).join('/'));
				}
				break; // Only need one entry to infer the dir
			}
		}
	}
	return dirs;
}

/**
 * Check if a file path is under any content collection directory.
 */
function isUnderContentDir(relPath: string, contentDirs: Set<string>): boolean {
	for (const dir of contentDirs) {
		if (relPath.startsWith(dir + '/') || relPath === dir) return true;
	}
	return false;
}

/**
 * Basic glob pattern matching for simple patterns.
 * Handles patterns like "astro.config.*", "package.json", "src/plugins/**"
 */
function matchesGlobPattern(filePath: string, pattern: string): boolean {
	// Convert glob pattern to regex
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars (except * and ?)
		.replace(/\*\*/g, '<<<GLOBSTAR>>>')
		.replace(/\*/g, '[^/]*')
		.replace(/<<<GLOBSTAR>>>/g, '.*')
		.replace(/\?/g, '.');

	const regex = new RegExp(`^${escaped}$`);
	return regex.test(filePath);
}

/**
 * Recursively walk a directory and call the callback for each file.
 */
async function walkDir(dir: string, callback: (absPath: string) => Promise<void>): Promise<void> {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const absPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await walkDir(absPath, callback);
		} else if (entry.isFile()) {
			await callback(absPath);
		}
	}
}
