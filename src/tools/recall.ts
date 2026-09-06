import type { PluginTool } from "@playa0v0/cyrene-plugin-sdk";
import type { Logger } from "../logger";
import { PLUGIN_ID } from "../plugin-id";
import type { MemoryRecord } from "../core/types";
import { formatMemoryList, readOptionalString, type ToolsStore } from "./shared";

/** 单次回忆最多列出的记忆条数。 */
const RECALL_LIMIT = 20;

export interface RecallToolDeps {
  store: ToolsStore;
  log: Logger;
}

/** 最近 N 条记忆（createdAt 降序），可选按会话过滤。 */
function recentRecords(store: ToolsStore, limit: number, conversationId?: string): MemoryRecord[] {
  const records = store.all(conversationId ? { conversationId } : undefined);
  return [...records]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

/** 「回忆」工具：AI 用来查看记忆库里有什么。 */
export function createRecallTool(deps: RecallToolDeps): PluginTool {
  const { store, log } = deps;

  return {
    id: `${PLUGIN_ID}_recall`,
    name: "回忆",
    description:
      "当用户让你回忆、提到过去聊过什么、或想查看记忆库里有什么时调用。" +
      "可选传 conversationId 只看指定会话；不传则返回全部最近记忆。",
    enabled: true,
    risk: "safe",
    effectKind: "read",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description: "可选。只回忆指定会话的记忆；不填则返回全部最近记忆。",
        },
      },
      required: [],
    },
    async execute(args) {
      try {
        const conversationId = readOptionalString(args.conversationId);
        await store.load();
        const records = recentRecords(store, RECALL_LIMIT, conversationId);
        // 「共 N 条」统一按活跃记录口径；未指定会话时直接用统计，指定会话时现数
        const total = conversationId
          ? store.all({ conversationId }).length
          : store.getStats().active;
        const scope = conversationId ? `会话 ${conversationId}` : "全部会话";
        if (records.length === 0) {
          return `${scope}还没有任何记忆（共 ${total} 条）。`;
        }
        return `${scope}共 ${total} 条记忆，最近 ${records.length} 条：\n${formatMemoryList(records)}`;
      } catch (err) {
        log.warn("recall 执行失败，已降级返回：", err);
        return "记忆暂时读不出来，稍后再试一次。";
      }
    },
  };
}
