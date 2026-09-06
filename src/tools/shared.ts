import type { MemoryRecord, SearchHit } from "../core/types";

/**
 * 工具层需要的存储面。
 * core/store.ts 的 MemoryStore 类天然满足本接口（结构化兼容），
 * 换存储实现时只要保住这几个方法即可。
 */
export interface ToolsStore {
  /** 重放 JSONL 日志构建内存索引；幂等，读操作前调用。 */
  load(): Promise<void>;
  /** 全量记录（按插入即时间顺序），可选按会话过滤 / 含软删。 */
  all(options?: { includeDeleted?: boolean; conversationId?: string }): MemoryRecord[];
  /** 按 id 软删一条记忆；未知 id 只记日志不抛异常。 */
  delete(id: string): Promise<void>;
  /** 统计信息：total 含软删，active 不含。 */
  getStats(): { total: number; active: number };
}

/** 工具输出用的时间戳格式：2026-09-07 14:30。 */
export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 把记忆列表排成给 AI 看的行：序号 + id + 时间 + 内容。 */
export function formatMemoryList(records: MemoryRecord[]): string {
  return records
    .map((record, index) => `${index + 1}. [${record.id}] ${formatTimestamp(record.createdAt)} ${record.content}`)
    .join("\n");
}

/** 检索结果格式：在记忆行基础上附加相关度，方便 AI 判断置信度。 */
export function formatHitList(hits: SearchHit[]): string {
  return hits
    .map(
      (hit, index) =>
        `${index + 1}. [${hit.record.id}] ${formatTimestamp(hit.record.createdAt)} ${hit.record.content}（相关度 ${hit.score.toFixed(2)}）`,
    )
    .join("\n");
}

/** 读取可选字符串参数：非字符串或空白一律视为未提供。 */
export function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 读取必填字符串参数：非字符串或空白返回空串，由调用方判空报错。 */
export function readRequiredString(value: unknown): string {
  return readOptionalString(value) ?? "";
}
