// Pure runtime-state model (what lives in the plugin's data.json). No Obsidian
// imports so it can be unit-tested in plain Node.
//
// Invariants (see AGENTS.md):
// - State is keyed by the stable project id from the config, never by name.
// - A project that disappears from the config becomes ORPHANED; its tabs are
//   kept until the user explicitly prunes them.
// - Nothing in here touches the config file; config and state are separate.

import { isValidProjectId, ProjectConfig, sanitizeCachedConfig } from "./config";

/** Bump when the persisted shape changes, and add a migration below. */
export const STATE_VERSION = 1;

/** A serializable subset of Obsidian's ViewState (no `active`, no `group`). */
export interface SavedViewState {
  type: string;
  state?: Record<string, unknown>;
  pinned?: boolean;
}

export interface SavedTab {
  /**
   * Obsidian's leaf id when the tab was captured. Leaf ids survive restarts in
   * workspace.json, so at startup they tell us which project a restored leaf
   * belongs to.
   */
  leafId?: string;
  view: SavedViewState;
  /** Ephemeral view state (cursor/scroll for Markdown), best effort. */
  eState?: Record<string, unknown>;
}

export interface SpaceState {
  /** Display name last seen in the config (used to label orphaned spaces). */
  name: string;
  /** Tabs in layout order. Splits are flattened into one list. */
  tabs: SavedTab[];
  /** Index into `tabs` of the focused tab, or -1. */
  activeTab: number;
  /** Epoch ms when the id disappeared from the config; null while configured. */
  orphanedAt: number | null;
}

export interface RuntimeState {
  stateVersion: typeof STATE_VERSION;
  activeProjectId: string | null;
  /** Keyed by project id. Includes orphaned spaces. */
  spaces: Record<string, SpaceState>;
  /** Cache of the last config that parsed cleanly (fallback for bad configs). */
  lastGoodConfig: ProjectConfig | null;
}

export type LoadStatus =
  /** No data.json yet. */
  | "fresh"
  /** Current version, sanitized. */
  | "ok"
  /** Older version, migrated forward. */
  | "migrated"
  /** Unrecognized content; caller should back it up before overwriting. */
  | "unrecognized"
  /** Written by a newer build; caller must NOT overwrite it. */
  | "newer";

export interface LoadResult {
  state: RuntimeState;
  status: LoadStatus;
}

/**
 * Forward migrations keyed by the version they upgrade FROM. Each takes the raw
 * object at version N and returns the raw object at version N + 1. Example for
 * a future v2:
 *
 *   1: (raw) => ({ ...raw, stateVersion: 2, newField: defaultValue }),
 */
export type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;
export const MIGRATIONS: Record<number, Migration> = {};

