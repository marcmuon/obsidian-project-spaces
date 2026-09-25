# Project Spaces

An Obsidian plugin that gives each of your projects its own persistent set of
live tabs. Desktop only.

## What Project Spaces is

**Persistent project tab contexts, not workspace snapshots.**

Each project listed in `ProjectSpaces.config.json` owns a set of tabs (and any
splits you make inside it). Click a project to show its tabs; the tabs of the
project you left stay alive in the background, with their cursor, scroll
position, undo history and plugin views intact. There is nothing to save: no
"save workspace", no "save as", no risk of overwriting another project's
layout.

## Credits

Project Spaces is built on
[Project View](https://github.com/ngchenghow/obsidian-project-view) by
[ngchenghow](https://github.com/ngchenghow). Project View came up with the idea
of switching between projects by hiding and showing live tab groups, and this
plugin keeps that approach. Project Spaces strips Project View down to that one
feature and adds a config-file project list and saved per-project state. Thank
you, ngchenghow. See [Upstream](#upstream) for details.

## Mental model

```
Project A   [A1] [A2] [A3] [A4]      <- visible
Project B   [B1] [B2] [B3]           <- alive, hidden
Research    (not opened yet)         <- saved tabs, built on first click
```

- Switching hides one project's tab groups and shows another's. Nothing is
  closed or reopened while Obsidian is running.
- New tabs and splits belong to the project that is visible when you create
  them.
- A project you have not visited since Obsidian started is rebuilt from its
  saved tabs on first click.
- A new project starts with one empty tab. It never copies the current
  project's tabs.

## Configuration

Location: `<Vault>/ProjectSpaces.config.json` (vault root). It appears in the
file explorer and opens in Obsidian's editor (the plugin shows `.json` files
and opens them as plain text).

```json
{
  "version": 1,
  "projects": [
    { "id": "project-a", "name": "Project A" },
    { "id": "project-b", "name": "Project B" },
    { "id": "research", "name": "Research" }
  ]
}
```

| Field | Rules |
| --- | --- |
| `version` | Must be `1`. |
| `projects` | Array. **Order = sidebar order.** May be empty. |
| `projects[].id` | Required, unique. Letters, digits, `-`, `_`, `.`; starts with a letter or digit; max 64 chars. **Keep it stable**: saved tabs are keyed by id. |
| `projects[].name` | Optional display name (defaults to the id). Change it freely. |

Unknown keys are ignored. A copy lives in
[`ProjectSpaces.config.example.json`](ProjectSpaces.config.example.json).

### Adding a project

Add an entry with a new `id` and save. The plugin reloads the file on its own
about a second after the save, or run **Project Spaces: Reload
configuration**. The new project appears with an empty tab set.

### Renaming a project

Change `name`, keep `id`. Tabs are kept.

### Reorganizing projects

Reorder the array. Only the sidebar order changes.

### Removing projects

Delete the entry. Its saved tabs are kept as **orphaned** state (if it was the
visible project, it stays visible until you switch away). Add the same `id`
back later and its tabs return. To forget orphaned state for good, run
**Project Spaces: Prune orphaned state** (asks for confirmation; never touches
notes).

### If the file is broken

Invalid JSON, a wrong `version`, duplicate ids, or a missing file never delete
anything. You get a notice, the sidebar shows a small error line, and the
plugin keeps using the last valid configuration until you fix the file.

## Commands

All are in the command palette under **Project Spaces:**. None has a default
hotkey; assign your own in Settings → Hotkeys.

| Command | What it does |
| --- | --- |
| Switch project... | Fuzzy picker of configured projects. |
| Next project / Previous project | Cycle in config order. |
| Open configuration | Opens `ProjectSpaces.config.json` (creates an empty one if missing). |
| Reload configuration | Re-reads the config now. |
| Prune orphaned state | Forgets saved tabs of ids no longer in the config. |
| Show project list | Reveals the sidebar list (also the ribbon's layers icon). |

The sidebar header has two small buttons: open configuration and reload.

## Local development

Requirements: Node 20+ and npm.

```sh
npm install
npm run verify          # typecheck + build + security check + unit tests
npm run install:local   # build if stale, then copy into your vault
```

`install:local` reads the vault from `dev.local.json` (gitignored, never
committed):

```json
{ "vaultPath": "/absolute/path/to/your/vault" }
```

It copies `main.js`, `manifest.json` and `styles.css` to
`<vault>/.obsidian/plugins/project-spaces/`. An existing copy, including
`data.json`, is backed up first to `.install-backups/` in this repo (outside
the vault). `data.json` itself is never overwritten.

For a throwaway test vault with synthetic notes, a Canvas and a PDF:

```sh
npm run sandbox         # creates .sandbox-vault/ (gitignored) and installs into it
```

Open `.sandbox-vault` as a vault in Obsidian to try changes without touching
your real tabs.

## Reloading after code changes

The loop is: edit `src/`, `npm run verify`, `npm run install:local`, reload the
plugin. Either way of reloading works:

1. Settings → Community plugins → turn **Project Spaces** off, then on.
2. From a terminal, with Obsidian's command line enabled (Settings → General →
   Command line interface):
   ```sh
   /Applications/Obsidian.app/Contents/MacOS/obsidian-cli plugin:reload id=project-spaces
   ```
   Add `vault=<vault name>` if more than one vault window is open.

Reloading or disabling the plugin closes the tabs of hidden projects (their
tabs are saved and come back when you visit them) and leaves the visible
project's tabs as a normal workspace.

## Reloading after config changes

No rebuild and no plugin reload. Saving `ProjectSpaces.config.json` triggers an
automatic reload; **Project Spaces: Reload configuration** (or the sidebar's
reload button) does it on demand.

## Data storage

| File | Holds | Who edits it |
| --- | --- | --- |
| `<Vault>/ProjectSpaces.config.json` | The project list: ids, names, order. | You. |
| `<Vault>/.obsidian/plugins/project-spaces/data.json` | Runtime state: active project, each project's tabs (Obsidian view state plus cursor/scroll where available), orphaned projects, a copy of the last valid config, `stateVersion`. | The plugin. |

`data.json` contains vault-relative file paths and view state only: no
credentials, tokens or note contents.

If you sync the vault with Obsidian Sync, a `.json` file at the vault root only
syncs when "Other file types" is enabled in Sync's settings.

## Security

- No network access: no `fetch`, `requestUrl`, XHR, WebSocket, external URLs or
  telemetry.
- No OAuth, no credentials, no tokens.
- No subprocess execution, no `eval` or `new Function`, no Node or Electron
  modules.
- Reads and writes only its config file and its own `data.json` through
  Obsidian's vault API.
- Zero runtime dependencies.

`npm run security:check` (part of `npm run verify`, and run again by
`install:local`) scans `src/`, the built `main.js` and `styles.css` for these
primitives, by line pattern and by syntax tree (so aliases such as
`const f = fetch` and computed access such as `window[name]` are caught), and
fails if any appear. It first checks itself against a list of known-bad
snippets.

## Upstream

Forked from [ngchenghow/obsidian-project-view](https://github.com/ngchenghow/obsidian-project-view)
at commit `b3030372606ddd002f5d27a93dbf74ad5eeab790` (tagged
`upstream-base-b303037` in this repo). Project View's switch serialization and
hidden-group approach were kept; Google Drive, recent edits, pins, folder
membership, merge tools and more were removed. Details, and how to review future
upstream changes, are in [docs/UPSTREAM.md](docs/UPSTREAM.md). The design is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

MIT license, original copyright retained (see [LICENSE](LICENSE)).
