import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 原子写文件：先写同目录临时文件，再用 rename 一步替换目标。
 * 同一卷上的 rename 是原子操作，进程崩溃 / 断电也不会留下写了一半的目标文件。
 * 失败时尽力清理临时文件，然后原样抛出，由调用方决定如何降级。
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  // 临时文件放在同目录，保证和目标在同一卷上，rename 才是原子替换
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmpPath, data, "utf8");
    await rename(tmpPath, path);
  } catch (err) {
    // 尽力清掉残留临时文件；清理本身失败则忽略
    try {
      await unlink(tmpPath);
    } catch {
      /* 忽略 */
    }
    throw err;
  }
}
