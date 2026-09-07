import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
// 热度默认值与 store 同源：bump 落盘（不持有 config）与检索融合必须用同一套数
import { HEAT_BUMP, HEAT_DECAY_PER_DAY, HEAT_WEIGHT } from "./core/store";

const CONFIG_KEY = "config";

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
};

export function loadConfig(storage: PluginStorage): PluginConfig {
  const saved = storage.get<Partial<PluginConfig>>(CONFIG_KEY) ?? {};
  return { ...DEFAULT_CONFIG, ...saved };
}

export function saveConfig(storage: PluginStorage, config: PluginConfig): void {
  storage.set(CONFIG_KEY, config);
}
