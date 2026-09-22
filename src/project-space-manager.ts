// Live workspace side of Project Spaces: which main-area leaves belong to which
// project, showing/hiding them, building a project's tabs from saved state,
// and capturing a project's tabs back into state.
//
// READ docs/ARCHITECTURE.md BEFORE "SIMPLIFYING" ANYTHING HERE. The switch
// queue, generation counter, pending counter and delayed guard release come
// from upstream Project View and exist because rapid clicks otherwise produce
// duplicate panes, half-built projects and state overwritten with the wrong
// tabs. `complete`, `unrestored`, `materialized` and the reconcile step close
// the remaining ways a project's saved tabs could be lost or duplicated.

import { App, WorkspaceItem, WorkspaceLeaf, WorkspaceParent } from "obsidian";
import {
  asCreateLeafParent,
  childrenOf,
  containerElOf,
  leafIdOf,
} from "./obsidian-internals";
import {
  mergeCapture,
  RuntimeState,
  SavedTab,
  SavedViewState,
  sameView,
  tabFile,
} from "./state";

/** Applied to tab groups / splits that contain no leaf of the active project. */
const HIDDEN_CLASS = "ps-hidden";
/** Applied to the root split while a project is being built (no flashing). */
const ROOT_BUILDING_CLASS = "ps-root-building";
/** Upstream's delay before releasing the switching guard after a switch. */
const SETTLE_MS = 150;
/** Upstream's startup waits: Obsidian keeps restoring leaves after layout-ready. */
const STARTUP_INITIAL_WAIT_MS = 300;
const STARTUP_LATE_WAIT_MS = 500;

export interface ManagerHost {
  app: App;
  state(): RuntimeState;
  /** Debounced write of data.json. */
  requestSave(): void;
  /** Something the sidebar shows changed. */
  changed(): void;
  /** Project id to activate when none is active (first configured), or null. */
  defaultProjectId(): string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** JSON round-trip so saved state never holds live objects or cycles. */
function plainCopy<T>(value: T): T | undefined {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return undefined;
  }
}

/** The saved form of a live leaf's view (no cursor/scroll). */
function viewOf(leaf: WorkspaceLeaf): SavedViewState {
  const vs = leaf.getViewState();
  const view: SavedViewState = { type: vs.type };
  // getViewState() works for deferred (not yet loaded) background tabs too.
  const state = vs.state ? plainCopy(vs.state) : undefined;
  if (state) view.state = state;
  if (vs.pinned) view.pinned = true;
  return view;
}

export class ProjectSpaceManager {
  /** Owner project id of each main-area leaf. Leaves not in here are "unowned". */
  private readonly owners = new WeakMap<WorkspaceLeaf, string>();
  /** Last focused leaf per project, used to restore the active tab on return. */
  private readonly lastFocused = new Map<string, WorkspaceLeaf>();
  /**
   * Projects whose live leaves are their real, complete tab list: fully built,
   * or reconciled against saved state, and shown. A project leaves this set
   * when a build for it starts and only re-enters after it finished and was
   * shown. Nothing is ever snapshotted from a project outside this set, so an
   * aborted or partial build can never overwrite saved tabs.
   */
  private readonly complete = new Set<string>();
  /**
   * Saved tabs that could not be opened (file missing, e.g. not synced yet, or
   * the view threw). They are not live, so captures would drop them; they are
   * carried along until a later build or reconcile opens them, the file is
   * deleted, or the project is pruned. Object identity survives captures
   * (mergeCapture keeps the same objects). Not persisted: after a restart the
   * reconcile step re-derives it.
   */
  private readonly unrestored = new WeakMap<SavedTab, "missing-file" | "failed-view">();
  /**
   * Saved leaf ids that a build is opening or has opened as new leaves. A leaf
   * Obsidian restores later with one of these ids (late layout restoration at
   * startup) is a duplicate and is closed. Claimed before the build's first
   * await; released if the build aborts.
   */
  private readonly materialized = new Set<string>();

