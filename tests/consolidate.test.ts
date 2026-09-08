import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginLlmMessage, PluginLlmService, PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createConsolidator } from "../src/pipeline/consolidate";
import { INSIGHTS_KEY, loadInsights, saveInsights } from "../src/core/insights";
import type { Insights } from "../src/core/insights";
import { MemoryStore } from "../src/core/store";
import type { Embedder, MemoryRecord } from "../src/core/types";
import { createTempStorage, silentLog } from "./helpers";

/**
 * 时间显式固定：createdAt 用固定基准递增，热度测试用显式 heat +
 * lastTouchedAt（Date.now() 只用来抵消衰减，不做同毫秒顺序断言）。
 */
const BASE = 1_700_000_000_000;
let seq = 0;

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  seq += 1;
  return {
    id: `r${seq}`,
    createdAt: BASE + seq * 1000,
    content: `记忆${seq}`,
    ...overrides,
  };
}

/** 捕获 LLM 请求的固定应答 mock。 */
function recordLlm(raw: string): { llm: PluginLlmService; calls: PluginLlmMessage[][] } {
  const calls: PluginLlmMessage[][] = [];
  const llm: PluginLlmService = {
    generateText: async (messages) => {
      calls.push(messages);
      return raw;
    },
  };
  return { llm, calls };
}

function labelsJson(count: number): string {
  return JSON.stringify({
    clusters: Array.from({ length: count }, (_, i) => ({ index: i, label: `主题${i}` })),
    conflicts: [],
  });
}

/** 一对共享实体「用户」的记录 + 三条无实体填充（凑满 5 条门槛）。 */
function catPairRecords(): MemoryRecord[] {
  const a = makeRecord({ content: "用户养了一只猫，名叫月饼", entities: ["用户"] });
  const b = makeRecord({ content: "月饼今天打了疫苗", entities: ["用户"] });
  return [a, b, makeRecord(), makeRecord(), makeRecord()];
}

