import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";

const CONFIG_KEY = "config";

export interface PluginConfig {
  embeddingProvider: "openai-compatible" | "none";
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingApiKeyName: string;
  embeddingDimensions?: number;
  hotContextBudgetChars: number;
  maxMemoriesPerTurn: number;
}

export const DEFAULT_CONFIG: PluginConfig = {
  embeddingProvider: "none",
  embeddingBaseUrl: "https://api.openai.com/v1",
  embeddingModel: "text-embedding-3-small",
  embeddingApiKeyName: "embedding_api_key",
  hotContextBudgetChars: 900,
  maxMemoriesPerTurn: 3,
};

export function loadConfig(storage: PluginStorage): PluginConfig {
  const saved = storage.get<Partial<PluginConfig>>(CONFIG_KEY) ?? {};
  return { ...DEFAULT_CONFIG, ...saved };
}

export function saveConfig(storage: PluginStorage, config: PluginConfig): void {
  storage.set(CONFIG_KEY, config);
}