  // ---- Switch serialization (ported from upstream showPane) ----
  // Every switch runs on this promise chain, one at a time. Concurrent runs
  // would each create a tab group and leave two projects side by side.
  private switchQueue: Promise<void> = Promise.resolve();
  // Bumped synchronously the moment a switch is requested (and on shutdown).
  // In-flight work compares its captured value after every await and stops as
  // soon as a newer request exists, so a new click never waits for old work.
  private switchGen = 0;
  // Switches queued or running. The `switching` guard is only released when
  // this drains to zero, otherwise a stale timer from an earlier switch would
  // re-enable layout handling in the middle of the next one.
  private pendingSwitches = 0;
  // True while a switch is in progress (upstream `isActivating`): layout
  // events are not treated as user edits and nothing is captured.
  private switching = false;
  // True until the startup routine finishes (upstream `starting`): Obsidian
  // may still be restoring the layout, so never capture during it.
  private starting = true;
  // True once the app is quitting (upstream `unloading`).
  private quitting = false;
  // True after dispose(): every entry point is a no-op, and async work that
  // resumes after unload does not touch the workspace or state.
  private disposed = false;
  private settleTimer: number | null = null;
  // The project whose tabs were last completely shown.
  private shownId: string | null = null;
  // Latest requested project, so the sidebar highlights a click immediately.
  private requestedId: string | null = null;

  constructor(private readonly host: ManagerHost) {}

  private get ws() {
    return this.host.app.workspace;
  }

  /** Quit or unload in progress: stop at the next checkpoint. */
  private get stopped(): boolean {
    return this.quitting || this.disposed;
  }

  get activeId(): string | null {
    return this.host.state().activeProjectId;
  }

  /** What the sidebar should highlight: the pending request, else the active project. */
  get displayedId(): string | null {
    return this.requestedId ?? this.activeId;
  }

  // ------------------------------------------------------------------
  // Leaf bookkeeping
  // ------------------------------------------------------------------

  /** Leaves in the main area (not sidebars, not popout windows), layout order. */
  mainLeaves(): WorkspaceLeaf[] {
    const root = this.ws.rootSplit;
    const out: WorkspaceLeaf[] = [];
    // Braced callback on purpose: iterateRootLeaves stops as soon as the
    // callback returns a truthy value, and `out.push()` returns the new length.
    // (Upstream had `iterateRootLeaves((l) => arr.push(l))`, which only ever
    // collected the first leaf.)
    this.ws.iterateRootLeaves((leaf) => {
      if (leaf.getRoot() === root) out.push(leaf);
    });
    return out;
  }

  private leavesOf(id: string): WorkspaceLeaf[] {
    return this.mainLeaves().filter((leaf) => this.owners.get(leaf) === id);
  }

  /** Leaves of the project currently on screen. */
  visibleLeaves(): WorkspaceLeaf[] {
    return this.shownId === null ? [] : this.leavesOf(this.shownId);
  }

  private static isEmptyLeaf(leaf: WorkspaceLeaf): boolean {
    return leaf.getViewState().type === "empty";
  }

  private fileExists = (path: string): boolean =>
    this.host.app.vault.getAbstractFileByPath(path) !== null;

  private canOpen(tab: SavedTab): boolean {
    const file = tabFile(tab);
    return file === null || this.fileExists(file);
  }

  /** Saved tabs to carry along although they are not open (see `unrestored`). */
  private keepUnopened = (tab: SavedTab): boolean =>
    this.unrestored.has(tab) || !this.canOpen(tab);

  /** A tab whose file was missing has arrived since (retry on next switch). */
  private hasArrivedFiles(id: string): boolean {
    return (this.host.state().spaces[id]?.tabs ?? []).some(
      (tab) => this.unrestored.get(tab) === "missing-file" && this.canOpen(tab)
    );
  }

  /** Tab count for the sidebar: live tabs if the project is live, else saved. */
  tabCount(id: string): number {
    const live = this.leavesOf(id);
    if (live.length > 0) {
      return live.filter((leaf) => !ProjectSpaceManager.isEmptyLeaf(leaf)).length;
    }
    return this.host.state().spaces[id]?.tabs.filter((t) => this.canOpen(t)).length ?? 0;
  }

  /**
   * A project needs building when it has no live leaves, or only placeholder
   * "New tab" leaves while it has saved tabs that can be opened. (A project
   * with some live content that is not `complete` is reconciled instead.)
   */
  private needsBuild(id: string): boolean {
    const live = this.leavesOf(id);
    if (live.length === 0) return true;
    if (live.some((leaf) => !ProjectSpaceManager.isEmptyLeaf(leaf))) return false;
    return (this.host.state().spaces[id]?.tabs ?? []).some((t) => this.canOpen(t));
  }

