# Future Work

Potential improvements beyond Phase 1-3. Ordered by estimated practical impact for cloudflare-docs.

---

## 1. CI/CD Integration (High Impact)

The incremental build currently works locally. To get value in production, the `dist-meta/` cache needs to persist across CI runs.

### Approach

```
CI Pipeline:
  1. Download dist-meta/ + dist/ from cache (R2 bucket, GitHub Actions cache, etc.)
  2. Run: astro build --previous-dist ./cache/dist
  3. Upload new dist-meta/ + dist/ to cache
  4. Deploy dist/
```

### Considerations

- **Cache key**: Use the git branch name or base commit SHA. Each branch should have its own cache so PRs don't interfere with each other.
- **Cache size**: `dist-meta/` is ~70 MB (36 MB data store + 2.8 MB internals + 1 MB dep map + 30 MB prerender bundle). `dist/` is ~1.8 GB. Consider caching only `dist-meta/` and a subset of `dist/` (the HTML pages).
- **First build on a new branch**: No cache exists → full build, which creates the cache for subsequent runs.
- **Main branch cache**: After merging to main, the main branch cache should be updated. PR branches can use main's cache as a starting point.
- **Concurrent builds**: Two builds running simultaneously against the same cache could corrupt it. CI should either serialize builds or use branch-specific cache paths.

### GitHub Actions Example (Sketch)

```yaml
- name: Restore build cache
  uses: actions/cache/restore@v4
  with:
    path: |
      build/cache/dist-meta/
      build/cache/dist/
    key: astro-build-${{ github.base_ref || 'main' }}

- name: Build
  run: npm run build:incremental

- name: Save build cache
  if: github.ref == 'refs/heads/main'
  uses: actions/cache/save@v4
  with:
    path: |
      build/cache/dist-meta/
      build/cache/dist/
    key: astro-build-main-${{ github.sha }}
```

---

## 2. Non-Docs Collection Tracking (Medium Impact)

Currently, any change to non-docs/non-partials collections (`changelog`, `glossary`, `compatibility-flags`, `plans`, `directory`, `workers-ai-models`, etc.) triggers a full rebuild because we don't know which pages consume their data.

### The Problem

These collections are consumed by specific `src/pages/` routes:

- `changelog` → `src/pages/[...changelog].xml.ts` + `src/pages/changelog/` routes
- `glossary` → `src/components/GlossaryTooltip.astro` (used in ~330 pages)
- `workers-ai-models` → `src/pages/workers-ai/models/` routes
- `compatibility-flags` → `src/pages/workers/platform/compatibility-dates/` routes

### Possible Approach

Add a `collectionRoutes` config option that maps collection names to the specific routes/pages that consume them:

```ts
incrementalBuild: {
  collectionRoutes: {
    changelog: ['/changelog/**', '/[...changelog].xml'],
    glossary: null, // null = affects all pages (used via GlossaryTooltip)
    'workers-ai-models': ['/workers-ai/models/**'],
    'compatibility-flags': ['/workers/platform/compatibility-dates/**'],
  }
}
```

When a mapped collection changes, only those routes are marked dirty (instead of full rebuild). Unmapped collections still trigger full rebuild.

### ROI Assessment

These collections change infrequently. The `glossary` collection is the trickiest because `GlossaryTooltip` is used across ~330 pages — so a glossary change would still rebuild 330 pages. The others have small, well-defined blast radii.

---

## 3. Phase 4: Component Dependency Tracking (Low Impact for cloudflare-docs)

### What It Would Do

Track which pages import which `src/components/` files. When a component changes, only rebuild pages that use it (instead of full rebuild).

### Why It's Low ROI for cloudflare-docs

Analysis of the last 200 commits:

