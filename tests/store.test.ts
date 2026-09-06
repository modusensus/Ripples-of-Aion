import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryRecord } from "../src/core/types";
import { remember } from "../src/core/remember";
import { dedupKeyOf, MemoryStore } from "../src/core/store";
import { createTempStorage, silentLog } from "./helpers";

function makeRecord(content: string, turnEventId?: string): MemoryRecord {
  return {
    id: "",
    createdAt: Date.now(),
    content,
    turn: turnEventId
      ? { conversationId: "conv-1", turnEventId, runId: "run-1" }
      : undefined,
  };
}

describe("MemoryStore", () => {
  let storage: Awaited<ReturnType<typeof createTempStorage>>;

  beforeEach(async () => {
    storage = await createTempStorage();
  });

  afterEach(async () => {
    await storage.cleanup();
  });

  it("append 落盘后，新实例能从 JSONL 完整重放", async () => {
    const store = new MemoryStore(storage.storage, silentLog);
    await store.append(makeRecord("用户喜欢深夜写代码", "evt-1"));
    await store.append(makeRecord("用户在准备考试", "evt-2"));

    const reloaded = new MemoryStore(storage.storage, silentLog);
    await reloaded.load();
    const all = reloaded.all();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.content)).toEqual(["用户喜欢深夜写代码", "用户在准备考试"]);
  });

  it("remember 内容哈希去重：相同内容只写一份，不同内容各自保留", async () => {
    const store = new MemoryStore(storage.storage, silentLog);
    expect(await remember(store, makeRecord("喜欢咖啡", "evt-1"), silentLog)).toBe(true);
    // 同内容不同轮次 → 仍然拦截（全局内容去重）
    expect(await remember(store, makeRecord("喜欢咖啡", "evt-2"), silentLog)).toBe(false);
    // 不同内容 → 放行
    expect(await remember(store, makeRecord("喜欢茶", "evt-2"), silentLog)).toBe(true);
    expect(store.all()).toHaveLength(2);
  });

  it("delete 软删后 all/getStats/检索全部排除，且允许同内容重写", async () => {
    const store = new MemoryStore(storage.storage, silentLog);
    const ok = await remember(store, makeRecord("要删除的内容", "evt-1"), silentLog);
    expect(ok).toBe(true);
    const [record] = store.all();
    expect(record).toBeTruthy();

    await store.delete(record.id);
    expect(store.all()).toHaveLength(0);
    expect(store.getStats().active).toBe(0);
    expect(store.searchKeyword("删除").map((r) => r.id)).not.toContain(record.id);

    // 软删移除去重键：同内容可以重新写入（用户明确要求重建）
    expect(await remember(store, makeRecord("要删除的内容", "evt-2"), silentLog)).toBe(true);
  });

  it("hasTurnEvent 永久标记轮次，删除记忆不清除", async () => {
    const store = new MemoryStore(storage.storage, silentLog);
    await remember(store, makeRecord("某条事实", "evt-9"), silentLog);
    expect(store.hasTurnEvent("evt-9")).toBe(true);
    const [record] = store.all();
    await store.delete(record.id);
    expect(store.hasTurnEvent("evt-9")).toBe(true);
  });

  it("searchKeyword 按命中词数排序并排除软删", async () => {
    const store = new MemoryStore(storage.storage, silentLog);
    await remember(store, makeRecord("用户喜欢咖啡也喜欢茶", "e1"), silentLog);
    await remember(store, makeRecord("用户喜欢咖啡", "e2"), silentLog);
    const hits = store.searchKeyword("喜欢 咖啡 茶");
    expect(hits.length).toBe(2);
    expect(hits[0].content).toContain("也喜欢");
  });

  it("getStats 区分 total 与 active", async () => {
    const store = new MemoryStore(storage.storage, silentLog);
    await remember(store, makeRecord("事实A", "e1"), silentLog);
    await remember(store, makeRecord("事实B", "e2"), silentLog);
    const before = store.getStats();
    expect(before.total).toBe(2);
    expect(before.active).toBe(2);
    const [record] = store.all();
    await store.delete(record.id);
    const after = store.getStats();
    expect(after.total).toBe(2);
    expect(after.active).toBe(1);
  });

  it("dedupKeyOf 对空内容返回 undefined", () => {
    expect(dedupKeyOf(makeRecord(""))).toBeUndefined();
  });
});
