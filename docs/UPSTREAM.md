# Upstream

- **Original repository:** https://github.com/ngchenghow/obsidian-project-view
  (plugin "Project View", id `project-view`, MIT, by ngchenghow)
- **Forked at:** `b3030372606ddd002f5d27a93dbf74ad5eeab790` ("Update
  README.md", upstream v1.0.16). Tagged `upstream-base-b303037` in this repo.
  Upstream `main` was at exactly this commit when the fork was made
  (2026-09-22), so no unreviewed upstream changes were taken.
- **Git setup:** remote `upstream` points at the original repo and is
  fetch-only (its push URL is set to `DISABLED`). `origin` is the owner's
  **private** GitHub repository; only branch `project-spaces` (the default
  branch there) and the `upstream-base-b303037` tag are pushed. Local `main`
  is upstream history.

## What was kept (as concepts, rewritten into `src/project-space-manager.ts`)

| Upstream (main.ts @ b303037) | Here |
| --- | --- |
| `showPane` + `_switchQueue` promise chain | `switchTo` / `enqueue` / `switchQueue` |
| `_showPaneGen`, bumped synchronously, checked between tab opens in `createPaneGroup`, which detaches its partial leaves on abort | `switchGen` checks in `build`, `abort()` closes created leaves |
| `_pendingSwitches` gating the 150 ms release of `isActivating` | `pendingSwitches` gating `switching`, `SETTLE_MS = 150` |
| `rv-hidden` on the root while a pane is built; revealed only by the latest switch | `ps-root-building` |
| Keep-alive mode: inactive groups hidden with `display: none` (`rv-pane-inactive`) | `ps-hidden`, now the only mode |
| `onLayoutChange` ignored while activating/starting/unloading; "all tabs closed" recreates an empty tab | `onLayoutChange` |
| Quit handler: capture, close non-active groups, `tasks.add(persist)` | `onQuit` + quit task |
| Startup settle delays (300 ms, then 500 ms) for Obsidian's late layout restoration | `STARTUP_INITIAL_WAIT_MS`, `STARTUP_LATE_WAIT_MS` |
| Capture reads `getViewState().state.file` (works for deferred tabs) | `toSavedTab` |

## What changed in the kept logic, and why

- **Ownership per leaf instead of one tab group per project.** Upstream tracked
  one `WorkspaceTabs` per project pane, so a split made inside a project was
  untracked: it stayed visible after switching and its tabs were never saved.
  Here every main-area leaf has an owner and visibility is computed over the
  whole layout tree.
- **Generic view state.** Upstream saved `{path, eState}` and reopened with
  `openFile`, dropping every non-file view. Here the whole `getViewState()` is
  saved and restored with `setViewState`, so Canvas, PDF, Blackboard, graph
  and unknown plugin views round-trip.
- **Startup adopts instead of rebuilding.** Upstream kept the first restored
  leaf, detached the others and reopened saved notes, then detached "stray"
  leaves. Here restored leaves are routed by their Obsidian leaf id: the active
  project's are kept (splits and deferred loading survive), other projects'
  copies are closed (their state is in data.json).
- **Upstream bug not carried over:** `settleStartupInner` collected leaves
  with `iterateRootLeaves((leaf) => existing.push(leaf))`. Obsidian stops
  iterating on a truthy return, so only the first leaf was ever collected.
- **First use no longer closes tabs.** Upstream's first `createPaneGroup`
  detached every open tab except one. Here the first project adopts them.
- **Capture is guarded by `shownId`** so an aborted build can never save an
  empty or partial tab list over a project's saved tabs.
- **Stale queued switches are skipped** instead of run (the newest request does
  the work).

## What was removed

- **Google Drive, entirely:** `gdrive.ts`, OAuth loopback server
  (`http.createServer` on 127.0.0.1, `shell.openExternal`), client id/secret
  and refresh token settings, Drive upload/download/merge, revision history,
  Drive-linked and Drive-created projects, the Drive version picker and
  modals.
- Recent Edits pane and edit tracking (editor-change diffing, history in
  data.json).
- Diff/merge machinery (additive merge, merge notes, apply-back).
- Pins, folder/note membership, the project contents pane and vault tree
  modals, file context-menu items, move/rename helpers.
- Project descriptions, named sub-panes per project, default tab sets,
  recently-closed tabs, back navigation.
- Settings tab, the in-vault data note (`ProjectView.md`), legacy data
  migrations.
- Project creation/editing UI: projects are defined only in
  `ProjectSpaces.config.json`.
- The committed build artifact `main.js` and the GitHub release workflow.

Upstream `main.ts` + `gdrive.ts` were 6,307 lines; `src/` here is about 2,200 (about 1,000 of it the workspace manager, heavily commented).

## Security-relevant differences

| | Upstream @ b303037 | Project Spaces |
| --- | --- | --- |
| Network | `requestUrl` to Google OAuth and Drive endpoints | None |
| Local server | `http.createServer` on 127.0.0.1 during OAuth | None |
| External launch | `electron.shell.openExternal` / `window.open` | None |
| Node/Electron access | `window.require` for `http`, `crypto`, `electron` | None (bundle only requires `obsidian`) |
| Secrets stored | Google client id, client secret, refresh token in data.json (plain text) | None |
| File writes | data note in the vault, Drive downloads into vault folders | Own `data.json`, the config file only when missing |
| Automated check | none | `npm run security:check` in `verify` and `install:local` |

When run against upstream's `main.js` + `gdrive.ts`, `security:check` reports
104 findings. Against this repo it reports none.

## Reviewing future upstream changes

Do **not** merge or rebase onto upstream. The code bases have diverged
structurally and upstream carries features this fork deliberately removed.

To look at what changed:

```sh
git fetch upstream
git log --oneline upstream-base-b303037..upstream/main
git diff upstream-base-b303037 upstream/main -- main.ts
```

For each change, decide whether it touches the concepts listed under "What was
kept" (switch serialization, hidden groups, startup restoration, capture). If
it does, and it fixes a real bug, port the idea by hand into
`src/project-space-manager.ts`, keeping the invariants in `AGENTS.md`. Before
porting, check the diff for new network, process, `window.require`, `eval` or
external-URL use. Then run `npm run verify` and the manual acceptance tests in
`docs/ARCHITECTURE.md`. Record the upstream commit you reviewed in this file.

| Date | Upstream commit reviewed | Outcome |
| --- | --- | --- |
| 2026-09-22 | `b3030372606ddd002f5d27a93dbf74ad5eeab790` | Fork base |
