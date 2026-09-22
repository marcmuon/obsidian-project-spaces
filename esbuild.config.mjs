import esbuild from "esbuild";
import process from "node:process";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Provided by Obsidian at runtime. Nothing else may be external: the plugin
  // has no runtime dependencies and must not load Node/Electron modules.
  external: ["obsidian"],
  format: "cjs",
  platform: "browser",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  legalComments: "none",
  outfile: "main.js",
});

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
