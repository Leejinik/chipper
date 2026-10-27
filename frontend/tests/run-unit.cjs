// Bundles each tests/*-unit.ts with esbuild (from vite's node_modules) and runs it in node.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chipper-unit-"));
let failed = false;
for (const f of fs.readdirSync(__dirname).filter((f) => f.endsWith("-unit.ts")).sort()) {
  const out = path.join(dir, f.replace(/\.ts$/, ".cjs"));
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, f)],
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
