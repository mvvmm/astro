# Incremental Build — Overview

This is the detailed documentation for the incremental build feature added to this Astro fork. See [INCREMENTAL_BUILD.md](../../INCREMENTAL_BUILD.md) at the repo root for the quick-start summary.

---

## Architecture

```
astro build --previous-dist ./build/cache/dist

┌─────────────────────────────────────────────────────────┐
│  1. Content sync (astro's normal content layer)         │  ~1s
│     - Loads/updates data-store.json with entry digests  │
├─────────────────────────────────────────────────────────┤
│  2. computeDirtyPathnames()                             │  ~4s
│     a. Load previous data-store.json + component-manifest│
│     b. Global files check (astro.config, package.json)  │
│     c. Non-content src/ file check                      │
│     d. Content entry digest diff (docs collection)      │
│     e. Partial dep map expansion (if partialResolver)   │
│     → Returns Set<pathname> or null (full rebuild)      │
├─────────────────────────────────────────────────────────┤
│  3. Vite build (SKIPPED if content-only change)         │  ~0s or ~106s
│     - If skipped: restore BuildInternals from cache     │
│     - If skipped: copy prerender bundle + _astro/ chunks│
├─────────────────────────────────────────────────────────┤
│  4. ssrMoveAssets() + generatePages()                   │  ~1-15s
│     - Prerenderer filtered to dirty pathnames only      │
│     - Only dirty pages rendered to HTML                 │
├─────────────────────────────────────────────────────────┤
│  5. copyCleanPages()                                    │  ~4s
│     - Copy unchanged HTML from previousDist → dist/     │
├─────────────────────────────────────────────────────────┤
│  6. persistBuildMetadata()                              │  ~4s
│     - Write data-store.json, component-manifest.json,   │
│       dep-map.json, build-internals.json, .prerender/   │
│       to dist-meta/ (both output + cache locations)     │
├─────────────────────────────────────────────────────────┤
│  7. Hooks (sitemap, etc.)                               │  ~4s
│     - Sitemap sees complete dist/ (dirty + clean pages) │
└─────────────────────────────────────────────────────────┘
                                                Total: ~19s
```

### Decision Tree

```
Has --previous-dist?
  ├─ No → Full build (normal Astro behavior)
  └─ Yes → computeDirtyPathnames()
              ├─ null (full rebuild needed) → Full Vite build
              │    Reasons: global file changed, src/ file changed,
              │    non-docs collection changed, missing cache
              └─ Set<pathname> → Incremental build
                   ├─ build-internals.json exists?
                   │    ├─ Yes → Skip Vite build, restore internals
                   │    └─ No  → Full Vite build (generates cache for next time)
                   ├─ generatePages (dirty pages only)
                   ├─ copyCleanPages (from previousDist)
                   └─ persistBuildMetadata (update cache)
```

---

## dist-meta/ Contents

After every build, `dist-meta/` is written as a sibling of `dist/`. When `--previous-dist` is provided, `dist-meta/` is also updated at the cache location.

| File                      | Size (cloudflare-docs) | Purpose                                                           |
| ------------------------- | ---------------------- | ----------------------------------------------------------------- |
| `data-store.json`         | ~36 MB                 | Devalue-serialized content entries with per-entry digests         |
| `component-manifest.json` | ~600 KB                | xxhash64 of every file in `src/` + global files                   |
| `dep-map.json`            | ~1 MB                  | Partial→page reverse dependency map + scanned digests cache       |
| `build-internals.json`    | ~2.8 MB                | Serialized BuildInternals (4 fields needed by generatePages)      |
| `.prerender/`             | ~30 MB                 | Cached prerender bundle (entry + chunks, post-manifest-injection) |

---

## Key Code Locations (Astro Fork)

All paths relative to `packages/astro/src/`:

