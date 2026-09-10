import { describe, expect, it } from "vitest";
import { buildEntityGraph, GRAPH_MAX_NODES } from "../src/core/graph";
import type { MemoryRecord } from "../src/core/types";

/** 固定时间戳：图谱不关心时间序，但 AGENTS.md 禁 Date.now() 同毫秒顺序断言，一律显式固定。 */
const T0 = 1_750_000_000_000;

function makeRecord(partial: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "content">): MemoryRecord {
  return { createdAt: T0, ...partial };
}

describe("实体图谱构建（buildEntityGraph）", () => {
  it("顶层 entities 与 entityClaims 的实体取并集建图", () => {
    const graph = buildEntityGraph([
      makeRecord({
        id: "r1",
        content: "艾莉丝在星穹车站告别",
        entities: ["艾莉丝"],
        entityClaims: [{ entity: "星穹车站", attribute: "位置", value: "三号月台" }],
      }),
      makeRecord({ id: "r2", content: "星穹车站的灯还亮着", entities: ["星穹车站"] }),
    ]);
    expect(graph.nodes.map((node) => node.name).sort()).toEqual(["艾莉丝", "星穹车站"].sort());
    // 星穹车站被两条记录提及；两实体在 r1 中共现
    expect(graph.nodes.find((node) => node.name === "星穹车站")!.count).toBe(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].weight).toBe(1);
    expect(graph.edges[0].a < graph.edges[0].b).toBe(true);
    // 共现双方互为邻居
    expect(graph.nodes.find((node) => node.name === "艾莉丝")!.degree).toBe(1);
    expect(graph.nodes.find((node) => node.name === "星穹车站")!.degree).toBe(1);
  });

  it("软删记录不参与建图", () => {
    const graph = buildEntityGraph([
      makeRecord({ id: "r1", content: "活着的共同记忆", entities: ["艾莉丝", "卡尔"] }),
      makeRecord({ id: "r2", content: "已遗忘的旧事", entities: ["艾莉丝", "卡尔"], deleted: true }),
    ]);
    // 软删记录的提及与共现全部不计
    expect(graph.nodes.map((node) => node.count)).toEqual([1, 1]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].weight).toBe(1);
  });

  it("共现边权随多条记录累加，端点按 a<b 字典序归一", () => {
    const graph = buildEntityGraph([
      makeRecord({ id: "r1", content: "1", entities: ["宙斯", "雅典娜"] }),
      makeRecord({ id: "r2", content: "2", entities: ["雅典娜", "宙斯"] }),
      makeRecord({
        id: "r3",
        content: "3",
        entityClaims: [
          { entity: "宙斯", attribute: "关系", value: "师徒" },
          { entity: "雅典娜", attribute: "关系", value: "师徒" },
        ],
      }),
    ]);
    expect(graph.edges).toHaveLength(1);
    const [a, b] = ["宙斯", "雅典娜"].sort();
    expect(graph.edges[0]).toEqual({ a, b, weight: 3 });
  });

  it("超过 40 个实体时按 (degree, count) 截断，边只在保留节点间重算", () => {
    expect(GRAPH_MAX_NODES).toBe(40);
    // 枢纽与 45 个叶子各共现一次：枢纽 degree=45，叶子 degree=1
    const records = Array.from({ length: 45 }, (_, i) =>
      makeRecord({
        id: `leaf-${String(i + 1).padStart(2, "0")}`,
        content: `叶子${i + 1}`,
        entities: ["枢纽", `实体-${String(i + 1).padStart(2, "0")}`],
      }),
    );
    const graph = buildEntityGraph(records);
    expect(graph.nodes).toHaveLength(GRAPH_MAX_NODES);
    const names = new Set(graph.nodes.map((node) => node.name));
    expect(names.has("枢纽")).toBe(true);
    expect(names.has("实体-40")).toBe(false);
    expect(names.has("实体-45")).toBe(false);
    // 边只剩 枢纽-保留叶子 共 39 条，被截掉的叶子不残留任何边
    expect(graph.edges).toHaveLength(GRAPH_MAX_NODES - 1);
    for (const edge of graph.edges) {
      expect(names.has(edge.a)).toBe(true);
      expect(names.has(edge.b)).toBe(true);
      expect(edge.a === "枢纽" || edge.b === "枢纽").toBe(true);
      expect(edge.weight).toBe(1);
    }
    // 截断只重算边：节点 degree/count 保持全量口径（枢纽仍连过 45 个实体）
    expect(graph.nodes.find((node) => node.name === "枢纽")!.degree).toBe(45);
    expect(graph.nodes.find((node) => node.name === "枢纽")!.count).toBe(45);
  });

  it("空输入与无实体记录返回空结构，不抛", () => {
    expect(buildEntityGraph([])).toEqual({ nodes: [], edges: [] });
    expect(buildEntityGraph([makeRecord({ id: "r1", content: "没有实体的记录" })])).toEqual({
      nodes: [],
      edges: [],
    });
    // 软删后即使带实体也是空图
    expect(
      buildEntityGraph([makeRecord({ id: "r2", content: "软删", entities: ["孤儿"], deleted: true })]),
    ).toEqual({ nodes: [], edges: [] });
    // 单实体：1 节点 0 边的合理形态
    const single = buildEntityGraph([makeRecord({ id: "r3", content: "独苗", entities: ["艾莉丝"] })]);
    expect(single.nodes).toHaveLength(1);
    expect(single.edges).toEqual([]);
  });

  it("注入 heatOf 时节点 heat 取相关记录均值，缺省与非有限值按中性 0.5", () => {
    const records = [
      makeRecord({ id: "r1", content: "1", entities: ["艾莉丝", "赫拉"] }),
      makeRecord({ id: "r2", content: "2", entities: ["艾莉丝"] }),
    ];
    const graph = buildEntityGraph(records, { heatOf: (record) => (record.id === "r1" ? 0.9 : 0.3) });
    // 艾莉丝被两条记录提及：(0.9 + 0.3) / 2；赫拉只出现在 r1
    expect(graph.nodes.find((node) => node.name === "艾莉丝")!.heat).toBeCloseTo(0.6, 10);
    expect(graph.nodes.find((node) => node.name === "赫拉")!.heat).toBeCloseTo(0.9, 10);
    // 未注入 heatOf：一律中性 0.5
    const neutral = buildEntityGraph(records);
    expect(neutral.nodes.every((node) => node.heat === 0.5)).toBe(true);
    // heatOf 返回非有限值：按 0.5 处理，不产 NaN
    const dirty = buildEntityGraph(records, { heatOf: () => Number.NaN });
    expect(dirty.nodes.every((node) => node.heat === 0.5)).toBe(true);
  });
});
