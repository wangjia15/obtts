import esbuild from "esbuild";
import process from "process";
import { createRequire } from "module";
import builtins from "builtin-modules";

const prod = process.argv.includes("--production");

// Force the Node codepath of `ws` (its `main` field, not the `browser` shim) so the
// bundled WebSocket client can set the Origin/User-Agent headers the Edge endpoint
// requires. The renderer's native browser WebSocket cannot set those headers.
const require = createRequire(import.meta.url);
const wsNodeEntry = require.resolve("ws");

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  alias: { ws: wsNodeEntry },
  define: { global: "globalThis" },
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  platform: "browser",
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
