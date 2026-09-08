import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";

/**
 * 洞察存储（v0.4.0 autoDream）。
 *
 * autoDream 产出的「标注型整合」结果单独落在这里，与记忆本体
 * （memories.jsonl）彻底分离：洞察是 LLM 派生的衍生数据，允许随时
 * 重新生成、整体覆盖，绝不回写或改删任何原始记忆。存储用插件 KV
 * 单键全量替换——洞察体量小（簇 ≤ 8、矛盾对有上限），全量覆盖比
 * 追加日志简单且天然幂等。
 */

/** 一次主题聚类：共现实体（可选经向量校验）归出的记忆组。 */
export interface MemoryCluster {
  id: string; // cluster_<创建时间毫秒>_<短随机>
  /** LLM 命名的主题标签；LLM 失败时用「未命名主题」。 */
  label: string;
  recordIds: string[];
  createdAt: number;
}

/** 一对互相矛盾的记忆标注；只是提醒，不改动任何原记忆。 */
export interface MemoryConflict {
  id: string; // conflict_<创建时间毫秒>_<短随机>
  recordIds: [string, string];
  /** 矛盾摘要（LLM 产出，截断到 80 字符）。 */
  note: string;
  createdAt: number;
}

/** 整合结果快照；version 只在格式不兼容时递增。 */
export interface Insights {
  version: 1;
  /** 上次成功整合的时间戳；从未跑过 = 0。 */
  lastRunAt: number;
  clusters: MemoryCluster[];
  conflicts: MemoryConflict[];
}

/** 洞察在插件 KV 里的存储键。 */
export const INSIGHTS_KEY = "insights";

/** 全新空洞察：从未整合过的标准初始态。 */
function emptyInsights(): Insights {
  return { version: 1, lastRunAt: 0, clusters: [], conflicts: [] };
}

/** 单条簇的形状校验：字段缺失/类型不对的条目直接丢弃，不拖垮整体。 */
function sanitizeCluster(item: unknown): MemoryCluster | null {
  if (typeof item !== "object" || item === null) return null;
  const { id, label, recordIds, createdAt } = item as Record<string, unknown>;
  if (typeof id !== "string" || id === "") return null;
  if (typeof label !== "string") return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (!Array.isArray(recordIds) || recordIds.length === 0) return null;
  if (!recordIds.every((rid) => typeof rid === "string" && rid !== "")) return null;
  return { id, label, recordIds: [...recordIds], createdAt };
}

/** 单条矛盾对的形状校验：recordIds 必须恰为两个非空字符串。 */
function sanitizeConflict(item: unknown): MemoryConflict | null {
  if (typeof item !== "object" || item === null) return null;
  const { id, note, recordIds, createdAt } = item as Record<string, unknown>;
  if (typeof id !== "string" || id === "") return null;
  if (typeof note !== "string") return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (!Array.isArray(recordIds) || recordIds.length !== 2) return null;
  if (!recordIds.every((rid) => typeof rid === "string" && rid !== "")) return null;
  return { id, note, recordIds: [recordIds[0], recordIds[1]], createdAt };
}

/**
 * 读取洞察；缺失、整体结构坏（version/lastRunAt/数组缺失）或 storage.get
 * 抛异常时一律回退到空洞察。条目级坏数据只丢对应条目——洞察是可再生的
 * 派生数据，宁可少展示不可让面板拿到畸形结构。
 */
export function loadInsights(storage: PluginStorage): Insights {
  try {
    const raw: unknown = storage.get(INSIGHTS_KEY);
    if (typeof raw !== "object" || raw === null) return emptyInsights();
    const obj = raw as Record<string, unknown>;
    if (obj.version !== 1) return emptyInsights();
    if (typeof obj.lastRunAt !== "number" || !Number.isFinite(obj.lastRunAt)) {
      return emptyInsights();
    }
    if (!Array.isArray(obj.clusters) || !Array.isArray(obj.conflicts)) return emptyInsights();
    const clusters = obj.clusters
      .map(sanitizeCluster)
      .filter((item): item is MemoryCluster => item !== null);
    const conflicts = obj.conflicts
      .map(sanitizeConflict)
      .filter((item): item is MemoryConflict => item !== null);
    return { version: 1, lastRunAt: obj.lastRunAt, clusters, conflicts };
  } catch {
    // 读不到就当没有：调用方（面板/整合引擎）按「从未整合」继续
    return emptyInsights();
  }
}

/**
 * 全量覆盖写入。任何异常（配额满、底层存储故障）只 warn 不抛——
 * 洞察丢了可以下次重新整合，绝不能波及调用方主流程。
 */
export function saveInsights(
  storage: PluginStorage,
  next: Insights,
  log: { warn(...args: unknown[]): void },
): void {
  try {
    storage.set(INSIGHTS_KEY, next);
  } catch (err) {
    log.warn("洞察写入失败（保留旧数据）:", err);
  }
}
