import type { PluginTool } from "@playa0v0/cyrene-plugin-sdk";
import type { Logger } from "../logger";
import { PLUGIN_ID } from "../plugin-id";
import type { ToolsStore } from "./shared";
import { readOptionalString } from "./shared";

export interface ForgetToolDeps {
  store: ToolsStore;
  log: Logger;
}

/** 「遗忘」工具：AI 用来按用户的明确要求删除记忆。 */
export function createForgetTool(deps: ForgetToolDeps): PluginTool {
  const { store, log } = deps;

  return {
    id: `${PLUGIN_ID}_forget`,
    name: "遗忘",
    description:
      "当用户明确要求删除或忘掉某条记忆时调用。" +
      "传 id 删除单条记忆，或传 conversationId 清空整个会话的记忆；" +
      "用户没有明确要求删除时不要调用。",
    enabled: true,
    risk: "safe",
    effectKind: "mutation",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "要删除的单条记忆 id。" },
        conversationId: { type: "string", description: "要清空整个会话记忆时传会话 id。" },
      },
      required: [],
    },
    async execute(args) {
      try {
        const id = readOptionalString(args.id);
        const conversationId = readOptionalString(args.conversationId);
        await store.load();

        // id 优先：两个都传时只删单条，避免误伤整个会话
        if (id) {
          const existing = store.all({ includeDeleted: true }).find((record) => record.id === id);
          if (!existing) {
            return `没有找到记忆 ${id}。`;
          }
          if (existing.deleted) {
            return `记忆 ${id} 已经删过了。`;
          }
          await store.delete(id);
          return `已删除记忆 ${id}。`;
        }
        if (conversationId) {
          // all() 默认不含软删，这里拿到的就是待删清单
          const targets = store.all({ conversationId });
          for (const record of targets) {
            await store.delete(record.id);
          }
          return targets.length > 0
            ? `已删除会话 ${conversationId} 的 ${targets.length} 条记忆。`
            : `会话 ${conversationId} 没有可删除的记忆。`;
        }
        return "请提供要删除的记忆 id，或要清空的会话 conversationId。";
      } catch (err) {
        log.warn("forget 执行失败：", err);
        return "删除没有完成，出现了一点问题，请稍后再试一次。";
      }
    },
  };
}
