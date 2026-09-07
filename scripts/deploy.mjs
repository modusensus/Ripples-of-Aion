#!/usr/bin/env node
/**
 * 本地部署：把构建产物拷贝到本机 Cyrene 用户插件目录。
 * 默认路径：%APPDATA%/live2d-cyrene/plugins/ripples-of-aion/
 * 如果 Cyrene 正在运行，需要手动在插件面板点「刷新插件」。
 */
import { cp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BUILT_PLUGIN = path.join(ROOT, "dist", "plugin", "ripples-of-aion");

function getCyrenePluginsDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "live2d-cyrene", "plugins", "ripples-of-aion");
}

async function main() {
  const target = getCyrenePluginsDir();
  console.log("[deploy] 部署到:", target);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(BUILT_PLUGIN, target, { recursive: true, force: true });
  console.log("[deploy] 完成。请在 Cyrene 插件面板点击「刷新插件」并手动启用。");
}

main().catch((err) => {
  console.error("[deploy] 失败:", err);
  process.exit(1);
});
