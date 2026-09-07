import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryRecord } from "../src/core/types";
import { canonicalAttr } from "../src/core/attributes";
import { remember } from "../src/core/remember";
import { dedupKeyOf, effectiveHeatOf, MemoryStore } from "../src/core/store";
import { appendJsonl } from "../src/util/jsonl";
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

  it("属性别名归一化：「工作所在地」的新 claim 也能闭合「工作地点」的旧活跃 claim（生产 bug 回归）", async () => {
    const store = new MemoryStore(storage.storage, silentLog);
    await remember(store, {
      id: "", createdAt: 1000, content: "用户的工作地点在杭州",
      entityClaims: [{ entity: "用户", attribute: "工作地点", value: "杭州", validFrom: 1000, validUntil: null }],
    }, silentLog);
    // v0.2.0 生产 bug：LLM 换个字面量「工作所在地」，旧 claim 不被闭合，
    // 时间轴出现两条并存的有效声明——归一化后必须视为同一属性
    await remember(store, {
      id: "", createdAt: 2000, content: "用户换到上海工作了",
      entityClaims: [{ entity: "用户", attribute: "工作所在地", value: "上海", validFrom: 2000, validUntil: null }],
    }, silentLog);

    const timeline = store.getEntityTimeline("用户", "工作地点");
    expect(timeline).toHaveLength(2);
    expect(timeline[0].claim.value).toBe("杭州");
    expect(timeline[0].claim.validUntil).toBe(2000);
    expect(timeline[1].claim.value).toBe("上海");
    expect(timeline[1].claim.validUntil).toBeNull();
    // 新 claim 落库即 canonical 形式
    expect(timeline[1].claim.attribute).toBe("工作地点");

    // 重放一致：闭合结果已落盘
    const reloaded = new MemoryStore(storage.storage, silentLog);
    await reloaded.load();
    expect(reloaded.getEntityTimeline("用户", "工作地点")).toHaveLength(2);
    expect(reloaded.getEntityTimeline("用户", "工作地点")[0].claim.validUntil).toBe(2000);
  });

  it("历史遗留字面量也能被闭合：存量「工作所在地」与新「工作地点」比较为同一属性", async () => {
    // 直接往 JSONL 写一条未经归一化的旧字面量 claim，模拟 v0.2.0 存量数据
    //（走 append 的话新字面量会被归一化，构造不出存量场景）
    await appendJsonl(join(storage.rootDir, "memories.jsonl"), {
      op: "put",
      record: {
        id: "legacy-1", createdAt: 1000, content: "用户的工作所在地在杭州",
        entityClaims: [{ entity: "用户", attribute: "工作所在地", value: "杭州", validFrom: 1000, validUntil: null }],
      },
    });
    const store = new MemoryStore(storage.storage, silentLog);
    await remember(store, {
      id: "", createdAt: 2000, content: "用户换到上海工作了",
      entityClaims: [{ entity: "用户", attribute: "工作地点", value: "上海", validFrom: 2000, validUntil: null }],
    }, silentLog);

    const timeline = store.getEntityTimeline("用户", "工作地点");
    expect(timeline).toHaveLength(2);
    // 存量 claim 的原始字面量保留不丢真，但比较看 canonical，照样被闭合
    expect(timeline[0].claim.attribute).toBe("工作所在地");
    expect(timeline[0].claim.value).toBe("杭州");
    expect(timeline[0].claim.validUntil).toBe(2000);
    expect(timeline[1].claim.validUntil).toBeNull();
  });

  it("getEntityTimeline：「出差行程」与「行程」按 canonical 归入同一 track，原始字面量各自保留", async () => {
    await appendJsonl(join(storage.rootDir, "memories.jsonl"), {
      op: "put",
      record: {
        id: "legacy-trip", createdAt: 1000, content: "用户在东京出差",
        entityClaims: [{ entity: "用户", attribute: "出差行程", value: "东京", validFrom: 1000, validUntil: null }],
      },
    });
    const store = new MemoryStore(storage.storage, silentLog);
    await remember(store, {
      id: "", createdAt: 2000, content: "用户接下来去大阪",
      entityClaims: [{ entity: "用户", attribute: "行程", value: "大阪", validFrom: 2000, validUntil: null }],
    }, silentLog);

    // 单属性查询：两个字面量都在「行程」track 上
    const track = store.getEntityTimeline("用户", "行程");
    expect(track.map((e) => e.claim.value)).toEqual(["东京", "大阪"]);
    expect(track.map((e) => e.claim.attribute)).toEqual(["出差行程", "行程"]);
    expect(track[0].claim.validUntil).toBe(2000);
    // 不带属性过滤也在同一条时间轴上，不重复成两条 track
    expect(store.getEntityTimeline("用户")).toHaveLength(2);
  });

  it("重述去重跨别名：同实体同属性（canonical 口径）同值的重述不再挂 claim", async () => {
    const store = new MemoryStore(storage.storage, silentLog);
    await remember(store, {
      id: "", createdAt: 1000, content: "用户住在北京",
      entityClaims: [{ entity: "用户", attribute: "居住地", value: "北京", validFrom: 1000, validUntil: null }],
    }, silentLog);
    await remember(store, {
      id: "", createdAt: 2000, content: "我的住址还是北京",
      entityClaims: [{ entity: "用户", attribute: "住址", value: "北京", validFrom: 2000, validUntil: null }],
    }, silentLog);

    const [, second] = store.all();
    expect(second.entityClaims).toBeUndefined();
    expect(store.getEntityTimeline("用户", "居住地")).toHaveLength(1);
    // 用别名字面量查询也能命中同一条时间轴
    expect(store.getEntityTimeline("用户", "住址")).toHaveLength(1);
  });
});