export function createEmptyState(): RuntimeState {
  return {
    stateVersion: STATE_VERSION,
    activeProjectId: null,
    // Null prototype: a valid id such as "constructor" or "toString" must not
    // resolve to an inherited Object.prototype member.
    spaces: Object.create(null) as Record<string, SpaceState>,
    lastGoodConfig: null,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeTab(raw: unknown): SavedTab | null {
  if (!isPlainObject(raw) || !isPlainObject(raw.view)) return null;
  const type = raw.view.type;
  if (typeof type !== "string" || type === "") return null;
  const view: SavedViewState = { type };
  if (isPlainObject(raw.view.state)) view.state = raw.view.state;
  if (raw.view.pinned === true) view.pinned = true;
  const tab: SavedTab = { view };
  if (typeof raw.leafId === "string" && raw.leafId !== "") tab.leafId = raw.leafId;
  if (isPlainObject(raw.eState)) tab.eState = raw.eState;
  return tab;
}

function sanitizeSpace(raw: unknown, id: string): SpaceState | null {
  if (!isPlainObject(raw)) return null;
  const tabs = Array.isArray(raw.tabs)
    ? raw.tabs.map(sanitizeTab).filter((t): t is SavedTab => t !== null)
    : [];
  const activeTab =
    typeof raw.activeTab === "number" &&
    Number.isInteger(raw.activeTab) &&
    raw.activeTab >= 0 &&
    raw.activeTab < tabs.length
      ? raw.activeTab
      : tabs.length > 0
        ? 0
        : -1;
  return {
    name: typeof raw.name === "string" && raw.name !== "" ? raw.name : id,
    tabs,
    activeTab,
    orphanedAt: typeof raw.orphanedAt === "number" ? raw.orphanedAt : null,
  };
}

function sanitizeCurrent(raw: Record<string, unknown>): RuntimeState {
  const state = createEmptyState();
  if (isPlainObject(raw.spaces)) {
    for (const [id, value] of Object.entries(raw.spaces)) {
      // Invalid ids are dropped: they can't come from a valid config, and
      // skipping them keeps `__proto__`-style keys out of the object.
      if (!isValidProjectId(id)) continue;
      const space = sanitizeSpace(value, id);
      if (space) state.spaces[id] = space;
    }
  }
  state.activeProjectId = isValidProjectId(raw.activeProjectId)
    ? raw.activeProjectId
    : null;
  state.lastGoodConfig = sanitizeCachedConfig(raw.lastGoodConfig);
  return state;
}

/**
 * Turn whatever `loadData()` returned into a current-version state. Never
 * throws and never silently discards a newer format (status "newer").
 */
export function migrateState(
  raw: unknown,
  migrations: Record<number, Migration> = MIGRATIONS
): LoadResult {
  if (raw === null || raw === undefined) {
    return { state: createEmptyState(), status: "fresh" };
  }
  if (!isPlainObject(raw) || typeof raw.stateVersion !== "number") {
    return { state: createEmptyState(), status: "unrecognized" };
  }
  let version = raw.stateVersion;
  if (version > STATE_VERSION) {
    return { state: createEmptyState(), status: "newer" };
  }
  let current: Record<string, unknown> = raw;
  let migrated = false;
  while (version < STATE_VERSION) {
    const step = migrations[version];
    if (!step) return { state: createEmptyState(), status: "unrecognized" };
    current = step(current);
    version++;
    migrated = true;
  }
  return { state: sanitizeCurrent(current), status: migrated ? "migrated" : "ok" };
}

export interface ReconcileResult {
  added: string[];
  orphaned: string[];
  recovered: string[];
}

/**
 * Align runtime state with a freshly loaded config (mutates `state`):
 * - new ids get an EMPTY space (never a copy of the current project),
 * - existing ids keep their tabs; only the display name is refreshed,
 * - ids missing from the config are marked orphaned (tabs kept),
 * - orphaned ids that reappear are recovered with their tabs.
 * Order changes need no state change: the sidebar follows the config array.
 */
export function reconcileWithConfig(
  state: RuntimeState,
  config: ProjectConfig,
  now: number
): ReconcileResult {
  const result: ReconcileResult = { added: [], orphaned: [], recovered: [] };
  const configured = new Set<string>();
  for (const project of config.projects) {
    configured.add(project.id);
    const space = state.spaces[project.id];
    if (!space) {
      state.spaces[project.id] = {
        name: project.name,
        tabs: [],
        activeTab: -1,
        orphanedAt: null,
      };
      result.added.push(project.id);
    } else {
      if (space.orphanedAt !== null) result.recovered.push(project.id);
      space.name = project.name;
      space.orphanedAt = null;
    }
  }
  for (const [id, space] of Object.entries(state.spaces)) {
    if (!configured.has(id) && space.orphanedAt === null) {
      space.orphanedAt = now;
      result.orphaned.push(id);
    }
  }
  state.lastGoodConfig = config;
  return result;
}

/** Ids with saved state that are not in the config. */
export function orphanedIds(state: RuntimeState, config: ProjectConfig): string[] {
  const configured = new Set(config.projects.map((p) => p.id));
  return Object.keys(state.spaces).filter((id) => !configured.has(id));
}

/**
 * Explicit, user-confirmed deletion of orphaned spaces. Only ids in
 * `confirmed` (what the user was shown) are deleted, and only if they are
 * still orphaned now. `keepId` (the active project) is never pruned because
 * its tabs are on screen.
 */
export function pruneOrphans(
  state: RuntimeState,
  config: ProjectConfig,
  confirmed: readonly string[],
  keepId: string | null
): string[] {
  const allowed = new Set(confirmed);
  const pruned: string[] = [];
  for (const id of orphanedIds(state, config)) {
    if (id === keepId || !allowed.has(id)) continue;
    delete state.spaces[id];
    pruned.push(id);
  }
  return pruned;
}

/** The vault path a tab shows, if it is a file-backed view. */
export function tabFile(tab: SavedTab): string | null {
  const file = tab.view.state?.file;
  return typeof file === "string" && file !== "" ? file : null;
}

/**
 * Whether two tabs show the same thing: same view type, and the same file for
 * file-backed views (else the same view state). A Markdown tab and a plugin
 * view of the same file are different tabs.
 */
export function sameView(a: SavedTab, b: SavedTab): boolean {
  if (a.view.type !== b.view.type) return false;
  const fileA = tabFile(a);
  if (fileA !== null) return fileA === tabFile(b);
  return JSON.stringify(a.view.state) === JSON.stringify(b.view.state);
}

/**
 * Merge a fresh capture with the previous saved list. Saved tabs that are not
 * open because they could not be restored (file missing, e.g. not yet synced;
 * or the view failed to load) are kept instead of silently dropped, until they
 * are restored or explicitly removed. `keep` decides which previous tabs are
 * such tabs. Intentional file deletions are handled by `removePath`.
 */
export function mergeCapture(
  previous: SavedTab[],
  live: SavedTab[],
  liveActive: number,
  keep: (tab: SavedTab) => boolean
): { tabs: SavedTab[]; activeTab: number } {
  const kept = previous.filter(
    (tab) => keep(tab) && !live.some((open) => sameView(open, tab))
  );
  const tabs = [...live, ...kept];
  const activeTab =
    liveActive >= 0 && liveActive < live.length ? liveActive : tabs.length > 0 ? 0 : -1;
  return { tabs, activeTab };
}

function isAtOrUnder(file: string, path: string): boolean {
  return file === path || file.startsWith(path + "/");
}

/** Rewrite saved tab paths after a vault rename (file or folder). */
export function remapPath(state: RuntimeState, oldPath: string, newPath: string): number {
  let changed = 0;
  for (const space of Object.values(state.spaces)) {
    for (const tab of space.tabs) {
      const file = tabFile(tab);
      if (file === null || !isAtOrUnder(file, oldPath)) continue;
      tab.view.state = { ...tab.view.state, file: newPath + file.slice(oldPath.length) };
      changed++;
    }
  }
  return changed;
}

/** Drop saved tabs for a file or folder the user deleted from the vault. */
export function removePath(state: RuntimeState, path: string): number {
  let removed = 0;
  for (const space of Object.values(state.spaces)) {
    const activeTab = space.tabs[space.activeTab];
    const next = space.tabs.filter((tab) => {
      const file = tabFile(tab);
      return file === null || !isAtOrUnder(file, path);
    });
    if (next.length === space.tabs.length) continue;
    removed += space.tabs.length - next.length;
    space.tabs = next;
    const idx = activeTab ? next.indexOf(activeTab) : -1;
    space.activeTab = idx >= 0 ? idx : next.length > 0 ? 0 : -1;
  }
  return removed;
}

/**
 * Which project should be active at startup: the persisted one if it still
 * has a space, else the first configured project, else none.
 */
export function initialActiveProject(
  state: RuntimeState,
  config: ProjectConfig
): string | null {
  const id = state.activeProjectId;
  if (id !== null && state.spaces[id]) return id;
  return config.projects[0]?.id ?? null;
}
