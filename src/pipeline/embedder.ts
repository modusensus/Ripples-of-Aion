import type { PluginSecretsService } from "@playa0v0/cyrene-plugin-sdk";
import type { PluginConfig } from "../config";
import type { Embedder } from "../core/types";
import type { Logger } from "../logger";

/** createEmbedderByProvider 的依赖。 */
export interface EmbedderDeps {
  secrets?: PluginSecretsService;
  log: Logger;
}

/** 单次 embeddings 请求的超时；Embedder 接口没有 signal，超时兜底防悬挂。 */
const EMBED_TIMEOUT_MS = 30_000;

/** 把 baseUrl 归一化为 embeddings 端点；容忍末尾斜杠和已带 /embeddings 的完整地址。 */
function embeddingsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (/\/embeddings$/i.test(base)) return base;
  return `${base}/embeddings`;
}

function isFiniteNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value)
    && value.length > 0
    && value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/** 校验 embeddings 响应：data 必须与输入等长，每项 embedding 是非空数字数组。 */
function parseVectors(data: unknown, expected: number): number[][] | null {
  if (!Array.isArray(data) || data.length !== expected) return null;
  const vectors: number[][] = [];
  for (const item of data) {
    const embedding = typeof item === "object" && item !== null
      ? (item as { embedding?: unknown }).embedding
      : undefined;
    if (!isFiniteNumberArray(embedding)) return null;
    vectors.push(embedding);
  }
  return vectors;
}

/**
 * 按配置创建 embedder。
 * - "none"：总是返回 null 的降级 embedder，检索退化为纯关键词。
 * - "openai-compatible"：密钥从 secrets 惰性读取；任何错误都 warn 并
 *   返回 null（调用方降级为仅关键词），绝不抛出。
 */
export function createEmbedderByProvider(config: PluginConfig, deps: EmbedderDeps): Embedder {
  if (config.embeddingProvider !== "openai-compatible") {
    return {
      id: "none",
      embed: async () => null,
    };
  }

  const { secrets, log } = deps;
  const url = embeddingsUrl(config.embeddingBaseUrl);

  return {
    id: `openai-compatible:${config.embeddingModel}`,
    async embed(texts) {
      // 空输入直接返回空向量组：不是"不可用"，避免误触发降级语义。
      if (texts.length === 0) return [];
      try {
        const apiKey = secrets ? await secrets.get(config.embeddingApiKeyName) : undefined;
        if (!apiKey) {
          log.warn(`未配置 embedding 密钥（${config.embeddingApiKeyName}），本轮降级为纯关键词检索`);
          return null;
        }
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ input: texts, model: config.embeddingModel }),
          signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        });
        if (!response.ok) {
          const detail = (await response.text().catch(() => "")).slice(0, 200);
          log.warn(`embeddings 请求失败 HTTP ${response.status}:`, detail);
          return null;
        }
        const payload: unknown = await response.json();
        const data = typeof payload === "object" && payload !== null
          ? (payload as { data?: unknown }).data
          : undefined;
        const vectors = parseVectors(data, texts.length);
        if (!vectors) {
          log.warn("embeddings 响应结构异常，本轮降级为纯关键词检索");
          return null;
        }
        return vectors;
      } catch (err) {
        log.warn("embeddings 请求异常，本轮降级为纯关键词检索:", err);
        return null;
      }
    },
  };
}
