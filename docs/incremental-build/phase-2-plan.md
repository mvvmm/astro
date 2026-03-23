# Phase 2: Partial Dependency Graph

**Status**: Implemented
**Prerequisite**: [Phase 1](./phase-1-plan.md) (implemented), [design.md](./design.md)

---

## Goal

When `partialResolver` is configured, build a reverse dependency map (`partial file path → Set<page entry ID>`) by scanning MDX files for JSX nodes. When a partial changes, instead of triggering a full rebuild (Phase 1 behavior), expand the dirty set to only the pages that use that partial — including transitive dependencies (partial A renders partial B).

---

## Context

### The Problem (Phase 1 Limitation)

Phase 1 triggers a full rebuild whenever ANY entry in the `partials` collection changes. For cloudflare-docs with 1,382 partials and 2,869 `<Render>` invocations across 1,502 MDX files, this means editing a partial used by 1 page still rebuilds all 6,080 pages.

### Why This Matters

Partials are content — they change with the same frequency as docs pages. A typical PR might edit a partial alongside the pages that use it. Phase 1 handles the page edits incrementally but triggers a full rebuild for the partial edit, negating the benefit.

### The `<Render>` Pattern

cloudflare-docs uses a custom `<Render>` component to include content partials:

```mdx
<Render file="prereqs" product="workers" />
```

This resolves to `getEntry("partials", "workers/prereqs")` at runtime. All 2,869 invocations use **static string literal props** (no computed values), making the pattern 100% statically analyzable.

94 partials render other partials (189 invocations), creating 2+ level deep dependency chains that require transitive resolution.

### Data Store Entry Format

| Collection | Entry ID example                       | `filePath`                                                      |
| ---------- | -------------------------------------- | --------------------------------------------------------------- |
| `docs`     | `workers/get-started/guide`            | `src/content/docs/workers/get-started/guide.mdx`                |
| `partials` | `workers/prereqs`                      | `src/content/partials/workers/prereqs.mdx`                      |
| `partials` | `cloudflare-one/gateway/selectors/foo` | `src/content/partials/cloudflare-one/gateway/selectors/foo.mdx` |

The `partialResolver` callback maps JSX props to the `filePath`:

```ts
// <Render file="prereqs" product="workers" />
partialResolver('Render', { file: 'prereqs', product: 'workers' });
// → "src/content/partials/workers/prereqs.mdx"
```

---

## Architecture

### Data Structures

**Dep map** (`dist-meta/dep-map.json`):

```ts
interface DepMap {
  /**
   * Maps a partial file path to the set of docs entry IDs whose pages
   * depend on it (directly or transitively).
   * Key: "src/content/partials/workers/prereqs.mdx"
   * Value: ["workers/get-started/guide", "workers/tutorials/foo", ...]
   */
  partialToPages: Record<string, string[]>;

  /**
   * Maps a partial file path to other partial file paths it directly
   * references via <Render>. Used for transitive closure computation.
   * Key: "src/content/partials/networking-services/routing/configure-tunnels.mdx"
   * Value: ["src/content/partials/networking-services/routing/anycast-warning.mdx", ...]
   */
  partialToPartials: Record<string, string[]>;

  /**
   * Digest of each scanned file at scan time. Used for incremental
   * rescan — only files whose digest changed need re-parsing.
   * Key: "src/content/docs/workers/get-started/guide.mdx"
   * Value: "6c7ebb6834739fee"
   */
  scannedDigests: Record<string, string>;
}
```

### Data Flow

