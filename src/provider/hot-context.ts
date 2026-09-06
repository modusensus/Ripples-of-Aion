import type { PluginPromptProvider } from "@playa0v0/cyrene-plugin-sdk";
import type { PluginConfig } from "../config";
import type { MemoryStore } from "../core/store";
import type { Embedder } from "../core/types";
import type { Logger } from "../logger";
import { createHybridSearcher } from "../retrieval/hybrid";

/** createHotContextProvider 的依赖集合。 */
export interface HotContextProviderDeps {
  store: MemoryStore;
  config: PluginConfig;
  embedder: Embedder;
  log: Logger;
}

/** 每次注入最多取多少条事实。 */
const TOP_K = 3;

/** 注入块的标题行。 */
const HEADER = "[岁月涟漪·记忆]";

/**
 * 热记忆 prompt provider：每轮请求前把与当前输入最相关的少量事实
 * 注入上下文。整体 fail-safe：任何异常都降级为空串，绝不阻断主流程。
 */
export function createHotContextProvider(deps: HotContextProviderDeps): PluginPromptProvider {
  const { store, config, embedder, log } = deps;
  const budget = Math.max(0, config.hotContextBudgetChars);
  // 混合检索：关键词打底 + 可用向量重排，任何检索失败都退化为空注入
  const search = createHybridSearcher(store, config, { embedder, log });

  const provider: PluginPromptProvider = {
    id: "hot-context",
    // 不填 modes：缺省即覆盖全部模式（chat / work / learn / code）。
    async provide(input) {
      try {
        if (input.signal.aborted) return "";
        const text = input.userText.trim();
        if (!text) return "";

        const hits = await search({ text, limit: TOP_K });
        if (input.signal.aborted) return "";

        // 逐条累加，超出预算即停，保证注入块始终不超过 hotContextBudgetChars。
        let block = HEADER;
        let kept = 0;
        for (const hit of hits) {
          const content = hit.record.content.trim();
          if (!content) continue;
          const line = `- ${content}`;
          const candidate = `${block}\n${line}`;
          if (candidate.length > budget) break;
          block = candidate;
          kept += 1;
        }
        return kept > 0 ? block : "";
      } catch (err) {
        log.warn("hot-context 记忆注入失败，本轮跳过：", err);
        return "";
      }
    },
  };

  return provider;
}
