import type { PluginPromptProvider } from "@playa0v0/cyrene-plugin-sdk";
import type { PluginConfig } from "../config";
import type { MemoryStore } from "../core/store";
import type { MemoryId } from "../core/types";
import type { Logger } from "../logger";
import { createHybridSearcher } from "../retrieval/hybrid";

/** createHotContextProvider 的依赖集合。 */
export interface HotContextProviderDeps {
  store: MemoryStore;
  config: PluginConfig;
  log: Logger;
}

/** 每次注入最多取多少条事实。 */
const TOP_K = 3;

/** 注入块的标题行。 */
const HEADER = "[岁月涟漪·记忆]";

/**
 * 热记忆 prompt provider：每轮请求前把与当前输入最相关的少量事实
 * 注入上下文。整体 fail-safe：任何异常都降级为空串，绝不阻断主流程。
 *
 * v0.3.0 轻量化：不再接收 embedder，只走关键词检索——实测每轮都打
 * embedding API 拖慢首字延迟；向量重排保留给 search 工具按需使用。
 */
export function createHotContextProvider(deps: HotContextProviderDeps): PluginPromptProvider {
  const { store, config, log } = deps;
  const budget = Math.max(0, config.hotContextBudgetChars);
  // 纯关键词检索（embedder 缺席即关键词路径），任何检索失败都退化为空注入
  const search = createHybridSearcher(store, config, { log });

  const provider: PluginPromptProvider = {
    id: "hot-context",
    // 不填 modes：缺省即覆盖全部模式（chat / work / learn / code）。
    // moments-post 为显式 opt-in（宿主 #75 起 Provider 必须声明场景才参与）：
    // 昔涟发动态时同样注入相关记忆。moments-post 的 userText 是对话摘要快照，
    // 关键词检索照常工作；记忆保持全局，不按 conversationId 过滤——
    // 跨聊天记忆正是本插件的核心能力。
    sources: ["conversation", "scheduler", "moments-post"],
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
        const keptIds: MemoryId[] = [];
        for (const hit of hits) {
          const content = hit.record.content.trim();
          if (!content) continue;
          const line = `- ${content}`;
          const candidate = `${block}\n${line}`;
          if (candidate.length > budget) break;
          block = candidate;
          keptIds.push(hit.record.id);
          kept += 1;
        }
        if (kept > 0) {
          // 访问加权：被注入即被想起。bumpHeat 内部已节流落盘、绝不抛，
          // 这里不 await（fire-and-forget），保持注入路径零额外延迟。
          store.bumpHeat(keptIds);
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