```
1. LOAD PREVIOUS DEP MAP
   - Read dist-meta/dep-map.json (if it exists)
   - If missing, start with empty dep map (full scan)

2. INCREMENTAL RESCAN
   For each MDX file in the docs and partials collections:
     - Look up its digest in the current data store
     - Compare against depMap.scannedDigests[filePath]
     - If digest unchanged → skip (reuse cached deps)
     - If digest changed or file is new → parse and scan

3. PARSE + SCAN (for each file needing rescan)
   - Read raw MDX content from disk
   - Parse with fromMarkdown() + mdxjs() extension
   - Visit all mdxJsxFlowElement and mdxJsxTextElement nodes
   - For each JSX node:
     a. Extract name and literal string attributes into a props Record
     b. Call partialResolver(name, props)
     c. If it returns a file path → record dependency:
        - If scanner file is a docs page: pageEntryId depends on partialFilePath
        - If scanner file is a partial: partialFilePath depends on partialFilePath

4. BUILD REVERSE MAP
   From the raw scan data (forward deps: file → [partialPaths]):
   - Build partialToPages (direct): for each page, for each partial it uses,
     add page to partial's set
   - Build partialToPartials (direct): for each partial, for each partial it uses,
     record the edge

5. TRANSITIVE CLOSURE
   For each partial P that has entries in partialToPartials:
   - BFS upward through partialToPartials reverse edges
   - Collect all ancestor partials (partials that directly or
     indirectly include P)
   - Propagate P's page set upward: if partial A renders partial B,
     then all pages of A are also pages of B
   After closure: partialToPages[P] contains ALL pages affected when P changes,
   not just direct consumers.

6. PERSIST
   Write dep-map.json to dist-meta/ (alongside data-store.json and
   component-manifest.json).
```

### Using the Dep Map in Dirty Computation

Phase 1 code (lines 159-167 of `incremental.ts`):

```ts
// For non-docs collections: any change → full rebuild
if (collectionName !== 'docs') {
  if (hasCollectionChanged(currentEntries, prevEntries)) {
    return null;
  }
  continue;
}
```

Phase 2 replaces this for the `partials` collection:

```ts
if (collectionName === 'partials' && partialResolver) {
  // Identify changed partial entries
  const changedPartialPaths = new Set<string>();
  for (const [entryId, entry] of currentEntries) {
    const prevEntry = prevEntries?.get(entryId);
    if (!prevEntry || entry.digest !== prevEntry.digest) {
      if (entry.filePath) changedPartialPaths.add(entry.filePath);
    }
  }
  // Check for deleted partials
  if (prevEntries) {
    for (const [entryId] of prevEntries) {
      if (!currentEntries.has(entryId)) {
        // Deleted partial — treat all its consumers as dirty
        const prevEntry = prevEntries.get(entryId)!;
        if (prevEntry.filePath) changedPartialPaths.add(prevEntry.filePath);
      }
    }
  }

  // Expand through transitive closure
  const allAffected = expandTransitive(changedPartialPaths, depMap);
  for (const partialPath of allAffected) {
    const pageEntryIds = depMap.partialToPages[partialPath] ?? [];
    for (const pageEntryId of pageEntryIds) {
      dirtyPathnames.add(entryIdToPathname(pageEntryId));
    }
  }
  continue; // don't fall through to "full rebuild"
}
```

All other non-docs collections still trigger full rebuild on change (unchanged from Phase 1).

### Transitive Closure Algorithm

```ts
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
```

**Example**: If partial `workers/prereqs` is changed, and partial `workers/setup` renders `workers/prereqs`, and page `workers/get-started/guide` renders `workers/setup`, then:

- Direct: `workers/prereqs` changed
- Transitive: `workers/setup` also affected (renders `workers/prereqs`)
- Pages: `workers/get-started/guide` is dirty (renders `workers/setup`)

---

## File Changes

### 1. `packages/astro/package.json`

Add two new direct dependencies (currently transitive only):

```json
"micromark-extension-mdxjs": "^3.0.0",
"mdast-util-from-markdown": "^2.0.0"
```

### 2. `packages/astro/src/core/build/incremental.ts`

**New functions:**

| Function              | Purpose                                                                       | Est. lines |
| --------------------- | ----------------------------------------------------------------------------- | ---------- |
| `buildDependencyMap`  | Orchestrates loading previous dep map, incremental rescan, transitive closure | ~80        |
| `scanMdxDependencies` | Parses one MDX file and returns the partial file paths it references          | ~40        |
| `expandTransitive`    | BFS upward through partial-to-partial edges to find all affected partials     | ~25        |

**Modified functions:**

| Function                | Change                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `computeDirtyPathnames` | Call `buildDependencyMap` when `partialResolver` is present; use dep map for partials diff |
| `persistBuildMetadata`  | Also write `dep-map.json` to all dist-meta/ directories                                    |

**New types:**

```ts
interface DepMap {
  partialToPages: Record<string, string[]>;
  partialToPartials: Record<string, string[]>;
  scannedDigests: Record<string, string>;
}
```

