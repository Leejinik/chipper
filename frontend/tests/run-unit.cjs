// Bundles tags-unit.ts with esbuild (from vite's node_modules) and runs it in node.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chipper-unit-")), "tags-unit.cjs");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "tags-unit.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  logLevel: "warning",
});
try {
  execFileSync(process.execPath, [out], { stdio: "inherit" });
} catch (e) {
  process.exit(1);
}
