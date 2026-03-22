import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import colors from 'piccolore';
import type * as vite from 'vite';
import { telemetry } from '../../events/index.js';
import { eventCliSession } from '../../events/session.js';
import {
	runHookBuildDone,
	runHookBuildStart,
	runHookConfigDone,
	runHookConfigSetup,
} from '../../integrations/hooks.js';
import type { AstroSettings, RoutesList } from '../../types/astro.js';
import type { AstroInlineConfig, RuntimeMode } from '../../types/public/config.js';
import { resolveConfig } from '../config/config.js';
import { createNodeLogger } from '../logger/node.js';
import { createSettings } from '../config/settings.js';
import { createVite } from '../create-vite.js';
import { createKey, getEnvironmentKey, hasEnvironmentKey } from '../encryption.js';
import { AstroError, AstroErrorData } from '../errors/index.js';
import type { Logger } from '../logger/core.js';
import { levels, timerMessage } from '../logger/core.js';
import { createRoutesList } from '../routing/create-manifest.js';
import { getPrerenderDefault } from '../../prerender/utils.js';
import { clearContentLayerCache } from '../sync/index.js';
import { ensureProcessNodeEnv } from '../util.js';
import { collectPagesData } from './page-data.js';
import { viteBuild } from './static-build.js';
import type { StaticBuildOptions } from './types.js';
import { getTimeStat } from './util.js';
import { warnIfCspWithShiki } from '../messages/runtime.js';

interface BuildOptions {
	/**
	 * Output a development-based build similar to code transformed in `astro dev`. This
	 * can be useful to test build-only issues with additional debugging information included.
	 *
	 * @default false
	 */
	devOutput?: boolean;
	/**
	 * Teardown the compiler WASM instance after build. This can improve performance when
	 * building once, but may cause a performance hit if building multiple times in a row.
	 *
	 * When building multiple projects in the same execution (e.g. during tests), disabling
	 * this option can greatly improve performance at the cost of some extra memory usage.
	 *
	 * @default true
	 */
	teardownCompiler?: boolean;
}

/**
 * Builds your site for deployment. By default, this will generate static files and place them in a dist/ directory.
 * If SSR is enabled, this will generate the necessary server files to serve your site.
 *
 * @experimental The JavaScript API is experimental
 */
export default async function build(
	inlineConfig: AstroInlineConfig,
	options: BuildOptions = {},
): Promise<void> {
	ensureProcessNodeEnv(options.devOutput ? 'development' : 'production');
	const logger = createNodeLogger(inlineConfig);
	const { userConfig, astroConfig } = await resolveConfig(inlineConfig, 'build');
	telemetry.record(eventCliSession('build', userConfig));

	warnIfCspWithShiki(astroConfig, logger);

	const settings = await createSettings(
		astroConfig,
		inlineConfig.logLevel,
		fileURLToPath(astroConfig.root),
	);

	if (inlineConfig.force) {
		// isDev is always false, because it's interested in the build command, not the output type
		await clearContentLayerCache({ settings, logger, fs, isDev: false });
	}

	const builder = new AstroBuilder(settings, {
		...options,
		logger,
		mode: inlineConfig.mode ?? 'production',
		runtimeMode: options.devOutput ? 'development' : 'production',
		previousDist: inlineConfig.previousDist,
	});
	await builder.run();
}

interface AstroBuilderOptions extends BuildOptions {
	logger: Logger;
	mode: string;
	runtimeMode: RuntimeMode;
	/**
	 * Provide a pre-built routes list to skip filesystem route scanning.
	 * Useful for testing builds with in-memory virtual modules.
	 */
	routesList?: RoutesList;
	/**
	 * Whether to run `syncInternal` during setup. Defaults to true.
	 * Set to false for in-memory builds that don't need type generation.
	 */
	sync?: boolean;
	/**
	 * Path to a previous build's dist/ directory for incremental builds.
	 */
	previousDist?: string;
}

