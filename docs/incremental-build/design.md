# Incremental Build (`--previous-dist`)

This document describes the design and implementation plan for adding incremental/partial build support to Astro via a `--previous-dist` CLI flag. It was written in the context of the `cloudflare-docs` repo (developers.cloudflare.com), which has ~6,080 MDX pages, but the implementation should be general-purpose.

---

## Problem

Astro's static build always rebuilds every page from scratch. For large sites (thousands of pages), this is slow. The goal is: given a prior successful build output, only rebuild pages whose source has changed, and copy everything else from the prior build.

---

## Proposed CLI API

```bash
astro build --previous-dist ./build/cache/dist
```

`--previous-dist <path>` points to the `dist/` directory of a prior successful build. Astro will:

1. Determine which pages are "dirty" (their source has changed since the prior build)
2. Build only the dirty pages
3. Copy clean pages from `--previous-dist` into the new `outDir`
4. Write metadata alongside `outDir` for the next incremental build to use

If no `--previous-dist` is provided, behavior is identical to today (full build).

---

## Key Research Findings

Before reading the implementation plan, these findings from codebase exploration are essential context:

### 1. The Vite module graph cannot map pages to source MDX files

Astro's Content Layer API stores all content in a single virtual module (`astro:data-layer-content`) — a serialized blob of the entire `data-store.json`. Individual `.mdx` files are **not** Vite module nodes. `getCollection()` is pure in-memory data access. `render(entry)` does eventually create a deferred Vite module node per `.mdx` file, but these are dynamic imports that Rollup can only partially trace.

**Consequence**: We cannot use the Vite/Rollup module graph to determine which pages depend on which source files. We must build the dependency map ourselves.

### 2. The data store has per-entry digests

Every `DataEntry` in `.astro/data-store.json` has a `digest` field: an xxhash64 of the entry's raw content, computed by the loader. This is the built-in change detection mechanism for the content layer.

**Consequence**: We can diff the current data store against the previous build's data store to know exactly which content entries changed. No git diff needed.

### 3. The prerenderer factory is the right intercept point

`settings.prerenderer` can be set to a factory function `(defaultPrerenderer) => customPrerenderer`. This is the only supported, non-hacky way to intercept and filter the list of paths that `generatePages()` will build. The factory receives the default prerenderer and returns a custom one that overrides `getStaticPaths()`.

**Consequence**: We override `getStaticPaths()` to return only dirty pathnames. The rest of the build pipeline is untouched.

### 4. `filteredPaths` in `generate.ts` is the render list

In `packages/astro/src/core/build/generate.ts`, after `prerenderer.getStaticPaths()` returns all paths, they are deduplicated and filtered into `filteredPaths` (lines 93–153). This is the flat `PathWithRoute[]` array that drives the rendering loop. Filtering this is sufficient to skip pages.

### 5. Partial dependencies (e.g. `<Render>`) are invisible to Vite

In cloudflare-docs, reusable content snippets are included via a `<Render file="setup" product="workers" />` JSX component. This is a runtime call to `getEntry('partials', 'workers/setup')`. Vite does not track this as a module dependency. The only way to build a partial→pages reverse map is by statically scanning MDX files for these JSX calls.

An existing utility `getPartialsUsage()` in `src/util/components.ts` of cloudflare-docs already does this AST scan. Astro should provide a general-purpose hook for this pattern.

---

## Architecture

### Two concerns, cleanly separated

**1. Dirty-page computation** (`packages/astro/src/core/build/incremental.ts`)

- Reads and diffs data stores (content entries)
- Scans MDX files for partial/component references (using user-configured resolver)
- Compares component file hashes
- Returns `Set<string>` of dirty pathnames, or `null` for full rebuild

**2. Partial build execution** (modifications to `packages/astro/src/core/build/index.ts` and `generate.ts`)

- Injects a prerenderer wrapper that filters `getStaticPaths()` to dirty pathnames
- After generation: copies clean pages from `--previous-dist` into `outDir`
- Persists metadata artifacts (data store + component manifest) alongside `outDir` for next run

---

## Implementation Plan

### Step 1 — CLI flag + config type

**`packages/astro/src/types/public/config.ts`**

Add to `AstroInlineOnlyConfig`:

```ts
/**
 * Path to a previous build's output directory. When provided, Astro will
 * perform an incremental build: only pages whose source has changed since
 * the previous build will be rebuilt. All other pages will be copied from
 * this directory.
 */
previousDist?: string;
```

Add to `AstroUserConfig` (or a new `build`-level option):

```ts
incrementalBuild?: {
  /**
   * A function that inspects a JSX node in an MDX file and returns the
   * content file path it depends on, or null if the node is not a content
   * reference. Used to build the partial→page reverse dependency map.
   *
   * Example for cloudflare-docs' <Render> component:
   *   (name, props) => {
   *     if (name === 'Render' && props.file && props.product) {
   *       return `src/content/partials/${props.product}/${props.file}.mdx`;
   *     }
   *     return null;
   *   }
   */
  partialResolver?: (jsxNodeName: string, jsxProps: Record<string, string>) => string | null;

  /**
   * Glob patterns (relative to project root) that, if any matched file has
   * changed, trigger a full rebuild instead of an incremental one.
   * Defaults to: ['astro.config.*', 'src/plugins/**', 'package.json']
   */
  globalFiles?: string[];
}
```

**`packages/astro/src/cli/flags.ts`**

Map `flags['previous-dist']` (kebab-case from CLI) to `inlineConfig.previousDist`:

```ts
previousDist: typeof flags['previous-dist'] === 'string' ? flags['previous-dist'] : undefined,
```

**`packages/astro/src/cli/build/index.ts`**

Add to help text:

```
['--previous-dist <path>', 'Path to a prior build output for incremental rebuild.'],
```

---

### Step 2 — Metadata artifacts

The incremental build needs to compare the current state against the prior build. Two artifacts are persisted **as siblings of `dist/`** after each build:

```
<project>/
  dist/                         ← the build output (Astro's outDir)
  dist-meta/                    ← metadata for next incremental build
    data-store.json             ← copy of node_modules/.astro/data-store.json at build time
    component-manifest.json     ← { [relativeFilePath]: xxhash64 } for all src/ non-content files
```

The `dist-meta/` directory path is derived from `previousDist` by convention: if `previousDist` is `/some/path/dist`, then the metadata is read from `/some/path/dist-meta/`.

This keeps the web-served `dist/` clean (no build metadata in the public directory), while keeping both artifacts co-located with the build they describe.

---

### Step 3 — `incremental.ts`: dirty-page computation

**New file: `packages/astro/src/core/build/incremental.ts`**

```ts
export interface IncrementalOptions {
  settings: AstroSettings;
  routesList: RoutesList;
  logger: Logger;
}

/**
 * Returns the set of pathnames that need to be rebuilt, or null if a full
 * rebuild is required.
 */
export async function computeDirtyPathnames(opts: IncrementalOptions): Promise<Set<string> | null>;
```

**Algorithm:**

```
1. GLOBAL INVALIDATION CHECK
   - Compute hashes of all files matching globalFiles patterns
   - Compare against component-manifest.json from dist-meta/
   - If any globalFiles entry changed → return null (full rebuild)

2. CONTENT ENTRY DIFF
   - Load previous data store from dist-meta/data-store.json
   - Load current data store from settings.config.cacheDir/data-store.json
   - For each collection entry:
       - New entry (id exists in current, not in previous) → dirty
       - Deleted entry (id exists in previous, not in current) → mark for cleanup
       - Changed entry (digest differs) → dirty
   - Map dirty entry filePaths to pathnames via routesList:
       - For docs collection entries: filePath → slug → pathname (1:1)
       - For data/config collections: changes may affect pages that reference
         them — treat as touching all pages (return null) unless the user has
         configured a resolver for them

3. PARTIAL REVERSE MAP (if partialResolver is configured)
   - Scan all MDX files under src/ using a fast MDX AST parser
   - For each JSX node, call partialResolver(nodeName, nodeProps)
   - If it returns a file path, record: partialFile → Set<pagePathname>
   - For each dirty partial file → expand to all pages in its reverse map set
   - Cache this map to dist-meta/dep-map.json for reuse on next run
     (invalidate cache if any MDX file's import section has changed)

4. COMPONENT FILE DIFF
   - Hash all files in src/ that are NOT in content collections
     (i.e., src/components/, src/layouts/, src/styles/, etc.)
   - Compare against component-manifest.json from dist-meta/
   - For each changed component file:
       - Scan MDX files for import statements referencing it
       - Add those pages to the dirty set
   - NOTE: transitive component deps (component using another component) are
     handled by scanning component files themselves for imports of other
     component files, recursively (BFS, cycle-safe)

5. CLEANUP SET
   - Collect pathnames of deleted entries (from step 2)
   - These will be deleted from the merged dist/ in step 5 of the build

6. RETURN
   - Return Set<string> of dirty pathnames
   - Attach cleanup set to the options object for use by copyCleanPages()
```