describe("autoDream 整合引擎（createConsolidator）", () => {
  let temp: Awaited<ReturnType<typeof createTempStorage>>;

  beforeEach(async () => {
    temp = await createTempStorage();
  });

  afterEach(async () => {
    await temp.cleanup();
  });

  async function makeConsolidator(options: {
    records: MemoryRecord[];
    llm: PluginLlmService;
    embedder?: Embedder | null;
    maxRecords?: number;
    storage?: PluginStorage;
  }) {
    const store = new MemoryStore(temp.storage, silentLog);
    for (const record of options.records) await store.append(record);
    const consolidator = createConsolidator({
      store,
      llm: options.llm,
      embedder: options.embedder ?? null,
      storage: options.storage ?? temp.storage,
      maxRecords: options.maxRecords ?? 100,
      log: silentLog,
    });
    return { store, consolidator };
  }

  function userPromptOf(calls: PluginLlmMessage[][]): string {
    return calls[0]?.find((message) => message.role === "user")?.content ?? "";
  }

  it("记录不足 5 条：直接返回 null，不发起 LLM 调用", async () => {
    const records = [makeRecord(), makeRecord(), makeRecord(), makeRecord()];
    const { llm, calls } = recordLlm(labelsJson(0));
    const { consolidator } = await makeConsolidator({ records, llm });
    const result = await consolidator.run(new AbortController().signal);
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
    expect(loadInsights(temp.storage).lastRunAt).toBe(0);
  });

  it("全部无实体：不成簇不成对，返回 null 且不调 LLM", async () => {
    const records = [makeRecord(), makeRecord(), makeRecord(), makeRecord(), makeRecord()];
    const { llm, calls } = recordLlm(labelsJson(0));
    const { consolidator } = await makeConsolidator({ records, llm });
    const result = await consolidator.run(new AbortController().signal);
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("实体互不相同：不共享实体就不成簇，返回 null 且不调 LLM", async () => {
    const records = ["甲", "乙", "丙", "丁", "戊"].map((entity) => makeRecord({ entities: [entity] }));
    const { llm, calls } = recordLlm(labelsJson(0));
    const { consolidator } = await makeConsolidator({ records, llm });
    const result = await consolidator.run(new AbortController().signal);
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("共享实体成簇：LLM 命名标签，洞察落盘可读回，prompt 带全局序号", async () => {
    const records = catPairRecords();
    const { llm, calls } = recordLlm('{"clusters":[{"index":0,"label":"宠物日常"}],"conflicts":[]}');
    const { consolidator } = await makeConsolidator({ records, llm });
    const result = await consolidator.run(new AbortController().signal);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.lastRunAt).toBeGreaterThan(0);
    expect(result!.clusters).toHaveLength(1);
    const cluster = result!.clusters[0];
    expect(cluster.label).toBe("宠物日常");
    // 成员顺序 = 热度序：a 被 b 的提及 bump 过，排在最前
    expect(cluster.recordIds).toEqual([records[0].id, records[1].id]);
    expect(cluster.id).toMatch(/^cluster_\d+_[0-9a-f]{8}$/);
    expect(cluster.createdAt).toBeGreaterThan(0);
    expect(result!.conflicts).toHaveLength(0);
    expect(loadInsights(temp.storage)).toEqual(result);
    const prompt = userPromptOf(calls);
    expect(prompt).toContain(records[0].content);
    expect(prompt).toContain("#0.");
  });

  it("簇数超过 8：按簇大小取前 8，最旧的簇被裁掉", async () => {
    const records: MemoryRecord[] = [];
    for (let k = 0; k < 9; k += 1) {
      records.push(makeRecord({ content: `主题${k}的上半条`, entities: [`实体${k}`] }));
      records.push(makeRecord({ content: `主题${k}的下半条`, entities: [`实体${k}`] }));
    }
    const { llm, calls } = recordLlm(labelsJson(8));
    const { consolidator } = await makeConsolidator({ records, llm, maxRecords: 100 });
    const result = await consolidator.run(new AbortController().signal);
    expect(result).not.toBeNull();
    expect(result!.clusters).toHaveLength(8);
    const flat = result!.clusters.flatMap((cluster) => cluster.recordIds);
    expect(new Set(flat).size).toBe(16);
    // 每簇 2 条等大，稳定排序下最先发现的簇（最新一对）保留，
    // 最旧一对（前两条 append 的记录）被截掉
    expect(flat).not.toContain(records[0].id);
    expect(flat).not.toContain(records[1].id);
    expect(result!.clusters[0].recordIds).toEqual([records[16].id, records[17].id]);
    expect(result!.clusters[0].label).toBe("主题0");
    expect(userPromptOf(calls)).toContain("簇7：");
  });

  it("冲突预过滤：时间轴已闭合的旧值对被剔除，不再送审", async () => {
    const old = makeRecord({
      content: "用户养了一只猫",
      entities: ["用户"],
      entityClaims: [{ entity: "用户", attribute: "宠物", value: "猫" }],
    });
    const newer = makeRecord({
      content: "用户把猫送走了，现在没有宠物",
      entities: ["用户"],
      entityClaims: [{ entity: "用户", attribute: "宠物", value: "无" }],
    });
    const fillers = [makeRecord(), makeRecord(), makeRecord()];
    const { llm, calls } = recordLlm('{"clusters":[{"index":0,"label":"养猫"}],"conflicts":[]}');
    const { store, consolidator } = await makeConsolidator({ records: [old, newer, ...fillers], llm });
    // 前提：store 侧在 append 新值时已闭合旧声明
    const closed = store.all().find((record) => record.id === old.id);
    expect(typeof closed?.entityClaims?.[0]?.validUntil).toBe("number");
    const result = await consolidator.run(new AbortController().signal);
    expect(result).not.toBeNull();
    expect(result!.conflicts).toHaveLength(0);
    // 候选对被剔除：prompt 里只剩簇材料，没有矛盾候选对段落
    const prompt = userPromptOf(calls);
    expect(prompt).not.toContain("疑似矛盾候选对");
    expect(prompt).toContain(old.content);
  });

  it("候选矛盾对送审：LLM 产出的矛盾标注经校验后落盘", async () => {
    const a = makeRecord({
      content: "用户养了一只猫，名叫月饼",
      entities: ["用户"],
      entityClaims: [{ entity: "用户", attribute: "偏好", value: "养猫" }],
    });
    const b = makeRecord({
      content: "用户对猫毛过敏，不能养猫",
      entities: ["用户"],
      entityClaims: [{ entity: "用户", attribute: "健康状况", value: "对猫毛过敏" }],
    });
    const fillers = [makeRecord(), makeRecord(), makeRecord()];
    const raw = JSON.stringify({
      clusters: [{ index: 0, label: "猫咪" }],
      conflicts: [{ a: 0, b: 4, note: "之前说养猫，现在说对猫毛过敏，互相矛盾" }],
    });
    const { llm, calls } = recordLlm(raw);
    const { consolidator } = await makeConsolidator({ records: [a, b, ...fillers], llm });
    const result = await consolidator.run(new AbortController().signal);
    expect(result).not.toBeNull();
    expect(result!.clusters).toHaveLength(1);
    expect(result!.conflicts).toHaveLength(1);
    const conflict = result!.conflicts[0];
    expect(conflict.recordIds).toEqual([a.id, b.id]);
    expect(conflict.note).toBe("之前说养猫，现在说对猫毛过敏，互相矛盾");
    expect(conflict.id).toMatch(/^conflict_\d+_[0-9a-f]{8}$/);
    expect(conflict.createdAt).toBeGreaterThan(0);
    expect(loadInsights(temp.storage).conflicts).toHaveLength(1);
    const prompt = userPromptOf(calls);
    expect(prompt).toContain("疑似矛盾候选对");
    expect(prompt).toContain(a.content);
    expect(prompt).toContain(b.content);
  });

  it("evidence 强校验：a===b / 越界 / 空 note 逐条跳过，同对去重，字符串序号容忍", async () => {
    const records = catPairRecords();
    const raw = JSON.stringify({
      clusters: [
        { index: 0, label: "宠物日常" }, // 合法，取第一条
        { index: 0, label: "重复的标签" }, // 同簇重复 → 忽略
        { index: 9, label: "越界簇" }, // 簇序号越界
        { index: "x", label: "坏序号" }, // 非数字序号
        { index: 0, label: "   " }, // 空 label
      ],
      conflicts: [
        { a: 0, b: 0, note: "自指对" }, // a === b
        { a: 0, b: 99, note: "序号越界" }, // 越界
        { a: -1, b: 4, note: "负数越界" }, // 负数
        { a: 0, b: 4, note: "   " }, // 空 note
        { a: 0, b: 4, note: "有效矛盾" }, // 保留
        { a: 4, b: 0, note: "反向重复" }, // 同对去重
        { a: "0", b: "4", note: "字符串序号" }, // 字符串序号 + 同对去重
        { a: 0, b: 4 }, // note 缺失
      ],
    });
    const { llm } = recordLlm(raw);
    const { consolidator } = await makeConsolidator({ records, llm });
    const result = await consolidator.run(new AbortController().signal);
    expect(result).not.toBeNull();
    expect(result!.clusters[0].label).toBe("宠物日常");
    expect(result!.conflicts).toHaveLength(1);
    expect(result!.conflicts[0].note).toBe("有效矛盾");
    expect(result!.conflicts[0].recordIds).toEqual([records[0].id, records[1].id]);
  });

  it("矛盾摘要截断到 80 字符", async () => {
    const records = catPairRecords();
    const raw = JSON.stringify({
      clusters: [{ index: 0, label: "主题" }],
      conflicts: [{ a: 0, b: 4, note: "矛".repeat(100) }],
    });
    const { llm } = recordLlm(raw);
    const { consolidator } = await makeConsolidator({ records, llm });
    const result = await consolidator.run(new AbortController().signal);
    expect(result!.conflicts[0].note).toBe("矛".repeat(80));
  });

  it("容忍栅栏包裹和 JSON 前后的解释文字", async () => {
    const records = catPairRecords();
    const raw = [
      "好的，整合结果如下：",
      "```json",
      '{"clusters":[{"index":0,"label":"主题甲"}],"conflicts":[]}',
      "```",
      "希望有帮助",
    ].join("\n");
    const { llm } = recordLlm(raw);
    const { consolidator } = await makeConsolidator({ records, llm });
    const result = await consolidator.run(new AbortController().signal);
    expect(result).not.toBeNull();
    expect(result!.clusters[0].label).toBe("主题甲");
  });

  it("完全无法解析：返回 null，旧洞察保持不动", async () => {
    const records = catPairRecords();
    const oldInsights: Insights = { version: 1, lastRunAt: 123, clusters: [], conflicts: [] };
    saveInsights(temp.storage, oldInsights, silentLog);
    const { llm, calls } = recordLlm("这不是 JSON");
    const { consolidator } = await makeConsolidator({ records, llm });
    const result = await consolidator.run(new AbortController().signal);
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
    expect(loadInsights(temp.storage).lastRunAt).toBe(123);
  });

  it("LLM 抛错：warn 后返回 null 不抛异常，旧洞察保持不动", async () => {
    const records = catPairRecords();
    const oldInsights: Insights = { version: 1, lastRunAt: 123, clusters: [], conflicts: [] };
    saveInsights(temp.storage, oldInsights, silentLog);
    const llm: PluginLlmService = {
      generateText: async () => {
        throw new Error("api down");
      },
    };
    const { consolidator } = await makeConsolidator({ records, llm });
    await expect(consolidator.run(new AbortController().signal)).resolves.toBeNull();
    expect(loadInsights(temp.storage).lastRunAt).toBe(123);
  });

  it("LLM 返回后 signal 已中止：不落盘，返回 null", async () => {
    const records = catPairRecords();
    const oldInsights: Insights = { version: 1, lastRunAt: 123, clusters: [], conflicts: [] };
    saveInsights(temp.storage, oldInsights, silentLog);
    const controller = new AbortController();
    const llm: PluginLlmService = {
      generateText: async () => {
        controller.abort();
        return labelsJson(1);
      },
    };
    const { consolidator } = await makeConsolidator({ records, llm });
    const result = await consolidator.run(controller.signal);
    expect(result).toBeNull();
    expect(loadInsights(temp.storage).lastRunAt).toBe(123);
  });

  it("预先中止的 signal：直接返回 null，不调 LLM", async () => {
    const records = catPairRecords();
    const { llm, calls } = recordLlm(labelsJson(1));
    const { consolidator } = await makeConsolidator({ records, llm });
    const controller = new AbortController();
    controller.abort();
    const result = await consolidator.run(controller.signal);
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("maxRecords 按有效热度降序选取：缺省按中性 0.5 参与，落选记录不参与聚类", async () => {
    const now = Date.now();
    const a1 = makeRecord({ content: "甲一", entities: ["甲"], heat: 0.99, lastTouchedAt: now });
    const a2 = makeRecord({ content: "甲二", entities: ["甲"], heat: 0.9, lastTouchedAt: now });
    const b1 = makeRecord({ content: "乙一", entities: ["乙"], heat: 0.8, lastTouchedAt: now });
    const b2 = makeRecord({ content: "乙二", entities: ["乙"], heat: 0.05, lastTouchedAt: now });
    const c1 = makeRecord({ content: "丙一", entities: ["丙"], heat: 0.6, lastTouchedAt: now });
    // 缺省 heat：中性 0.5（createdAt 取当下，衰减可忽略）
    const c2 = makeRecord({ content: "丙二", entities: ["丙"], createdAt: now });
    const { llm } = recordLlm(labelsJson(2));
    const { consolidator } = await makeConsolidator({
      records: [a1, a2, b1, b2, c1, c2],
      llm,
      maxRecords: 5,
    });
    const result = await consolidator.run(new AbortController().signal);
    expect(result).not.toBeNull();
    expect(result!.clusters).toHaveLength(2);
    // top5 ≈ a1(0.99+bump) a2(0.9) b1(0.8+bump) c1(0.6+bump) c2(≈0.5)；
    // b2(0.05) 落选 → 乙簇只剩 1 条被丢弃；c2 缺省热度仍入选
    const ids = new Set(result!.clusters.flatMap((cluster) => cluster.recordIds));
    expect(ids).toEqual(new Set([a1.id, a2.id, c1.id, c2.id]));
  });

  it("embedder 簇内校验：与簇中心余弦过低的离群记录被摘出", async () => {
    const m1 = makeRecord({ content: "甲一", entities: ["甲"] });
    const m2 = makeRecord({ content: "甲二", entities: ["甲"] });
    const m3 = makeRecord({ content: "完全无关的一条", entities: ["甲"] });
    const fillers = [makeRecord(), makeRecord()];
    const embedder: Embedder = {
      id: "test",
      embed: async (texts) => texts.map((text) => (text === "完全无关的一条" ? [0, 1] : [1, 0])),
    };
    const { llm } = recordLlm(labelsJson(1));
    const { consolidator } = await makeConsolidator({ records: [m1, m2, m3, ...fillers], llm, embedder });
    const result = await consolidator.run(new AbortController().signal);
    expect(result).not.toBeNull();
    expect(result!.clusters).toHaveLength(1);
    // m3 与中心 (2/3, 1/3) 的余弦 ≈ 0.447 < 0.5，被摘出（宁缺勿错分）
    expect(result!.clusters[0].recordIds).toEqual([m1.id, m2.id]);
  });

  it("embedder 失败降级（返回 null）：跳过簇内校验，纯实体聚类照常", async () => {
    const records = [
      makeRecord({ content: "甲一", entities: ["甲"] }),
      makeRecord({ content: "甲二", entities: ["甲"] }),
      makeRecord({ content: "甲三", entities: ["甲"] }),
      makeRecord(),
      makeRecord(),
    ];
    const embedder: Embedder = { id: "none", embed: async () => null };
    const { llm } = recordLlm(labelsJson(1));
    const { consolidator } = await makeConsolidator({ records, llm, embedder });
    const result = await consolidator.run(new AbortController().signal);
    expect(result!.clusters[0].recordIds).toHaveLength(3);
  });

  it("embedder 失败降级（抛错）：跳过簇内校验，纯实体聚类照常", async () => {
    const records = [
      makeRecord({ content: "甲一", entities: ["甲"] }),
      makeRecord({ content: "甲二", entities: ["甲"] }),
      makeRecord({ content: "甲三", entities: ["甲"] }),
      makeRecord(),
      makeRecord(),
    ];
    const embedder: Embedder = {
      id: "boom",
      embed: async () => {
        throw new Error("network down");
      },
    };
    const { llm } = recordLlm(labelsJson(1));
    const { consolidator } = await makeConsolidator({ records, llm, embedder });
    const result = await consolidator.run(new AbortController().signal);
    expect(result).not.toBeNull();
    expect(result!.clusters[0].recordIds).toHaveLength(3);
  });

  it("落盘失败（set 抛错 / 静默丢失）：run 返回 null，旧洞察保持不动", async () => {
    const records = catPairRecords();
    const map = new Map<string, unknown>();
    map.set(INSIGHTS_KEY, { version: 1, lastRunAt: 123, clusters: [], conflicts: [] } satisfies Insights);
    const brokenStorage: PluginStorage = {
      get: (key) => map.get(key) as never,
      set: () => {
        throw new Error("quota exceeded");
      },
      rootDir: () => "/mock/broken",
    };
    const noopStorage: PluginStorage = {
      get: (key) => map.get(key) as never,
      set: () => {}, // 静默失败：写入悄悄丢掉
      rootDir: () => "/mock/noop",
    };
    const first = recordLlm(labelsJson(1));
    const second = recordLlm(labelsJson(1));
    const store = new MemoryStore(temp.storage, silentLog);
    for (const record of records) await store.append(record);
    const broken = createConsolidator({
      store,
      llm: first.llm,
      embedder: null,
      storage: brokenStorage,
      maxRecords: 100,
      log: silentLog,
    });
    expect(await broken.run(new AbortController().signal)).toBeNull();
    // 静默失败由落盘回读校验兜住：写没写进去，回读说了算
    const noop = createConsolidator({
      store,
      llm: second.llm,
      embedder: null,
      storage: noopStorage,
      maxRecords: 100,
      log: silentLog,
    });
    expect(await noop.run(new AbortController().signal)).toBeNull();
    // 两次 run 都走到了 LLM 之后的落盘环节才失败
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    expect(loadInsights(brokenStorage).lastRunAt).toBe(123);
    expect(loadInsights(noopStorage).lastRunAt).toBe(123);
  });
});
