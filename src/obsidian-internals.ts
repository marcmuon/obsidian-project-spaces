// The few undocumented Obsidian workspace members this plugin relies on, kept
// in one file so an Obsidian update that changes them is easy to locate.
// Verified against Obsidian 1.13.7 desktop.

import { WorkspaceItem, WorkspaceLeaf, WorkspaceParent, WorkspaceSplit } from "obsidian";

interface InternalItem {
  /** DOM element of a split / tab group / leaf. */
  containerEl?: HTMLElement;
  /** Child items of a split or tab group. */
  children?: WorkspaceItem[];
  /** Stable id, persisted in workspace.json and reused on restore. */
  id?: string;
}

function internal(item: WorkspaceItem): InternalItem {
  return item as unknown as InternalItem;
}

export function containerElOf(item: WorkspaceItem): HTMLElement | null {
  return internal(item).containerEl ?? null;
}

export function childrenOf(item: WorkspaceItem): WorkspaceItem[] {
  const children = internal(item).children;
  return Array.isArray(children) ? children : [];
}

export function leafIdOf(leaf: WorkspaceLeaf): string | undefined {
  const id = internal(leaf).id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * The public typing says `createLeafInParent(parent: WorkspaceSplit, ...)`, but
 * it also accepts a tab group and then adds a tab at `index` (verified). Do NOT
 * pass a WorkspaceSplit here: on a split it inserts a bare leaf without a tab
 * group, which corrupts the layout.
 */
export function asCreateLeafParent(tabGroup: WorkspaceParent): WorkspaceSplit {
  return tabGroup as unknown as WorkspaceSplit;
}