**Fallback behavior**: If anything goes wrong during dirty computation (parse error, missing files, unexpected schema), log a warning and return `null` (full rebuild). Incremental builds should never cause incorrect output — when in doubt, rebuild everything.

---

### Step 4 — Prerenderer injection in `build/index.ts`

In `AstroBuilder.build()`, after `collectPagesData()` and before `viteBuild()`:

```ts
let dirtyPathnames: Set<string> | null = null;

if (settings.config.previousDist) {
  const { computeDirtyPathnames } = await import('./incremental.js');
  dirtyPathnames = await computeDirtyPathnames({
    settings: this.settings,
    routesList: this.routesList,
    logger: this.logger,
  });

  if (dirtyPathnames !== null) {
    this.logger.info('build', `Incremental build: ${dirtyPathnames.size} pages need rebuilding.`);
    // Wrap the prerenderer to filter getStaticPaths() output
    const existingPrerenderer = settings.prerenderer;
    settings.prerenderer = (defaultPrerenderer) => {
      const base =
        typeof existingPrerenderer === 'function'
          ? existingPrerenderer(defaultPrerenderer)
          : (existingPrerenderer ?? defaultPrerenderer);
      return {
        ...base,
        getStaticPaths: async () => {
          const all = await base.getStaticPaths();
          return all.filter(({ pathname }) => dirtyPathnames!.has(pathname));
        },
      };
    };
  } else {
    this.logger.info('build', 'Incremental build: full rebuild required.');
  }
}
```

---

### Step 5 — Post-build: copy clean pages + persist metadata

After `viteBuild()` returns, still inside `AstroBuilder.build()`:

```ts
if (settings.config.previousDist && dirtyPathnames !== null) {
  const { copyCleanPages, persistBuildMetadata } = await import('./incremental.js');

  await copyCleanPages({
    previousDist: new URL(settings.config.previousDist, settings.config.root),
    outDir: settings.config.outDir,
    dirtyPathnames,
    buildFormat: settings.config.build.format,
    trailingSlash: settings.config.trailingSlash,
    logger: this.logger,
  });
}

// Always persist metadata (full or partial build)
if (settings.config.previousDist || /* always write on full build */ true) {
  await persistBuildMetadata({
    settings: this.settings,
    outDir: settings.config.outDir,
  });
}
```

**`copyCleanPages` logic:**

```
For each HTML file in previousDist/:
  - Derive the pathname from the file path (reverse of getOutFile logic)
  - If pathname is NOT in dirtyPathnames AND NOT in cleanupSet:
      - Copy previousDist/<file> → outDir/<file>
  - If pathname IS in cleanupSet:
      - Do not copy (page was deleted)

For shared assets (always use new build's version, already in outDir):
  - _astro/**         ← JS/CSS chunks, always regenerated
  - sitemap-*.xml     ← regenerated from full data store
  - __redirects       ← regenerated from public/__redirects
  - robots.txt        ← from public/, always copied by Vite
  (No action needed — new build already wrote these to outDir)
```

**`persistBuildMetadata` logic:**

```
distMetaDir = outDir/../dist-meta/   (sibling of outDir)
mkdir -p distMetaDir

1. Copy node_modules/.astro/data-store.json → distMetaDir/data-store.json
2. Compute component-manifest.json:
   - Hash all files in src/ that are not under src/content/
   - Write { [relativePath]: xxhash64 } → distMetaDir/component-manifest.json
3. Copy dep-map.json (if it was generated during this build) → distMetaDir/dep-map.json
```

---

### Step 6 — Sitemap behavior