describe("属性别名归一化（canonicalAttr）", () => {
  it("别名映射命中：生产实测变体与常见同义词归一到 canonical 词条", () => {
    expect(canonicalAttr("工作所在地")).toBe("工作地点");
    expect(canonicalAttr("出差行程")).toBe("行程");
    expect(canonicalAttr("住址")).toBe("居住地");
    expect(canonicalAttr("健康状态")).toBe("健康状况");
    expect(canonicalAttr("公司")).toBe("雇主");
    // 语义不同的属性绝不合并
    expect(canonicalAttr("所在地")).toBe("所在地");
    expect(canonicalAttr("职业")).toBe("职业");
  });

  it("清洗：trim + 全角转半角 + 去中间空格，清洗后再查别名表", () => {
    expect(canonicalAttr("  居住地  ")).toBe("居住地");
    expect(canonicalAttr("职　位")).toBe("职位");
    expect(canonicalAttr("工作 地点")).toBe("工作地点");
    expect(canonicalAttr("　出差行程　")).toBe("行程");
    expect(canonicalAttr("ＩＤ")).toBe("ID");
  });

  it("未命中别名表时原样返回（清洗后），归一化幂等", () => {
    expect(canonicalAttr("宠物")).toBe("宠物");
    expect(canonicalAttr("宠物 名")).toBe("宠物名");
    expect(canonicalAttr("名字来源")).toBe("名字来源");
    expect(canonicalAttr("工作地点")).toBe("工作地点");
    expect(canonicalAttr(canonicalAttr("工作所在地"))).toBe(canonicalAttr("工作所在地"));
  });

  it("空串与纯空白安全：返回空串，不抛异常", () => {
    expect(canonicalAttr("")).toBe("");
    expect(canonicalAttr("   ")).toBe("");
    expect(canonicalAttr("　")).toBe("");
  });
});