export class AstroBuilder {
	private settings: AstroSettings;
	private logger: Logger;
	private mode: string;
	private runtimeMode: RuntimeMode;
	private origin: string;
	private routesList: RoutesList;
	private timer: Record<string, number>;
	private teardownCompiler: boolean;
	private sync: boolean;
	private previousDist: string | undefined;

	constructor(settings: AstroSettings, options: AstroBuilderOptions) {
		this.mode = options.mode;
		this.runtimeMode = options.runtimeMode;
		this.settings = settings;
		this.logger = options.logger;
		this.teardownCompiler = options.teardownCompiler ?? true;
		this.sync = options.sync ?? true;
		this.previousDist = options.previousDist;
		this.origin = settings.config.site
			? new URL(settings.config.site).origin
			: `http://localhost:${settings.config.server.port}`;
		this.routesList = options.routesList ?? { routes: [] };
		this.timer = {};
	}

	/** Setup Vite and run any async setup logic that couldn't run inside of the constructor. */
	private async setup() {
		this.logger.debug('build', 'Initial setup...');
		const { logger } = this;
		this.timer.init = performance.now();
		this.settings = await runHookConfigSetup({
			settings: this.settings,
			command: 'build',
			logger: logger,
		});
		this.settings.buildOutput = getPrerenderDefault(this.settings.config) ? 'static' : 'server';

		// Skip filesystem route scanning if routesList was pre-populated (e.g. in-memory builds)
		if (this.routesList.routes.length === 0) {
			this.routesList = await createRoutesList({ settings: this.settings }, this.logger);
		}

		await runHookConfigDone({ settings: this.settings, logger: logger, command: 'build' });

		// If we're building for the server, we need to ensure that an adapter is installed.
		// If the adapter installed does not support a server output, an error will be thrown when the adapter is added, so no need to check here.
		if (!this.settings.config.adapter && this.settings.buildOutput === 'server') {
			throw new AstroError(AstroErrorData.NoAdapterInstalled);
		}

		const viteConfig = await createVite(
			{
				server: {
					hmr: false,
					middlewareMode: true,
				},
			},
			{
				routesList: this.routesList,
				settings: this.settings,
				logger: this.logger,
				mode: this.mode,
				command: 'build',
				sync: false,
			},
		);

		if (this.sync) {
			const { syncInternal } = await import('../sync/index.js');
			await syncInternal({
				mode: this.mode,
				settings: this.settings,
				logger,
				fs,
				command: 'build',
			});
		}

		return { viteConfig };
	}

