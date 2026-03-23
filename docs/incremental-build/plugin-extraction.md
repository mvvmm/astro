# Extracting the Incremental Build as an Astro Plugin

**Date**: 2026-03-22

This document analyzes whether the incremental build feature (currently implemented as modifications to the Astro fork) can be extracted into a standalone Astro integration/plugin.

---

## Summary

| Phase | Plugin-able? | Performance with plugin | Performance with fork |
| ----- | ------------ | ----------------------- | --------------------- |
| 1     | **Yes**      | ~130s (Vite still runs) | ~130s                 |
| 2     | **Yes**      | ~130s (Vite still runs) | ~130s                 |
| 3     | **No**       | N/A                     | **~19s**              |

Phases 1 and 2 can be cleanly extracted into a plugin. Phase 3 (skip Vite build) cannot — it requires access to internal APIs that Astro does not expose.

A Phase 1+2 plugin would reduce the page **rendering** time from minutes to seconds, but the Vite bundling phase (~106s) still runs on every build. For cloudflare-docs, this means ~130s incremental builds instead of ~19s with the fork.

---

## Prior Art

As of March 2026, **no existing Astro plugin attempts incremental/partial builds.** Searched:

- npm registry (`astro incremental build`, `astro partial build`, `astro cache build`)
- Astro integrations directory (https://astro.build/integrations/)
- GitHub repositories

This would be the first.

---

## Astro Integration API — Relevant Build Hooks

The hooks are listed in execution order during `astro build`:

| Hook                    | When it fires                              | Can set prerenderer?       | Can mutate Vite config? | Receives BuildInternals? | Can read/write dist/? |
| ----------------------- | ------------------------------------------ | -------------------------- | ----------------------- | ------------------------ | --------------------- |
| `astro:config:setup`    | Before config is frozen                    | No                         | Yes (AstroConfig.vite)  | No                       | No                    |
| `astro:config:done`     | Config frozen                              | No                         | No                      | No                       | No                    |
| `astro:routes:resolved` | After routes scanned                       | No                         | No                      | No                       | No                    |
| **`astro:build:start`** | **Before viteBuild()**                     | **Yes** (`setPrerenderer`) | No                      | No                       | No                    |
| `astro:build:setup`     | Before `vite.createBuilder()`              | No                         | Yes (`updateConfig`)    | Partial (`pages` map)    | No                    |
| `astro:build:ssr`       | After env builds, before `generatePages()` | No                         | No                      | No                       | No                    |
| `astro:build:generated` | After all pages rendered                   | No                         | No                      | No                       | Yes                   |
| **`astro:build:done`**  | **After everything**                       | No                         | No                      | No                       | **Yes**               |

### Key APIs

**`setPrerenderer()`** (available in `astro:build:start`):

```ts
setPrerenderer(
  prerenderer: AstroPrerenderer | ((defaultPrerenderer: AstroPrerenderer) => AstroPrerenderer)
) => void
```

This is the only public way to filter which pages get rendered. It wraps `getStaticPaths()` to control which pathnames are generated. This is exactly what Phases 1 and 2 use.

**`astro:build:done`** receives `{ pages, dir, assets, logger }`:

- `dir` is the output directory URL
- `pages` is a list of generated pathnames
- The plugin can freely read/write the filesystem here — perfect for `copyCleanPages()` and `persistBuildMetadata()`

---

## Phase-by-Phase Analysis

### Phase 1 — Content Diffing + Prerenderer Filter: **Plugin-able**

What it needs:

1. Read the previous data store from `dist-meta/data-store.json` → **filesystem read, no internal API needed**
2. Read the current data store from `node_modules/.astro/data-store.json` → **filesystem read** (path is `config.cacheDir + '/data-store.json'`)
3. Hash `src/` files for the component manifest → **filesystem read**
4. Compute dirty pathnames → **pure logic, no internal API needed**
5. Filter `getStaticPaths()` → **`setPrerenderer()` in `astro:build:start`**
6. Copy clean pages + persist metadata → **`astro:build:done` filesystem access**

**All of this maps cleanly to the public integration API.**

Hook mapping:

```
astro:config:done     → capture config.cacheDir, config.outDir
astro:build:start     → computeDirtyPathnames() + setPrerenderer(filtered)
astro:build:done      → copyCleanPages() + persistBuildMetadata()
```

### Phase 2 — Partial Dependency Graph: **Plugin-able**

Same as Phase 1, plus:

1. Scan MDX files for JSX nodes → **filesystem read + MDX parsing, no internal API**
2. Build dep map → **pure logic**
3. Expand dirty set via transitive closure → **pure logic**
4. Persist dep map → **filesystem write in `astro:build:done`**

**All of this is pure computation on files. No internal API needed.**

### Phase 3 — Skip Vite Build: **NOT Plugin-able**

This phase needs three things the public API does not provide:

**1. Short-circuit `viteBuild()` itself.**

There is no hook or mechanism for a plugin to say "skip the Vite build." The `viteBuild()` call happens inside `AstroBuilder.build()` unconditionally. The only way to skip it is to modify `index.ts` directly (which is what our fork does with the `if (!skippedViteBuild)` branch).

**2. Access `BuildInternals` after the Vite build.**

`BuildInternals` is created inside `viteBuild()` and never exposed to any integration hook. Our fork serializes it to `build-internals.json` and restores it to bypass Vite. A plugin has no way to obtain or restore this object.

The `astro:build:setup` hook receives `pages: Map<string, PageBuildData>` which is a reference to `internals.pagesByKeys`, but this is a single field, not the full `BuildInternals`. And it's only available _during_ the Vite build, not after.

**3. Call `generatePages()` and `ssrMoveAssets()` directly.**

When skipping the Vite build, our fork manually calls `ssrMoveAssets()` then `generatePages()` with the restored `BuildInternals`. These functions are internal to `packages/astro/src/core/build/` and not exported as public API.

**4. Defer `.prerender/` directory cleanup.**

Our fork comments out the `fs.promises.rm(prerenderOutputDir)` inside `static-build.ts` and moves it to `index.ts` after metadata caching. A plugin cannot control this.

---

## What a Phase 1+2 Plugin Would Look Like

```ts
// astro-incremental-build.ts
import type { AstroIntegration } from 'astro';

interface IncrementalBuildOptions {
  /** Path to a previous build's dist/ directory */
  previousDist: string;
  /** Glob patterns that trigger full rebuild if changed */
  globalFiles?: string[];
  /** Maps JSX nodes to content file dependencies */
  partialResolver?: (name: string, props: Record<string, string>) => string | null;
}

export default function incrementalBuild(options: IncrementalBuildOptions): AstroIntegration {
  let config: AstroConfig;
  let dirtyResult: IncrementalBuildResult | null = null;

  return {
    name: 'astro-incremental-build',
    hooks: {
      'astro:config:done': ({ config: c }) => {
        config = c;
      },

      'astro:build:start': async ({ setPrerenderer, logger }) => {
        // 1. Load previous data store + manifest from dist-meta/
        // 2. Load current data store from config.cacheDir
        // 3. Compute dirty pathnames (same logic as incremental.ts)
        // 4. Build dep map if partialResolver configured
        dirtyResult = await computeDirtyPathnames({ config, options, logger });

        if (dirtyResult !== null) {
          logger.info(`Incremental: ${dirtyResult.dirtyPathnames.size} page(s) to rebuild`);

          // 5. Wrap prerenderer to filter getStaticPaths()
          setPrerenderer((defaultPrerenderer) => ({
            ...defaultPrerenderer,
            async getStaticPaths() {
              const all = await defaultPrerenderer.getStaticPaths();
              return all.filter(({ pathname }) => dirtyResult!.dirtyPathnames.has(pathname));
            },
          }));
        } else {
          logger.info('Incremental: full rebuild required.');
        }
      },

      'astro:build:done': async ({ dir, logger }) => {
        // 6. Copy clean pages from previousDist
        if (dirtyResult !== null) {
          await copyCleanPages({
            previousDist: options.previousDist,
            outDir: dir,
            result: dirtyResult,
            logger,
          });
        }

        // 7. Persist metadata for next build
        await persistBuildMetadata({ config, options, dirtyResult, logger });
      },
    },
  };
}
```

### Usage in astro.config.ts

```ts
import { defineConfig } from 'astro/config';
import incrementalBuild from 'astro-incremental-build';

export default defineConfig({
  integrations: [
    incrementalBuild({
      previousDist: './build/cache/dist',
      partialResolver: (name, props) => {
        if (name === 'Render' && props.file && props.product) {
          return `src/content/partials/${props.product}/${props.file}.mdx`;
        }
        return null;
      },
    }),
  ],
});
```

### Plugin Advantages Over Fork

- Works with stock Astro (no fork required)
- Can be published to npm as a standalone package
- Upgradeable independently of Astro version (as long as hooks don't change)
- Simpler to maintain — no need to rebase on upstream Astro changes

### Plugin Limitations vs Fork

- **~130s builds instead of ~19s** — the Vite bundling phase (~106s) still runs every time
- Cannot cache or restore `BuildInternals`
- Cannot skip `viteBuild()` or call `generatePages()` directly
- No `--previous-dist` CLI flag — must be configured in `astro.config.ts`

---

## What Astro Core Would Need to Add for Phase 3 as a Plugin

Any **one** of these additions would enable Phase 3 in a plugin:

### Option A: `shouldSkipViteBuild` hook

A new hook that fires after `computeDirtyPathnames` but before `viteBuild()`:

```ts
'astro:build:before-vite'?: (options: {
  skipViteBuild: (restoredInternals: BuildInternals) => void;
  logger: AstroIntegrationLogger;
}) => void | Promise<void>;
```

If the plugin calls `skipViteBuild(internals)`, Astro skips `viteBuild()` and uses the provided internals for `generatePages()`.

### Option B: Expose `BuildInternals` in `astro:build:done`

```ts
'astro:build:done': (options: {
  // ... existing fields ...
  internals: BuildInternals;  // NEW
}) => void | Promise<void>;
```

This would let the plugin serialize internals for the next build. Combined with a `shouldSkipViteBuild` mechanism, this enables the full Phase 3 flow.

### Option C: `prerenderer.shouldRunViteBuild()` extension

Extend the `AstroPrerenderer` interface:

```ts
interface AstroPrerenderer {
  getStaticPaths(): Promise<PathWithRoute[]>;
  shouldRunViteBuild?(): Promise<{ skip: boolean; internals?: BuildInternals }>;
}
```

This is the most elegant option — the prerenderer already controls _which_ pages to build; extending it to control _whether to build at all_ is a natural extension. However, it tightly couples the prerenderer to the build lifecycle in a way the current design avoids.

---

---

## Generalization (Applied)

The initial implementation hardcoded collection names `'docs'` and `'partials'`, and used a Starlight-specific `entryIdToPathname` mapping. These have been generalized into config options so the feature works for any Astro site:

| Hardcoding                            | Fix                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| Only `docs` collection gets diffed    | `pageCollections: string[]` — list of collections to diff incrementally           |
| Only `partials` collection is scanned | `partialCollections: string[]` — list of collections to scan for dep graph        |
| Starlight `/index` stripping          | `entryIdToPathname` callback — configurable mapping from entry ID to URL pathname |

Default values match the original behavior (`pageCollections: ['docs']`, `partialCollections: ['partials']`), so cloudflare-docs continues to work without config changes. Other sites override as needed:

```ts
// Example: blog site with route at /blog/[...slug]
incrementalBuild: {
  pageCollections: ['posts'],
  partialCollections: ['snippets'],
  entryIdToPathname: (collection, entryId) => {
    if (collection === 'posts') return `/blog/${entryId}`;
    return `/${entryId}`;
  },
}
```

---

## Recommendation

**For cloudflare-docs specifically**: Keep using the fork. The ~19s builds from Phase 3 are the primary value. A plugin-only approach at ~130s isn't worth it when the fork is already working.

**For a general-purpose tool**: Build a Phase 1+2 plugin first. It captures the rendering time savings (minutes → seconds for page generation) and works with stock Astro. If adoption is strong, propose adding a `shouldSkipViteBuild` hook to Astro core to enable Phase 3.

**For upstreaming to Astro**: The cleanest path would be to propose the `astro:build:before-vite` hook (Option A above) to the Astro team. This is a small, focused addition that doesn't leak `BuildInternals` into the public API. If accepted, the entire incremental build feature — including Phase 3 — could be a plugin.
