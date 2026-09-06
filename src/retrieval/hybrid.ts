import { tokenizeText } from "../core/store";
import type { PluginConfig } from "../config";
import type { Logger } from "../logger";
import type { Embedder, MemoryRecord, SearchHit, SearchQuery } from "../core/types";

/**
 * 混合评分权重：向量 1.0 > 关键词 0.7（沿用 dsh-mneme 的合并权重，
 * 语义优先、关键词兜底），可按召回质量调整。
 */
const KEYWORD_WEIGHT = 0.7;
const VECTOR_WEIGHT = 1.0;
/** 未显式传 limit 时的默认返回条数。 */
const DEFAULT_LIMIT = 10;

/**
 * 混合检索需要的存储面。
 * core/store.ts 的 MemoryStore 类天然满足本接口（结构化兼容），
 * 换存储实现时只要保住这两个方法即可。
 */
export interface HybridSearchStore {
  /** 重放 JSONL 日志构建内存索引；幂等，读操作前调用。 */
  load(): Promise<void>;
  /** 关键词召回：返回按相关度降序的候选记录（不含软删）。 */
  searchKeyword(query: string): MemoryRecord[];
}

export interface HybridSearcherDeps {
  embedder: Embedder;
  log: Logger;
}

/** 混合检索函数签名。 */
export type HybridSearcher = (query: SearchQuery) => Promise<SearchHit[]>;

/**
 * 混合检索器：关键词召回打底，向量分重打分。
 * 流程：searchKeyword 拿候选 → 按会话过滤 → 可用时对查询取 embedding，
 * 与候选记录的向量（embeddingModel 匹配当前配置）算余弦 → 加权融合排序。
 * 向量不可用时退化为纯关键词检索，绝不因 embedding 挂掉而整体失败。
 */
export function createHybridSearcher(
  store: HybridSearchStore,
  config: PluginConfig,
  deps: HybridSearcherDeps,
): HybridSearcher {
  const { embedder, log } = deps;

  return async function search(query: SearchQuery): Promise<SearchHit[]> {
    const limit = Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT));
    await store.load();

    // 1. 关键词召回 + 会话过滤（store 已按相关度排序、已剔除软删）
    const candidates = store.searchKeyword(query.text).filter(
      (record) => !query.conversationId || record.conversationId === query.conversationId,
    );
    if (candidates.length === 0) {
      return [];
    }

    // 2. 关键词分：store 只返回记录不带分，这里用同一套分词复算匹配词数，
    //    量纲与 store 内部排序一致，归一到 [0,1] 后参与融合
    const keywordScores = keywordScoresOf(query.text, candidates);

    // 3. 查询向量：拿不到就走纯关键词
    const queryVector = await fetchQueryVector(query.text);
    if (!queryVector) {
      return candidates.slice(0, limit).map((record, index) => ({
        record,
        score: keywordScores[index],
        source: "keyword" as const,
      }));
    }

    // 4. 融合：向量 1.0 + 关键词 0.7；无可用向量的记录向量分记 0
    const maxKeyword = Math.max(0, ...keywordScores);
    const fused = candidates.map((record, index) => {
      const keywordScore = maxKeyword > 0 ? keywordScores[index] / maxKeyword : 0;
      const vectorScore = vectorScoreOf(record, queryVector, config);
      return {
        record,
        score: KEYWORD_WEIGHT * keywordScore + VECTOR_WEIGHT * vectorScore,
        source: "hybrid" as const,
      };
    });

    // 5. 降序截断（sort 稳定，同分保持关键词序 + 新者在前）
    fused.sort((a, b) => b.score - a.score);
    return fused.slice(0, limit);
  };

  /** 取查询向量；embedder 缺席、调用失败或返回空都按不可用处理。 */
  async function fetchQueryVector(text: string): Promise<number[] | null> {
    const trimmed = text.trim();
    if (!embedder || trimmed.length === 0) {
      return null;
    }
    try {
      const vectors = await embedder.embed([trimmed]);
      return vectors?.[0] ?? null;
    } catch (err) {
      log.warn("查询向量获取失败，退化为纯关键词检索：", err);
      return null;
    }
  }
}

/**
 * 关键词分：查询词（去重）在记录内容里命中的个数，与 store.searchKeyword 同一套算法。
 * 返回数组与 records 一一对应。
 */
function keywordScoresOf(query: string, records: MemoryRecord[]): number[] {
  const queryTokens = [...new Set(tokenizeText(query))];
  return records.map((record) => {
    if (queryTokens.length === 0) return 0;
    const contentTokens = new Set(tokenizeText(record.content));
    let score = 0;
    for (const token of queryTokens) {
      if (contentTokens.has(token)) score += 1;
    }
    return score;
  });
}

/** 记录向量分：仅当记录带向量且 embeddingModel 与当前配置匹配时计算，归一到 [0,1]。 */
function vectorScoreOf(record: MemoryRecord, queryVector: number[], config: PluginConfig): number {
  if (!record.embedding || record.embeddingModel !== config.embeddingModel) {
    return 0;
  }
  // 余弦 ∈ [-1,1]，线性映射到 [0,1] 再参与加权
  const cosine = cosineSimilarity(queryVector, record.embedding);
  return (cosine + 1) / 2;
}

/** 余弦相似度；维度不一致或存在零向量时返回 0。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
