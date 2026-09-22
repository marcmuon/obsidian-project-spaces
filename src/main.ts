// Project Spaces: persistent, visually separated sets of live tabs per project.
// Wiring only; see project-space-manager.ts for the workspace logic and
// docs/ARCHITECTURE.md for the model.

import { Notice, Plugin, TAbstractFile, WorkspaceLeaf } from "obsidian";
import {
  CONFIG_PATH,
  EMPTY_CONFIG_TEXT,
  ProjectConfig,
  ProjectConfigEntry,
  resolveConfig,
} from "./config";
import { ConfirmPruneModal, OrphanSummary, ProjectSuggestModal } from "./modals";
import { ProjectSpaceManager } from "./project-space-manager";
import { ProjectSidebarView, VIEW_TYPE_PROJECT_SPACES } from "./project-sidebar";
import {
  createEmptyState,
  migrateState,
  orphanedIds,
  pruneOrphans,
  reconcileWithConfig,
  remapPath,
  removePath,
  RuntimeState,
} from "./state";

const SAVE_DEBOUNCE_MS = 1000;
const CONFIG_RELOAD_DEBOUNCE_MS = 750;
const ERROR_NOTICE_MS = 10000;

export default class ProjectSpacesPlugin extends Plugin {
  private state: RuntimeState = createEmptyState();
  /** Config currently in use: the file if valid, else the last valid one. */
  private config: ProjectConfig = { version: 1, projects: [] };
  private configError: string | null = null;
  /** Last error shown as a Notice by the watcher (avoids repeating it while typing). */
  private lastNoticedError: string | null = null;
  /**
   * False when data.json must not be overwritten: written by a newer build, or
   * unreadable/unrecognized and the backup copy failed.
   */
  private canSave = true;
  /** Set in onunload: late async callbacks must not schedule saves. */
  private unloaded = false;
  private saveTimer: number | null = null;
  private configTimer: number | null = null;
  private manager!: ProjectSpaceManager;

  async onload(): Promise<void> {
    await this.loadState();
    if (this.state.lastGoodConfig) this.config = this.state.lastGoodConfig;

    this.manager = new ProjectSpaceManager({
      app: this.app,
      state: () => this.state,
      requestSave: () => this.requestSave(),
      changed: () => this.refreshSidebar(),
      defaultProjectId: () => this.config.projects[0]?.id ?? null,
    });

    this.registerView(
      VIEW_TYPE_PROJECT_SPACES,
      (leaf) =>
        new ProjectSidebarView(leaf, {
          projects: () => this.config.projects,
          displayedProjectId: () => this.manager.displayedId,
          tabCount: (id) => this.manager.tabCount(id),
          configError: () => this.configError,
          orphanedActiveName: () => this.orphanedActiveName(),
          switchTo: (id) => void this.manager.switchTo(id),
          openConfig: () => void this.openConfig(),
          reloadConfig: () => void this.reloadConfig(true),
        })
    );

    // Show .json files in the file explorer and open them in the plain-text
    // (Markdown) editor, so ProjectSpaces.config.json is visible and editable
    // in Obsidian. Fails harmlessly if another plugin already owns ".json".
    try {
      this.registerExtensions(["json"], "markdown");
    } catch {
      console.info("[Project Spaces] .json is handled by another plugin");
    }

    this.addRibbonIcon("layers", "Project Spaces", () => void this.revealSidebar());
    this.registerCommands();

    this.app.workspace.onLayoutReady(() => void this.onLayoutReady());
  }

  onunload(): void {
    this.manager?.dispose();
    if (this.configTimer !== null) window.clearTimeout(this.configTimer);
    void this.saveNow();
    this.unloaded = true;
  }

