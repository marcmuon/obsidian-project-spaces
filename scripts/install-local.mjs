// Copies the built plugin into a vault:
//   <vault>/.obsidian/plugins/project-spaces/{main.js,manifest.json,styles.css}
//
//   npm run install:local                 vault from dev.local.json (gitignored)
//   npm run install:local -- --vault DIR  explicit vault (e.g. .sandbox-vault)
//
// Builds first if main.js is missing or older than the sources, and refuses to
// install if the security check fails. Any existing copy (including the
// runtime state in data.json) is backed up to .install-backups/ in this repo,
// outside the vault so it is never synced. data.json itself is never touched.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

const ARTIFACTS = ["main.js", "manifest.json", "styles.css"];
const KEEP_BACKUPS = 10;

function fail(message) {
  console.error(`install:local: ${message}`);
  process.exit(1);
}

function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.status !== 0) fail(`step failed: node ${args.join(" ")}`);
}

function vaultPath() {
  const flag = process.argv.indexOf("--vault");
  if (flag !== -1) {
    const value = process.argv[flag + 1];
    if (!value) fail("--vault needs a path");
    return resolve(value);
  }
  if (!existsSync("dev.local.json")) {
    fail(
      'no dev.local.json. Create it (it is gitignored):\n  { "vaultPath": "/absolute/path/to/vault" }'
    );
  }
  const { vaultPath: path } = JSON.parse(readFileSync("dev.local.json", "utf8"));
  if (typeof path !== "string" || path === "") fail('dev.local.json needs a "vaultPath" string');
  return resolve(path);
}

function newestSourceMtime() {
  const files = [
    ...readdirSync("src").map((f) => join("src", f)),
    "styles.css",
    "manifest.json",
    "esbuild.config.mjs",
    "package.json",
  ];
  return Math.max(...files.map((f) => statSync(f).mtimeMs));
}

const vault = vaultPath();
if (!existsSync(join(vault, ".obsidian"))) {
  fail(`${vault} is not an Obsidian vault (no .obsidian folder)`);
}

if (!existsSync("main.js") || statSync("main.js").mtimeMs < newestSourceMtime()) {
  console.log("Building (main.js missing or stale)...");
  run(["esbuild.config.mjs", "production"]);
}
run(["scripts/security-check.mjs"]);

const { id } = JSON.parse(readFileSync("manifest.json", "utf8"));
const target = join(vault, ".obsidian", "plugins", id);

const existing = existsSync(target)
  ? readdirSync(target).filter((f) => statSync(join(target, f)).isFile())
  : [];
if (existing.length > 0) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = join(".install-backups", basename(vault));
  const backup = join(backupRoot, stamp);
  mkdirSync(backup, { recursive: true });
  for (const file of existing) copyFileSync(join(target, file), join(backup, file));
  console.log(`Backed up existing ${target} (${existing.join(", ")}) -> ${backup}`);
  // Keep only the newest backups for this vault.
  const old = readdirSync(backupRoot).sort().slice(0, -KEEP_BACKUPS);
  for (const dir of old) rmSync(join(backupRoot, dir), { recursive: true, force: true });
}

mkdirSync(target, { recursive: true });
for (const file of ARTIFACTS) copyFileSync(file, join(target, file));
console.log(`Installed ${ARTIFACTS.join(", ")} -> ${target}`);
console.log(
  [
    "",
    "Next, in Obsidian (first time): Settings -> Community plugins -> enable \"Project Spaces\".",
    "After a code change, reload the plugin with either:",
    "  Settings -> Community plugins -> toggle Project Spaces off and on",
    `  /Applications/Obsidian.app/Contents/MacOS/obsidian-cli plugin:reload id=${id}`,
  ].join("\n")
);
