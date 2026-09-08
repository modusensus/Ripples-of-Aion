import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
// 热度默认值与 store 同源：bump 落盘（不持有 config）与检索融合必须用同一套数
import { HEAT_BUMP, HEAT_DECAY_PER_DAY, HEAT_WEIGHT } from "./core/store";

const CONFIG_KEY = "config";

/**
 * autoDream 空闲整合默认值：字段在 PluginConfig 里可选（旧存档无此键），
 * 读取侧用这些常量兜底（与 store 的 HEAT_* 常量同模式）。
 */
export const DEFAULT_CONSOLIDATION_ENABLED = true;
/** 最后一轮摄入完成后静默 30 分钟才整合。 */
export const DEFAULT_CONSOLIDATION_IDLE_MINUTES = 30;
/** 单次整合最多送 80 条记录。 */
export const DEFAULT_CONSOLIDATION_MAX_RECORDS = 80;

export interface PluginConfig {
  embeddingProvider: "openai-compatible" | "none";
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingApiKeyName: string;
  embeddingDimensions?: number;
  hotContextBudgetChars: number;
  maxMemoriesPerTurn: number;
  /** 主观热度：每天惰性衰减系数（0.05 ≈ 两周衰到一半）。 */
  heatDecayPerDay?: number;
  /** 主观热度：检索融合的热度增益权重（score *= 1 + weight * effectiveHeat）。 */
  heatWeight?: number;
  /** 主观热度：单次访问/提及 bump 向 1 靠拢的比例。 */
  heatBump?: number;
  /**
   * autoDream 空闲整合总开关：整合要花一次 LLM 调用，给成本敏感用户
   * 一键关掉的逃生门；关掉后不做任何后台整合，洞察数据保持原样。
   */
  consolidationEnabled?: boolean;
  /**
   * 空闲判定：最后一轮摄入完成后静默满多少分钟才允许整合——避免在
   * 用户连续对话时抢 LLM 配额，只有确认「聊完了」才动手。
   */
  consolidationIdleMinutes?: number;
  /**
   * 单次整合送入 LLM 的记录数上限：上下文长度与成本的硬护栏，
   * 超出按有效热度降序截断（最重要的记忆优先参与整合）。
   */
  consolidationMaxRecords?: number;
}

export const DEFAULT_CONFIG: PluginConfig = {
  embeddingProvider: "none",
  embeddingBaseUrl: "https://api.openai.com/v1",
  embeddingModel: "text-embedding-3-small",
  embeddingApiKeyName: "embedding_api_key",
  hotContextBudgetChars: 900,
  maxMemoriesPerTurn: 3,
  heatDecayPerDay: HEAT_DECAY_PER_DAY,
  heatWeight: HEAT_WEIGHT,
  heatBump: HEAT_BUMP,
  consolidationEnabled: DEFAULT_CONSOLIDATION_ENABLED,
  consolidationIdleMinutes: DEFAULT_CONSOLIDATION_IDLE_MINUTES,
  consolidationMaxRecords: DEFAULT_CONSOLIDATION_MAX_RECORDS,
};

export function loadConfig(storage: PluginStorage): PluginConfig {
  const saved = storage.get<Partial<PluginConfig>>(CONFIG_KEY) ?? {};
  return { ...DEFAULT_CONFIG, ...saved };
}

export function saveConfig(storage: PluginStorage, config: PluginConfig): void {
  storage.set(CONFIG_KEY, config);
}