  private async onLayoutReady(): Promise<void> {
    await this.reloadConfig(false);
    // The plugin may have been disabled while the config was being read:
    // registering events or creating the sidebar now would outlive unload.
    if (this.unloaded) return;

    // Registered after layout-ready so the initial vault-load "create" burst
    // is not handled.
    this.registerEvent(this.app.vault.on("modify", (f) => this.onVaultFile(f.path)));
    this.registerEvent(this.app.vault.on("create", (f) => this.onVaultFile(f.path)));
    this.registerEvent(
      this.app.vault.on("delete", (f) => {
        this.onVaultFile(f.path);
        if (removePath(this.state, f.path) > 0) this.requestSave();
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (f: TAbstractFile, oldPath: string) => {
        this.onVaultFile(f.path);
        this.onVaultFile(oldPath);
        if (remapPath(this.state, oldPath, f.path) > 0) this.requestSave();
      })
    );

    const ws = this.app.workspace;
    this.registerEvent(ws.on("layout-change", () => this.manager.onLayoutChange()));
    this.registerEvent(
      ws.on("active-leaf-change", (leaf: WorkspaceLeaf | null) =>
        this.manager.onActiveLeafChange(leaf)
      )
    );
    this.registerEvent(
      ws.on("quit", (tasks) => {
        this.manager.onQuit();
        tasks.add(async () => {
          // Let in-flight switch/startup work finish cancelling (it closes the
          // partial tabs it created) before the final state and layout saves.
          await this.manager.whenIdle();
          await this.saveNow();
          await this.manager.flushLayout();
        });
      })
    );

    await this.ensureSidebar();
    if (this.unloaded) return;
    await this.manager.start();
  }

  // ------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------

  private registerCommands(): void {
    // No default hotkeys on purpose: assign them in Settings -> Hotkeys.
    this.addCommand({
      id: "switch-project",
      name: "Switch project...",
      callback: () => {
        if (!this.requireProjects()) return;
        new ProjectSuggestModal(this.app, this.config.projects, (p) => {
          void this.manager.switchTo(p.id);
        }).open();
      },
    });
    this.addCommand({
      id: "next-project",
      name: "Next project",
      callback: () => this.cycleProject(1),
    });
    this.addCommand({
      id: "previous-project",
      name: "Previous project",
      callback: () => this.cycleProject(-1),
    });
    this.addCommand({
      id: "open-configuration",
      name: "Open configuration",
      callback: () => void this.openConfig(),
    });
    this.addCommand({
      id: "reload-configuration",
      name: "Reload configuration",
      callback: () => void this.reloadConfig(true),
    });
    this.addCommand({
      id: "prune-orphaned-state",
      name: "Prune orphaned state",
      callback: () => this.promptPrune(),
    });
    this.addCommand({
      id: "show-project-list",
      name: "Show project list",
      callback: () => void this.revealSidebar(),
    });
  }

  private requireProjects(): boolean {
    if (this.config.projects.length > 0) return true;
    new Notice(`Project Spaces: no projects configured in ${CONFIG_PATH}.`);
    return false;
  }

  private cycleProject(step: 1 | -1): void {
    if (!this.requireProjects()) return;
    const projects = this.config.projects;
    const current = projects.findIndex((p) => p.id === this.manager.displayedId);
    const next =
      current === -1
        ? step === 1
          ? 0
          : projects.length - 1
        : (current + step + projects.length) % projects.length;
    void this.manager.switchTo(projects[next].id);
  }

  private promptPrune(): void {
    // With a missing or broken config every project could look orphaned.
    if (this.configError !== null) {
      new Notice("Project Spaces: fix the configuration before pruning.");
      return;
    }
    // The ids shown in the dialog are the only ones that may be deleted, and
    // only if they are still orphaned when the user confirms.
    const orphans: OrphanSummary[] = orphanedIds(this.state, this.config)
      .filter((id) => id !== this.state.activeProjectId)
      .map((id) => {
        const space = this.state.spaces[id];
        return {
          id,
          name: space.name,
          tabs: space.tabs.length,
          orphanedAt: space.orphanedAt,
        };
      });
    if (orphans.length === 0) {
      new Notice("Project Spaces: no orphaned project state to prune.");
      return;
    }
    const shown = orphans.map((o) => o.id);
    new ConfirmPruneModal(this.app, orphans, () => {
      if (this.configError !== null) {
        new Notice("Project Spaces: the configuration became invalid; nothing was pruned.");
        return;
      }
      const pruned = pruneOrphans(this.state, this.config, shown, this.state.activeProjectId);
      this.manager.closeProjects(pruned);
      void this.saveNow();
      this.refreshSidebar();
      new Notice(`Project Spaces: pruned ${pruned.length} orphaned project(s).`);
    }).open();
  }

  // ------------------------------------------------------------------
  // Configuration
  // ------------------------------------------------------------------

  private onVaultFile(path: string): void {
    if (path !== CONFIG_PATH) return;
    if (this.configTimer !== null) window.clearTimeout(this.configTimer);
    this.configTimer = window.setTimeout(() => {
      this.configTimer = null;
      void this.reloadConfig(false);
    }, CONFIG_RELOAD_DEBOUNCE_MS);
  }

  private async readConfigText(): Promise<string | null> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(CONFIG_PATH))) return null;
    return adapter.read(CONFIG_PATH);
  }

  /**
   * Load ProjectSpaces.config.json. On success, reconcile runtime state (new
   * ids get empty spaces, removed ids become orphaned; live tabs are never
   * touched). On failure keep the last valid config and all state.
   */
  async reloadConfig(manual: boolean): Promise<void> {
    let error: string;
    try {
      const text = await this.readConfigText();
      if (this.unloaded) return;
      const resolved = resolveConfig(text, this.state.lastGoodConfig);
      if (resolved.error === null) {
        this.applyConfig(resolved.config, manual);
        return;
      }
      // Keep the last good config (resolveConfig already fell back to it);
      // state is not reconciled, so nothing is orphaned or changed.
      this.config = resolved.config;
      error = resolved.error;
    } catch (e) {
      error = `Could not read ${CONFIG_PATH}: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.configError = error;
    if (manual || error !== this.lastNoticedError) {
      new Notice(
        `Project Spaces: ${error}\nStill using the last valid configuration; no tabs were changed.`,
        ERROR_NOTICE_MS
      );
    }
    this.lastNoticedError = error;
    this.refreshSidebar();
  }

  private applyConfig(config: ProjectConfig, manual: boolean): void {
    this.config = config;
    this.configError = null;
    this.lastNoticedError = null;
    const result = reconcileWithConfig(this.state, config, Date.now());
    this.requestSave();
    this.manager.activateIfIdle();
    this.refreshSidebar();
    if (manual) {
      const extra =
        result.orphaned.length > 0 ? `, ${result.orphaned.length} now orphaned (state kept)` : "";
      new Notice(`Project Spaces: loaded ${config.projects.length} project(s)${extra}.`);
    }
  }

  async openConfig(): Promise<void> {
    if (!(await this.app.vault.adapter.exists(CONFIG_PATH))) {
      await this.app.vault.create(CONFIG_PATH, EMPTY_CONFIG_TEXT);
    }
    if (this.unloaded) return;
    // Reuse a config tab only if it is in the visible project; a hidden
    // project's tab can't be focused (focus would bounce back).
    const existing = this.manager
      .visibleLeaves()
      .find((leaf) => leaf.getViewState().state?.file === CONFIG_PATH);
    if (existing) {
      this.app.workspace.setActiveLeaf(existing, { focus: true });
      return;
    }
    // Opened as plain text in the Markdown editor (works even when another
    // plugin owns the .json extension).
    await this.app.workspace.getLeaf("tab").setViewState({
      type: "markdown",
      state: { file: CONFIG_PATH, mode: "source" },
      active: true,
    });
  }

  private orphanedActiveName(): string | null {
    const id = this.state.activeProjectId;
    if (id === null || this.config.projects.some((p: ProjectConfigEntry) => p.id === id)) {
      return null;
    }
    return this.state.spaces[id]?.name ?? id;
  }

  // ------------------------------------------------------------------
  // Persistence (data.json)
  // ------------------------------------------------------------------

  private async loadState(): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.loadData();
    } catch {
      // data.json exists but is not valid JSON: keep a copy before we ever
      // overwrite it, then start fresh. No copy, no overwriting.
      this.state = createEmptyState();
      this.guardOverwrite(await this.backupDataFile("unreadable"), "was unreadable");
      return;
    }
    const { state, status } = migrateState(raw);
    this.state = state;
    if (status === "unrecognized") {
      this.guardOverwrite(await this.backupDataFile(status), "had an unknown format");
    }
    if (status === "migrated") {
      this.guardOverwrite(await this.backupDataFile(status), "was migrated to a new format");
    }
    if (status === "newer") {
      this.canSave = false;
      new Notice(
        "Project Spaces: data.json was written by a newer version of this plugin. " +
          "Running without saving so it is not overwritten.",
        ERROR_NOTICE_MS
      );
    }
  }

  /** After a failed backup, refuse to overwrite the original data.json. */
  private guardOverwrite(backedUp: boolean, what: string): void {
    if (backedUp) {
      new Notice(`Project Spaces: data.json ${what}; a backup copy was saved next to it.`);
      return;
    }
    this.canSave = false;
    new Notice(
      `Project Spaces: data.json ${what} and could not be backed up, so it will not be ` +
        "overwritten. Tab state is not being saved this session.",
      ERROR_NOTICE_MS
    );
  }

  /** Copy data.json next to itself (inside the vault's plugin folder). */
  private async backupDataFile(reason: string): Promise<boolean> {
    const dir = this.manifest.dir;
    if (!dir) return false;
    const adapter = this.app.vault.adapter;
    const source = `${dir}/data.json`;
    try {
      if (!(await adapter.exists(source))) return true; // nothing to lose
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await adapter.copy(source, `${dir}/data.${reason}-${stamp}.json`);
      return true;
    } catch (e) {
      console.error("[Project Spaces] could not back up data.json", e);
      return false;
    }
  }

  private requestSave(): void {
    if (this.unloaded) return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

  private async saveNow(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.canSave) return;
    await this.saveData(this.state);
  }

  // ------------------------------------------------------------------
  // Sidebar
  // ------------------------------------------------------------------

  private refreshSidebar(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECT_SPACES)) {
      if (leaf.view instanceof ProjectSidebarView) leaf.view.render();
    }
  }

  /** Make sure the project list exists; first time, dock it above the file explorer. */
  private async ensureSidebar(): Promise<void> {
    if (this.unloaded) return;
    const ws = this.app.workspace;
    if (ws.getLeavesOfType(VIEW_TYPE_PROJECT_SPACES).length > 0) return;
    const explorer = ws.getLeavesOfType("file-explorer")[0];
    const leaf = explorer
      ? ws.createLeafBySplit(explorer, "horizontal", true)
      : ws.getLeftLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_PROJECT_SPACES, active: false });
  }

  private async revealSidebar(): Promise<void> {
    await this.ensureSidebar();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECT_SPACES)[0];
    if (leaf) await this.app.workspace.revealLeaf(leaf);
  }
}
