import type { PluginTool } from "@playa0v0/cyrene-plugin-sdk";
import { DEFAULT_RERANK_ENABLED, type PluginConfig } from "../config";
import type { Logger } from "../logger";
import { PLUGIN_ID } from "../plugin-id";
import type { Embedder, MemoryId, SearchQuery } from "../core/types";
import { createHybridSearcher, type HybridSearchStore } from "../retrieval/hybrid";
import type { Reranker } from "../retrieval/rerank";
import { formatHitList, readOptionalString, readRequiredString } from "./shared";

export interface SearchToolDeps {
  // 访问加权：命中返回即视为被想起；store 内部节流落盘、绝不抛。
  store: HybridSearchStore & {
    bumpHeat(ids: MemoryId[]): void;
  };
  config: PluginConfig;
  embedder: Embedder;
  log: Logger;
  /**
   * 可选：提供后对混合检索出口做 LLM 精排（rerankEnabled 可关，默认开）。
   * reranker 内部已 fail-safe（任何失败降级原序），缺席时保持纯初排。
   */
  reranker?: Reranker;
}

/** 「搜索记忆」工具：AI 用来按主题查历史事实。 */
export function createSearchTool(deps: SearchToolDeps): PluginTool {
  const { store, log } = deps;
  const search = createHybridSearcher(deps.store, deps.config, { embedder: deps.embedder, log });

  return {
    id: `${PLUGIN_ID}_search`,
    name: "搜索记忆",
    description:
      "当需要查找和某主题相关的历史事实、用户提过的偏好或约定时调用。" +
      "参数 query 填检索主题；可选 conversationId 限定会话范围。",
    enabled: true,
    risk: "safe",
    effectKind: "read",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "要检索的主题或关键词。" },
        conversationId: { type: "string", description: "可选。只在指定会话范围内搜索。" },
      },
      required: ["query"],
    },
    async execute(args) {
      try {
        const text = readRequiredString(args.query);
        if (text.length === 0) {
          return "请提供要搜索的主题（query）。";
        }
        const query: SearchQuery = {
          text,
          conversationId: readOptionalString(args.conversationId),
        };
        let hits = await search(query);
        if (hits.length === 0) {
          return `没有找到与「${text}」相关的记忆。`;
        }
        // LLM 精排（v0.6.0）：只重排不增删，reranker 内部已 fail-safe
        //（失败降级原序），这里不重复 try 包裹；bump 与输出都用最终结果。
        if (deps.reranker && (deps.config.rerankEnabled ?? DEFAULT_RERANK_ENABLED)) {
          hits = await deps.reranker.rerank(hits, { query: text });
        }
        // 访问加权：返回结果前 bump（不 await，内部已 fail-safe）。
        store.bumpHeat(hits.map((hit) => hit.record.id));
        return `找到 ${hits.length} 条相关记忆：\n${formatHitList(hits)}`;
      } catch (err) {
        log.warn("search 执行失败，已降级返回：", err);
        return "记忆搜索暂时不可用，稍后再试一次。";
      }
    },
  };
}