describe("主观热度（heat）", () => {
  let storage: Awaited<ReturnType<typeof createTempStorage>>;

  beforeEach(async () => {
    storage = await createTempStorage();
  });

  afterEach(async () => {
    await storage.cleanup();
  });

  /** 日志行数 = 落盘 op 数；先等 fire-and-forget 写入完成再数，避免竞态。 */
  async function journalOps(store: MemoryStore): Promise<number> {
    await store.awaitPendingWrites();
    const raw = await readFile(join(storage.rootDir, "memories.jsonl"), "utf8");
    return raw.split("\n").filter((line) => line.trim() !== "").length;
  }

  it("有效热度按 exp 公式惰性衰减：缺省中性 0.5、半衰期 ≈ ln2/decay", () => {
    const now = 1_000_000_000_000;
    const day = 86_400_000;
    const base: MemoryRecord = { id: "a", createdAt: now, content: "x" };
    // 缺省 heat 视为中性 0.5（getter 语义）；刚创建（now = 锚点）不衰减
    expect(effectiveHeatOf(base, 0.05, now)).toBe(0.5);
    // heat=0.8：10 天后 = 0.8 * exp(-0.05*10)
    const touched: MemoryRecord = { ...base, heat: 0.8, lastTouchedAt: now };
    expect(effectiveHeatOf(touched, 0.05, now + 10 * day)).toBeCloseTo(0.8 * Math.exp(-0.5), 12);
    // 半衰期：ln2 / 0.05 ≈ 13.86 天衰到一半
    expect(effectiveHeatOf(touched, 0.05, now + (Math.LN2 / 0.05) * day)).toBeCloseTo(0.4, 12);
    // 从未触碰的记忆从 createdAt 起算衰减：老而未被想起的自然沉底
    expect(effectiveHeatOf({ ...base, createdAt: now - 100 * day }, 0.05, now)).toBeLessThan(0.5);
    // 时钟回拨不放大热度
    expect(effectiveHeatOf(touched, 0.05, now - day)).toBe(0.8);
    // 越界持久值先夹取到 [0,1]；decay=0 时有效热度恒等于存储值
    expect(effectiveHeatOf({ ...base, heat: 5, lastTouchedAt: now }, 0, now)).toBe(1);
    expect(effectiveHeatOf({ ...base, heat: -3, lastTouchedAt: now }, 0, now)).toBe(0);
  });

  it("bump 抖动抑制：30 分钟内重复 bump 只影响内存不落盘，超过间隔才追加 put op", async () => {
    const store = new MemoryStore(storage.storage, silentLog);
    const now = 1_700_000_000_000;
    await remember(store, { id: "", createdAt: now, content: "常被想起的事实" }, silentLog);
    const [record] = store.all();
    expect(await journalOps(store)).toBe(1);

    // 首次 bump：中性 0.5 升一档到 0.575，落盘
    store.bumpHeat([record.id], { now });
    expect(record.heat).toBeCloseTo(0.575, 6);
    expect(await journalOps(store)).toBe(2);

    // 10 分钟后重复 bump：节流窗口内只影响内存（热度继续爬升），不追加日志
    store.bumpHeat([record.id], { now: now + 10 * 60_000 });
    expect(record.heat).toBeGreaterThan(0.575);
    expect(await journalOps(store)).toBe(2);

    // 距上次触碰 31 分钟：超过间隔，重新落盘
    store.bumpHeat([record.id], { now: now + 10 * 60_000 + 31 * 60_000 });
    expect(await journalOps(store)).toBe(3);

    // 落盘快照与内存一致：新实例重放后热度、触碰时间都对得上
    const reloaded = new MemoryStore(storage.storage, silentLog);
    await reloaded.load();
    const [replayed] = reloaded.all();
    expect(replayed.heat).toBe(record.heat);
    expect(replayed.lastTouchedAt).toBe(record.lastTouchedAt);
  });

  it("被提及加权：append 带相同实体的新记录后，旧记录热度上升且产生 put op", async () => {
    const store = new MemoryStore(storage.storage, silentLog);
    // 旧记录 1 分钟前创建：衰减可忽略，但衰减锚点早于 bump 时刻
    await remember(store, {
      id: "", createdAt: Date.now() - 60_000,
      content: "用户养了只猫叫月饼",
      entities: ["用户", "月饼"],
    }, silentLog);
    const [old] = store.all();
    expect(old.heat).toBeUndefined();

    // 新记忆提及「月饼」→ 旧记录被提及 bump：中性 0.5 起步升一档 ≈ 0.575
    await remember(store, {
      id: "", createdAt: Date.now(),
      content: "月饼爱睡键盘",
      entities: ["月饼"],
    }, silentLog);
    const [, fresh] = store.all();
    expect(fresh.heat).toBeUndefined(); // 新记录本身不 bump
    expect(old.heat).toBeCloseTo(0.575, 2);
    expect(typeof old.lastTouchedAt).toBe("number");
    expect(await journalOps(store)).toBe(3); // 2 条 remember put + 1 次 bump 落盘

    // 重放一致：新实例读到的热度与触碰时间相同
    const reloaded = new MemoryStore(storage.storage, silentLog);
    await reloaded.load();
    const [replayed] = reloaded.all();
    expect(replayed.heat).toBe(old.heat);
    expect(replayed.lastTouchedAt).toBe(old.lastTouchedAt);
  });

  it("bumpHeat fail-safe：未加载 / 未知 id / 脏数据都不抛、不产 NaN", async () => {
    const store = new MemoryStore(storage.storage, silentLog);
    // 未 load（内存索引为空）+ 未知 id：静默跳过
    expect(() => store.bumpHeat(["ghost", ""])).not.toThrow();
    await remember(store, {
      id: "", createdAt: 1000, content: "脏数据记录",
      heat: Number.NaN, lastTouchedAt: Number.NaN,
    }, silentLog);
    const [record] = store.all();
    expect(() => store.bumpHeat([record.id, "ghost"])).not.toThrow();
    expect(Number.isFinite(record.heat)).toBe(true);
    expect(Number.isFinite(record.lastTouchedAt)).toBe(true);
    // 该 bump 未被节流、会落盘：等同节流写结束再收尾，避免清理撞上在途写入
    await store.awaitPendingWrites();
  });

  it("bump 落盘失败只 warn 不抛，内存热度照常生效（fail-safe）", async () => {
    const store = new MemoryStore(storage.storage, silentLog);
    await remember(store, { id: "", createdAt: 1000, content: "会被想起的事实" }, silentLog);
    const [record] = store.all();
    // 破坏日志文件：换成同名目录，让追加写必然失败
    const journal = join(storage.rootDir, "memories.jsonl");
    await rm(journal);
    await mkdir(journal);
    expect(() => store.bumpHeat([record.id], { now: 1000 })).not.toThrow();
    // 内存照常生效（排序仍能受益），落盘失败只 warn
    expect(record.heat).toBeCloseTo(0.575, 6);
    // 失败在写链内被吞掉：等待挂起写入也能正常结束（不悬挂、不抛）
    await store.awaitPendingWrites();
  });
});
