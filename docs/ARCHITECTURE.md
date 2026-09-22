# Architecture

Project Spaces keeps one live set of main-area tabs per project and shows only
the active project's set. This document is the contract for anyone changing
`src/`. The invariants in `AGENTS.md` are summarized here with the reasons
behind them.

## Modules

| File | Role | Obsidian API? |
| --- | --- | --- |
| `src/config.ts` | Parse and validate `ProjectSpaces.config.json`; choose between the file and the last valid config. | No (unit-tested) |
| `src/state.ts` | Runtime state types, migrations, reconcile with config, orphan/prune, path rename/delete, capture merge. | No (unit-tested) |
| `src/project-space-manager.ts` | Live workspace: leaf ownership, visibility, build, capture, switch queue, startup, quit. | Yes |
| `src/obsidian-internals.ts` | The undocumented Obsidian members used (`containerEl`, `children`, leaf `id`, tab-group `createLeafInParent`). | Yes |
| `src/project-sidebar.ts` | The "Projects" list view. | Yes |
| `src/modals.ts` | Fuzzy project picker; prune confirmation. | Yes |
| `src/main.ts` | Plugin wiring: load/save `data.json`, config reload + watcher, commands, vault events. | Yes |

## Project config model

`<vault>/ProjectSpaces.config.json`:

```json
{ "version": 1, "projects": [ { "id": "project-a", "name": "Project A" } ] }
```

- `id` is the identity: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, unique. Runtime
  state is keyed by it.
- `name` is presentation only (defaults to `id`).
- Array order is sidebar order and next/previous order.
- `parseConfig` never throws. `resolveConfig(text, lastGood)` returns the file's
  config when valid; otherwise the last valid one plus an error. A missing file
  counts as an error, not as "zero projects".
- The plugin writes the file only when "Open configuration" finds it missing
  (`{"version":1,"projects":[]}`); it never writes project names.

## Runtime state model (`data.json`)

```ts
interface RuntimeState {
  stateVersion: 1;
  activeProjectId: string | null;
  spaces: Record<string, SpaceState>; // keyed by project id, includes orphans
  lastGoodConfig: ProjectConfig | null; // fallback when the file is broken
}
interface SpaceState {
  name: string;              // last display name seen (labels orphans)
  tabs: SavedTab[];          // layout order; splits are flattened
  activeTab: number;         // index into tabs, -1 if none
  orphanedAt: number | null; // epoch ms when the id left the config
}
interface SavedTab {
  leafId?: string;                 // Obsidian leaf id (stable across restarts)
  view: { type: string; state?: Record<string, unknown>; pinned?: boolean };
  eState?: Record<string, unknown>; // ephemeral state, e.g. { cursor, scroll }
}
```

`view` is `leaf.getViewState()` without `active`, `group`, `icon` and `title`,
so any view type is stored generically: Markdown, Canvas (`viewState` with pan
and zoom), PDF, Blackboard (`blackboard-view`), graph, and so on. It is
restored with `leaf.setViewState(view, eState)`. An unknown view type (plugin
disabled) round-trips unchanged: Obsidian keeps its state and shows a
placeholder.

**Migrations.** `migrateState(raw)` returns `{ state, status }`:

- `fresh`: no data.json.
- `ok`: current version, sanitized.
- `migrated`: older version run through `MIGRATIONS[n]` steps. main.ts backs
  up the old data.json first.
- `unrecognized`: shape not understood, or a migration step is missing.
  main.ts backs it up, then starts fresh.
- `newer`: written by a newer build. main.ts runs in memory and never saves.

To change the format: bump `STATE_VERSION`, add `MIGRATIONS[old]`, add a test.

## Live model: leaves, owners, visibility

Obsidian's main area (`workspace.rootSplit`) is a tree of splits, tab groups
(`WorkspaceTabs`) and leaves (tabs). Project Spaces keeps every project's tabs
in that one tree:

