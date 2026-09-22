# AGENTS.md: Project Spaces

Instructions for coding agents working in this repo. Read
`docs/ARCHITECTURE.md` before touching `src/project-space-manager.ts`.

## What this plugin is

"Give me persistent, visually separated sets of live Obsidian documents by
project." Nothing more. It is not a task manager, knowledge graph, project
database, kanban, note-metadata system, sync service, AI assistant, MCP server
or cloud service.

## Invariants (do not break without an explicit request from the owner)

1. **No project names or ids in source.** The taxonomy comes only from the
   config file. Tests and the example config use synthetic names
   (`Project A`, `project-a`, `Research`).
2. **`ProjectSpaces.config.json` (vault root) is the taxonomy source of
   truth.** Ids, display names and order live there and nowhere else. The
   plugin writes it only when it is missing and the user runs "Open
   configuration" (empty project list).
3. **`data.json` holds runtime state only**: active project, saved tabs per
   project, orphan markers, a cache of the last valid config, `stateVersion`.
   Never secrets, credentials or note contents.
4. **The stable project id is the identity.** State is keyed by id. Renaming
   (`name`) or reordering must never change or move state.
5. **Never delete project state because an id left the config.** It becomes
   orphaned (`orphanedAt`), is recovered if the id returns, and is removed only
   by the explicit "Prune orphaned state" command. A missing or invalid config
   must never reconcile state; keep the last valid config.
6. **Zero network access.** No fetch/requestUrl/XHR/WebSocket/EventSource,
   external URLs, telemetry, CSS `url()`/`@import`. Also no child_process,
   eval/new Function, window.require, Node or Electron modules. Enforced by
   `npm run security:check`; do not weaken the checker to make a change pass.
7. **No note metadata.** Never require or write frontmatter, tags or any
   per-note data.
8. **Switching must never overwrite another project's state.** Full capture
   (including cursor/scroll) only for the project currently shown
   (`shownId`), never during a switch or startup. Hidden projects may only
   have their view state refreshed from their own live leaves
   (`refreshHidden`). A new project starts empty; it never copies the current
   project's tabs.
9. **Keep the upstream race protections** in `ProjectSpaceManager`: the
   promise-chain `switchQueue`, the synchronous `switchGen` bump with checks
   between tab opens (abort and close partial work), `pendingSwitches` gating
   the delayed release of `switching`, hiding the root while building and
   revealing it only from the latest switch. Rapid clicking must never produce
   duplicate tabs, a project's tabs inside another, ghost panes, or a stale
   switch finishing after a newer one.
10. **No unrelated features** without an explicit request. Prefer deleting code
    to adding it.

## Obsidian gotchas that already bit this code

- `workspace.iterateRootLeaves(cb)` stops at the first truthy return. Never
  write `iterateRootLeaves((l) => arr.push(l))`; use a braced body. Use
  `mainLeaves()`.
- `createLeafInParent(split, i)` on a **split** inserts a bare leaf without a
  tab group and corrupts the layout. Only pass a tab group (see
  `asCreateLeafParent`).
- A hidden editor reports scroll 0, so never read cursor/scroll from a hidden
  project.
- `layout-change` is asynchronous: a new tab can still be unowned when the next
  switch starts. Adoption goes by the tab group's owner, and switches adopt
  before capturing.
- Background tabs restored by Obsidian are deferred: `getViewState()` works,
  ephemeral state does not (reuse the previously saved one).
- Undocumented members (`containerEl`, `children`, leaf `id`) are isolated in
  `src/obsidian-internals.ts`.

## Workflow

```sh
npm run verify          # typecheck, build, security check, unit tests: must pass
npm run install:local   # copy into the vault in dev.local.json (gitignored)
npm run sandbox         # or: throwaway .sandbox-vault for manual testing
```

Pure logic (`src/config.ts`, `src/state.ts`) has unit tests in `test/`; add
tests there for any change to parsing, reconciliation or migrations. Workspace
behavior needs the manual acceptance tests in `docs/ARCHITECTURE.md`.

State format changes: bump `STATE_VERSION` in `src/state.ts`, add a migration
to `MIGRATIONS`, add a test. Never reinterpret an old format silently.

## Privacy

Never commit vault paths, personal project names, `dev.local.json`, planning
notes or `.install-backups/`. No pushing and no remotes other than `upstream`
unless the owner asks.

## Upstream

Upstream changes are reviewed and ported by hand, never merged. See
`docs/UPSTREAM.md`.