| Commit type                                  | % of PRs | Current behavior       | Phase 4 benefit           |
| -------------------------------------------- | -------- | ---------------------- | ------------------------- |
| Content-only (MDX docs + partials)           | **81%**  | ~19s incremental build | Not needed                |
| Global source (layout, header, footer, etc.) | **~5%**  | Full rebuild           | **No** — genuinely global |
| Scoped component (WranglerCommand, etc.)     | **~3%**  | Full rebuild           | **Yes** — could help      |
| Non-src (CI, config, deps)                   | **11%**  | Mixed                  | Not applicable            |

The key problem: **9 of 11 Starlight component overrides are truly global.** `Page.astro`, `Head.astro`, `Header.astro`, `Footer.astro`, `Sidebar.astro`, `SidebarSublist.astro`, `MarkdownContent.astro`, `TableOfContents.astro`, and `PageTitle.astro` are injected into every single page via Starlight's `virtual:starlight/components/*` system. A change to any of them legitimately requires rebuilding all ~6,080 pages.

Only ~3% of commits touch scoped components (like `WranglerCommand`, `DashButton`, `Stream`) where dependency tracking would actually help.

### Implementation Sketch (If Pursued)

1. After the Vite build, extract the module graph to build a reverse map: `component file → pages that import it`
2. Store in `dist-meta/component-deps.json`
3. In `computeDirtyPathnames`, when a non-content src/ file changes:
   - Look up which pages depend on it via the reverse map
   - If ALL pages depend on it (global component) → full rebuild
   - If subset → add those pages to dirty set (and still run Vite build, since source changed)
4. Transitive deps: if component A imports component B, pages using A are also affected by B changes

### Complexity

High. The Vite module graph is only available during the build (not persisted). Extracting and serializing it requires intercepting Rollup's `generateBundle` hook to walk `moduleIds`. Layout/Starlight components are resolved via virtual modules, which complicates graph walking.

---

## 4. Build Time Optimization Opportunities (Various Impact)

### 4a. Parallelize Prerender + Client Builds (~30-40s savings)

Currently, the three Vite builds (prerender → SSR → client) run sequentially. The prerender and SSR builds are independent — only the client build depends on them (needs discovered hydrated components). Running prerender and SSR in parallel could save ~30-40s on full builds.

**Risk**: Need to verify no shared mutable state in `BuildInternals` between concurrent builds.

### 4b. Persistent Rollup Cache (~40-60s savings)

Rollup 4 has a `cache` option that stores parsed ASTs and resolved module info. Passing a previous build's cache to the next build skips re-parsing unchanged modules. However, Vite 7 doesn't expose this option through its builder API, and Rollup's cache is an in-memory object not designed for disk persistence.

**Complexity**: Very high. Would require patching Vite internals or a custom serializer for Rollup's cache object.

### 4c. Cache Data Store ESM Output (~5-10s savings)

The `astro:data-layer-content` virtual module reads `data-store.json` (~36 MB), parses it, converts it to ESM via `dataToEsm()`, and then Rollup re-parses the generated ESM. Caching the ESM output when the data store hasn't changed would skip this round-trip.

**Complexity**: Low. Check data store mtime/hash, reuse previous ESM string if unchanged.

---

## 5. Stability / Edge Cases

Known areas that could benefit from hardening:

| Scenario                           | Current behavior                                 | Improvement                                   |
| ---------------------------------- | ------------------------------------------------ | --------------------------------------------- |
| `--force` + `--previous-dist`      | Untested                                         | Should ignore cache, do full rebuild          |
| Concurrent builds on same cache    | Undefined (possible corruption)                  | File locking or error detection               |
| Corrupted `build-internals.json`   | Falls back to full Vite build (error caught)     | Good — could add checksum verification        |
| Astro version upgrade              | May produce incompatible `build-internals.json`  | Add version field to serialized internals     |
| New route added (not just content) | Falls back to full rebuild (new src/pages/ file) | Correct behavior                              |
| `trailingSlash` config change      | Full rebuild (config change detected)            | Correct behavior                              |
| Large number of dirty pages        | Renders all dirty pages sequentially             | Could add concurrency limit like full build   |
| Image optimization                 | Only optimizes images for dirty pages            | Clean pages' images come from cache — correct |
