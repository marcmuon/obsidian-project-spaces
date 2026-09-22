// Bundles test/*.test.ts with esbuild (already a dev dependency) and runs them
// with Node's built-in test runner. Tests cover the pure modules only
// (config.ts, state.ts); workspace behavior is covered by manual acceptance
// tests (see docs/ARCHITECTURE.md).
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import esbuild from "esbuild";

const outdir = ".test-build";
rmSync(outdir, { recursive: true, force: true });
const entries = readdirSync("test")
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => join("test", f));

await esbuild.build({
  entryPoints: entries,
  bundle: true,
  platform: "node",
  format: "esm",
  outdir,
  outExtension: { ".js": ".mjs" },
  logLevel: "warning",
});

const files = readdirSync(outdir).map((f) => join(outdir, f));
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