- **Ownership.** `owners: WeakMap<WorkspaceLeaf, projectId>`. Every main-area
  leaf belongs to exactly one project. Leaves nobody owns are adopted on the
  next `layout-change` and at the start of every switch
  (`adoptUnownedLeaves`):
  - a leaf whose Obsidian id is a saved tab of another project is a restored
    stray and is closed (that project's state is safe in data.json);
  - a leaf inside a tab group joins the project that owns the group's other
    tabs (`layout-change` is asynchronous, so a tab opened a moment before a
    switch may be adopted after the active project changed);
  - anything else (a new split, first-run tabs) joins the active project.
  So new tabs, splits and dragged tabs belong to the project that was visible
  when they were made.
- **Visibility.** `applyVisibility()` walks the tree. A leaf is visible if the
  active project owns it (or nobody owns it yet). A split or tab group gets
  class `ps-hidden` (`display: none`) when none of its descendants is visible.
  So a project can own several tab groups and splits, and a group created
  inside another project's split still hides and shows correctly. Hidden
  leaves stay loaded: editor state, undo history and plugin views survive.
- **Focus guard.** If a hidden project's leaf becomes active (for example
  through "focus tab group" commands), focus goes back to the visible project,
  so keystrokes never land in an invisible editor.

Popout windows and sidebars are outside `rootSplit` and are never touched.

## Switching lifecycle

`switchTo(id)` comes from upstream `showPane`. Do not remove any part of it:

1. `requestedId = id` (the sidebar highlights the click immediately).
2. `enqueue`: `switchGen++` (synchronously), `pendingSwitches++`, then the job
   is chained onto `switchQueue`, so switches run strictly one at a time.
3. `switchImpl(id, gen)`:
   1. If `gen !== switchGen`, a newer request exists: return (skip entirely).
   2. Adopt pending leaves, then **capture** the project being left, while it
      is still visible.
   3. `switching = true`; `activeProjectId = id`.
   4. If the target needs a build (no live leaves, or only an empty tab while
      it has saved tabs), add `ps-root-building` (`visibility: hidden` on the
      root) and **build**:
      - Reuse the project's empty tab if it has one; otherwise
        `createLeafBySplit(anchor, "vertical")` makes a new tab group.
      - For each saved tab, check `gen` first, then
        `createLeafInParent(group, i)` and `setViewState`. On a stale `gen`,
        close every leaf this build created, reset a reused tab to empty, and
        return false.
      - Tabs whose file is missing are skipped (kept in state); a throwing
        view is logged and skipped.
   5. If superseded, return and leave the root hidden (the newer switch will
      reveal it).
   6. `applyVisibility()`, focus the project's last focused leaf,
      `shownId = id`.
   7. `finally`: reveal the root only if `gen` is still current.
   8. Save; after `SETTLE_MS` (150 ms), release `switching` **only if**
      `pendingSwitches === 0`, then capture and refresh hidden projects.

Why each piece exists (all observed failure modes):

- Queue: two concurrent builds each create a tab group, so two projects end up
  side by side.
- `switchGen` checks inside the build: a new click shouldn't wait for an old
  project to open 10 tabs, and a half-built project must not survive.
- `pendingSwitches` gate: a stale 150 ms timer from switch N would re-enable
  capture in the middle of switch N+1 and save a half-built layout.
- `shownId`: after an aborted build, `activeProjectId` can point at a project
  with no or only placeholder leaves. Capture is refused unless that project
  finished building and is visible, so its saved tabs are never overwritten
  with nothing.
- Root hiding: the new tab group is created next to the old project's groups;
  without hiding, it flashes.

## Persistence lifecycle

- **Capture** (`capture(id)`) = live leaves of the shown project →
  `SavedTab[]`, merged with saved tabs whose file does not exist right now
  (e.g. not yet synced), so they are not dropped. Runs when a project is left,
  on `layout-change`, on `active-leaf-change` within the active project, after
  a switch settles, and on quit. It never runs while `switching` or
  `starting`, and only for `shownId`.
- **Hidden refresh** (`refreshHidden()`): hidden projects that have live
  leaves get their saved **view state** refreshed from those leaves, keeping
  the previously saved cursor/scroll (a hidden editor reports scroll 0, a
  deferred tab has none). A tab can still be loading when its project is
  hidden (captured as a Markdown tab without a file); this corrects it. Runs on
  quiet `layout-change`, after a switch settles, on quit and on unload. Hidden
  projects are always complete, because an aborted build closes everything it
  opened, so their live leaves are their real tab list.
- **Save**: debounced 1 s `saveData`; immediate on quit via `tasks.add` and on
  unload.
- **Vault events**: rename rewrites saved paths (files and folders) in every
  project; delete removes saved tabs for that path. Hidden live leaves follow
  Obsidian's own rename handling.
- **All tabs closed**: when the user closes the active project's last tab,
  Obsidian removes the tab group (other, hidden groups still exist), so the
  plugin records an empty tab list and rebuilds one empty tab.

