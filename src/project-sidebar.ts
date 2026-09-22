// The "Projects" list in the left sidebar. Deliberately minimal: a header
// with two small buttons, one row per configured project, the active one
// highlighted, and an open-tab count.

import { ItemView, setIcon, WorkspaceLeaf } from "obsidian";
import { ProjectConfigEntry } from "./config";

export const VIEW_TYPE_PROJECT_SPACES = "project-spaces-sidebar";

export interface SidebarHost {
  projects(): ProjectConfigEntry[];
  /** Highlighted project (pending click or active). */
  displayedProjectId(): string | null;
  tabCount(id: string): number;
  /** Current config error, if the file is invalid or missing. */
  configError(): string | null;
  /** Name of the active project when it is no longer in the config. */
  orphanedActiveName(): string | null;
  switchTo(id: string): void;
  openConfig(): void;
  reloadConfig(): void;
}

export class ProjectSidebarView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: SidebarHost
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_PROJECT_SPACES;
  }

  getDisplayText(): string {
    return "Project Spaces";
  }

  getIcon(): string {
    return "layers";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("ps-sidebar");

    const header = root.createDiv({ cls: "ps-header" });
    header.createSpan({ cls: "ps-title", text: "Projects" });
    const actions = header.createDiv({ cls: "ps-actions" });
    this.iconButton(actions, "file-cog", "Open configuration", () => this.host.openConfig());
    this.iconButton(actions, "refresh-cw", "Reload configuration", () =>
      this.host.reloadConfig()
    );

    const error = this.host.configError();
    if (error) {
      const el = root.createDiv({
        cls: "ps-error",
        text: "Config error, using last valid config.",
      });
      el.setAttr("title", error);
    }

    const projects = this.host.projects();
    if (projects.length === 0) {
      root.createDiv({
        cls: "ps-empty",
        text: "No projects. Add some to ProjectSpaces.config.json.",
      });
    }

    const list = root.createDiv({ cls: "ps-list" });
    const displayed = this.host.displayedProjectId();
    for (const project of projects) {
      const row = list.createDiv({ cls: "ps-project tree-item-self is-clickable" });
      row.toggleClass("is-active", project.id === displayed);
      row.setAttr("tabindex", "0");
      row.setAttr("role", "button");
      row.createSpan({ cls: "ps-name", text: project.name });
      const count = this.host.tabCount(project.id);
      row.createSpan({ cls: "ps-count", text: count > 0 ? String(count) : "" });
      row.addEventListener("click", () => this.host.switchTo(project.id));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.host.switchTo(project.id);
        }
      });
    }

    const orphanName = this.host.orphanedActiveName();
    if (orphanName !== null) {
      root.createDiv({
        cls: "ps-note",
        text: `Showing "${orphanName}", which is no longer in the config.`,
      });
    }
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
    const button = parent.createDiv({ cls: "clickable-icon", attr: { "aria-label": label } });
    setIcon(button, icon);
    button.addEventListener("click", onClick);
  }
}
