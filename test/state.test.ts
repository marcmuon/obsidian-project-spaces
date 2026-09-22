import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ProjectConfig } from "../src/config";
import {
  createEmptyState,
  initialActiveProject,
  mergeCapture,
  migrateState,
  orphanedIds,
  pruneOrphans,
  reconcileWithConfig,
  remapPath,
  removePath,
  RuntimeState,
  SavedTab,
  STATE_VERSION,
} from "../src/state";

function config(...entries: [string, string][]): ProjectConfig {
  return { version: 1, projects: entries.map(([id, name]) => ({ id, name })) };
}

function mdTab(file: string, leafId?: string): SavedTab {
  const tab: SavedTab = { view: { type: "markdown", state: { file, mode: "source" } } };
  if (leafId) tab.leafId = leafId;
  return tab;
}

/** State with two configured projects that have tabs. */
function populated(): RuntimeState {
  const state = createEmptyState();
  reconcileWithConfig(state, config(["a", "Project A"], ["b", "Project B"]), 1000);
  state.spaces.a.tabs = [mdTab("A1.md", "l1"), mdTab("A2.md", "l2"), mdTab("A3.md"), mdTab("A4.md")];
  state.spaces.a.activeTab = 1;
  state.spaces.b.tabs = [mdTab("B1.md"), mdTab("B2.md"), mdTab("B3.md")];
  state.spaces.b.activeTab = 0;
  state.activeProjectId = "a";
  return state;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("reconcileWithConfig (stable id behavior)", () => {
  it("adding a project creates an EMPTY space and leaves others untouched", () => {
    const state = populated();
    const before = clone(state.spaces);
    const result = reconcileWithConfig(
      state,
      config(["a", "Project A"], ["b", "Project B"], ["c", "Project C"]),
      2000
    );
    assert.deepEqual(result.added, ["c"]);
    assert.deepEqual(state.spaces.c.tabs, []);
    assert.equal(state.spaces.c.activeTab, -1);
    assert.deepEqual(state.spaces.a, before.a);
    assert.deepEqual(state.spaces.b, before.b);
  });

  it("renaming (same id) keeps tabs and updates the display name", () => {
    const state = populated();
    const tabs = clone(state.spaces.a.tabs);
    reconcileWithConfig(state, config(["a", "AI Infrastructure"], ["b", "Project B"]), 2000);
    assert.equal(state.spaces.a.name, "AI Infrastructure");
    assert.deepEqual(state.spaces.a.tabs, tabs);
    assert.equal(state.spaces.a.activeTab, 1);
  });

  it("reordering changes nothing in state", () => {
    const state = populated();
    const before = clone(state.spaces);
    reconcileWithConfig(state, config(["b", "Project B"], ["a", "Project A"]), 2000);
    assert.deepEqual({ ...state.spaces }, before);
  });

  it("removing a project orphans it without deleting its tabs", () => {
    const state = populated();
    const tabs = clone(state.spaces.b.tabs);
    const result = reconcileWithConfig(state, config(["a", "Project A"]), 5000);
    assert.deepEqual(result.orphaned, ["b"]);
    assert.equal(state.spaces.b.orphanedAt, 5000);
    assert.deepEqual(state.spaces.b.tabs, tabs);
    assert.deepEqual(orphanedIds(state, config(["a", "Project A"])), ["b"]);
  });

  it("re-adding the same id recovers the orphaned state", () => {
    const state = populated();
    const tabs = clone(state.spaces.b.tabs);
    reconcileWithConfig(state, config(["a", "Project A"]), 5000);
    const result = reconcileWithConfig(state, config(["a", "Project A"], ["b", "Beta"]), 9000);
    assert.deepEqual(result.recovered, ["b"]);
    assert.equal(state.spaces.b.orphanedAt, null);
    assert.equal(state.spaces.b.name, "Beta");
    assert.deepEqual(state.spaces.b.tabs, tabs);
  });

  it("keeps the first orphan timestamp across repeated reloads", () => {
    const state = populated();
    reconcileWithConfig(state, config(["a", "Project A"]), 5000);
    reconcileWithConfig(state, config(["a", "Project A"]), 6000);
    assert.equal(state.spaces.b.orphanedAt, 5000);
  });

  it("does not change the active project", () => {
    const state = populated();
    reconcileWithConfig(state, config(["b", "Project B"]), 5000);
    assert.equal(state.activeProjectId, "a");
  });

  it("handles ids that match Object.prototype members", () => {
    const state = createEmptyState();
    const names = config(["constructor", "C"], ["toString", "T"], ["hasOwnProperty", "H"]);
    const result = reconcileWithConfig(state, names, 1);
    assert.deepEqual(result.added, ["constructor", "toString", "hasOwnProperty"]);
    const [ctor, str]: string[] = ["constructor", "toString"];
    assert.deepEqual(state.spaces[ctor].tabs, []);
    assert.equal(state.spaces[str].name, "T");
    const roundTrip = migrateState(JSON.parse(JSON.stringify(state)));
    assert.deepEqual(Object.keys(roundTrip.state.spaces), ["constructor", "toString", "hasOwnProperty"]);
  });

  it("caches the config as last known good", () => {
    const state = populated();
    const next = config(["a", "Project A"]);
    reconcileWithConfig(state, next, 5000);
    assert.deepEqual(state.lastGoodConfig, next);
  });
});

describe("pruneOrphans", () => {
  it("only deletes confirmed orphans, never configured projects or the kept id", () => {
    const state = populated();
    reconcileWithConfig(state, config(["c", "Project C"]), 5000); // a and b orphaned
    const pruned = pruneOrphans(state, config(["c", "Project C"]), ["a", "b", "c"], "a");
    assert.deepEqual(pruned, ["b"]);
    assert.ok(state.spaces.a);
    assert.ok(state.spaces.c);
    assert.equal(state.spaces.b, undefined);
  });

  it("never deletes an orphan the user was not shown", () => {
    const state = populated();
    reconcileWithConfig(state, config(["c", "Project C"]), 5000); // a and b orphaned
    const pruned = pruneOrphans(state, config(["c", "Project C"]), ["b"], null);
    assert.deepEqual(pruned, ["b"]);
    assert.ok(state.spaces.a, "a was orphaned but not in the confirmed list");
  });

  it("skips a confirmed id that was re-added to the config meanwhile", () => {
    const state = populated();
    reconcileWithConfig(state, config(["a", "Project A"]), 5000); // b orphaned
    const pruned = pruneOrphans(state, config(["a", "Project A"], ["b", "B"]), ["b"], null);
    assert.deepEqual(pruned, []);
    assert.ok(state.spaces.b);
  });
});

describe("migrateState", () => {
  it("returns a fresh state when there is no data.json", () => {
    const result = migrateState(null);
    assert.equal(result.status, "fresh");
    assert.equal(result.state.stateVersion, STATE_VERSION);
  });

  it("round-trips a current-version state", () => {
    const state = populated();
    const result = migrateState(clone(state));
    assert.equal(result.status, "ok");
    assert.deepEqual(result.state, state);
  });

  it("refuses to interpret a newer version (caller must not overwrite)", () => {
    const result = migrateState({ stateVersion: STATE_VERSION + 1, spaces: {} });
    assert.equal(result.status, "newer");
  });

  it("flags unrecognized content", () => {
    assert.equal(migrateState([1, 2]).status, "unrecognized");
    assert.equal(migrateState({ projects: [] }).status, "unrecognized");
  });

  it("runs the migration chain for older versions", () => {
    // Simulate a hypothetical v0 that stored `tabsById` instead of `spaces`.
    const v0 = { stateVersion: 0, tabsById: { a: { name: "A", tabs: [mdTab("x.md")], activeTab: 0 } } };
    const result = migrateState(v0, {
      0: (raw) => ({ stateVersion: 1, spaces: raw.tabsById, activeProjectId: "a" }),
    });
    assert.equal(result.status, "migrated");
    assert.equal(result.state.activeProjectId, "a");
    assert.deepEqual(result.state.spaces.a.tabs, [mdTab("x.md")]);
  });

  it("reports a missing migration step as unrecognized instead of guessing", () => {
    assert.equal(migrateState({ stateVersion: 0 }, {}).status, "unrecognized");
  });

  it("sanitizes bad entries without throwing", () => {
    // JSON.parse creates a real own "__proto__" key (an object literal would
    // set the prototype instead), which is what a tampered data.json yields.
    const spaces = JSON.parse('{"__proto__": {"tabs": []}, "bad id": {"tabs": []}}') as Record<string, unknown>;
    const result = migrateState({
      stateVersion: 1,
      activeProjectId: 42,
      spaces: {
        ...spaces,
        good: {
          name: "Good",
          tabs: [
            { view: { type: "markdown", state: { file: "g.md" } }, leafId: "id1", eState: { scroll: 3 } },
            { view: { type: "" } },
            "garbage",
            { view: { type: "canvas", state: { file: "c.canvas" }, active: true, group: "x" } },
          ],
          activeTab: 99,
          orphanedAt: "nope",
        },
      },
      lastGoodConfig: { version: 1, projects: [{ id: "good", name: "Good" }] },
    });
    assert.equal(result.status, "ok");
    assert.equal(result.state.activeProjectId, null);
    assert.deepEqual(Object.keys(result.state.spaces), ["good"]);
    const good = result.state.spaces.good;
    assert.equal(good.tabs.length, 2);
    assert.deepEqual(good.tabs[1].view, { type: "canvas", state: { file: "c.canvas" } });
    assert.equal(good.tabs[0].eState?.scroll, 3);
    assert.equal(good.activeTab, 0);
    assert.equal(good.orphanedAt, null);
    assert.equal(result.state.lastGoodConfig?.projects[0].id, "good");
  });
});

describe("mergeCapture", () => {
  it("replaces saved tabs with the live capture", () => {
    const merged = mergeCapture([mdTab("old.md")], [mdTab("new.md")], 0, () => false);
    assert.deepEqual(merged.tabs, [mdTab("new.md")]);
    assert.equal(merged.activeTab, 0);
  });

  it("carries unopened tabs (missing file, failed view) until they are live", () => {
    const late = mdTab("late.md");
    const failed: SavedTab = { view: { type: "some-plugin-view", state: { x: 1 } } };
    const previous = [mdTab("here.md"), late, failed];
    const unopened = new Set<SavedTab>([late, failed]);
    const merged = mergeCapture(previous, [mdTab("here.md")], 0, (t) => unopened.has(t));
    assert.deepEqual(merged.tabs.map((t) => t.view.state?.file ?? t.view.type), [
      "here.md",
      "late.md",
      "some-plugin-view",
    ]);
    // Same objects survive, so "unopened" tracking by identity keeps working.
    assert.equal(merged.tabs[1], late);
  });

  it("keeps a failed plugin view of a file that is also open as Markdown", () => {
    const failed: SavedTab = { view: { type: "custom-view", state: { file: "A.md", zoom: 2 } } };
    const merged = mergeCapture([mdTab("A.md"), failed], [mdTab("A.md")], 0, (t) => t === failed);
    assert.deepEqual(merged.tabs.map((t) => t.view.type), ["markdown", "custom-view"]);
  });

  it("does not duplicate a kept tab that is now open", () => {
    const late = mdTab("late.md");
    const merged = mergeCapture([late], [mdTab("late.md")], 0, () => true);
    assert.equal(merged.tabs.length, 1);
  });

  it("an empty live capture saves an empty list (user closed everything)", () => {
    const merged = mergeCapture([mdTab("a.md")], [], -1, () => false);
    assert.deepEqual(merged.tabs, []);
    assert.equal(merged.activeTab, -1);
  });
});

describe("remapPath / removePath", () => {
  it("rewrites file and folder renames in every space", () => {
    const state = populated();
    state.spaces.b.tabs.push(mdTab("Folder/deep/x.md"));
    assert.equal(remapPath(state, "A1.md", "Renamed.md"), 1);
    assert.equal(state.spaces.a.tabs[0].view.state?.file, "Renamed.md");
    assert.equal(remapPath(state, "Folder", "Moved"), 1);
    assert.equal(state.spaces.b.tabs[3].view.state?.file, "Moved/deep/x.md");
    assert.equal(state.spaces.b.tabs[3].view.state?.mode, "source");
  });

  it("does not treat a name prefix as a folder", () => {
    const state = populated();
    state.spaces.a.tabs.push(mdTab("Folder2/y.md"));
    assert.equal(remapPath(state, "Folder", "Moved"), 0);
  });

  it("removes deleted files and keeps the active tab pointing at the same tab", () => {
    const state = populated(); // a: A1 A2(active) A3 A4
    assert.equal(removePath(state, "A1.md"), 1);
    assert.equal(state.spaces.a.tabs.length, 3);
    assert.equal(state.spaces.a.tabs[state.spaces.a.activeTab].view.state?.file, "A2.md");
  });
});

describe("initialActiveProject", () => {
  it("keeps a persisted active project that still has a space", () => {
    const state = populated();
    assert.equal(initialActiveProject(state, config(["b", "B"])), "a");
  });

  it("falls back to the first configured project, or null", () => {
    const state = createEmptyState();
    assert.equal(initialActiveProject(state, config(["x", "X"], ["y", "Y"])), "x");
    assert.equal(initialActiveProject(state, config()), null);
  });
});
