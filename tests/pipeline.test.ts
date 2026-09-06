import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginConversationMessage } from "@playa0v0/cyrene-plugin-sdk";
import { createTurnIngestor } from "../src/pipeline/ingest";
import { TaskQueue } from "../src/pipeline/queue";
import { MemoryStore } from "../src/core/store";
import type { IngestTask } from "../src/core/types";
import { createTempStorage, silentLog } from "./helpers";

const MESSAGES: PluginConversationMessage[] = [
  { id: "m1", role: "user", text: "我最近在准备期末考试，每天复习到很晚。", at: new Date().toISOString() },
  { id: "m2", role: "assistant", text: "辛苦啦，记得别熬太晚，需要我帮你规划复习计划吗？", at: new Date().toISOString() },
];

const TASK: IngestTask = {
  conversationId: "conv-1",
  turnEventId: "evt-100",
  inputMessageId: "m1",
  finalMessageId: "m2",
};

describe("turn 摄入管线（逐事实写入）", () => {
  let storage: Awaited<ReturnType<typeof createTempStorage>>;

  beforeEach(async () => {
    storage = await createTempStorage();
  });

  afterEach(async () => {
    await storage.cleanup();
  });

  function makeIngestor(llmOutput: string) {
    const store = new MemoryStore(storage.storage, silentLog);
    const ingest = createTurnIngestor({
      conversations: {
        list: async () => ({ items: [] }),
        getMessages: async () => ({ items: MESSAGES, range: {} }),
      },
      llm: { generateText: async () => llmOutput },
      // 恒 null 的降级 embedder：纯关键词路径
      embedder: { id: "none", embed: async () => null },
      store,
      config: {
        embeddingProvider: "none",
        embeddingBaseUrl: "",
        embeddingModel: "",
        embeddingApiKeyName: "k",
        hotContextBudgetChars: 900,
        maxMemoriesPerTurn: 3,
      },
      log: silentLog,
    });
    return { store, ingest };
  }

  it("一轮抽取出的多条事实各自成条入库，带轮次溯源", async () => {
    const { store, ingest } = makeIngestor('["用户在准备期末考试", "用户最近睡得晚"]');
    await ingest(TASK);
    const all = store.all();
    expect(all).toHaveLength(2);
    expect(all[0].turn?.turnEventId).toBe("evt-100");
    expect(all[0].conversationId).toBe("conv-1");
    expect(all[0].embedding).toBeUndefined();
    expect(store.hasTurnEvent("evt-100")).toBe(true);
  });

  it("同一轮重复摄入：内容哈希去重拦截，不产生重复记录", async () => {
    const { store, ingest } = makeIngestor('["用户在准备期末考试"]');
    await ingest(TASK);
    await ingest(TASK);
    expect(store.all()).toHaveLength(1);
  });

  it("LLM 输出无法解析时安全跳过，不写垃圾数据", async () => {
    const { store, ingest } = makeIngestor("这不是 JSON");
    await ingest(TASK);
    expect(store.all()).toHaveLength(0);
  });

  it("对话消息为空时不做任何事", async () => {
    const store = new MemoryStore(storage.storage, silentLog);
    const ingest = createTurnIngestor({
      conversations: {
        list: async () => ({ items: [] }),
        getMessages: async () => ({ items: [], range: {} }),
      },
      llm: { generateText: async () => '["x"]' },
      embedder: { id: "none", embed: async () => null },
      store,
      config: {
        embeddingProvider: "none",
        embeddingBaseUrl: "",
        embeddingModel: "",
        embeddingApiKeyName: "k",
        hotContextBudgetChars: 900,
        maxMemoriesPerTurn: 3,
      },
      log: silentLog,
    });
    await ingest(TASK);
    expect(store.all()).toHaveLength(0);
  });

  it("通过 TaskQueue 串行摄入：两条任务顺序处理完，队列归零", async () => {
    // 两轮抽取不同事实，避免内容哈希去重干扰本测试的意图
    const outputs = ['["事实X"]', '["事实Y"]'];
    const store = new MemoryStore(storage.storage, silentLog);
    const ingest = createTurnIngestor({
      conversations: {
        list: async () => ({ items: [] }),
        getMessages: async () => ({ items: MESSAGES, range: {} }),
      },
      llm: { generateText: async () => outputs.shift() ?? "[]" },
      embedder: { id: "none", embed: async () => null },
      store,
      config: {
        embeddingProvider: "none",
        embeddingBaseUrl: "",
        embeddingModel: "",
        embeddingApiKeyName: "k",
        hotContextBudgetChars: 900,
        maxMemoriesPerTurn: 3,
      },
      log: silentLog,
    });
    const controller = new AbortController();
    const queue = new TaskQueue<IngestTask>({ signal: controller.signal, log: silentLog });
    const t1 = queue.enqueue({ ...TASK, turnEventId: "evt-1" }, async (task, signal) => {
      await ingest(task, signal);
    });
    const t2 = queue.enqueue({ ...TASK, turnEventId: "evt-2" }, async (task, signal) => {
      await ingest(task, signal);
    });
    await Promise.all([t1, t2]);
    expect(queue.stats()).toEqual({ pending: 0, running: 0 });
    expect(store.all()).toHaveLength(2);
    expect(store.all()[0].turn?.turnEventId).toBe("evt-1");
  });
});
