import type {
  PluginConversationMessage,
  PluginLlmMessage,
  PluginLlmService,
} from "@playa0v0/cyrene-plugin-sdk";
import type { Logger } from "../logger";

/** extractFacts 的选项。 */
export interface ExtractFactsOptions {
  /** 单轮最多抽取的事实条数。 */
  maxFacts: number;
  log: Logger;
  signal?: AbortSignal;
}

/** 超长对话截断，避免无谓的 token 消耗；事实抽取不要求完整原文。 */
const MAX_TRANSCRIPT_CHARS = 16_000;

function buildSystemPrompt(maxFacts: number): string {
  return [
    "你是对话记忆抽取器。从对话中找出值得长期记住的事实，供日后回忆使用。",
    "要求：",
    "- 只保留稳定、可复用的信息（身份、偏好、项目、约定、结论、重要背景），忽略寒暄和一次性过程。",
    `- 每条改写成独立自包含的第三人称陈述句，脱离上下文也能读懂，最多 ${maxFacts} 条。`,
    "- 没有值得记的内容就输出空数组。",
    '- 只输出一个 JSON 字符串数组，例如 ["..."]，不要任何解释或 Markdown。',
  ].join("\n");
}

function buildTranscript(messages: PluginConversationMessage[]): string {
  const transcript = messages
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.text.trim()}`)
    .join("\n");
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) return transcript;
  return `${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}\n…（后文已截断）`;
}

/**
 * 解析模型输出为事实数组。
 * 返回 null 表示输出无法解析（调用方负责 warn）；合法的空数组原样返回。
 */
function parseFacts(raw: string, maxFacts: number): string[] | null {
  let text = raw.trim();
  if (!text) return null;
  // 容忍模型包一层 Markdown 代码栅栏。
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 容忍模型在数组前后附加解释文字：截取第一个 JSON 数组再试一次。
    const bracket = text.match(/\[[\s\S]*\]/);
    if (!bracket) return null;
    try {
      parsed = JSON.parse(bracket[0]);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  return parsed
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, maxFacts);
}

/**
 * 让 LLM 从一轮对话中抽取 0~maxFacts 条事实。
 * 任何失败（调用失败、输出无法解析、signal 中止）都 warn 后返回 []，不抛出。
 */
export async function extractFacts(
  llm: PluginLlmService,
  messages: PluginConversationMessage[],
  options: ExtractFactsOptions,
): Promise<string[]> {
  const { maxFacts, log, signal } = options;
  if (maxFacts <= 0 || messages.length === 0) return [];
  if (signal?.aborted) return [];

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
    if (signal?.aborted) return [];
    const facts = parseFacts(raw, maxFacts);
    if (facts === null) {
      log.warn("事实抽取输出无法解析，本轮跳过:", raw.slice(0, 200));
      return [];
    }
    if (facts.length === 0) log.log("本轮没有抽取到事实");
    return facts;
  } catch (err) {
    log.warn("事实抽取失败（降级为不写入）:", err);
    return [];
  }
}
