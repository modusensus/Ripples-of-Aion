import type { PluginTool } from "@playa0v0/cyrene-plugin-sdk";
import type { Logger } from "../logger";
import { PLUGIN_ID } from "../plugin-id";
import type { ClaimEntry } from "../core/store";
import { readOptionalString, readRequiredString, formatTimestamp, type ToolsStore } from "./shared";

export interface TimelineToolDeps {
  store: ToolsStore & {
    /** 实体属性时间轴查询（core/store.ts 的 MemoryStore 天然满足）。 */
    getEntityTimeline(entity: string, attribute?: string): ClaimEntry[];
  };
  log: Logger;
}

/** 单条时间轴输出的公共段：值 + 起止时间。 */
function formatClaimSpan(entry: ClaimEntry): string {
  const from = formatTimestamp(entry.claim.validFrom ?? entry.record.createdAt);
  // 正常闭合由写入侧完成；这里遇到活跃 claim 之外还没有 until 的，
  // 说明闭合落盘失败过，用「至今」如实展示脏状态
  const until = entry.claim.validUntil == null ? "至今" : formatTimestamp(entry.claim.validUntil);
  return `${entry.claim.value}（${from} 至 ${until}）`;
}

/** 「实体时间轴」工具：AI 用来查询某实体的属性随时间的变化。 */
export function createTimelineTool(deps: TimelineToolDeps): PluginTool {
  const { store, log } = deps;

  return {
    id: `${PLUGIN_ID}_timeline`,
    name: "实体时间轴",
    description:
      "当需要知道某个实体的属性现在是什么、过去是什么、什么时候变的时调用。" +
      "entity 填主体名（如「用户」或某个具体的人/物/项目）；可选 attribute 只看单一属性（如「居住地」）。",
    enabled: true,
    risk: "safe",
    effectKind: "read",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "属性所属的主体名，例如「用户」。" },
        attribute: { type: "string", description: "可选。只看这一个属性，例如「居住地」。" },
      },
      required: ["entity"],
    },
    async execute(args) {
      try {
        const entity = readRequiredString(args.entity);
        if (entity.length === 0) {
          return "请提供要查询的实体（entity）。";
        }
        const attribute = readOptionalString(args.attribute);
        await store.load();
        const entries = store.getEntityTimeline(entity, attribute);
        if (entries.length === 0) {
          return attribute
            ? `实体「${entity}」没有属性「${attribute}」的记录。`
            : `没有找到实体「${entity}」的属性记录。`;
        }

        // 按属性分组、组内最新在前；组内第一条若是活跃 claim 即当前值
        const byAttribute = new Map<string, ClaimEntry[]>();
        for (const entry of [...entries].reverse()) {
          const group = byAttribute.get(entry.claim.attribute) ?? [];
          group.push(entry);
          byAttribute.set(entry.claim.attribute, group);
        }

        const lines: string[] = [];
        let count = 0;
        for (const [attr, group] of byAttribute) {
          const [latest, ...history] = group;
          count += group.length;
          const attrLines: string[] = [];
          if (latest.claim.validUntil == null) {
            const from = formatTimestamp(latest.claim.validFrom ?? latest.record.createdAt);
            attrLines.push(`- 属性「${attr}」当前：${latest.claim.value}（自 ${from}）`);
          } else {
            // 最新一条也已闭合：该属性目前没有有效值，全部按历史展示
            attrLines.push(`- 属性「${attr}」当前：无（最近一次记录已变更或失效）`);
            attrLines.push(`- 属性「${attr}」历史：${formatClaimSpan(latest)}`);
          }
          for (const entry of history) {
            attrLines.push(`- 属性「${attr}」历史：${formatClaimSpan(entry)}`);
          }
          lines.push(...attrLines);
        }
        return `实体「${entity}」的属性时间轴（共 ${count} 条）：\n${lines.join("\n")}`;
      } catch (err) {
        log.warn("timeline 执行失败，已降级返回：", err);
        return "时间轴查询暂时不可用，稍后再试一次。";
      }
    },
  };
}
