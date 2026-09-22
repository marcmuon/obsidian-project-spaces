// Live workspace side of Project Spaces: which main-area leaves belong to which
// project, showing/hiding them, building a project's tabs from saved state,
// and capturing a project's tabs back into state.
//
// READ docs/ARCHITECTURE.md BEFORE "SIMPLIFYING" ANYTHING HERE. The switch
// queue, generation counter, pending counter and delayed guard release come
// from upstream Project View and exist because rapid clicks otherwise produce
// duplicate panes, half-built projects and state overwritten with the wrong
// tabs.

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
  /** Immediate write of data.json. */
  saveNow(): Promise<void>;
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

export class ProjectSpaceManager {
  /** Owner project id of each main-area leaf. Leaves not in here are "unowned". */
  private readonly owners = new WeakMap<WorkspaceLeaf, string>();
  /** Last focused leaf per project, used to restore the active tab on return. */
  private readonly lastFocused = new Map<string, WorkspaceLeaf>();

  // ---- Switch serialization (ported from upstream showPane) ----
  // Every switch runs on this promise chain, one at a time. Concurrent runs
  // would each create a tab group and leave two projects side by side.
  private switchQueue: Promise<void> = Promise.resolve();
  // Bumped synchronously the moment a switch is requested. An in-flight build
  // compares its captured value between tab opens and aborts as soon as a
  // newer request exists, so a new click never waits for an old build.
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
  // The project whose tabs were last fully built AND made visible. Capture is
  // only allowed for this project. After an aborted build the active id can
  // point at a project with no (or only placeholder) leaves; capturing it
  // would overwrite its saved tabs with nothing.
  private shownId: string | null = null;
  // Latest requested project, so the sidebar highlights a click immediately.
  private requestedId: string | null = null;

  constructor(private readonly host: ManagerHost) {}