| File                          | Key functions                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core/build/incremental.ts`   | `computeDirtyPathnames`, `copyCleanPages`, `persistBuildMetadata`, `buildDependencyMap`, `scanMdxDependencies`, `expandTransitive`, `serializeBuildInternals`, `restoreBuildInternals`, `copyBuildArtifacts` |
| `core/build/index.ts`         | `AstroBuilder.build()` — orchestrates incremental flow, prerenderer injection, skip-Vite branch                                                                                                              |
| `core/build/static-build.ts`  | `viteBuild()`, `ssrMoveAssets()` (exported for skip-Vite path)                                                                                                                                               |
| `core/build/generate.ts`      | `generatePages()` — renders HTML for filtered pathnames                                                                                                                                                      |
| `core/build/internal.ts`      | `BuildInternals` type, `createBuildInternals()`                                                                                                                                                              |
| `types/public/config.ts`      | `previousDist` (inline-only), `incrementalBuild` config type                                                                                                                                                 |
| `core/config/schemas/base.ts` | Zod schema for `incrementalBuild`                                                                                                                                                                            |
| `cli/flags.ts`                | `--previous-dist` CLI flag mapping                                                                                                                                                                           |
| `content/data-store.ts`       | `DataEntry` type with `digest` field (read by incremental.ts)                                                                                                                                                |
| `content/loaders/glob.ts`     | Where digests are computed (xxhash64 of raw content)                                                                                                                                                         |

### Key Code Locations (cloudflare-docs)

| File              | What                                                       |
| ----------------- | ---------------------------------------------------------- |
| `astro.config.ts` | `incrementalBuild.partialResolver` callback for `<Render>` |
| `package.json`    | `build:incremental` script                                 |

---

## How to Resume Development

### Setting Up

1. **Astro fork**: Branch `partial-builds` at `/Users/vance/code/cloudflare/astro`
2. **cloudflare-docs**: Branch with incremental config at `/Users/vance/code/cloudflare/cloudflare-docs`
3. After making changes to `packages/astro/src/core/build/`:
   ```bash
   # Build the astro package
   pnpm -C packages/astro build
   # Copy compiled output to cloudflare-docs
   cp packages/astro/dist/core/build/{incremental,index,static-build}.js \
      /Users/vance/code/cloudflare/cloudflare-docs/node_modules/astro/dist/core/build/
   ```
4. Test in cloudflare-docs:
   ```bash
   cd /Users/vance/code/cloudflare/cloudflare-docs
   npm run build:incremental
   ```

### Testing Workflow

```bash
# 1. Establish baseline (full build, creates dist-meta/)
npm run build
cp -r dist/ build/cache/dist/
cp -r dist-meta/ build/cache/dist-meta/

# 2. Make a content change
# edit src/content/docs/workers/get-started/guide.mdx

# 3. Run incremental build
npm run build:incremental
# Should see: "Incremental: skipped Vite build" + "1 page(s) to rebuild"

# 4. Preview
npx astro preview
```

### Pre-Existing Build Errors

The `pnpm -C packages/astro build` command will show TypeScript errors like:

```
src/core/build/common.ts: error TS2305: Module '"../../core/path.js"' has no exported member 'appendForwardSlash'.
```

These are **pre-existing** workspace cross-reference issues unrelated to incremental build changes. The JS compilation (`astro-scripts build`) succeeds before `tsc` runs, so the compiled output in `dist/` is correct despite these errors.

---

## Documents in This Directory

| Document                                       | Description                                                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [design.md](./design.md)                       | Original architecture and research. Written before implementation; some details superseded by phase plans. |
| [phase-1-plan.md](./phase-1-plan.md)           | Phase 1: Content digest diffing with conservative full-rebuild fallback.                                   |
| [phase-2-plan.md](./phase-2-plan.md)           | Phase 2: Partial dependency graph via `partialResolver` + MDX AST scanning.                                |
| [phase-3-plan.md](./phase-3-plan.md)           | Phase 3: Skip Vite build by serializing/restoring BuildInternals.                                          |
| [testing-results.md](./testing-results.md)     | All test results across phases with timings and correctness checks.                                        |
| [future-work.md](./future-work.md)             | Phase 4 analysis (component tracking), CI/CD integration, other improvements.                              |
| [plugin-extraction.md](./plugin-extraction.md) | Analysis of extracting this as an Astro plugin. Phases 1+2 are plugin-able; Phase 3 requires the fork.     |

## Phases

| Phase | Scope                                                       | Status                                                     |
| ----- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| 1     | Content digest diffing + conservative fallback              | Implemented                                                |
| 2     | Partial dependency graph (`partialResolver` + MDX scanning) | Implemented                                                |
| 3     | Skip Vite build for content-only changes                    | Implemented                                                |
| 4     | Component import scanning + collection→route mapping        | Deferred (low ROI, see [future-work.md](./future-work.md)) |
