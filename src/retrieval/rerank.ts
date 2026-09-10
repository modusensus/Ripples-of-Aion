import type { PluginLlmMessage, PluginLlmService } from "@playa0v0/cyrene-plugin-sdk";
import type { SearchHit } from "../core/types";
import type { Logger } from "../logger";

/**
 * 精排层。
 * 直通实现不做任何重排；LLM 精排把初排候选交给宿主 LLM 按相关度重排序
 * （v0.6.0）。精排只接 search 工具的混合检索出口，hot-context 纯关键词不动。
 * 精排是增益不是刚需：任何失败都 log.warn 降级为原序，绝不抛异常。
 */

/** 精排器：对初排候选重排序，输入输出是同一批记录（context.query 供 LLM 判断相关度）。 */
export interface Reranker {
  rerank(hits: SearchHit[], context: { query: string }): Promise<SearchHit[]>;
}

/** 直通精排：原样返回初排结果，保持顺序不变。 */
export function createPassThroughReranker(): Reranker {
  return {
    async rerank(hits: SearchHit[]): Promise<SearchHit[]> {
      return hits;
    },
  };
}

/** 单次送精排的候选上限：控制 prompt 长度与 token 成本，其余保持原序垫底。 */
const RERANK_CANDIDATES = 10;

/** 发给 LLM 的单条候选内容截断：事实陈述都很短，160 字足够判断相关度。 */
const SNIPPET_MAX_CHARS = 160;

/** 精排输出的 maxTokens：一个候选编号数组的宽松上限。 */
const RERANK_MAX_TOKENS = 256;

/** 单次精排超时：精排在检索出口上，等太久不如直接用原序。 */
const RERANK_TIMEOUT_MS = 15_000;

function buildSystemPrompt(): string {
  return [
    "你是记忆检索精排器。根据查询主题判断每条候选记忆与查询的相关度，把它们按相关度从高到低重新排序。",
    "要求：",
    '- 只输出一个 JSON 对象，格式：{"order":[2,0,1]}，不要任何解释或 Markdown。',
    "- order 数组的元素是候选编号（从 0 开始），按相关度降序排列。",
    "- 只允许使用给出的候选编号，绝不编造材料里没有的编号，每个编号最多出现一次；不必给全，只给与查询相关的。",
  ].join("\n");
}

/** 候选清单：编号 + 截断内容 + 日期（YYYY-MM-DD），帮助 LLM 判断时效相关度。 */
function buildUserPrompt(query: string, hits: SearchHit[]): string {
  const lines: string[] = [`查询主题：${query}`, "", "【候选记忆】（行首数字即候选编号）"];
  hits.forEach((hit, index) => {
    // 内容是 LLM 派生的不可信数据：重放时类型不可信，先清洗再进 prompt
    const content = typeof hit.record.content === "string" ? hit.record.content.trim() : "";
    const snippet =
      content.length <= SNIPPET_MAX_CHARS ? content : `${content.slice(0, SNIPPET_MAX_CHARS)}…`;
    const created = Number.isFinite(hit.record.createdAt)
      ? new Date(hit.record.createdAt).toISOString().slice(0, 10)
      : "未知时间";
    lines.push(`${index}. ${snippet}（记录于 ${created}）`);
  });
  return lines.join("\n");
}

/**
 * 解析模型输出为候选编号数组。与 extractor/consolidate 同级容错：
 * 剥栅栏、容忍 JSON 前后的解释文字；接受 {"order":[...]} 或裸数组 [...]。
 * 返回 null 表示整体无法解析（调用方负责 warn 降级）。
 */
function parseOrder(raw: string): unknown[] | null {
  let text = raw.trim();
  if (!text) return null;
  // 容忍模型包一层 Markdown 代码栅栏。
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 容忍模型在 JSON 前后附加解释文字：优先截取对象，退而截取数组再试。
    const brace = text.match(/\{[\s\S]*\}/);
    if (brace) {
      try {
        parsed = JSON.parse(brace[0]);
      } catch {
        parsed = undefined;
      }
    }
    if (parsed === undefined) {
      const bracket = text.match(/\[[\s\S]*\]/);
      if (!bracket) return null;
      try {
        parsed = JSON.parse(bracket[0]);
      } catch {
        return null;
      }
    }
  }
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "object" && parsed !== null) {
    const order = (parsed as { order?: unknown }).order;
    if (Array.isArray(order)) return order;
  }
  return null;
}

/** 容忍模型把编号写成字符串（与 extractor/consolidate 对下标的宽容度一致）。 */
function toIndex(value: unknown, bound: number): number | null {
  const index = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(index) || index < 0 || index >= bound) return null;
  return index;
}

/**
 * 按 LLM 给出的编号构建最终顺序：有效索引在前（按 LLM 顺序），越界/非整数/
 * 重复编号剔除，漏掉的候选按原相对序追加在尾——LLM 只表达头部偏好，召回
 * 结果一条不丢。score 保持召回分不动。
 */
function orderedHitsOf(rawOrder: unknown[], candidates: SearchHit[]): SearchHit[] {
  const seen = new Set<number>();
  const ordered: SearchHit[] = [];
  for (const item of rawOrder) {
    const index = toIndex(item, candidates.length);
    if (index === null || seen.has(index)) continue;
    seen.add(index);
    ordered.push(candidates[index]);
  }
  for (let i = 0; i < candidates.length; i += 1) {
    if (!seen.has(i)) ordered.push(candidates[i]);
  }
  return ordered;
}

/**
 * LLM 精排器：把初排前 RERANK_CANDIDATES 条候选（含内容与 createdAt）交给
 * 宿主 LLM 按查询相关度重排，其余候选保持原序垫底。fail-safe 全面降级：
 * llm 缺失、调用抛错、超时、输出无法解析——一律 log.warn 后返回原序，绝不抛。
 */
export function createLlmReranker(llm: PluginLlmService, deps: { log: Logger }): Reranker {
  const { log } = deps;

  return {
    async rerank(hits: SearchHit[], context: { query: string }): Promise<SearchHit[]> {
      // 单条/空结果没有排序可言，也别浪费那次 LLM 调用
      if (hits.length <= 1) return hits;
      try {
        const candidates = hits.slice(0, RERANK_CANDIDATES);
        const messages: PluginLlmMessage[] = [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: buildUserPrompt(context.query, candidates) },
        ];
        const raw = await llm.generateText(messages, {
          maxTokens: RERANK_MAX_TOKENS,
          timeoutMs: RERANK_TIMEOUT_MS,
          purpose: "rerank-memories",
        });
        const order = parseOrder(raw);
        if (order === null) {
          log.warn("精排输出无法解析，保持原序:", raw.slice(0, 200));
          return hits;
        }
        // 候选段按精排序，未送审的尾部候选保持原序
        return orderedHitsOf(order, candidates).concat(hits.slice(RERANK_CANDIDATES));
      } catch (err) {
        log.warn("LLM 精排失败，保持原序:", err);
        return hits;
      }
    },
  };
}