`@astrojs/sitemap` generates its sitemap by scanning the built `dist/` for HTML files after the build completes (via the `astro:build:done` hook). Since `copyCleanPages` copies clean HTML files back into `dist/` before `astro:build:done` fires, the sitemap will see the complete set of pages and generate correctly.

**Verification needed**: Confirm that `astro:build:done` fires after `copyCleanPages` in the execution order. In `build/index.ts`, `runHookBuildDone` is called after `viteBuild()` returns — and `copyCleanPages` will be called immediately after `viteBuild()`, before `runHookBuildDone`. So the order is:

```
viteBuild() completes
→ copyCleanPages() runs (fills out dist/ with clean pages)
→ persistBuildMetadata() runs
→ runHookBuildDone() fires (sitemap scans complete dist/)  ✓
```

---

### Step 7 — Handling `emptyOutDir`

In `viteBuild()` (line 118 of `static-build.ts`), Astro empties `outDir` before building:

```ts
if (settings.config?.vite?.build?.emptyOutDir !== false) {
  emptyDir(settings.config.outDir, new Set('.git'));
}
```

This is correct behavior for a partial build too — we want a clean `outDir`, and we'll fill it in from `previousDist` for clean pages after the build. No change needed here.

---

## Known Limitations

| Scenario                                        | Behavior                                                                                                                                                                                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Render>` with computed/dynamic props          | The `partialResolver` only sees literal string prop values. Dynamic props (e.g. `<Render file={someVar}>`) are not traceable — those pages will not be marked dirty. Mitigation: treat any `<Render>` with non-literal props as touching all pages. |
| Component transitive deps (A uses B, B changes) | BFS scan of component imports handles one level well; deeply nested chains may be missed. In practice, most component changes will be caught.                                                                                                       |
| `astro.config.ts` change                        | Full rebuild triggered (via `globalFiles`).                                                                                                                                                                                                         |
| New page added                                  | Detected as new entry in data store → built correctly.                                                                                                                                                                                              |
| Page deleted                                    | Detected as deleted entry → not copied from prior build → omitted from output.                                                                                                                                                                      |
| Concurrent builds                               | Not safe. CI must serialize builds or use separate `outDir`/cache paths.                                                                                                                                                                            |
| First run (no `--previous-dist`)                | Full build, metadata written to `dist-meta/`. Subsequent runs can use `--previous-dist`.                                                                                                                                                            |
| `force` flag                                    | `astro build --force --previous-dist ...` should trigger full rebuild (ignore previous dist).                                                                                                                                                       |

---

## File Summary

| File                                           | Status  | Description                                                                                |
| ---------------------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `packages/astro/src/types/public/config.ts`    | Modify  | Add `previousDist` to `AstroInlineOnlyConfig`; add `incrementalBuild` to `AstroUserConfig` |
| `packages/astro/src/cli/flags.ts`              | Modify  | Map `--previous-dist` flag to `inlineConfig.previousDist`                                  |
| `packages/astro/src/cli/build/index.ts`        | Modify  | Add `--previous-dist` to help text                                                         |
| `packages/astro/src/core/build/incremental.ts` | **New** | `computeDirtyPathnames`, `copyCleanPages`, `persistBuildMetadata`                          |
| `packages/astro/src/core/build/index.ts`       | Modify  | Inject prerenderer wrapper and call post-build steps when `previousDist` is set            |

Total surface area: ~5 files, ~400 lines of new code.

---

## Integration in cloudflare-docs

Once the Astro fork is built and installed, cloudflare-docs adds to `astro.config.ts`:

```ts
incrementalBuild: {
  partialResolver: (name, props) => {
    if (name === 'Render' && props.file && props.product) {
      return `src/content/partials/${props.product}/${props.file}.mdx`;
    }
    return null;
  },
  globalFiles: [
    'astro.config.ts',
    'src/plugins/**',
    'src/styles/**',
    'ec.config.mjs',
    'package.json',
  ],
},
```

And the build command becomes:

```bash
astro build --previous-dist ./build/cache/dist
```

Where `./build/cache/dist` is populated by copying the last successful build's `dist/` there (e.g. from a GitHub Actions artifact, an R2 bucket, or a local directory for dev testing).
