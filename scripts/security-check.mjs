// Fails if runtime code contains networking, process execution, dynamic code
// or Node/Electron access. Scans the TypeScript sources AND the built bundle
// (so a dependency or build step can't sneak something in), plus styles.css
// (a CSS url()/@import would make a network request).
//
// Docs (README, docs/) may contain links; only runtime files are scanned.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const JS_RULES = [
  [/\brequestUrl\b/, "Obsidian requestUrl (network)"],
  [/\bfetch\s*\(/, "fetch() (network)"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest (network)"],
  [/\bWebSocket\b/, "WebSocket (network)"],
  [/\bEventSource\b/, "EventSource (network)"],
  [/\bsendBeacon\b/, "navigator.sendBeacon (network)"],
  [/\bchild_process\b/, "child_process (process execution)"],
  [/\bexec(Sync|File)?\s*\(/, "exec() (process execution)"],
  [/\bspawn(Sync)?\s*\(/, "spawn() (process execution)"],
  [/\beval\s*\(/, "eval()"],
  [/\bnew\s+Function\b/, "new Function()"],
  [/\bopenExternal\b/, "shell.openExternal"],
  [/\bopenWithDefaultApp\b/, "openWithDefaultApp (launches apps)"],
  [/\bwindow\.open\s*\(/, "window.open"],
  [/\bwindow\.require\b/, "window.require (Node access)"],
  [/\belectron\b/, "electron module"],
  [/\bimport\s*\(/, "dynamic import()"],
  [/\bnew\s+Worker\s*\(/, "Web Worker"],
  [/https?:\/\//, "http(s) URL"],
  // CommonJS require is only allowed for the "obsidian" module the bundle is
  // built against (esbuild emits require("obsidian")).
  [/\brequire\s*\(\s*(?!["']obsidian["']\s*\))/, 'require() of anything but "obsidian"'],
];

const CSS_RULES = [
  [/@import\b/i, "@import (network)"],
  [/\burl\s*\(/i, "url() (network)"],
  [/https?:\/\//i, "http(s) URL"],
];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const targets = [
  ...walk("src").filter((p) => p.endsWith(".ts")).map((p) => [p, JS_RULES]),
  ["styles.css", CSS_RULES],
];
if (existsSync("main.js")) {
  targets.push(["main.js", JS_RULES]);
} else {
  console.error("security:check: main.js not found; run `npm run build` first.");
  process.exit(1);
}

let failures = 0;
for (const [file, rules] of targets) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const [pattern, label] of rules) {
      if (pattern.test(line)) {
        failures++;
        console.error(`${file}:${i + 1}: ${label}\n    ${line.trim().slice(0, 160)}`);
      }
    }
  });
}

if (failures > 0) {
  console.error(`\nsecurity:check FAILED (${failures} finding(s)).`);
  process.exit(1);
}
console.log(`security:check passed (${targets.length} files scanned: src/*.ts, styles.css, main.js).`);
