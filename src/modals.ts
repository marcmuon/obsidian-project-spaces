import { App, FuzzySuggestModal, Modal, Setting } from "obsidian";
import { ProjectConfigEntry } from "./config";

/** "Switch project..." picker. */
export class ProjectSuggestModal extends FuzzySuggestModal<ProjectConfigEntry> {
  constructor(
    app: App,
    private readonly projects: ProjectConfigEntry[],
    private readonly onChoose: (project: ProjectConfigEntry) => void
  ) {
    super(app);
    this.setPlaceholder("Switch to project...");
  }

  getItems(): ProjectConfigEntry[] {
    return this.projects;
  }

  getItemText(project: ProjectConfigEntry): string {
    return project.name;
  }

  onChooseItem(project: ProjectConfigEntry): void {
    this.onChoose(project);
  }
}

export interface OrphanSummary {
  id: string;
  name: string;
  tabs: number;
  orphanedAt: number | null;
}

/** Confirmation for the explicit "Prune orphaned state" command. */
export class ConfirmPruneModal extends Modal {
  constructor(
    app: App,
    private readonly orphans: OrphanSummary[],
    private readonly onConfirm: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Prune orphaned project state?" });
    contentEl.createEl("p", {
      text:
        "These project ids are no longer in ProjectSpaces.config.json. Pruning " +
        "permanently forgets their saved tabs. Notes are not touched.",
    });
    const list = contentEl.createEl("ul");
    for (const orphan of this.orphans) {
      const since =
        orphan.orphanedAt !== null
          ? `, orphaned ${new Date(orphan.orphanedAt).toLocaleDateString()}`
          : "";
      list.createEl("li", {
        text: `${orphan.name} (id "${orphan.id}", ${orphan.tabs} tab(s)${since})`,
      });
    }
    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("Prune")
          .setWarning()
          .onClick(() => {
            this.close();
            this.onConfirm();
          })
      )
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
