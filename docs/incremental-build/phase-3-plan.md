# Phase 3: Skip Vite Build for Content-Only Changes

**Status**: Implemented
**Prerequisite**: [Phase 1](./phase-1-plan.md) (implemented), [Phase 2](./phase-2-plan.md) (implemented)

---

## Goal

When only content files (docs MDX, partials) have changed and no source files (components, layouts, styles, config) have changed, skip the ~106s Vite bundling phase entirely and reuse the previous build's compiled output. Only re-run page rendering for dirty pages and copy clean pages from cache.

**Expected impact**: Incremental build time drops from ~130-140s to ~25-35s.

---

## Key Insight

The Vite build produces three outputs:

| Build     | Output directory      | Purpose                                   |
| --------- | --------------------- | ----------------------------------------- |
| Prerender | `.prerender/` in dist | JS bundle for rendering pages to HTML     |
| Client    | `dist/_astro/`        | Browser CSS/JS chunks                     |
| SSR       | Server dir            | Server runtime (skipped for static sites) |

When only content changes (MDX body text, frontmatter), **all three outputs are deterministic** — same source files → same bundle. The only thing that changes is the data store (content), which is loaded at page rendering time, not at bundle time.

The current `computeDirtyPathnames()` already distinguishes content-only changes from source file changes. When it returns non-null, we know no source files changed (the Phase 1 conservative check at lines 117-143 would have returned `null` otherwise).

---

## Architecture

### Current Build Flow

```
viteBuild() {
  1. Create BuildInternals, track page data
  2. Empty outDir
  3. buildEnvironments() {
     a. Prerender Vite build          (~70s)
     b. SSR Vite build                (skipped for static)
     c. Client Vite build             (~30s)
     d. Run manifest injection         (~2s)
     e. ssrMoveAssets()               (~1s)
     f. generatePages()               (~3s for incremental)
     g. Clean up prerender dir
  }
}
```

### Proposed Flow (Content-Only Incremental)

```
if (incrementalResult !== null) {
  // Content-only change — skip Vite build
  1. Restore BuildInternals from dist-meta/build-internals.json
  2. Copy prerender bundle from previousDist
  3. Copy client chunks from previousDist
  4. ssrMoveAssets() with restored internals
  5. generatePages() with restored internals (only dirty pages)
  6. Clean up prerender dir
} else {
  // Source file changed — full Vite build
  viteBuild() { ... normal flow ... }
}
```

---

## What Must Be Serialized

After the Vite build completes (all three environments done, manifest injected, chunks written to disk), four fields from `BuildInternals` are needed by `generatePages()` and `ssrMoveAssets()`:

### Tier 1: Required by generatePages()

| Field                       | Type                         | Used by                                          |
| --------------------------- | ---------------------------- | ------------------------------------------------ |
| `pagesByKeys`               | `Map<string, PageBuildData>` | `hasPrerenderedPages()`, `headElements()` styles |
| `prerenderEntryFileName`    | `string`                     | `createDefaultPrerenderer()` to load bundle      |
| `entrySpecifierToBundleMap` | `Map<string, string>`        | Script resolution in `BuildPipeline`             |

### Tier 2: Required by ssrMoveAssets()

| Field                     | Type                       | Used by                      |
| ------------------------- | -------------------------- | ---------------------------- |
| `ssrAssetsPerEnvironment` | `Map<string, Set<string>>` | `ssrMoveAssets()` asset list |

### Serialization Format

```ts
interface SerializedBuildInternals {
  pagesByKeys: [string, SerializedPageBuildData][];
  prerenderEntryFileName: string;
  entrySpecifierToBundleMap: [string, string][];
  ssrAssetsPerEnvironment: [string, string[]][];
}

interface SerializedPageBuildData {
  key: string;
  component: string;
  route: RouteData; // Already JSON-serializable (all plain data)
  moduleSpecifier: string;
  styles: { depth: number; order: number; sheet: StylesheetAsset }[];
}
```

All fields are plain data (strings, numbers, booleans, arrays, objects). No functions, no class instances, no circular references. The `RouteData` type has many fields but they're all serializable (strings, regex patterns as strings, arrays of segments).

**Caveat**: `RouteData.pattern` is a `RegExp`. It must be serialized as a string (`.source` + `.flags`) and reconstructed with `new RegExp()`.

---

## What Must Be Copied from previousDist

