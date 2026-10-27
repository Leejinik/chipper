// Bundles the unit test files with esbuild (from vite's node_modules) and runs it in node.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));

// tags-unit.ts (stage 3) and assign-unit.ts (stage 4)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chipper-unit-"));
let failed = false;
for (const name of ["tags-unit", "assign-unit"]) {
  const out = path.join(dir, name + ".cjs");
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, name + ".ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: out,
    logLevel: "warning",
  });
  try {
    execFileSync(process.execPath, [out], { stdio: "inherit" });
  } catch (e) {
    failed = true;
  }
}
if (failed) process.exit(1);
