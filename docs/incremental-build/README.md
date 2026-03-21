# Incremental Build

Documentation for the incremental/partial build feature (`--previous-dist`).

## Documents

- **[design.md](./design.md)** — Full architecture and design document. Covers the problem, proposed API, research findings, and complete implementation plan across all phases.
- **[phase-1-plan.md](./phase-1-plan.md)** — Phase 1 implementation plan. Conservative approach: content digest diffing with full-rebuild fallback for non-content changes.
- **[phase-2-plan.md](./phase-2-plan.md)** — Phase 2 implementation plan. Partial dependency graph via `partialResolver` callback and MDX AST scanning.
- **[testing-results.md](./testing-results.md)** — Testing results for Phase 1 and Phase 2 against cloudflare-docs (~6,080 pages, ~1,382 partials).

## Phases

| Phase | Scope                                                       | Status      |
| ----- | ----------------------------------------------------------- | ----------- |
| 1     | Content digest diffing + conservative fallback              | Implemented |
| 2     | Partial dependency graph (`partialResolver` + MDX scanning) | Implemented |
| 3     | Component import scanning + collection→route mapping        | Future      |
