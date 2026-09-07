import type {
  PluginConversationMessage,
  PluginLlmMessage,
  PluginLlmService,
} from "@playa0v0/cyrene-plugin-sdk";
import { CANONICAL_ATTRS, canonicalAttr } from "../core/attributes";
import type { Logger } from "../logger";

/** extractTurn 的选项。 */
export interface ExtractTurnOptions {
  /** 单轮最多抽取的事实条数。 */
  maxFacts: number;
  log: Logger;
  signal?: AbortSignal;
}

/** 一条待入库的实体属性声明：factIndex 指向本轮 facts 数组的下标。 */
export interface ExtractedClaim {
  entity: string;
  attribute: string;
  value: string;
  factIndex: number;
}

/** 单轮抽取结果：facts 是检索主体，claims 是附加在对应事实上的结构化时间轴声明。 */
export interface ExtractedTurn {
  facts: string[];
  claims: ExtractedClaim[];
}

const EMPTY_TURN: ExtractedTurn = { facts: [], claims: [] };

/** 超长对话截断，避免无谓的 token 消耗；事实抽取不要求完整原文。 */
const MAX_TRANSCRIPT_CHARS = 16_000;

/** 单轮最多接受的属性声明条数：超出部分直接丢弃，防止模型刷屏。 */
const MAX_CLAIMS_PER_TURN = 8;

/** claim 单个字段的最大长度；LLM 派生字段一律先截断再入库。 */
const CLAIM_FIELD_MAX_CHARS = 80;

function buildSystemPrompt(maxFacts: number): string {
  return [
    "你是对话记忆抽取器。从对话中找出值得长期记住的事实，以及其中会随时间变化的实体属性，供日后回忆和时间轴查询使用。",
    "要求：",
    "- facts：只保留稳定、可复用的信息（身份、偏好、项目、约定、结论、重要背景），忽略寒暄和一次性过程。",
    `- 每条 facts 改写成独立自包含的第三人称陈述句，脱离上下文也能读懂，最多 ${maxFacts} 条；没有值得记的就输出空数组。`,
    "- claims：从 facts 里挑出「会随时间变化的属性」的当前值，例如居住地、正在做的事、养了什么宠物、关系状态；明显恒定、永不变化的属性（生日等）不要写。",
    // 固定属性词表：LLM 选词不稳定会让时间轴按字面量分裂成多条（生产实测
    // 「工作所在地」vs「工作地点」），先用封闭词表从源头收敛；漏网变体由
    // 存储侧 canonicalAttr 兜底。词表是静态文本，与对话内容无关。
    `- attribute 优先从固定词表里选一个：${CANONICAL_ATTRS.join("、")}。同一个属性每轮都用词表里的同一个词（写「工作地点」不写「工作所在地」，写「行程」不写「出差行程」）；词表实在覆盖不了时才自拟最简短的属性名。`,
    '- 每条 claim 是一个对象：entity 是属性所属的主体名（如「用户」「月饼」），attribute 是属性名（如「居住地」），value 是当前值，fact 是该 claim 来源事实在 facts 数组中的下标（从 0 开始）。最多 8 条；没有就输出空数组。',
    '- 只输出一个 JSON 对象，格式：{"facts": ["..."], "claims": [{"entity": "...", "attribute": "...", "value": "...", "fact": 0}]}，不要任何解释或 Markdown。',
  ].join("\n");
}

function buildTranscript(messages: PluginConversationMessage[]): string {
  const transcript = messages
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.text.trim()}`)
    .join("\n");
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) return transcript;
  return `${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}\n…（后文已截断）`;
}

/** 清洗 facts：只留非空字符串，截断到 maxFacts。 */
function sanitizeFacts(raw: unknown[], maxFacts: number): string[] {
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, maxFacts);
}

/**
 * 清洗 claims：字段必须是非空字符串、fact 必须指向存在的 facts 下标。
 * attribute 先过 canonicalAttr 归一化——prompt 词表只是第一道引导，
 * 这里把漏网变体（别名/全角/空格）收敛成 canonical 形式，存储侧
 * （store.append）会再归一一次，幂等双保险。
 * 单条不合格直接丢弃（宁可少存不错存），返回条数不超过 MAX_CLAIMS_PER_TURN。
 */
function sanitizeClaims(raw: unknown, factCount: number): ExtractedClaim[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedClaim[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { entity, attribute, value, fact } = item as Record<string, unknown>;
    if (typeof entity !== "string" || typeof attribute !== "string" || typeof value !== "string") {
      continue;
    }
    const trimmedEntity = entity.trim();
    const trimmedValue = value.trim();
    const canonical = canonicalAttr(attribute);
    if (!trimmedEntity || !canonical || !trimmedValue) continue;
    // 容忍模型把下标写成字符串；越界或缺失一律丢弃
    const index = typeof fact === "number" ? fact : typeof fact === "string" ? Number(fact) : NaN;
    if (!Number.isInteger(index) || index < 0 || index >= factCount) continue;
    out.push({
      entity: trimmedEntity.slice(0, CLAIM_FIELD_MAX_CHARS),
      attribute: canonical.slice(0, CLAIM_FIELD_MAX_CHARS),
      value: trimmedValue.slice(0, CLAIM_FIELD_MAX_CHARS),
      factIndex: index,
    });
    if (out.length >= MAX_CLAIMS_PER_TURN) break;
  }
  return out;
}

/**
 * 解析模型输出为抽取结果。
 * 返回 null 表示整体无法解析（调用方负责 warn）；claims 逐条清洗，
 * 单条坏 claim 只丢自己，不影响 facts。
 * 兼容旧格式（纯字符串数组 = 只有 facts）和模型包栅栏/夹带解释文字的情况。
 */
function parseTurn(raw: string, maxFacts: number): ExtractedTurn | null {
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
  // 旧格式：纯字符串数组，只有 facts
  if (Array.isArray(parsed)) {
    return { facts: sanitizeFacts(parsed, maxFacts), claims: [] };
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as { facts?: unknown; claims?: unknown };
  if (!Array.isArray(obj.facts)) return null;
  const facts = sanitizeFacts(obj.facts, maxFacts);
  return { facts, claims: sanitizeClaims(obj.claims, facts.length) };
}

/**
 * 让 LLM 从一轮对话中抽取 0~maxFacts 条事实和对应的时间轴属性声明。
 * 任何失败（调用失败、输出无法解析、signal 中止）都 warn 后返回空结果，不抛出。
 */
export async function extractTurn(
  llm: PluginLlmService,
  messages: PluginConversationMessage[],
  options: ExtractTurnOptions,
): Promise<ExtractedTurn> {
  const { maxFacts, log, signal } = options;
  if (maxFacts <= 0 || messages.length === 0) return EMPTY_TURN;
  if (signal?.aborted) return EMPTY_TURN;

  const requestMessages: PluginLlmMessage[] = [
    { role: "system", content: buildSystemPrompt(maxFacts) },
    { role: "user", content: buildTranscript(messages) },
  ];
  try {
    const raw = await llm.generateText(requestMessages, {
      maxTokens: 512,
      signal,
      purpose: "extract-facts",
    });
    if (signal?.aborted) return EMPTY_TURN;
    const turn = parseTurn(raw, maxFacts);
    if (turn === null) {
      log.warn("事实抽取输出无法解析，本轮跳过:", raw.slice(0, 200));
      return EMPTY_TURN;
    }
    if (turn.facts.length === 0) log.log("本轮没有抽取到事实");
    return turn;
  } catch (err) {
    log.warn("事实抽取失败（降级为不写入）:", err);
    return EMPTY_TURN;
  }
}
