import type { PluginTool } from "@playa0v0/cyrene-plugin-sdk";
import type { PluginConfig } from "../config";
import type { Logger } from "../logger";
import { PLUGIN_ID } from "../plugin-id";
import type { Embedder, SearchQuery } from "../core/types";
import { createHybridSearcher, type HybridSearchStore } from "../retrieval/hybrid";
import { formatHitList, readOptionalString, readRequiredString } from "./shared";

export interface SearchToolDeps {
  store: HybridSearchStore;
  config: PluginConfig;
  embedder: Embedder;
  log: Logger;
}

/** 「搜索记忆」工具：AI 用来按主题查历史事实。 */
export function createSearchTool(deps: SearchToolDeps): PluginTool {
  const { log } = deps;
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
        const hits = await search(query);
        if (hits.length === 0) {
          return `没有找到与「${text}」相关的记忆。`;
        }
        return `找到 ${hits.length} 条相关记忆：\n${formatHitList(hits)}`;
      } catch (err) {
        log.warn("search 执行失败，已降级返回：", err);
        return "记忆搜索暂时不可用，稍后再试一次。";
      }
    },
  };
}