	/** Run the build logic. build() is marked private because usage should go through ".run()" */
	private async build({ viteConfig }: { viteConfig: vite.InlineConfig }) {
		await runHookBuildStart({ settings: this.settings, logger: this.logger });
		this.validateConfig();

		this.logger.info('build', `output: ${colors.blue('"' + this.settings.config.output + '"')}`);
		this.logger.info('build', `mode: ${colors.blue('"' + this.settings.buildOutput + '"')}`);
		this.logger.info(
			'build',
			`directory: ${colors.blue(fileURLToPath(this.settings.config.outDir))}`,
		);
		if (this.settings.adapter) {
			this.logger.info('build', `adapter: ${colors.green(this.settings.adapter.name)}`);
		}
		this.logger.info('build', 'Collecting build info...');
		this.timer.loadStart = performance.now();
		const { assets, allPages } = collectPagesData({
			settings: this.settings,
			logger: this.logger,
			manifest: this.routesList,
		});

		this.logger.debug('build', timerMessage('All pages loaded', this.timer.loadStart));

		// The names of each pages
		const pageNames: string[] = [];

		// ---------------------------------------------------------------
		// Incremental build: compute dirty pages and inject prerenderer
		// ---------------------------------------------------------------
		let incrementalResult: import('./incremental.js').IncrementalBuildResult | null = null;

		if (this.previousDist) {
			const { computeDirtyPathnames } = await import('./incremental.js');
			incrementalResult = await computeDirtyPathnames({
				settings: this.settings,
				routesList: this.routesList,
				logger: this.logger,
				previousDist: this.previousDist,
			});

			if (incrementalResult !== null) {
				this.logger.info(
					'build',
					colors.green(
						`Incremental build: ${incrementalResult.dirtyPathnames.size} page(s) to rebuild` +
							(incrementalResult.cleanupPathnames.size > 0
								? `, ${incrementalResult.cleanupPathnames.size} to remove`
								: ''),
					),
				);

				// Wrap the prerenderer to filter getStaticPaths() to dirty pathnames only
				const existingPrerenderer = this.settings.prerenderer;
				const dirtyPathnames = incrementalResult.dirtyPathnames;
				this.settings.prerenderer = (defaultPrerenderer) => {
					const base =
						typeof existingPrerenderer === 'function'
							? existingPrerenderer(defaultPrerenderer)
							: (existingPrerenderer ?? defaultPrerenderer);
					return {
						...base,
						async getStaticPaths() {
							const all = await base.getStaticPaths();
							return all.filter(({ pathname }) => dirtyPathnames.has(pathname));
						},
					};
				};
			} else {
				this.logger.info('build', 'Incremental build: full rebuild required.');
			}
		}

		// Bundle the assets in your final build: This currently takes the HTML output
		// of every page (stored in memory) and bundles the assets pointed to on those pages.
		this.timer.buildStart = performance.now();
		this.logger.info(
			'build',
			colors.green(`✓ Completed in ${getTimeStat(this.timer.init, performance.now())}.`),
		);

		const hasKey = hasEnvironmentKey();
		const keyPromise = hasKey ? getEnvironmentKey() : createKey();

		const opts: StaticBuildOptions = {
			allPages,
			settings: this.settings,
			logger: this.logger,
			routesList: this.routesList,
			runtimeMode: this.runtimeMode,
			origin: this.origin,
			pageNames,
			teardownCompiler: this.teardownCompiler,
			viteConfig,
			key: keyPromise,
		};

		// ---------------------------------------------------------------
		// Phase 3: Skip Vite build for content-only changes
		// ---------------------------------------------------------------
		let viteBuildInternals: import('./internal.js').BuildInternals | null = null;
		let skippedViteBuild = false;

		if (this.previousDist && incrementalResult !== null) {
			// Content-only change — try to skip the Vite build
			const incremental = await import('./incremental.js');
			const root = fileURLToPath(this.settings.config.root);
			const previousDistAbs = path.resolve(root, this.previousDist);
			const distMetaDir = path.join(path.dirname(previousDistAbs), 'dist-meta');
			const internalsPath = path.join(distMetaDir, 'build-internals.json');

			if (fs.existsSync(internalsPath)) {
				try {
					const internalsJson = fs.readFileSync(internalsPath, 'utf-8');
					viteBuildInternals = await incremental.restoreBuildInternals(internalsJson);

					// Empty outDir (normally done inside viteBuild)
					if (this.settings.config?.vite?.build?.emptyOutDir !== false) {
						const { emptyDir } = await import('../fs/index.js');
						emptyDir(this.settings.config.outDir, new Set('.git'));
					}

					// Copy build artifacts from previous build
					await incremental.copyBuildArtifacts({
						previousDist: this.previousDist,
						settings: this.settings,
						logger: this.logger,
					});

					// Run the post-build steps that normally happen inside viteBuild:
					// 1. ssrMoveAssets
					// 2. generatePages (with prerenderer filter for dirty pages)
					// 3. Clean up prerender dir
					const { getPrerenderOutputDirectory } = await import('../../prerender/utils.js');
					const { ssrMoveAssets } = await import('./static-build.js');
					const { generatePages } = await import('./generate.js');
					const prerenderOutputDir = getPrerenderOutputDirectory(this.settings);

					this.logger.info('build', 'Rearranging server assets...');
					await ssrMoveAssets(opts, viteBuildInternals, prerenderOutputDir);
					await generatePages(opts, viteBuildInternals, prerenderOutputDir);
					await fs.promises.rm(prerenderOutputDir, { recursive: true, force: true });

					skippedViteBuild = true;
					this.logger.info(
						'build',
						colors.green('Incremental: skipped Vite build (content-only change).'),
					);
				} catch (err) {
					this.logger.warn(
						'build',
						`Incremental: failed to skip Vite build, falling back to full build. ${err}`,
					);
					viteBuildInternals = null;
				}
			}
		}

		if (!skippedViteBuild) {
			const result = await viteBuild(opts);
			viteBuildInternals = result.internals;
		}

		// ---------------------------------------------------------------
		// Incremental build: copy clean pages from previous dist
		// ---------------------------------------------------------------
		if (this.previousDist && incrementalResult !== null) {
			const { copyCleanPages } = await import('./incremental.js');
			await copyCleanPages({
				previousDist: this.previousDist,
				outDir: this.settings.config.outDir,
				result: incrementalResult,
				logger: this.logger,
				settings: this.settings,
			});
		}

		// ---------------------------------------------------------------
		// Persist build metadata for future incremental builds
		// ---------------------------------------------------------------
		{
			const { persistBuildMetadata } = await import('./incremental.js');
			await persistBuildMetadata({
				settings: this.settings,
				logger: this.logger,
				previousDist: this.previousDist,
				depMap: incrementalResult?.depMap,
				internals: viteBuildInternals,
			});
		}

		// Clean up the prerender directory (deferred from viteBuild to allow
		// persistBuildMetadata to cache it first)
		if (!skippedViteBuild) {
			const { getPrerenderOutputDirectory } = await import('../../prerender/utils.js');
			const prerenderOutputDir = getPrerenderOutputDirectory(this.settings);
			await fs.promises.rm(prerenderOutputDir, { recursive: true, force: true });
		}

		// Write any additionally generated assets to disk.
		this.timer.assetsStart = performance.now();
		Object.keys(assets).map((k) => {
			if (!assets[k]) return;
			const filePath = new URL(`file://${k}`);
			fs.mkdirSync(new URL('./', filePath), { recursive: true });
			fs.writeFileSync(filePath, assets[k], 'utf8');
			delete assets[k]; // free up memory
		});
		this.logger.debug('build', timerMessage('Additional assets copied', this.timer.assetsStart));

		// You're done! Time to clean up.
		await runHookBuildDone({
			settings: this.settings,
			pages: pageNames,
			routes: Object.values(allPages)
				.flat()
				.map((pageData) => pageData.route),
			logger: this.logger,
		});

		if (this.logger.level && levels[this.logger.level()] <= levels['info']) {
			await this.printStats({
				logger: this.logger,
				timeStart: this.timer.init,
				pageCount: pageNames.length,
				buildMode: this.settings.buildOutput!, // buildOutput is always set at this point
			});
		}
	}

	/** Build the given Astro project.  */
	async run() {
		this.settings.timer.start('Total build');

		const setupData = await this.setup();
		try {
			await this.build(setupData);
		} catch (_err) {
			throw _err;
		} finally {
			this.settings.timer.end('Total build');
			// Benchmark results
			this.settings.timer.writeStats();
		}
	}

	private validateConfig() {
		const { config } = this.settings;

		// outDir gets blown away so it can't be the root.
		if (config.outDir.toString() === config.root.toString()) {
			throw new Error(
				`the outDir cannot be the root folder. Please build to a folder such as dist.`,
			);
		}
	}

	/** Stats */
	private async printStats({
		logger,
		timeStart,
		pageCount,
		buildMode,
	}: {
		logger: Logger;
		timeStart: number;
		pageCount: number;
		buildMode: AstroSettings['buildOutput'];
	}) {
		const total = getTimeStat(timeStart, performance.now());

		let messages: string[] = [];
		if (buildMode === 'static') {
			messages = [`${pageCount} page(s) built in`, colors.bold(total)];
		} else {
			messages = ['Server built in', colors.bold(total)];
		}

		logger.info('build', messages.join(' '));
		logger.info('build', `${colors.bold('Complete!')}`);
	}
}
