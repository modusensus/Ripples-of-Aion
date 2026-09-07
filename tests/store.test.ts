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

  it("新 claim 闭合同实体同属性的旧活跃 claim：validUntil 置为新记录 createdAt，重放后保持", async () => {
    const store = new MemoryStore(storage.storage, silentLog);
    await remember(store, {
      id: "", createdAt: 1000, content: "用户住在北京",
      entityClaims: [{ entity: "用户", attribute: "居住地", value: "北京", validFrom: 1000, validUntil: null }],
    }, silentLog);
    await remember(store, {
      id: "", createdAt: 2000, content: "用户搬到上海了",
      entityClaims: [{ entity: "用户", attribute: "居住地", value: "上海", validFrom: 2000, validUntil: null }],
    }, silentLog);

    const timeline = store.getEntityTimeline("用户");
    expect(timeline).toHaveLength(2);
    expect(timeline[0].claim.value).toBe("北京");
    expect(timeline[0].claim.validUntil).toBe(2000);
    expect(timeline[1].claim.value).toBe("上海");
    expect(timeline[1].claim.validUntil).toBeNull();

    // 闭合结果已落盘：新实例重放后时间轴一致
    const reloaded = new MemoryStore(storage.storage, silentLog);
    await reloaded.load();
    const replayed = reloaded.getEntityTimeline("用户");
    expect(replayed[0].claim.validUntil).toBe(2000);
    expect(replayed[1].claim.validUntil).toBeNull();
  });

  it("不同属性、不同实体互不闭合", async () => {
    const store = new MemoryStore(storage.storage, silentLog);
    await remember(store, {
      id: "", createdAt: 1000, content: "用户住在北京",
      entityClaims: [{ entity: "用户", attribute: "居住地", value: "北京", validFrom: 1000, validUntil: null }],
    }, silentLog);
    await remember(store, {
      id: "", createdAt: 2000, content: "用户在准备考试",
      entityClaims: [
        { entity: "用户", attribute: "目标", value: "期末考试", validFrom: 2000, validUntil: null },
        { entity: "月饼", attribute: "居住地", value: "上海", validFrom: 2000, validUntil: null },
      ],
    }, silentLog);

    expect(store.getEntityTimeline("用户", "居住地")[0].claim.validUntil).toBeNull();
    expect(store.getEntityTimeline("用户", "目标")).toHaveLength(1);
    expect(store.getEntityTimeline("月饼", "居住地")).toHaveLength(1);
  });

  it("与既有活跃 claim 完全相同（entity/attribute/value）时，新记录不挂重复 claim", async () => {
    const store = new MemoryStore(storage.storage, silentLog);
    await remember(store, {
      id: "", createdAt: 1000, content: "用户住在北京",
      entityClaims: [{ entity: "用户", attribute: "居住地", value: "北京", validFrom: 1000, validUntil: null }],
    }, silentLog);
    await remember(store, {
      id: "", createdAt: 2000, content: "我现在还是住在北京",
      entityClaims: [{ entity: "用户", attribute: "居住地", value: "北京", validFrom: 2000, validUntil: null }],
    }, silentLog);

    const [, second] = store.all();
    expect(second.entityClaims).toBeUndefined();
    expect(store.getEntityTimeline("用户")).toHaveLength(1);
    expect(store.getEntityTimeline("用户")[0].claim.validFrom).toBe(1000);
  });

  it("软删记录的 claim 不参与闭合也不出现在时间轴", async () => {
    const store = new MemoryStore(storage.storage, silentLog);
    await remember(store, {
      id: "", createdAt: 1000, content: "用户住在北京",
      entityClaims: [{ entity: "用户", attribute: "居住地", value: "北京", validFrom: 1000, validUntil: null }],
    }, silentLog);
    const [first] = store.all();
    await store.delete(first.id);
    await remember(store, {
      id: "", createdAt: 2000, content: "用户搬到上海了",
      entityClaims: [{ entity: "用户", attribute: "居住地", value: "上海", validFrom: 2000, validUntil: null }],
    }, silentLog);

    expect(store.getEntityTimeline("用户")).toHaveLength(1);
    expect(store.getEntityTimeline("用户")[0].claim.value).toBe("上海");
  });
});