### 3. `/Users/vance/code/cloudflare/cloudflare-docs/astro.config.ts`

Add `partialResolver` to the existing config:

```ts
incrementalBuild: {
  partialResolver: (name, props) => {
    if (name === 'Render' && props.file && props.product) {
      return `src/content/partials/${props.product}/${props.file}.mdx`;
    }
    return null;
  },
},
```

---

## Dep Map Caching Strategy

### First Build (No Previous Dep Map)

- Full scan of all ~7,400 MDX files (docs + partials)
- Parse each, extract dependencies
- Build full dep map from scratch
- Estimated time: ~2-5 seconds (MDX parsing is fast, no compilation)

### Subsequent Builds (Previous Dep Map Exists)

- Compare each file's current digest against `scannedDigests`
- Only re-parse files whose digest changed
- For a typical 1-file edit: re-parse 1 file (~1ms)
- Merge updated deps into existing map
- Re-compute transitive closure (fast, ~94 partial-to-partial edges)

### Cache Invalidation

The dep map is automatically invalidated when:

- A file's digest changes → that file is re-scanned
- A file is deleted → its entries are removed from the map
- A new file is added → it is scanned (no previous digest to compare)
- The dep-map.json file is missing → full rescan

No explicit invalidation needed — the digest comparison handles it.

---

## Error Handling

| Scenario                                          | Behavior                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| MDX parse error for one file                      | Log warning, treat file as depending on ALL partials (conservative)          |
| `partialResolver` throws                          | Log warning, skip that JSX node                                              |
| `partialResolver` returns path that doesn't exist | Silently ignore (the partial may have been deleted)                          |
| Partial not in dep map (new, never scanned)       | It won't be in `partialToPages`, so its change won't expand to any pages.    |
|                                                   | However, pages referencing it WILL be re-scanned (their digest changed too). |
| Dep-map.json corrupted                            | `try/catch` → fall back to full rescan                                       |
| Circular partial-to-partial dependency            | BFS `visited` set prevents infinite loops                                    |

---

## Testing Plan

### Manual Test: Single Partial Change

```bash
# 1. Run full build (establishes baseline + dep map)
npm run build:incremental

# 2. Edit a partial used by a known set of pages
# e.g., src/content/partials/workers/prereqs.mdx (used by ~5 pages)
echo "{/* test */}" >> src/content/partials/workers/prereqs.mdx

# 3. Run incremental build
npm run build:incremental

# 4. Verify:
#   - Build log shows "Incremental build: 5 page(s) to rebuild" (not 6,080)
#   - Only the 5 pages using prereqs were rebuilt
#   - Other pages copied from cache
```

### Manual Test: Nested Partial Change

```bash
# Edit a partial that is rendered by another partial
# Find a chain: page → partial A → partial B
# Edit partial B → verify both pages using A and pages using B are rebuilt
```

### Manual Test: Fallback Still Works

```bash
# Edit a non-docs, non-partials collection entry (e.g., glossary)
# Verify full rebuild is triggered (unchanged from Phase 1)
```

---

## Known Limitations (Phase 2)

| Limitation                                                   | Impact                                            | Future fix                            |
| ------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------- |
| Any non-content src/ file change still triggers full rebuild | Component edits still full-rebuild                | Phase 3: component import scanning    |
| Non-docs/non-partials collection changes still full rebuild  | Glossary, changelog, etc. edits full-rebuild      | Phase 3: collection→route mapping     |
| `partialResolver` only sees literal string JSX attributes    | Dynamic props like `file={someVar}` are invisible | N/A (100% literal in cloudflare-docs) |
| First build after adding `partialResolver` does full scan    | ~2-5 second overhead (one time)                   | Acceptable                            |

---

## Implementation Order

1. Add `micromark-extension-mdxjs` and `mdast-util-from-markdown` to `packages/astro/package.json`
2. Add `DepMap` type and `scanMdxDependencies()` helper to `incremental.ts`
3. Add `buildDependencyMap()` function
4. Add `expandTransitive()` helper
5. Update `computeDirtyPathnames()` to use dep map for partials collection
6. Update `persistBuildMetadata()` to write `dep-map.json`
7. Build astro package
8. Configure `partialResolver` in cloudflare-docs' `astro.config.ts`
9. Test with partial changes