## Restart and lazy restore

- **Quit** (`workspace.on("quit")`): capture the visible project, then close
  every hidden project's leaves (upstream behavior), so `workspace.json` only
  restores the active project. Hidden projects are rebuilt from data.json on
  their first click.
- **Plugin disable/reload** (`onunload` without quit): same cleanup, and all
  `ps-*` classes are removed, so the remaining layout is a normal workspace.
- **Startup** (`onLayoutReady` → `start()`, queued like a switch): hide the
  root, wait 300 ms (Obsidian keeps restoring after layout-ready; upstream
  value), then pick the active project (persisted, else the first configured)
  and adopt restored leaves. Leaves whose id belongs to another project's
  saved tabs are closed (crash case: `workspace.json` still had hidden
  columns). If the active project has nothing live, build it. Wait 500 ms more,
  adopt late arrivals, apply visibility, reveal. Splits of the active project
  survive a restart because its leaves are adopted, not rebuilt.
- **First run** (no data.json): the first configured project becomes active
  and adopts the tabs already open. Nothing is closed. (Upstream closed all
  but one tab on first use.)

## Config reload behavior

- Triggers: vault `modify`/`create`/`delete`/`rename` of the config path
  (750 ms debounce), the "Reload configuration" command, the sidebar button,
  and startup.
- Valid file: `reconcileWithConfig` adds empty spaces for new ids, updates
  names, marks missing ids orphaned, recovers returning ids, and caches the
  config as `lastGoodConfig`. Live tabs are never touched. The active project
  never changes on reload, even if it was removed (it stays visible until you
  switch; the sidebar says it is no longer in the config). Otherwise, cutting
  an entry to paste it elsewhere would switch away from the config editor
  mid-edit.
- Invalid or missing file: keep the last valid config, do not reconcile
  (nothing becomes orphaned), show a Notice (the watcher shows each distinct
  error once; the manual command always shows it) and a small error line in
  the sidebar. Pruning is refused while the config has an error.
- If nothing was active (empty config) and projects appear, the first one is
  activated and adopts the open tabs.

## Orphaned state

An id in `spaces` but not in the config is orphaned: `orphanedAt` is set the
first time it goes missing. Its tabs stay in data.json indefinitely; its live
leaves (if any) stay hidden until quit. Re-adding the same id clears
`orphanedAt` and brings the tabs back. "Prune orphaned state" lists orphans
(never the active project), asks for confirmation, deletes their state and
closes any live leaves they still have.

## Why this is not Workspace++

Workspace++ (and Obsidian's core Workspaces) save **snapshots**: a named layout
you save explicitly and load later. Loading replaces the whole layout; saving
over the wrong name loses a layout. Project Spaces has no save step:

- Each project's tabs are live objects kept in the same window, merely hidden.
  Switching does not serialize or reopen anything while Obsidian runs.
- The saved form (data.json) is written continuously and only for the project
  on screen, so one project's save can never write another project's tabs.
- New projects start empty; there is no "save as" that clones the current
  layout.

## Manual acceptance tests

Unit tests cover config/state logic. Workspace behavior is checked in a
sandbox vault (`npm run sandbox`, open `.sandbox-vault` in Obsidian). The
checks below were run through `obsidian-cli eval`, clicking the real sidebar
rows:

1. Independent projects: A with 4 notes, B with 3; A→B→A keeps both sets,
   A's cursor and scroll.
2. Adding project C via the config while in A: A untouched, C empty.
3. Rename (same id) and reload: tabs intact.
4. Reorder and reload: sidebar order changes, tabs intact.
5. Rapid switching (A→B→C→A→B→A with 0–150 ms gaps, plus random sequences
   with forced rebuilds): after settling, exactly one project visible, no
   duplicate or unowned leaves, saved state unchanged, focus in the visible
   project.
6. Restart (window reload / quit and reopen): active project restored,
   others rebuilt on click.
7. Markdown, Canvas, PDF and Blackboard views restore.
8. Broken JSON: notice, last valid config kept, tabs untouched; fixing the
   file and reloading resumes normally.
9. Security: `npm run security:check`; the runtime makes no network requests.

Note for automated testing: a background (occluded) Obsidian window throttles
`setTimeout` chains heavily. Wait for `pendingSwitches === 0 && !switching`
instead of sleeping for fixed times.
