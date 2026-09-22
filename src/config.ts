// Pure parsing/validation of ProjectSpaces.config.json. No Obsidian imports so
// it can be unit-tested in plain Node.
//
// The config file is the ONLY source of the project taxonomy. Never hardcode
// project ids or names anywhere in the source.

/** Vault-relative path of the human-edited taxonomy file (vault root). */
export const CONFIG_PATH = "ProjectSpaces.config.json";

/** The config schema version this build understands. */
export const CONFIG_VERSION = 1;

/**
 * Allowed project ids: letters, digits, `-`, `_`, `.`; must start with a letter
 * or digit; at most 64 characters. Keeps ids safe as object keys (no
 * `__proto__`) and readable in data.json.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidProjectId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id);
}

export interface ProjectConfigEntry {
  /** Stable identity. Runtime state is keyed by this. */
  id: string;
  /** Display name only. Defaults to the id when omitted. */
  name: string;
}

export interface ProjectConfig {
  version: 1;
  /** Array order is sidebar order. */
  projects: ProjectConfigEntry[];
}

export type ConfigParseResult =
  | { ok: true; config: ProjectConfig }
  | { ok: false; error: string };

/** Written when "Open configuration" finds no file. No project names here. */
export const EMPTY_CONFIG_TEXT =
  JSON.stringify({ version: CONFIG_VERSION, projects: [] }, null, 2) + "\n";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse and validate config text. Never throws; on any problem returns a
 * human-readable error so the caller can keep the last known good config.
 * Unknown keys are ignored for forward compatibility.
 */
export function parseConfig(text: string): ConfigParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Invalid JSON: ${detail}` };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, error: "Top level must be a JSON object." };
  }
  if (raw.version !== CONFIG_VERSION) {
    return {
      ok: false,
      error: `Unsupported "version": ${JSON.stringify(raw.version)} (expected ${CONFIG_VERSION}).`,
    };
  }
  if (!Array.isArray(raw.projects)) {
    return { ok: false, error: `"projects" must be an array.` };
  }

  const projects: ProjectConfigEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.projects.length; i++) {
    const entry: unknown = raw.projects[i];
    const where = `projects[${i}]`;
    if (!isPlainObject(entry)) {
      return { ok: false, error: `${where} must be an object.` };
    }
    const id = entry.id;
    if (!isValidProjectId(id)) {
      return {
        ok: false,
        error:
          `${where}.id must be a string of letters, digits, "-", "_" or "." ` +
          `(starting with a letter or digit, max 64 chars); got ${JSON.stringify(id)}.`,
      };
    }
    if (seen.has(id)) {
      return { ok: false, error: `Duplicate project id "${id}".` };
    }
    seen.add(id);
    let name = id;
    if (entry.name !== undefined) {
      if (typeof entry.name !== "string" || entry.name.trim() === "") {
        return { ok: false, error: `${where}.name must be a non-empty string.` };
      }
      name = entry.name.trim();
    }
    projects.push({ id, name });
  }
  return { ok: true, config: { version: CONFIG_VERSION, projects } };
}

export interface ResolvedConfig {
  /** The config to use: the file's if valid, else the last known good one. */
  config: ProjectConfig;
  /** Why the file could not be used, or null when it was valid. */
  error: string | null;
  /** True when `config` came from the file (state may be reconciled). */
  fromFile: boolean;
}

/**
 * Decide which config to use given the file text (null = file missing) and
 * the last known good config. A missing or invalid file NEVER replaces the
 * last good config, so a typo cannot hide projects or touch their state.
 */
export function resolveConfig(
  text: string | null,
  lastGood: ProjectConfig | null
): ResolvedConfig {
  const fallback = lastGood ?? { version: CONFIG_VERSION, projects: [] };
  if (text === null) {
    return {
      config: fallback,
      error: `${CONFIG_PATH} not found. Run "Project Spaces: Open configuration" to create it.`,
      fromFile: false,
    };
  }
  const result = parseConfig(text);
  if (!result.ok) return { config: fallback, error: result.error, fromFile: false };
  return { config: result.config, error: null, fromFile: true };
}

/**
 * Re-validate a config previously cached in data.json. Returns null when the
 * cached value is unusable (never throws).
 */
export function sanitizeCachedConfig(value: unknown): ProjectConfig | null {
  if (value === null || value === undefined) return null;
  const result = parseConfig(JSON.stringify(value));
  return result.ok ? result.config : null;
}