  /** Map saved leaf id -> project id, for routing leaves Obsidian restored. */
  private savedLeafOwners(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [id, space] of Object.entries(this.host.state().spaces)) {
      for (const tab of space.tabs) if (tab.leafId) map.set(tab.leafId, id);
    }
    return map;
  }

  /**
   * Give every unowned main-area leaf an owner, and repair mixed tab groups.
   * - A leaf whose Obsidian id a build claimed (`materialized`) is a
   *   late-restored duplicate (startup): closed.
   * - A leaf whose Obsidian id is a saved tab of ANOTHER project was restored
   *   from workspace.json (e.g. after a crash). That project's tabs are in
   *   data.json and it will be rebuilt lazily, so the stray copy is closed.
   * - A new tab inside a tab group joins the project owning that group's other
   *   tabs. layout-change (which triggers adoption) can arrive after the user
   *   already switched projects, so "the active project" is not reliable for
   *   a tab opened a moment ago.
   * - Everything else (new splits, first-run tabs) joins the active project.
   *   switchImpl adopts before leaving a project, so leaves created while it
   *   was visible are attributed to it.
   * - A tab group holding leaves of several projects, one of them the active
   *   project, only arises from the user moving a tab into a visible group
   *   (e.g. docking a popout tab): the whole group joins the active project,
   *   and the moved tabs are removed from their former project's saved list
   *   so they are not resurrected there.
   */
  private adoptUnownedLeaves(): void {
    const active = this.activeId;
    if (active === null) return;
    let savedOwners: Map<string, string> | null = null;
    const strays: WorkspaceLeaf[] = [];
    const leaves = this.mainLeaves();
    for (const leaf of leaves) {
      if (this.owners.has(leaf)) continue;
      const leafId = leafIdOf(leaf);
      if (leafId && this.materialized.has(leafId)) {
        strays.push(leaf);
        continue;
      }
      savedOwners ??= this.savedLeafOwners();
      const savedOwner = leafId ? savedOwners.get(leafId) : undefined;
      if (savedOwner !== undefined && savedOwner !== active) {
        strays.push(leaf);
        continue;
      }
      this.owners.set(leaf, savedOwner ?? this.groupOwner(leaf) ?? active);
    }
    for (const leaf of strays) leaf.detach();

    const groups = new Set<WorkspaceParent>();
    for (const leaf of leaves) if (!strays.includes(leaf)) groups.add(leaf.parent as WorkspaceParent);
    for (const group of groups) {
      const members = childrenOf(group).filter(
        (item): item is WorkspaceLeaf => item instanceof WorkspaceLeaf
      );
      const groupOwners = new Set(members.map((leaf) => this.owners.get(leaf)));
      if (groupOwners.size < 2 || !groupOwners.has(active)) continue;
      for (const leaf of members) {
        const former = this.owners.get(leaf);
        if (former !== undefined && former !== active) this.forgetMovedLeaf(former, leaf);
        this.owners.set(leaf, active);
      }
    }
  }

  /** A leaf moved from project `former` into another project. */
  private forgetMovedLeaf(former: string, leaf: WorkspaceLeaf): void {
    const space = this.host.state().spaces[former];
    const leafId = leafIdOf(leaf);
    if (!space || !leafId) return;
    const kept = space.tabs.filter((tab) => tab.leafId !== leafId);
    if (kept.length === space.tabs.length) return;
    const activeTab = space.tabs[space.activeTab];
    space.tabs = kept;
    const index = activeTab ? kept.indexOf(activeTab) : -1;
    space.activeTab = index >= 0 ? index : kept.length > 0 ? 0 : -1;
    this.host.requestSave();
  }

  /** Owner of the other tabs in this leaf's tab group, if any. */
  private groupOwner(leaf: WorkspaceLeaf): string | undefined {
    for (const sibling of childrenOf(leaf.parent as WorkspaceParent)) {
      if (sibling === leaf || !(sibling instanceof WorkspaceLeaf)) continue;
      const owner = this.owners.get(sibling);
      if (owner !== undefined) return owner;
    }
    return undefined;
  }

  // ------------------------------------------------------------------
  // Visibility
  // ------------------------------------------------------------------

  /**
   * Hide every tab group / split in the main area that contains no leaf of the
   * active project; show the rest. Computed over the whole tree, so a project
   * may own several groups and splits, and a project's group may even sit
   * inside a split created by another project: each item is shown iff it
   * contains at least one visible leaf.
   */
  applyVisibility(): void {
    const active = this.activeId;
    const visit = (item: WorkspaceItem, isRoot: boolean): boolean => {
      if (item instanceof WorkspaceLeaf) {
        const owner = this.owners.get(item);
        // Unowned leaves stay visible; hiding a leaf we don't know about could
        // hide the user's only tab. They are adopted on the next layout change.
        return active === null || owner === undefined || owner === active;
      }
      let visible = false;
      // No short-circuit: every child must get its class updated.
      for (const child of childrenOf(item)) {
        if (visit(child, false)) visible = true;
      }
      if (!isRoot) containerElOf(item)?.toggleClass(HIDDEN_CLASS, !visible);
      return visible;
    };
    visit(this.ws.rootSplit, true);
  }

  private clearVisibility(): void {
    const visit = (item: WorkspaceItem): void => {
      if (item instanceof WorkspaceLeaf) return;
      containerElOf(item)?.removeClass(HIDDEN_CLASS);
      for (const child of childrenOf(item)) visit(child);
    };
    visit(this.ws.rootSplit);
    containerElOf(this.ws.rootSplit)?.removeClass(ROOT_BUILDING_CLASS);
  }

  /** The leaf to focus when showing a project. */
  private focusTarget(id: string): WorkspaceLeaf | null {
    const leaves = this.leavesOf(id);
    const remembered = this.lastFocused.get(id);
    if (remembered && leaves.includes(remembered)) return remembered;
    return leaves[0] ?? null;
  }

  private focusProject(id: string): void {
    const leaf = this.focusTarget(id);
    if (!leaf) return;
    this.lastFocused.set(id, leaf);
    this.ws.setActiveLeaf(leaf, { focus: true });
  }

  // ------------------------------------------------------------------
  // Capture (live leaves -> saved state)
  // ------------------------------------------------------------------

  private toSavedTab(
    leaf: WorkspaceLeaf,
    previous: Map<string, SavedTab>,
    visible: boolean
  ): SavedTab {
    const leafId = leafIdOf(leaf);
    const tab: SavedTab = { view: viewOf(leaf) };
    if (leafId) tab.leafId = leafId;
    // Ephemeral state (cursor, scroll) is only trustworthy for a rendered tab
    // of the visible project: a hidden editor reports scroll 0 and a deferred
    // tab was never rendered. Otherwise keep what was saved for this leaf.
    const eState: unknown =
      visible && !leaf.isDeferred
        ? plainCopy(leaf.getEphemeralState() as unknown)
        : leafId
          ? previous.get(leafId)?.eState
          : undefined;
    if (eState && typeof eState === "object" && !Array.isArray(eState)) {
      tab.eState = eState as Record<string, unknown>;
    }
    return tab;
  }

  /**
   * Snapshot the shown project's live tabs into its saved state. Only for the
   * project last completely shown. Cursor/scroll are read only while it is
   * also the active (visible) project: during an interrupted switch it may
   * already be hidden, and a hidden editor reports scroll 0. If the shown
   * project has no leaves at all, the user closed its last tab: saved as "no
   * open tabs" (layout-change may not have reported it yet when a switch
   * starts).
   */
  capture(id: string | null): void {
    if (this.disposed || id === null || id !== this.shownId || this.starting) return;
    const visible = id === this.activeId;
    if (visible) {
      // A newly opened tab gets focus before layout-change assigns it an
      // owner, so active-leaf-change can miss it; ask Obsidian directly.
      const recent = this.ws.getMostRecentLeaf(this.ws.rootSplit);
      if (recent && this.owners.get(recent) === id) this.lastFocused.set(id, recent);
    }
    this.snapshot(id, visible, true);
  }

  /**
   * Refresh the view state (never cursor/scroll) of hidden, complete projects
   * from their live leaves. A tab can still be loading when its project is
   * hidden (captured as a Markdown tab with no file); this corrects it.
   */
  refreshHidden(): void {
    if (this.disposed || this.starting) return;
    const hidden = new Set<string>();
    for (const leaf of this.mainLeaves()) {
      const owner = this.owners.get(leaf);
      if (owner !== undefined && owner !== this.shownId && owner !== this.activeId) hidden.add(owner);
    }
    for (const id of hidden) this.snapshot(id, false, false);
  }

  private snapshot(id: string, visible: boolean, shown: boolean): void {
    if (!this.complete.has(id)) return;
    const space = this.host.state().spaces[id];
    if (!space) return;
    const leaves = this.leavesOf(id);
    // Not shown with no leaves = its leaves were closed by us (shutdown,
    // prune): saved state is authoritative. Shown with none = user closed all.
    if (leaves.length === 0 && !shown) return;
    const previous = new Map<string, SavedTab>();
    for (const tab of space.tabs) if (tab.leafId) previous.set(tab.leafId, tab);
    const focused = this.lastFocused.get(id);
    const live: SavedTab[] = [];
    let liveActive = -1;
    for (const leaf of leaves) {
      if (ProjectSpaceManager.isEmptyLeaf(leaf)) continue;
      if (leaf === focused) liveActive = live.length;
      live.push(this.toSavedTab(leaf, previous, visible));
    }
    const merged = mergeCapture(space.tabs, live, liveActive, this.keepUnopened);
    space.tabs = merged.tabs;
    space.activeTab = merged.activeTab;
    this.host.requestSave();
    this.host.changed();
  }

  // ------------------------------------------------------------------
  // Build and reconcile (saved state -> live leaves)
  // ------------------------------------------------------------------

  /** A leaf in a brand-new tab group beside the current layout. */
  private newGroupLeaf(): WorkspaceLeaf {
    // Any main-area leaf works as the anchor: visibility is computed per item,
    // so the new group shows/hides correctly even if it ends up nested in a
    // split that another project created.
    const anchor = this.ws.getMostRecentLeaf(this.ws.rootSplit) ?? this.mainLeaves()[0];
    if (!anchor) return this.ws.getLeaf("tab");
    return this.ws.createLeafBySplit(anchor, "vertical");
  }

  private newTabAfter(leaf: WorkspaceLeaf): WorkspaceLeaf {
    const group = leaf.parent as WorkspaceParent;
    const index = childrenOf(group).indexOf(leaf) + 1;
    return this.ws.createLeafInParent(asCreateLeafParent(group), index);
  }

  /** Whether in-flight work for generation `gen` must stop now. */
  private superseded(gen: number): boolean {
    return gen !== this.switchGen || this.stopped;
  }

  /**
   * Open `tabs` for project `id`, starting in `first` (a free leaf) and then
   * as new tabs after `after`. Returns the leaves created (for rollback) and
   * the opened tabs, or null if superseded (caller rolls back).
   */
  private async openTabs(
    id: string,
    tabs: SavedTab[],
    first: WorkspaceLeaf | null,
    after: WorkspaceLeaf,
    gen: number,
    created: WorkspaceLeaf[]
  ): Promise<Map<SavedTab, WorkspaceLeaf> | null> {
    const opened = new Map<SavedTab, WorkspaceLeaf>();
    let last = after;
    let slot = first;
    for (const tab of tabs) {
      if (this.superseded(gen)) return null;
      if (!this.canOpen(tab)) {
        // File missing (e.g. not synced yet): keep the entry for later.
        this.unrestored.set(tab, "missing-file");
        continue;
      }
      const leaf: WorkspaceLeaf = slot ?? this.newTabAfter(last);
      if (leaf !== slot) created.push(leaf);
      this.owners.set(leaf, id);
      slot = null;
      try {
        await leaf.setViewState({ ...tab.view, active: false }, tab.eState);
        opened.set(tab, leaf);
        this.unrestored.delete(tab);
        last = leaf;
      } catch (e) {
        // One bad view must not break the project or lose its entry: keep it
        // (see `unrestored`) and reuse the leaf for the next tab. (Unknown view
        // types do NOT throw; Obsidian keeps their state, so a disabled
        // plugin's views survive.)
        console.warn(`[Project Spaces] could not restore a "${tab.view.type}" tab`, e);
        this.unrestored.set(tab, "failed-view");
        slot = leaf;
      }
    }
    if (this.superseded(gen)) return null;
    if (slot && slot !== first) slot.detach(); // trailing failed leaf, never reused
    return opened;
  }

  /**
   * Build a project with no live content from its saved tabs. Returns false
   * if superseded; then everything this build created is closed again (unless
   * the plugin was unloaded meanwhile: then nothing is touched).
   */
  private async build(id: string, gen: number): Promise<boolean> {
    this.complete.delete(id);
    const space = this.host.state().spaces[id];
    const saved = space ? [...space.tabs] : [];
    // Claim the saved leaf ids before the first await, so an original leaf
    // Obsidian restores meanwhile is recognized as a duplicate (see
    // `materialized`).
    const claimed = saved
      .map((tab) => (this.canOpen(tab) ? tab.leafId : undefined))
      .filter((leafId): leafId is string => leafId !== undefined && !this.materialized.has(leafId));
    for (const leafId of claimed) this.materialized.add(leafId);

    // Reuse a placeholder leaf the project already has; close any others.
    const existing = this.leavesOf(id);
    for (const extra of existing.slice(1)) extra.detach();
    const created: WorkspaceLeaf[] = [];
    let first = existing[0] ?? null;
    if (!first) {
      first = this.newGroupLeaf();
      created.push(first);
    }
    this.owners.set(first, id);

    const rollback = async (): Promise<false> => {
      for (const leafId of claimed) this.materialized.delete(leafId);
      if (this.disposed) return false; // never touch the workspace after unload
      for (const leaf of created) leaf.detach();
      // A reused placeholder goes back to empty. The project stays out of
      // `complete`, so nothing snapshots this partial state.
      if (first && !created.includes(first)) {
        try {
          await first.setViewState({ type: "empty" });
        } catch {
          // Leaf already closed.
        }
      }
      return false;
    };

    const opened = await this.openTabs(id, saved, first, first, gen, created);
    if (opened === null) return rollback();
    if (opened.size === 0) {
      // Nothing to show (no saved tabs, or none could be opened): one empty tab.
      await first.setViewState({ type: "empty" });
      if (this.superseded(gen)) return rollback();
    }
    const savedActive = space?.tabs[space.activeTab];
    const focus =
      (savedActive && opened.get(savedActive)) ?? opened.values().next().value ?? first;
    this.lastFocused.set(id, focus);
    return true;
  }

  /**
   * Make a project that already has live content (restored at startup, or
   * left partial by an interrupted build or unload) match its saved tabs:
   * saved tabs with no live counterpart (by Obsidian leaf id, else by the same
   * view) are opened; ones that can't be opened are kept as unrestored. This
   * is what makes adoption safe: a partial layout can never be captured over a
   * longer saved tab list. Live tabs not in the saved list are kept (new tabs).
   * Returns false if superseded (tabs already opened stay: they are real tabs
   * of this project, which is simply not `complete` yet).
   */
  private async reconcile(id: string, gen: number): Promise<boolean> {
    const space = this.host.state().spaces[id];
    const live = this.leavesOf(id).filter((leaf) => !ProjectSpaceManager.isEmptyLeaf(leaf));
    if (!space || live.length === 0) return true;
    const unmatched = new Set(live);
    const missing: SavedTab[] = [];
    for (const tab of space.tabs) {
      let match = [...unmatched].find((leaf) => tab.leafId !== undefined && leafIdOf(leaf) === tab.leafId);
      match ??= [...unmatched].find((leaf) => sameView({ view: viewOf(leaf) }, tab));
      if (match) unmatched.delete(match);
      else missing.push(tab);
    }
    if (missing.length === 0) return true;
    const after = live[live.length - 1];
    const opened = await this.openTabs(id, missing, null, after, gen, []);
    if (opened === null) return false;
    // Leftover placeholders ("New tab") are noise next to real tabs.
    for (const leaf of this.leavesOf(id)) if (ProjectSpaceManager.isEmptyLeaf(leaf)) leaf.detach();
    return true;
  }

  // ------------------------------------------------------------------
  // Switching
  // ------------------------------------------------------------------

  /** Queue a job on the switch chain (see field comments). */
  private enqueue(job: (gen: number) => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const gen = ++this.switchGen;
    this.pendingSwitches++;
    const run = this.switchQueue
      .catch(() => {})
      .then(() => job(gen))
      .finally(() => {
        this.pendingSwitches--;
        if (this.pendingSwitches === 0 && this.requestedId !== null) {
          this.requestedId = null;
          if (!this.disposed) this.host.changed();
        }
      });
    this.switchQueue = run;
    return run;
  }

  /** Resolves once queued work has finished (used before the final quit save). */
  whenIdle(): Promise<void> {
    return this.switchQueue.catch(() => {});
  }

  /** Show project `id`, keeping the one being left alive but hidden. */
  switchTo(id: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.requestedId = id;
    this.host.changed();
    return this.enqueue((gen) => this.switchImpl(id, gen));
  }

  private async switchImpl(targetId: string, gen: number): Promise<void> {
    // A newer request arrived while this one waited in the queue. It will do
    // the work; running this one would only build tabs to throw them away.
    if (this.superseded(gen)) return;
    const state = this.host.state();
    const rootEl = containerElOf(this.ws.rootSplit);
    try {
      if (!state.spaces[targetId]) return; // unknown id; `finally` still settles
      const leaving = this.activeId;
      const alreadyShown =
        leaving === targetId &&
        this.shownId === targetId &&
        this.complete.has(targetId) &&
        !this.needsBuild(targetId);
      if (!alreadyShown) {
        // Tabs opened just before this click may not have been adopted yet
        // (layout-change is asynchronous). Adopt them now, while the project
        // being left is still the active one, then snapshot it while visible.
        this.adoptUnownedLeaves();
        this.capture(leaving);

        this.switching = true;
        state.activeProjectId = targetId;
        this.host.changed();

        if (this.needsBuild(targetId)) {
          // Hide the main area while building so the new group never appears
          // next to the old project during the async tab opens.
          rootEl?.addClass(ROOT_BUILDING_CLASS);
          if (!(await this.build(targetId, gen))) return;
        } else if (!this.complete.has(targetId) || this.hasArrivedFiles(targetId)) {
          rootEl?.addClass(ROOT_BUILDING_CLASS);
          if (!(await this.reconcile(targetId, gen))) return;
        }
        if (this.superseded(gen)) return;
      }
      this.applyVisibility();
      this.focusProject(targetId);
      this.shownId = targetId;
      this.complete.add(targetId);
    } catch (e) {
      console.error("[Project Spaces] switch failed", e);
      // Never leave two projects visible; the target stays out of `complete`.
      if (!this.superseded(gen)) this.applyVisibility();
    } finally {
      // Every switch that is still the newest settles the UI and the guard,
      // whichever path it took (a superseded one leaves that to the newer).
      if (!this.superseded(gen)) {
        rootEl?.removeClass(ROOT_BUILDING_CLASS);
        this.host.requestSave();
        this.releaseSwitchingSoon();
      }
    }
  }

  /**
   * Release the switching guard after the layout settles, but only once no
   * further switch is queued (upstream behavior; see `pendingSwitches`).
   */
  private releaseSwitchingSoon(): void {
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      if (this.stopped || this.pendingSwitches !== 0) return;
      this.switching = false;
      this.capture(this.activeId);
      this.refreshHidden();
    }, SETTLE_MS);
  }

  // ------------------------------------------------------------------
  // Startup, idle activation, layout events
  // ------------------------------------------------------------------

  /**
   * Called once from onLayoutReady. Adopts the restored layout into the active
   * project (nothing is closed except restored copies of OTHER projects'
   * tabs) and reconciles it against saved state, or builds it from saved state
   * if nothing of it was restored.
   */
  start(): Promise<void> {
    return this.enqueue((gen) => this.startImpl(gen));
  }

  private async startImpl(gen: number): Promise<void> {
    const rootEl = containerElOf(this.ws.rootSplit);
    rootEl?.addClass(ROOT_BUILDING_CLASS);
    try {
      await sleep(STARTUP_INITIAL_WAIT_MS);
      if (this.stopped) return;
      const state = this.host.state();
      if (state.activeProjectId === null || !state.spaces[state.activeProjectId]) {
        state.activeProjectId = this.host.defaultProjectId();
      }
      const active = state.activeProjectId;
      if (active === null) return; // no projects configured: stay out of the way
      this.adoptUnownedLeaves();
      this.restoreEphemeralStates(active);
      // Keep whichever tab Obsidian restored as focused, if it is ours
      // (recorded before reconcile opens anything).
      const restoredFocus = this.ws.getMostRecentLeaf(this.ws.rootSplit);
      if (restoredFocus && this.owners.get(restoredFocus) === active) {
        this.lastFocused.set(active, restoredFocus);
      }
      if (this.needsBuild(active)) {
        if (!(await this.build(active, gen))) return;
      }
      await sleep(STARTUP_LATE_WAIT_MS);
      if (this.superseded(gen)) return;
      // Late-restored leaves: duplicates of what a build claimed are closed
      // (see `materialized`); anything else joins the active project.
      this.adoptUnownedLeaves();
      if (!(await this.reconcile(active, gen))) return;
      this.applyVisibility();
      this.focusProject(active);
      this.shownId = active;
      this.complete.add(active);
    } catch (e) {
      console.error("[Project Spaces] startup failed", e);
    } finally {
      this.starting = false;
      if (!this.superseded(gen)) rootEl?.removeClass(ROOT_BUILDING_CLASS);
      if (!this.disposed) this.host.changed();
    }
    this.capture(this.activeId);
  }

  /**
   * Obsidian's workspace.json does not keep cursor/scroll, so leaves it
   * restores at startup open at the top. Re-apply what we saved, matched by
   * leaf id. Works on deferred (background) leaves too: Obsidian applies it
   * when the tab is first shown.
   */
  private restoreEphemeralStates(id: string): void {
    const space = this.host.state().spaces[id];
    if (!space) return;
    const saved = new Map<string, Record<string, unknown>>();
    for (const tab of space.tabs) if (tab.leafId && tab.eState) saved.set(tab.leafId, tab.eState);
    for (const leaf of this.leavesOf(id)) {
      const leafId = leafIdOf(leaf);
      const eState = leafId ? saved.get(leafId) : undefined;
      if (!eState) continue;
      try {
        leaf.setEphemeralState(eState);
      } catch (e) {
        console.warn("[Project Spaces] could not restore cursor/scroll", e);
      }
    }
  }

  /**
   * After a config reload: if nothing is active yet (first project added to an
   * empty config), activate the first project and adopt the current tabs.
   */
  activateIfIdle(): void {
    if (this.stopped || this.starting || this.activeId !== null) return;
    const id = this.host.defaultProjectId();
    if (id === null) return;
    void this.enqueue(async (gen) => {
      if (this.superseded(gen) || this.activeId !== null) return;
      this.host.state().activeProjectId = id;
      this.adoptUnownedLeaves();
      if (this.needsBuild(id) && !(await this.build(id, gen))) return;
      if (!(await this.reconcile(id, gen))) return;
      this.applyVisibility();
      this.shownId = id;
      this.complete.add(id);
      this.host.requestSave();
      this.host.changed();
    });
  }

  onLayoutChange(): void {
    if (this.stopped) return;
    this.adoptUnownedLeaves();
    this.applyVisibility();
    if (this.switching || this.starting) return;
    const active = this.activeId;
    if (active === null || active !== this.shownId) return;
    // Saves "no open tabs" if the user just closed the last one.
    this.capture(active);
    if (this.leavesOf(active).length === 0) {
      // With hidden groups still in the root, Obsidian removes the emptied
      // group instead of leaving a "New tab", so the main area would go blank.
      // Rebuild: with nothing saved that yields one empty tab.
      void this.switchTo(active);
      return;
    }
    this.refreshHidden();
  }

  onActiveLeafChange(leaf: WorkspaceLeaf | null): void {
    if (this.stopped || !leaf || leaf.getRoot() !== this.ws.rootSplit) return;
    const owner = this.owners.get(leaf);
    if (owner === undefined || this.switching || this.starting) return;
    if (owner === this.activeId) {
      this.lastFocused.set(owner, leaf);
      this.capture(owner);
      return;
    }
    // A hidden project's leaf got focus (e.g. a "focus next tab group"
    // command walked into a hidden group). Typing would go into an invisible
    // editor, so put focus back into the visible project.
    const back = this.activeId !== null ? this.focusTarget(this.activeId) : null;
    if (back) this.ws.setActiveLeaf(back, { focus: true });
  }

  // ------------------------------------------------------------------
  // Shutdown
  // ------------------------------------------------------------------

  /**
   * Leave the workspace as a normal single-project layout and make data.json
   * agree with it. Shared by quit and plugin unload.
   * - Invalidates in-flight work (it stops at its next checkpoint; on quit it
   *   then closes what it created, and the quit task waits for that via
   *   `whenIdle()` before saving and flushing the layout).
   * - Keeps the project last completely shown. If a switch was mid-build, the
   *   half-built target is closed and the active id reverts to the shown
   *   project. During startup nothing is shown yet: the active project is
   *   kept, and whatever partial layout it has is reconciled against saved
   *   state on the next start, so it can never be saved over its tab list.
   * - Captures the kept project (cursor/scroll only if it was still the
   *   visible one), refreshes hidden complete projects, then closes every
   *   other project's leaves; they rebuild lazily from data.json.
   */
  private shutdown(): void {
    this.switchGen++;
    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    const keep = this.shownId ?? this.activeId;
    if (this.shownId !== null && !this.starting) {
      this.adoptUnownedLeaves();
      this.capture(this.shownId);
      this.refreshHidden();
      this.host.state().activeProjectId = this.shownId;
    }
    const others = this.mainLeaves().filter((leaf) => {
      const owner = this.owners.get(leaf);
      return owner !== undefined && owner !== keep;
    });
    for (const leaf of others) leaf.detach();
  }

  /** App is quitting (upstream behavior: workspace.json keeps one project). */
  onQuit(): void {
    if (this.stopped) return;
    this.shutdown();
    this.quitting = true;
  }

  /**
   * Obsidian writes workspace.json before quit handlers run, so the leaves
   * closed in onQuit would otherwise still be restored next time (startup
   * copes, but the file should match). Flush a layout save now.
   */
  async flushLayout(): Promise<void> {
    this.ws.requestSaveLayout();
    await this.ws.requestSaveLayout.run();
  }

  /** Plugin unload. After this, every entry point is a no-op. */
  dispose(): void {
    if (this.disposed) return;
    if (!this.quitting) this.shutdown();
    this.disposed = true;
    this.clearVisibility();
  }

  /** Close live leaves of projects whose state was pruned. */
  closeProjects(ids: string[]): void {
    const doomed = new Set(ids);
    for (const leaf of this.mainLeaves()) {
      const owner = this.owners.get(leaf);
      if (owner !== undefined && doomed.has(owner) && owner !== this.activeId) leaf.detach();
    }
    for (const id of ids) this.complete.delete(id);
  }
}
