import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = dirname(fileURLToPath(import.meta.url));
const outputPath = join(pluginDir, "main.js");
const checkOnly = process.argv.includes("--check");

const result = await build({
  absWorkingDir: pluginDir,
  entryPoints: ["src/main.js"],
  outfile: outputPath,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: [
    "obsidian",
    "electron",
    "@codemirror/view",
  ],
  charset: "utf8",
  legalComments: "none",
  minify: false,
  sourcemap: false,
  write: !checkOnly,
});

if (checkOnly) {
  const expected = result.outputFiles?.[0]?.contents;
  const current = await readFile(outputPath);
  if (!expected || Buffer.compare(Buffer.from(expected), current) !== 0) {
    throw new Error(
      "main.js is out of date. Run `npm run build` in the plugin directory."
    );
  }
  console.log("lacan translation helper bundle is up to date");
}