When skipping the Vite build, the output directories are empty (because `emptyOutDir` runs, or because they haven't been created yet). We need to restore:

| Artifact                  | Source                                  | Destination               |
| ------------------------- | --------------------------------------- | ------------------------- |
| Prerender bundle + chunks | `previousDist/../.prerender/`           | Current `.prerender/` dir |
| Client CSS/JS chunks      | `previousDist/_astro/`                  | Current `dist/_astro/`    |
| Public files              | `previousDist/` (non-HTML, non-\_astro) | Current `dist/`           |

Actually, looking more carefully at the flow: for a static build, `emptyOutDir` clears `dist/`. Then the Vite client build copies `public/` to `dist/` and writes CSS/JS chunks to `dist/_astro/`. The prerender build writes to `.prerender/`.

For our skip-Vite path, we need:

1. **Copy `.prerender/` contents** from previous build — the prerender entry bundle + its chunks
2. **Copy `dist/_astro/` contents** from previous build — client CSS/JS chunks
3. **Copy `dist/public` files** — or skip `emptyOutDir` and only clear HTML files

The simplest approach: **don't empty outDir at all for incremental builds**. The previous `dist/` already has the correct `_astro/`, public files, and HTML pages. We only need to:

- Overwrite HTML files for dirty pages (generatePages does this)
- Copy the prerender bundle to the `.prerender/` temp directory (so the prerenderer can import it)

Wait — but `copyCleanPages()` already copies HTML from `previousDist` to `dist/`. And `emptyOutDir` runs inside `viteBuild()`, which we're skipping entirely. So if we skip `viteBuild()`, outDir is still empty from... no, `emptyOutDir` is inside `viteBuild()` at line 117. If we skip `viteBuild()`, it won't be emptied.

But we need to think about this differently. On the FIRST incremental run, `dist/` was cleared by the previous build. On SUBSEQUENT incremental runs, `dist/` contains the output of the last build. We need a fresh `dist/` for each build.

**Revised approach**: For the skip-Vite path:

1. Empty `dist/` (same as current behavior)
2. Copy `_astro/`, public files, and other non-HTML assets from `previousDist` to `dist/`
3. Copy `.prerender/` from previous build's server dir to a temp location
4. Run `ssrMoveAssets()` + `generatePages()` (only dirty pages)
5. Copy clean HTML pages from `previousDist` (existing `copyCleanPages()`)

---

## File Changes

### 1. `packages/astro/src/core/build/incremental.ts`

**New functions:**

| Function                    | Purpose                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- |
| `serializeBuildInternals()` | Extracts the 4 needed fields from BuildInternals, serializes to JSON          |
| `restoreBuildInternals()`   | Deserializes JSON back to a BuildInternals object with the 4 fields populated |
| `copyBuildArtifacts()`      | Copies prerender bundle + client chunks from previousDist into outDir         |

**Modified functions:**

| Function               | Change                                                                 |
| ---------------------- | ---------------------------------------------------------------------- |
| `persistBuildMetadata` | Also write `build-internals.json` to dist-meta/ after every Vite build |

### 2. `packages/astro/src/core/build/static-build.ts`

**Export `viteBuild()`'s return value** — currently returns `{ internals }`, which is correct.

**New export**: Need to export `ssrMoveAssets`, `generatePages`, and `getPrerenderOutputDirectory` so they can be called from `index.ts` when skipping the Vite build.

Or alternatively, create a new function `incrementalBuildWithoutVite()` that orchestrates the skip-Vite flow.

### 3. `packages/astro/src/core/build/index.ts`

In the `build()` method, add the skip-Vite branch:

```ts
if (this.previousDist && incrementalResult !== null) {
  // Content-only change — skip Vite build
  const { restoreBuildInternals, copyBuildArtifacts } = await import('./incremental.js');
  const internals = await restoreBuildInternals({ ... });
  await copyBuildArtifacts({ ... });
  // Manually run the post-build steps that normally happen inside viteBuild
  await ssrMoveAssets(opts, internals, prerenderOutputDir);
  await generatePages(opts, internals, prerenderOutputDir);
} else {
  // Normal Vite build
  await viteBuild(opts);
}
```

---

## Implementation Order

1. Add `serializeBuildInternals()` to `incremental.ts`
2. Update `persistBuildMetadata()` to save `build-internals.json`
3. Add `restoreBuildInternals()` to `incremental.ts`
4. Add `copyBuildArtifacts()` to `incremental.ts`
5. Export `ssrMoveAssets`, `generatePages`, `getPrerenderOutputDirectory` from `static-build.ts`
6. Add skip-Vite branch to `build/index.ts`
7. Build + test

---

## Risk Assessment

| Risk                                             | Mitigation                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `RouteData.pattern` (RegExp) serialization       | Serialize as `{ source, flags }`, reconstruct with `new RegExp()`                           |
| Missing prerender bundle in previousDist         | Check existence, fall back to full build                                                    |
| Missing client chunks                            | Check `_astro/` exists, fall back to full build                                             |
| `BuildInternals` schema changes between versions | Include a version field in `build-internals.json`, fall back if mismatch                    |
| Page style references stale (CSS chunk renamed)  | Can't happen — we only skip Vite when source files haven't changed, so chunks are identical |

---

## Expected Performance

| Scenario            | Current | With Phase 3 |
| ------------------- | ------- | ------------ |
| 1 page changed      | ~130s   | **~25s**     |
| 33 pages (partial)  | ~141s   | **~35s**     |
| 0 pages (no change) | ~137s   | **~20s**     |
| Source file changed | ~350s   | ~350s        |
