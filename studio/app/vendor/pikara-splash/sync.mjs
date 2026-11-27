#!/usr/bin/env node
// pikara-splash sharing tool. The single source of truth is CreateYourWorld/crates/pikara-splash.
//
//   node crates/pikara-splash/sync.mjs --build
//       compile web/src/pikara-splash.ts → web/dist/pikara-splash.js (+ .d.ts) and copy splash.css
//   node crates/pikara-splash/sync.mjs --to <app-dir>
//       vendor the crate + built web files into another app, as described by
//       <app-dir>/pikara-splash.vendor.json  { "rust": "vendor/pikara-splash", "web": "src/vendor/pikara-splash" }
//       and record version, source commit and file hashes in that manifest
//   node <vendored-rust-dir>/sync.mjs --check <app-dir>
//       verify that nobody edited the vendored copy (hashes must match the manifest); exit 1 otherwise
//
// No dependencies besides Node ≥ 18 (and TypeScript from the CYW checkout for --build).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

const RUST_FILES = ["Cargo.toml", "build.rs", "src", "permissions", "README.md", "sync.mjs"];
const WEB_FILES = ["pikara-splash.js", "pikara-splash.d.ts", "splash.css"];

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const posix = (p) => p.split(sep).join("/");

function walk(p, out = []) {
  if (statSync(p).isDirectory()) for (const n of readdirSync(p)) walk(join(p, n), out);
  else out.push(p);
  return out;
}

function build() {
  const web = join(HERE, "web");
  const tsc = ["../../node_modules/typescript/bin/tsc", "../../../node_modules/typescript/bin/tsc"].map((p) => resolve(HERE, p)).find(existsSync);
  if (!tsc) throw new Error("TypeScript not found: run npm install in the CreateYourWorld checkout");
  execFileSync(process.execPath, [tsc, "-p", join(web, "tsconfig.json")], { stdio: "inherit" });
  copyFileSync(join(web, "splash.css"), join(web, "dist", "splash.css"));
  console.log("built", posix(relative(process.cwd(), join(web, "dist"))));
}

function sourceCommit() {
  try {
    const c = execFileSync("git", ["-C", HERE, "log", "-1", "--format=%H", "--", "."], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["-C", HERE, "status", "--porcelain", "--", "."], { encoding: "utf8" }).trim();
    return dirty ? `${c}+local-changes` : c;
  } catch {
    return "unknown";
  }
}

function vendor(appDir) {
  const manifestPath = join(appDir, "pikara-splash.vendor.json");
  if (!existsSync(manifestPath)) throw new Error(`missing ${manifestPath} ({"rust": "...", "web": "..."})`);
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  const rustDst = join(appDir, m.rust);
  const webDst = join(appDir, m.web);
  build();
  for (const d of [rustDst, webDst]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); }
  const files = {};
  for (const f of RUST_FILES) {
    for (const src of walk(join(HERE, f))) {
      const rel = relative(HERE, src);
      const dst = join(rustDst, rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      files[posix(join(m.rust, rel))] = sha(dst);
    }
  }
  for (const f of WEB_FILES) {
    const dst = join(webDst, f);
    copyFileSync(join(HERE, "web", "dist", f), dst);
    files[posix(join(m.web, f))] = sha(dst);
  }
  const version = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(HERE, "Cargo.toml"), "utf8"))[1];
  const out = { rust: m.rust, web: m.web, version, source: "github.com/eddiesu9420minecraft-wq/CreateYourWorld/crates/pikara-splash", sourceCommit: sourceCommit(), files };
  writeFileSync(manifestPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`vendored pikara-splash ${version} (${out.sourceCommit.slice(0, 12)}) → ${Object.keys(files).length} files`);
}

function check(appDir) {
  const m = JSON.parse(readFileSync(join(appDir, "pikara-splash.vendor.json"), "utf8"));
  const bad = [];
  for (const [rel, h] of Object.entries(m.files || {})) {
    const p = join(appDir, rel);
    if (!existsSync(p)) bad.push(`missing  ${rel}`);
    else if (sha(p) !== h) bad.push(`modified ${rel}`);
  }
  if (bad.length) {
    console.error(`pikara-splash vendored copy differs from ${m.sourceCommit}:\n  ${bad.join("\n  ")}\nEdit the source in CreateYourWorld/crates/pikara-splash and re-run sync.mjs --to.`);
    process.exit(1);
  }
  console.log(`pikara-splash ${m.version} vendored copy OK (${Object.keys(m.files).length} files, source ${m.sourceCommit.slice(0, 12)})`);
}

if (flag("--build")) build();
else if (opt("--to")) vendor(resolve(opt("--to")));
else if (opt("--check")) check(resolve(opt("--check")));
else {
  console.log("usage: sync.mjs --build | --to <app-dir> | --check <app-dir>");
  process.exit(2);
}
