#!/usr/bin/env node
/**
 * prepack 闸门：防止 TS 源码改了但 dist/index.cjs 没重新构建导致的静默失效事故。
 * 重新计算源码 hash，与构建时记录的 hash 比对，不一致就报错。
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "src");
const MANIFEST_PATH = path.join(ROOT, "manifest.json");
const SOURCE_HASH_PATH = path.join(ROOT, "dist", ".source-hash");
const OUT_CJS = path.join(ROOT, "dist", "plugin", "ripples-of-aion", "index.cjs");

async function sha256File(filePath) {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function hashDirectory(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  let hash = createHash("sha256");
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const subHash = await hashDirectory(full, relative);
      hash.update(`${relative}/:${subHash}\n`);
    } else if (entry.isFile()) {
      const fileHash = await sha256File(full);
      hash.update(`${relative}:${fileHash}\n`);
    }
  }
  return hash.digest("hex");
}

async function computeSourceHash() {
  const srcHash = await hashDirectory(SRC_DIR);
  const manifestHash = await sha256File(MANIFEST_PATH);
  return createHash("sha256").update(srcHash).update(manifestHash).digest("hex");
}

async function main() {
  try {
    await stat(OUT_CJS);
  } catch {
    console.error("[check-sync] 失败：缺少 dist/plugin/ripples-of-aion/index.cjs，请先运行 npm run build");
    process.exit(1);
  }

  let savedHash;
  try {
    savedHash = (await readFile(SOURCE_HASH_PATH, "utf8")).trim();
  } catch {
    console.error("[check-sync] 失败：缺少 dist/.source-hash，请先运行 npm run build");
    process.exit(1);
  }

  const currentHash = await computeSourceHash();
  if (currentHash !== savedHash) {
    console.error("[check-sync] 失败：源码或 manifest.json 已变更，但产物未重新构建");
    console.error("[check-sync] 请先运行 npm run build，再执行打包/发布");
    process.exit(1);
  }

  console.log("[check-sync] 源码与产物一致，可以打包");
}

main().catch((err) => {
  console.error("[check-sync] 异常:", err);
  process.exit(1);
});
