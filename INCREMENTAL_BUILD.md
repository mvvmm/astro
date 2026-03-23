# Incremental Build (`--previous-dist`)

This Astro fork adds incremental/partial build support. When given a prior build's output, only pages whose content has changed are rebuilt. Everything else is copied from the cache.

## Quick Start

```bash
# Full build (first time, or after source file changes)
astro build
# Save the output as cache
cp -r dist/ build/cache/dist/
cp -r dist-meta/ build/cache/dist-meta/

# Incremental build (content-only changes)
astro build --previous-dist ./build/cache/dist
```

## Current Status

| Phase | What                                           | Status      | Impact                                    |
| ----- | ---------------------------------------------- | ----------- | ----------------------------------------- |
| 1     | Content digest diffing + conservative fallback | Implemented | Skips rendering unchanged pages           |
| 2     | Partial dependency graph (`partialResolver`)   | Implemented | Partial edits rebuild only affected pages |
| 3     | Skip Vite build for content-only changes       | Implemented | ~19s builds (down from ~130s+)            |

**Tested against cloudflare-docs** (~6,080 pages, ~1,382 partials): a single-page content edit builds in **~19 seconds**.

## How It Works

1. **Diff data stores** — Compare content entry digests (xxhash64) between current and previous build
2. **Expand via dep map** — If partials changed, use the cached dependency graph to find affected pages
3. **Skip Vite build** — If no source files changed, reuse the previous build's compiled JS/CSS bundles
4. **Render only dirty pages** — Filter `getStaticPaths()` to only dirty pathnames
5. **Copy clean pages** — Fill out `dist/` with unchanged HTML from the cache
6. **Persist metadata** — Write `dist-meta/` artifacts for the next incremental build

## What Triggers a Full Rebuild

- Any change to `astro.config.*` or `package.json`
- Any change to non-content source files (`src/components/`, `src/layouts/`, `src/styles/`, `src/pages/`, etc.)
- Any change to non-docs/non-partials content collections
- Missing or corrupted `dist-meta/` cache
- First build (no `--previous-dist`)

## Documentation

Detailed docs live in [`docs/incremental-build/`](./docs/incremental-build/):

- **[Overview](./docs/incremental-build/README.md)** — Architecture, file inventory, code locations, how to resume development
- **[Design](./docs/incremental-build/design.md)** — Original research and architecture document
- **[Phase 1 Plan](./docs/incremental-build/phase-1-plan.md)** — Content digest diffing
- **[Phase 2 Plan](./docs/incremental-build/phase-2-plan.md)** — Partial dependency graph
- **[Phase 3 Plan](./docs/incremental-build/phase-3-plan.md)** — Skip Vite build
- **[Testing Results](./docs/incremental-build/testing-results.md)** — All test results with timings
- **[Future Work](./docs/incremental-build/future-work.md)** — Phase 4 analysis, CI/CD, potential improvements
- **[Plugin Extraction](./docs/incremental-build/plugin-extraction.md)** — Can this be an Astro plugin? (Phases 1+2 yes, Phase 3 no)

## Files Changed (Astro Fork)

| File                                             | Lines  | What                                                         |
| ------------------------------------------------ | ------ | ------------------------------------------------------------ |
| `packages/astro/src/core/build/incremental.ts`   | ~1,120 | Core logic: dirty computation, dep map, serialization, copy  |
| `packages/astro/src/core/build/index.ts`         | +77    | Build orchestration: skip-Vite branch, prerenderer injection |
| `packages/astro/src/core/build/static-build.ts`  | +3     | Export `ssrMoveAssets`, defer `.prerender/` cleanup          |
| `packages/astro/src/types/public/config.ts`      | +35    | `previousDist` + `incrementalBuild` config types             |
| `packages/astro/src/core/config/schemas/base.ts` | +8     | Zod schema for `incrementalBuild`                            |
| `packages/astro/src/cli/flags.ts`                | +1     | `--previous-dist` CLI flag mapping                           |
| `packages/astro/src/cli/build/index.ts`          | +4     | Help text                                                    |
| `packages/astro/package.json`                    | +2     | `micromark-extension-mdxjs`, `mdast-util-from-markdown` deps |

## Files Changed (cloudflare-docs)

| File              | What                                                              |
| ----------------- | ----------------------------------------------------------------- |
| `astro.config.ts` | Added `incrementalBuild.partialResolver` for `<Render>` component |
| `package.json`    | Added `build:incremental` script                                  |
