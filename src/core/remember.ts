import type { Logger } from "../logger";
import { dedupKeyOf } from "./store";
import type { MemoryStore } from "./store";
import type { MemoryRecord } from "./types";

/**
 * 记忆写入的唯一收口：先按内容哈希去重，再落盘。
 * 返回 true 表示已写入；false 表示重复或写入失败（均已 warn，不抛异常）。
 * 一轮允许多条不同事实；完全相同的内容全局只存一份。
 */
export async function remember(
  store: MemoryStore,
  record: MemoryRecord,
  log: Logger,
): Promise<boolean> {
  // 确保索引已重放完毕，避免 load 之前写入时漏判重
  await store.load();
  const dedupKey = dedupKeyOf(record);
  if (dedupKey && store.hasDedupKey(dedupKey)) {
    log.warn("相同内容的事实已存在，跳过写入", dedupKey);
    return false;
  }
  try {
    // append 内部已做错误降级，这里兜底防意外异常外泄
    return await store.append(record);
  } catch (err) {
    log.warn("记忆写入失败", err);
    return false;
  }
}
