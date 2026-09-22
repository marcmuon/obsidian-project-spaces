// Fails if runtime code contains networking, process execution, dynamic code
// or Node/Electron access. Runtime code = the TypeScript sources AND the built
// bundle (so a dependency or build step can't sneak something in), plus
// styles.css (a CSS url()/@import would make a network request).
//
// Two passes:
// 1. Line regexes (catch URLs, CSS and obvious calls, even in comments).
// 2. A syntax-tree pass with the TypeScript parser that catches references
//    rather than just calls: aliasing (`const f = fetch`), `Function(...)`
//    without `new`, computed access on global objects (`window[name]`),
//    Reflect, dynamic import(), string-evaluated timers, network-capable DOM.
// Before scanning, the checker runs itself against known-bad snippets
// (self-test) so a weakened rule fails loudly.
//
// Docs (README, docs/) may contain links; only runtime files are scanned.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// ---------------------------------------------------------------------------
// Pass 1: line regexes
// ---------------------------------------------------------------------------

const JS_LINE_RULES = [
  [/\brequestUrl\b/, "Obsidian requestUrl (network)"],
  [/\bfetch\b/, "fetch (network)"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest (network)"],
  [/\bWebSocket\b/, "WebSocket (network)"],
  [/\bEventSource\b/, "EventSource (network)"],
  [/\bsendBeacon\b/, "navigator.sendBeacon (network)"],
  [/\bchild_process\b/, "child_process (process execution)"],
  [/\bexec(Sync|File)?\s*\(/, "exec() (process execution)"],
  [/\bspawn(Sync)?\s*\(/, "spawn() (process execution)"],
  [/\beval\b/, "eval"],
  [/\bFunction\s*\(/, "Function() constructor"],
  [/\bopenExternal\b/, "shell.openExternal"],
  [/\bopenWithDefaultApp\b/, "openWithDefaultApp (launches apps)"],
  [/\bwindow\.open\s*\(/, "window.open"],
  [/\bwindow\.require\b/, "window.require (Node access)"],
  [/\belectron\b/, "electron module"],
  [/\bimport\s*\(/, "dynamic import()"],
  [/\bnew\s+(Shared)?Worker\s*\(/, "Web Worker"],
  [/\b(https?|wss?):\/\//, "URL"],
  // CommonJS require is only allowed for the "obsidian" module the bundle is
  // built against (esbuild emits require("obsidian")).
  [/\brequire\s*\(\s*(?!["']obsidian["']\s*\))/, 'require() of anything but "obsidian"'],
];

const CSS_LINE_RULES = [
  [/@import\b/i, "@import (network)"],
  [/\burl\s*\(/i, "url() (network)"],
  [/(https?|wss?):\/\//i, "URL"],
];

function lineFindings(text, rules) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    for (const [pattern, label] of rules) {
      if (pattern.test(line)) out.push({ line: i + 1, label, text: line.trim() });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Pass 2: syntax tree
// ---------------------------------------------------------------------------

/** Globals that must never be referenced at all. */
const FORBIDDEN_GLOBALS = new Set([
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Function", "eval",
  "process", "Buffer", "globalThis", "Reflect", "importScripts", "Worker",
  "SharedWorker", "requestUrl", "request", "electron",
]);

/** Property names that must never be accessed (obj.x or obj["x"]). */
const FORBIDDEN_PROPS = new Set([
  "requestUrl", "request", "openExternal", "openWithDefaultApp", "showInFolder",
  "sendBeacon", "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "require",
  "eval", "Function", "child_process", "exec", "execSync", "execFile", "spawn",
  "spawnSync", "fork", "getBasePath", "getFullPath", "fsPromises", "readLocalFile",
  "importScripts",
]);

/** Objects whose computed members (obj[expr]) could reach anything global. */
const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self", "top", "parent", "frames"]);

/** Elements that load remote resources by themselves. */
const LOADING_TAGS = new Set(["script", "iframe", "img", "link", "object", "embed", "audio", "video", "source", "frame"]);

/** Attributes/properties that make an element load a URL. */
const LOADING_ATTRS = new Set(["src", "href", "srcdoc", "srcset", "formAction"]);

function stringValue(node) {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  return null;
}

function astFindings(text, fileName) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out = [];
  const flag = (node, label) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    out.push({ line: line + 1, label, text: node.getText(source).slice(0, 120) });
  };

  const visit = (node) => {
    if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text)) {
      const parent = node.parent;
      const isMemberName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node) ||
        (ts.isPropertyDeclaration(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node);
      if (!isMemberName) flag(node, `reference to ${node.text}`);
    }
    if (ts.isIdentifier(node) && node.text === "require") {
      const call = node.parent;
      const allowed =
        ts.isCallExpression(call) &&
        call.expression === node &&
        call.arguments.length === 1 &&
        stringValue(call.arguments[0]) === "obsidian";
      const isMemberName = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
      if (!allowed && !isMemberName) flag(node, 'require of anything but "obsidian"');
    }
    if (ts.isPropertyAccessExpression(node) && FORBIDDEN_PROPS.has(node.name.text)) {
      flag(node, `access to .${node.name.text}`);
    }
    // Members of global objects: window.open, window.Worker, self.process...
    // (Modal.open() etc. on ordinary objects are fine.)
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_OBJECTS.has(node.expression.text) &&
      (node.name.text === "open" || FORBIDDEN_GLOBALS.has(node.name.text))
    ) {
      flag(node, `${node.expression.text}.${node.name.text}`);
    }
    if (ts.isElementAccessExpression(node)) {
      const key = stringValue(node.argumentExpression);
      if (key !== null && (FORBIDDEN_PROPS.has(key) || FORBIDDEN_GLOBALS.has(key))) {
        flag(node, `computed access to "${key}"`);
      }
      if (
        key === "open" &&
        ts.isIdentifier(node.expression) &&
        GLOBAL_OBJECTS.has(node.expression.text)
      ) {
        flag(node, `${node.expression.text}["open"]`);
      }
      if (
        key === null &&
        ts.isIdentifier(node.expression) &&
        GLOBAL_OBJECTS.has(node.expression.text)
      ) {
        flag(node, `computed access on ${node.expression.text}`);
      }
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) flag(node, "dynamic import()");
      if (ts.isIdentifier(node.expression) && node.expression.text === "open") flag(node, "global open()");
      const callee = node.expression;
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      const first = node.arguments[0];
      if (
        (calleeName === "setTimeout" || calleeName === "setInterval") &&
        first &&
        (ts.isStringLiteralLike(first) || ts.isTemplateExpression(first))
      ) {
        flag(node, `${calleeName} with a string (eval)`);
      }
      if ((calleeName === "createElement" || calleeName === "createEl") && LOADING_TAGS.has(stringValue(first))) {
        flag(node, `creates <${stringValue(first)}> (loads remote resources)`);
      }
      if ((calleeName === "setAttribute" || calleeName === "setAttr") && LOADING_ATTRS.has(stringValue(first))) {
        flag(node, `sets ${stringValue(first)} attribute (loads a URL)`);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      LOADING_ATTRS.has(node.left.name.text)
    ) {
      flag(node, `assigns .${node.left.name.text} (loads a URL)`);
    }
    if (ts.isStringLiteralLike(node) && /(https?|wss?):\/\/|child_process|^node:|electron/.test(node.text)) {
      flag(node, "suspicious string literal");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

// ---------------------------------------------------------------------------
// Self-test: every snippet must be flagged, every clean snippet must not.
// ---------------------------------------------------------------------------

const MUST_FLAG = [
  "const network = fetch; network(url);",
  "Function('return 1')();",
  "new Function('x', 'return x');",
  "Reflect.get(window, 'require')('node:fs');",
  "window['fe' + 'tch'](u);",
  "globalThis.fetch(u);",
  "const r = window.require; r('child_process');",
  "import('./x.js');",
  "setTimeout('alert(1)', 10);",
  "document.createElement('script');",
  "img.src = u;",
  "(0, eval)('1');",
  "obsidian.requestUrl({ url });",
  "const { requestUrl } = api;",
  "app.openWithDefaultApp(p);",
  "require('fs');",
  "window.open(u);",
  "open(u);",
  "const W = window.Worker; new W(u);",
  "const env = window.process.env;",
  "window['open'](u);",
  "self.fetch(u);",
];
const MUST_PASS = [
  'var import_obsidian = require("obsidian");',
  "window.setTimeout(() => {}, 10);",
  "state.spaces[id] = space;",
  "this.app.workspace.requestSaveLayout();",
  "el.createDiv({ cls: 'x', attr: { 'aria-label': 'y' } });",
  "new SomeModal(app).open();",
  "state.data = { tabs: [] };",
  "task.action = 'save';",
];

function checkAll(text, fileName) {
  return [...lineFindings(text, JS_LINE_RULES), ...astFindings(text, fileName)];
}

let selfTestFailures = 0;
for (const snippet of MUST_FLAG) {
  if (checkAll(snippet, "self-test.ts").length === 0) {
    selfTestFailures++;
    console.error(`self-test: NOT flagged (checker too weak): ${snippet}`);
  }
}
for (const snippet of MUST_PASS) {
  const found = checkAll(snippet, "self-test.ts");
  if (found.length > 0) {
    selfTestFailures++;
    console.error(`self-test: false positive on: ${snippet} (${found.map((f) => f.label).join(", ")})`);
  }
}
if (selfTestFailures > 0) {
  console.error(`\nsecurity:check self-test FAILED (${selfTestFailures}).`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

if (!existsSync("main.js")) {
  console.error("security:check: main.js not found; run `npm run build` first.");
  process.exit(1);
}
const jsFiles = [...walk("src").filter((p) => p.endsWith(".ts")), "main.js"];

let failures = 0;
const report = (file, findings) => {
  for (const f of findings) {
    failures++;
    console.error(`${file}:${f.line}: ${f.label}\n    ${f.text}`);
  }
};
for (const file of jsFiles) report(file, checkAll(readFileSync(file, "utf8"), file));
report("styles.css", lineFindings(readFileSync("styles.css", "utf8"), CSS_LINE_RULES));

if (failures > 0) {
  console.error(`\nsecurity:check FAILED (${failures} finding(s)).`);
  process.exit(1);
}
console.log(
  `security:check passed: self-test ${MUST_FLAG.length}+${MUST_PASS.length} ok; ` +
    `${jsFiles.length + 1} files scanned (src/*.ts, main.js, styles.css).`
);
