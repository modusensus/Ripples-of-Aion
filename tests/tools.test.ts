import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginConfig } from "../src/config";
import { createRecallTool } from "../src/tools/recall";
import { createSearchTool } from "../src/tools/search";
import { createForgetTool } from "../src/tools/forget";
import { createHotContextProvider } from "../src/provider/hot-context";
import { createHybridSearcher } from "../src/retrieval/hybrid";
import { createPassThroughReranker } from "../src/retrieval/rerank";
import { MemoryStore } from "../src/core/store";
import { remember } from "../src/core/remember";
import { createTempStorage, silentLog } from "./helpers";

function makeConfig(overrides?: Partial<PluginConfig>): PluginConfig {
  return {
    embeddingProvider: "none",
    embeddingBaseUrl: "",
    embeddingModel: "",
    embeddingApiKeyName: "k",
    hotContextBudgetChars: 900,
    maxMemoriesPerTurn: 3,
    ...overrides,
  };
}

describe("工具与检索层（源码级）", () => {
  let storage: Awaited<ReturnType<typeof createTempStorage>>;

  beforeEach(async () => {
    storage = await createTempStorage();
  });

  afterEach(async () => {
    await storage.cleanup();
  });

  async function makeStoreWithContent(): Promise<MemoryStore> {
    const store = new MemoryStore(storage.storage, silentLog);
    await remember(store, { id: "", createdAt: Date.now(), content: "用户喜欢喝手冲咖啡" }, silentLog);
    await remember(store, { id: "", createdAt: Date.now(), content: "用户在准备期末考试" }, silentLog);
    return store;
  }

  it("recall：空库返回可读提示；有内容时列出带 id 的记忆行", async () => {
    const store = new MemoryStore(storage.storage, silentLog);
    const tool = createRecallTool({ store, log: silentLog });
    const empty = await tool.execute({});
    expect(empty).toContain("还没有任何记忆");

    const store2 = await makeStoreWithContent();
    const tool2 = createRecallTool({ store: store2, log: silentLog });
    const out = await tool2.execute({});
    expect(out).toContain("手冲咖啡");
    expect(out).toMatch(/\[[0-9a-f-]{36}\]/);
  });

  it("search：query 缺失时提示；命中时返回带相关度的结果", async () => {
    const store = await makeStoreWithContent();
    const tool = createSearchTool({ store, config: makeConfig(), embedder: { id: "none", embed: async () => null }, log: silentLog });
    const noQuery = await tool.execute({});
    expect(noQuery).toContain("请提供");
    const hits = await tool.execute({ query: "咖啡" });
    expect(hits).toContain("手冲咖啡");
    expect(hits).toContain("相关度");
  });

  it("forget：按 id 删除单条；按 conversationId 清空会话", async () => {
    const store = await makeStoreWithContent();
    const tool = createForgetTool({ store, log: silentLog });
    const noArgs = await tool.execute({});
    expect(noArgs).toContain("请提供");
    const [first] = store.all();
    const single = await tool.execute({ id: first.id });
    expect(single).toContain("已删除记忆");
    expect(store.all()).toHaveLength(1);

    const rest = store.all();
    for (const r of rest) await store.delete(r.id);
    // 再写入一条带会话来源的记录，测按会话清空
    await remember(store, {
      id: "", createdAt: Date.now(),
      content: "用户喜欢晚上散步",
      turn: { conversationId: "conv-9", turnEventId: "e1" },
      conversationId: "conv-9",
    }, silentLog);
    const bulk = await tool.execute({ conversationId: "conv-9" });
    expect(bulk).toContain("已删除会话");
    expect(store.all()).toHaveLength(0);
  });

  it("hybrid：纯关键词路径按相关度排序、按会话过滤", async () => {
    const store = await makeStoreWithContent();
    const search = createHybridSearcher(store, makeConfig(), { embedder: { id: "none", embed: async () => null }, log: silentLog });
    const hits = await search({ text: "咖啡 考试" });
    expect(hits.length).toBe(2);
    // 两条各命中 2 词同分：同分新者优先，后写入的「期末考试」应排第一
    expect(hits[0].record.content).toContain("期末考试");
    const filtered = await search({ text: "咖啡", conversationId: "no-such-conv" });
    expect(filtered).toHaveLength(0);
  });

  it("rerank 直通实现保持原序", async () => {
    const reranker = createPassThroughReranker();
    const hits = [
      { record: { id: "a", createdAt: 1, content: "A" }, score: 0.5, source: "keyword" as const },
      { record: { id: "b", createdAt: 2, content: "B" }, score: 0.9, source: "keyword" as const },
    ];
    expect(await reranker.rerank(hits)).toEqual(hits);
  });

  it("hot-context：注入 top 事实且不超预算；空库与中止返回空串", async () => {
    const store = await makeStoreWithContent();
    const provider = createHotContextProvider({ store, config: makeConfig({ hotContextBudgetChars: 40 }), embedder: { id: "none", embed: async () => null }, log: silentLog });
    const controller = new AbortController();
    const block = await provider.provide({
      source: "conversation",
      mode: "chat",
      userText: "咖啡 怎么喝",
      signal: controller.signal,
    });
    // 预算 40 字符：标题行 + 至多一条事实
    expect(block).toContain("[岁月涟漪·记忆]");
    expect(block!.length).toBeLessThanOrEqual(40);

    const empty = new MemoryStore(storage.storage, silentLog);
    const p2 = createHotContextProvider({ store: empty, config: makeConfig(), embedder: { id: "none", embed: async () => null }, log: silentLog });
    expect(await p2.provide({ source: "conversation", mode: "chat", userText: "anything", signal: controller.signal })).toBe("");

    const aborted = new AbortController();
    aborted.abort();
    expect(await p2.provide({ source: "conversation", mode: "chat", userText: "x", signal: aborted.signal })).toBe("");
  });
});
