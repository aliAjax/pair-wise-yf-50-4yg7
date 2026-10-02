#!/usr/bin/env node
// 本地修订账语义验证入口：esbuild 打包后在 Node 中执行（避免 TS 与 ~ 别名问题）。
// 用法：node scripts/verify.mjs
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = ["verify-ledger.mjs", "verify-store.mjs"].map((f) => path.join(root, "scripts", f));
const outDir = path.join(root, "node_modules", ".verify");

for (const entry of targets) {
  const out = path.join(outDir, path.basename(entry).replace(".mjs", ".bundle.mjs"));
  await build({
    entryPoints: [entry], bundle: true, platform: "node", format: "esm",
    outfile: out, absWorkingDir: root, alias: { "~": root }, logLevel: "warning"
  });
  console.log(`\n=== ${path.basename(entry)} ===`);
  try {
    execFileSync(process.execPath, [out], { stdio: "inherit", cwd: root });
  } catch {
    rmSync(outDir, { recursive: true, force: true });
    process.exit(1);
  }
}
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
