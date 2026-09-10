import { describe, expect, it } from "vitest";
import type { PluginLlmMessage, PluginLlmService } from "@playa0v0/cyrene-plugin-sdk";
import type { SearchHit } from "../src/core/types";
import { createLlmReranker } from "../src/retrieval/rerank";

/** 构造一条 SearchHit；createdAt 显式固定，避免时间序依赖 Date.now()。 */
function hitOf(id: string, createdAt: number, content: string): SearchHit {
  return { record: { id, createdAt, content }, score: 0.5, source: "keyword" };
}

/**
 * 假 LLM：捕获 generateText 入参，按脚本返回或抛错；log 记录 warn 便于
 * 断言「失败已降级告警」。
 */
function makeLlm(options: { reply?: string; throwErr?: unknown } = {}) {
  const calls: Array<{ messages: PluginLlmMessage[]; options: unknown }> = [];
  const warns: unknown[][] = [];
  const log = {
    log: () => {},
    warn: (...args: unknown[]) => {
      warns.push(args);
    },
    error: () => {},
  };
  const llm: PluginLlmService = {
    generateText: async (messages, opts) => {
      calls.push({ messages, options: opts });
      if (options.throwErr !== undefined) throw options.throwErr;
      return options.reply ?? "";
    },
  };
  return { llm, log, calls, warns };
}

describe("LLM 精排（createLlmReranker）", () => {
  // 三条候选：0=北京 1=猫 2=考试（编号即初排下标）
  const hits = [
    hitOf("a", Date.UTC(2026, 0, 10), "用户住在北京"),
    hitOf("b", Date.UTC(2026, 0, 11), "用户养了一只猫"),
    hitOf("c", Date.UTC(2026, 0, 12), "用户在准备期末考试"),
  ];

  it("合法 {\"order\":[...]} 按相关度重排，score 保持召回分且调用参数符合契约", async () => {
    const ctx = makeLlm({ reply: '{"order":[2,0,1]}' });
    const reranker = createLlmReranker(ctx.llm, { log: ctx.log });
    const out = await reranker.rerank(hits, { query: "用户的宠物" });
    expect(out.map((h) => h.record.id)).toEqual(["c", "a", "b"]);
    // score 保持召回分不改动，只动顺序
    expect(out.map((h) => h.score)).toEqual([0.5, 0.5, 0.5]);
    expect(ctx.calls).toHaveLength(1);
    const call = ctx.calls[0]!;
    expect(call.messages).toHaveLength(2);
    expect(call.messages[0]!.role).toBe("system");
    expect(call.messages[0]!.content).toContain("精排");
    expect(call.messages[1]!.role).toBe("user");
    expect(call.messages[1]!.content).toContain("用户的宠物");
    expect(call.messages[1]!.content).toContain("用户养了一只猫");
    expect(call.messages[1]!.content).toContain("2026-01-11");
    expect(call.options).toMatchObject({ maxTokens: 256, timeoutMs: 15000, purpose: "rerank-memories" });
  });

  it("裸数组 [...] 输出同样接受", async () => {
    const ctx = makeLlm({ reply: "[2,0,1]" });
    const reranker = createLlmReranker(ctx.llm, { log: ctx.log });
    const out = await reranker.rerank(hits, { query: "q" });
    expect(out.map((h) => h.record.id)).toEqual(["c", "a", "b"]);
  });

  it("越界/非整数/重复索引剔除，字符串数字宽容，有效部分仍生效", async () => {
    const ctx = makeLlm({ reply: '{"order":["99", 1.5, "2", 0, 2]}' });
    const reranker = createLlmReranker(ctx.llm, { log: ctx.log });
    const out = await reranker.rerank(hits, { query: "q" });
    // 99 越界、1.5 非整数剔除；第二个 2 重复剔除 → [c, a]，漏掉的 b 补尾
    expect(out.map((h) => h.record.id)).toEqual(["c", "a", "b"]);
  });

  it("漏掉的候选按原相对序补尾，不丢召回", async () => {
    const ctx = makeLlm({ reply: '{"order":[2]}' });
    const reranker = createLlmReranker(ctx.llm, { log: ctx.log });
    const out = await reranker.rerank(hits, { query: "q" });
    // LLM 只认可 2 → [c]，其余按原相对序补尾
    expect(out.map((h) => h.record.id)).toEqual(["c", "a", "b"]);
    expect(out).toHaveLength(hits.length);
  });

  it("LLM 调用抛错时降级原序且不抛异常", async () => {
    const ctx = makeLlm({ throwErr: new Error("quota exceeded") });
    const reranker = createLlmReranker(ctx.llm, { log: ctx.log });
    const out = await reranker.rerank(hits, { query: "q" });
    expect(out).toEqual(hits);
    expect(ctx.warns.length).toBeGreaterThan(0);
  });

  it("输出垃圾文本无法解析时降级原序", async () => {
    const ctx = makeLlm({ reply: "抱歉，这个问题我回答不了。" });
    const reranker = createLlmReranker(ctx.llm, { log: ctx.log });
    const out = await reranker.rerank(hits, { query: "q" });
    expect(out).toEqual(hits);
    expect(ctx.warns.length).toBeGreaterThan(0);
  });

  it("markdown 围栏包裹的 JSON 容错", async () => {
    const ctx = makeLlm({ reply: '```json\n{"order":[1,2,0]}\n```' });
    const reranker = createLlmReranker(ctx.llm, { log: ctx.log });
    const out = await reranker.rerank(hits, { query: "q" });
    expect(out.map((h) => h.record.id)).toEqual(["b", "c", "a"]);
  });

  it("候选不足两条时直接返回，不发起 LLM 调用", async () => {
    const ctx = makeLlm({ reply: '{"order":[0]}' });
    const reranker = createLlmReranker(ctx.llm, { log: ctx.log });
    expect(await reranker.rerank([], { query: "q" })).toEqual([]);
    const single = [hitOf("a", 1000, "A")];
    expect(await reranker.rerank(single, { query: "q" })).toEqual(single);
    expect(ctx.calls).toHaveLength(0);
  });
});