  private get ws() {
    return this.host.app.workspace;
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

  private static isEmptyLeaf(leaf: WorkspaceLeaf): boolean {
    return leaf.getViewState().type === "empty";
  }

  private fileExists = (path: string): boolean =>
    this.host.app.vault.getAbstractFileByPath(path) !== null;

  /** Saved tabs that can be opened now (file-backed tabs need their file). */
  private restorableTabs(id: string): SavedTab[] {
    const space = this.host.state().spaces[id];
    if (!space) return [];
    return space.tabs.filter((tab) => {
      const file = tabFile(tab);
      return file === null || this.fileExists(file);
    });
  }

  /** Tab count for the sidebar: live tabs if the project is live, else saved. */
  tabCount(id: string): number {
    const live = this.leavesOf(id);
    if (live.length > 0) {
      return live.filter((leaf) => !ProjectSpaceManager.isEmptyLeaf(leaf)).length;
    }
    return this.restorableTabs(id).length;
  }

  /**
   * A project needs building when it has no live leaves, or only placeholder
   * "New tab" leaves while it has saved tabs to restore.
   */
  private needsBuild(id: string): boolean {
    const live = this.leavesOf(id);
    if (live.length === 0) return true;
    const hasContent = live.some((leaf) => !ProjectSpaceManager.isEmptyLeaf(leaf));
    return !hasContent && this.restorableTabs(id).length > 0;
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
   * Give every unowned main-area leaf an owner.
   * - A leaf whose Obsidian id is a saved tab of ANOTHER project was restored
   *   from workspace.json (e.g. after a crash, when the quit handler could not
   *   close hidden projects). That project's tabs are already in data.json and
   *   it will be rebuilt lazily, so the stray copy is closed. Keeping it would
   *   show another project's tab in this one.
   * - A new tab inside a tab group joins the project owning that group's other
   *   tabs. layout-change (which triggers adoption) can arrive after the user
   *   already switched projects, so "the active project" is not reliable for
   *   a tab opened a moment ago.
   * - Everything else (new splits, first-run tabs) joins the active project.
   *   switchImpl adopts before leaving a project, so leaves created while it
   *   was visible are attributed to it.
   */
  private adoptUnownedLeaves(): void {
    const active = this.activeId;
    if (active === null) return;
    let savedOwners: Map<string, string> | null = null;
    const strays: WorkspaceLeaf[] = [];
    for (const leaf of this.mainLeaves()) {
      if (this.owners.has(leaf)) continue;
      savedOwners ??= this.savedLeafOwners();
      const leafId = leafIdOf(leaf);
      const savedOwner = leafId ? savedOwners.get(leafId) : undefined;
      if (savedOwner !== undefined && savedOwner !== active) {
        strays.push(leaf);
        continue;
      }
      this.owners.set(leaf, savedOwner ?? this.groupOwner(leaf) ?? active);
    }
    for (const leaf of strays) leaf.detach();
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
    const vs = leaf.getViewState();
    const view: SavedViewState = { type: vs.type };
    // getViewState() works for deferred (not yet loaded) background tabs too.
    const state = vs.state ? plainCopy(vs.state) : undefined;
    if (state) view.state = state;
    if (vs.pinned) view.pinned = true;
    const leafId = leafIdOf(leaf);
    const tab: SavedTab = { view };
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
   * Snapshot the shown project's live tabs into its saved state. Only allowed
   * for the project currently shown: a half-built or placeholder project must
   * never overwrite its saved tabs.
   */
  capture(id: string | null): void {
    if (id === null || id !== this.shownId || this.starting) return;
    // A newly opened tab gets focus before layout-change assigns it an owner,
    // so active-leaf-change can miss it; ask Obsidian for the most recent one.
    const recent = this.ws.getMostRecentLeaf(this.ws.rootSplit);
    if (recent && this.owners.get(recent) === id) this.lastFocused.set(id, recent);
    this.snapshot(id, true);
  }

  /**
   * Refresh the view state (not cursor/scroll) of hidden projects that have
   * live leaves. Needed because a tab can still be loading when its project is
   * hidden: it was captured as a Markdown tab with no file, and without this
   * it would be restored that way after a restart. Hidden projects are always
   * complete (an aborted build closes everything it opened), so their live
   * leaves are their real tab list.
   */
  refreshHidden(): void {
    if (this.starting || this.switching) return;
    const hidden = new Set<string>();
    for (const leaf of this.mainLeaves()) {
      const owner = this.owners.get(leaf);
      if (owner !== undefined && owner !== this.shownId) hidden.add(owner);
    }
    for (const id of hidden) this.snapshot(id, false);
  }

  private snapshot(id: string, visible: boolean): void {
    const space = this.host.state().spaces[id];
    if (!space) return;
    const leaves = this.leavesOf(id);
    // No live leaves at all means "not built", not "closed everything".
    if (leaves.length === 0) return;
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
    const merged = mergeCapture(space.tabs, live, liveActive, this.fileExists);
    space.tabs = merged.tabs;
    space.activeTab = merged.activeTab;
    this.host.requestSave();
    this.host.changed();
  }

  // ------------------------------------------------------------------
  // Build (saved state -> live leaves)
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

  /**
   * Open a project's saved tabs. Returns false if a newer switch superseded
   * this build; in that case everything this build created has been closed
   * again, so no half-built project is left behind.
   */
  private async build(id: string, gen: number): Promise<boolean> {
    const space = this.host.state().spaces[id];
    const tabs = this.restorableTabs(id);
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

    const abort = async (): Promise<false> => {
      for (const leaf of created) leaf.detach();
      // A reused placeholder goes back to empty so the project is not left
      // showing a partial tab set that a later capture could save.
      if (first && !created.includes(first)) {
        await first.setViewState({ type: "empty" });
      }
      return false;
    };

    const opened = new Map<SavedTab, WorkspaceLeaf>();
    let last: WorkspaceLeaf | null = null; // last successfully opened leaf
    let slot: WorkspaceLeaf | null = first; // a leaf free to receive the next tab
    for (const tab of tabs) {
      if (gen !== this.switchGen) return abort();
      const leaf: WorkspaceLeaf = slot ?? this.newTabAfter(last ?? first);
      if (leaf !== slot) created.push(leaf);
      this.owners.set(leaf, id);
      slot = null;
      try {
        await leaf.setViewState({ ...tab.view, active: false }, tab.eState);
        opened.set(tab, leaf);
        last = leaf;
      } catch (e) {
        // One bad view must not break the whole project: log it and reuse the
        // leaf for the next tab. (Unknown view types do NOT throw; Obsidian
        // keeps their state, so a disabled plugin's views survive.)
        console.warn(`[Project Spaces] could not restore a "${tab.view.type}" tab`, e);
        slot = leaf;
      }
    }
    if (gen !== this.switchGen) return abort();

    if (opened.size === 0) {
      // Nothing to show (no saved tabs, or every restore failed): one empty tab.
      await first.setViewState({ type: "empty" });
    } else if (slot) {
      // A trailing leaf whose restore failed and was never reused.
      slot.detach();
    }
    const savedActive = space?.tabs[space.activeTab];
    const focus =
      (savedActive && opened.get(savedActive)) ?? opened.values().next().value ?? first;
    this.lastFocused.set(id, focus);
    return gen === this.switchGen;
  }

  // ------------------------------------------------------------------
  // Switching
  // ------------------------------------------------------------------

  /** Queue a job on the switch chain (see field comments). */
  private enqueue(job: (gen: number) => Promise<void>): Promise<void> {
    const gen = ++this.switchGen;
    this.pendingSwitches++;
    const run = this.switchQueue
      .catch(() => {})
      .then(() => job(gen))
      .finally(() => {
        this.pendingSwitches--;
        if (this.pendingSwitches === 0 && this.requestedId !== null) {
          this.requestedId = null;
          this.host.changed();
        }
      });
    this.switchQueue = run;
    return run;
  }

  /** Show project `id`, keeping the one being left alive but hidden. */
  switchTo(id: string): Promise<void> {
    this.requestedId = id;
    this.host.changed();
    return this.enqueue((gen) => this.switchImpl(id, gen));
  }

  private async switchImpl(targetId: string, gen: number): Promise<void> {
    // A newer request arrived while this one waited in the queue. It will do
    // the work; running this one would only build tabs to throw them away.
    if (gen !== this.switchGen) return;
    const state = this.host.state();
    if (!state.spaces[targetId]) return;
    const leaving = this.activeId;
    if (leaving === targetId && this.shownId === targetId && !this.needsBuild(targetId)) {
      this.applyVisibility();
      this.focusProject(targetId);
      return;
    }

    // Tabs opened just before this click may not have been adopted yet
    // (layout-change is asynchronous). Adopt them now, while the project being
    // left is still the active one, then snapshot it while it is visible.
    this.adoptUnownedLeaves();
    this.capture(leaving);

    this.switching = true;
    state.activeProjectId = targetId;
    this.host.changed();

    const rootEl = containerElOf(this.ws.rootSplit);
    try {
      if (this.needsBuild(targetId)) {
        // Hide the main area while building so the new group never appears
        // next to the old project during the async tab opens.
        rootEl?.addClass(ROOT_BUILDING_CLASS);
        const built = await this.build(targetId, gen);
        // Superseded: leave the root hidden; the newer switch reveals it.
        if (!built || gen !== this.switchGen) return;
      }
      this.applyVisibility();
      this.focusProject(targetId);
      this.shownId = targetId;
    } catch (e) {
      console.error("[Project Spaces] switch failed", e);
    } finally {
      // Only the latest switch may reveal the root.
      if (gen === this.switchGen) rootEl?.removeClass(ROOT_BUILDING_CLASS);
    }

    this.host.requestSave();
    this.releaseSwitchingSoon();
  }

  /**
   * Release the switching guard after the layout settles, but only once no
   * further switch is queued (upstream behavior; see `pendingSwitches`).
   */
  private releaseSwitchingSoon(): void {
    window.setTimeout(() => {
      if (this.pendingSwitches !== 0) return;
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
   * tabs), or builds it from saved state if nothing of it was restored.
   */
  start(): Promise<void> {
    return this.enqueue((gen) => this.startImpl(gen));
  }

  private async startImpl(gen: number): Promise<void> {
    const rootEl = containerElOf(this.ws.rootSplit);
    rootEl?.addClass(ROOT_BUILDING_CLASS);
    try {
      await sleep(STARTUP_INITIAL_WAIT_MS);
      const state = this.host.state();
      if (state.activeProjectId === null || !state.spaces[state.activeProjectId]) {
        state.activeProjectId = this.host.defaultProjectId();
      }
      const active = state.activeProjectId;
      if (active === null) return; // no projects configured: stay out of the way
      this.adoptUnownedLeaves();
      this.restoreEphemeralStates(active);
      if (this.needsBuild(active)) {
        const built = await this.build(active, gen);
        if (!built) return;
      }
      await sleep(STARTUP_LATE_WAIT_MS);
      this.adoptUnownedLeaves();
      if (gen !== this.switchGen) return;
      // Keep whichever tab Obsidian restored as focused, if it is ours.
      const restoredFocus = this.ws.getMostRecentLeaf(this.ws.rootSplit);
      if (restoredFocus && this.owners.get(restoredFocus) === active && !this.lastFocused.has(active)) {
        this.lastFocused.set(active, restoredFocus);
      }
      this.applyVisibility();
      this.focusProject(active);
      this.shownId = active;
    } catch (e) {
      console.error("[Project Spaces] startup failed", e);
    } finally {
      this.starting = false;
      if (gen === this.switchGen) rootEl?.removeClass(ROOT_BUILDING_CLASS);
      this.host.changed();
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
    if (this.starting || this.activeId !== null) return;
    const id = this.host.defaultProjectId();
    if (id === null) return;
    void this.enqueue(async (gen) => {
      if (gen !== this.switchGen || this.activeId !== null) return;
      this.host.state().activeProjectId = id;
      this.adoptUnownedLeaves();
      if (this.needsBuild(id) && !(await this.build(id, gen))) return;
      this.applyVisibility();
      this.shownId = id;
      this.host.requestSave();
      this.host.changed();
    });
  }

  onLayoutChange(): void {
    if (this.quitting) return;
    this.adoptUnownedLeaves();
    this.applyVisibility();
    if (this.switching || this.starting) return;
    const active = this.activeId;
    if (active === null || active !== this.shownId) return;
    if (this.leavesOf(active).length === 0) {
      // The user closed the active project's last tab. With hidden groups
      // still in the root, Obsidian removes the empty group instead of leaving
      // a "New tab", so the main area would go blank. Record the (empty) tab
      // list, then rebuild: with no saved tabs that yields one empty tab.
      const space = this.host.state().spaces[active];
      if (space) {
        space.tabs = space.tabs.filter((tab) => {
          const file = tabFile(tab);
          return file !== null && !this.fileExists(file); // keep only unrestorable ones
        });
        space.activeTab = space.tabs.length > 0 ? 0 : -1;
      }
      this.shownId = null;
      void this.switchTo(active);
      return;
    }
    this.capture(active);
    this.refreshHidden();
  }

  onActiveLeafChange(leaf: WorkspaceLeaf | null): void {
    if (!leaf || this.quitting || leaf.getRoot() !== this.ws.rootSplit) return;
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

  /**
   * App is quitting: capture the visible project and close hidden projects'
   * leaves so workspace.json only restores the active project (upstream
   * behavior). Their state is already in data.json and they rebuild lazily.
   */
  onQuit(): void {
    this.capture(this.activeId);
    this.refreshHidden();
    this.quitting = true;
    this.detachHiddenLeaves();
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

  /**
   * Plugin disabled (not quitting): same cleanup, and remove our classes so
   * the layout is a plain single-project workspace again.
   */
  dispose(): void {
    if (!this.quitting) {
      this.capture(this.activeId);
      this.refreshHidden();
      this.detachHiddenLeaves();
    }
    this.clearVisibility();
  }

  private detachHiddenLeaves(): void {
    const active = this.activeId;
    const hidden = this.mainLeaves().filter((leaf) => {
      const owner = this.owners.get(leaf);
      return owner !== undefined && owner !== active;
    });
    for (const leaf of hidden) leaf.detach();
  }

  /** Close live leaves of projects whose state was pruned. */
  closeProjects(ids: string[]): void {
    const doomed = new Set(ids);
    for (const leaf of this.mainLeaves()) {
      const owner = this.owners.get(leaf);
      if (owner !== undefined && doomed.has(owner) && owner !== this.activeId) leaf.detach();
    }
  }
}
