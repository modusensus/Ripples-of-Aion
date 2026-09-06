import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "../logger";

/** 把对象作为一行 JSON 追加到文件末尾，以 \n 结尾。 */
export async function appendJsonl(path: string, obj: unknown): Promise<void> {
  // 目录不存在时先建出来，首启场景常见
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(obj)}\n`, "utf8");
}

/**
 * 逐行读取并解析 JSONL 文件。
 * 文件不存在视为空数组（首次运行）；单行解析失败只 warn 跳过，不影响其余行。
 * 其他读文件错误原样抛出，由调用方降级处理。
 */
export async function readJsonl<T>(path: string, log: Logger): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  const out: T[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch (err) {
      // 坏行常见于写入中断，跳过即可，不必让整个文件不可用
      log.warn(`JSONL 第 ${i + 1} 行解析失败，已跳过`, err);
    }
  }
  return out;
}
