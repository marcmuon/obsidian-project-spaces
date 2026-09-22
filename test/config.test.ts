import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { EMPTY_CONFIG_TEXT, parseConfig, resolveConfig, sanitizeCachedConfig } from "../src/config";

function ok(text: string) {
  const result = parseConfig(text);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.config;
}

function err(text: string): string {
  const result = parseConfig(text);
  if (result.ok) throw new Error("expected an error");
  return result.error;
}

describe("parseConfig", () => {
  it("parses a valid config and keeps array order", () => {
    const config = ok(
      JSON.stringify({
        version: 1,
        projects: [
          { id: "project-b", name: "Project B" },
          { id: "project-a", name: "Project A" },
          { id: "research", name: "Research" },
        ],
      })
    );
    assert.deepEqual(
      config.projects.map((p) => p.id),
      ["project-b", "project-a", "research"]
    );
    assert.equal(config.projects[0].name, "Project B");
  });

  it("defaults name to id and trims names", () => {
    const config = ok('{"version":1,"projects":[{"id":"a"},{"id":"b","name":"  B  "}]}');
    assert.equal(config.projects[0].name, "a");
    assert.equal(config.projects[1].name, "B");
  });

  it("accepts an empty project list", () => {
    assert.deepEqual(ok('{"version":1,"projects":[]}').projects, []);
  });

  it("ignores unknown keys", () => {
    const config = ok('{"version":1,"extra":true,"projects":[{"id":"a","color":"red"}]}');
    assert.deepEqual(config.projects, [{ id: "a", name: "a" }]);
  });

  it("rejects malformed JSON with a readable message", () => {
    assert.match(err('{"version":1,'), /Invalid JSON/);
  });

  it("rejects wrong or missing version", () => {
    assert.match(err('{"projects":[]}'), /Unsupported "version"/);
    assert.match(err('{"version":2,"projects":[]}'), /Unsupported "version": 2/);
  });

  it("rejects non-object roots and non-array projects", () => {
    assert.match(err("[]"), /Top level/);
    assert.match(err('{"version":1,"projects":{}}'), /must be an array/);
  });

  it("rejects duplicate ids", () => {
    assert.match(err('{"version":1,"projects":[{"id":"a"},{"id":"a"}]}'), /Duplicate project id "a"/);
  });

  it("rejects unsafe or empty ids and empty names", () => {
    assert.match(err('{"version":1,"projects":[{"id":""}]}'), /projects\[0\]\.id/);
    assert.match(err('{"version":1,"projects":[{"id":"__proto__"}]}'), /projects\[0\]\.id/);
    assert.match(err('{"version":1,"projects":[{"id":"has space"}]}'), /projects\[0\]\.id/);
    assert.match(err('{"version":1,"projects":[{"id":"a","name":"  "}]}'), /name must be/);
    assert.match(err('{"version":1,"projects":["a"]}'), /must be an object/);
  });

  it("the template written for a missing file is valid and has no projects", () => {
    assert.deepEqual(ok(EMPTY_CONFIG_TEXT).projects, []);
  });
});

describe("sanitizeCachedConfig", () => {
  it("round-trips a valid cached config", () => {
    const config = ok('{"version":1,"projects":[{"id":"a","name":"A"}]}');
    assert.deepEqual(sanitizeCachedConfig(config), config);
  });

  it("returns null for missing or broken cache", () => {
    assert.equal(sanitizeCachedConfig(undefined), null);
    assert.equal(sanitizeCachedConfig({ version: 1, projects: "nope" }), null);
  });
});

describe("resolveConfig (invalid config keeps last known good)", () => {
  const lastGood = ok('{"version":1,"projects":[{"id":"a","name":"A"},{"id":"b","name":"B"}]}');

  it("uses the file when it is valid", () => {
    const resolved = resolveConfig('{"version":1,"projects":[{"id":"c"}]}', lastGood);
    assert.equal(resolved.error, null);
    assert.equal(resolved.fromFile, true);
    assert.deepEqual(resolved.config.projects.map((p) => p.id), ["c"]);
  });

  it("keeps the last known good config when the file is broken", () => {
    const resolved = resolveConfig('{"version":1,"projects":[{"id":"a"', lastGood);
    assert.match(resolved.error ?? "", /Invalid JSON/);
    assert.equal(resolved.fromFile, false);
    assert.deepEqual(resolved.config, lastGood);
  });

  it("keeps the last known good config when the file is missing", () => {
    const resolved = resolveConfig(null, lastGood);
    assert.match(resolved.error ?? "", /not found/);
    assert.deepEqual(resolved.config, lastGood);
  });

  it("falls back to no projects when nothing valid was ever loaded", () => {
    const resolved = resolveConfig("not json", null);
    assert.deepEqual(resolved.config.projects, []);
    assert.equal(resolved.fromFile, false);
  });
});
