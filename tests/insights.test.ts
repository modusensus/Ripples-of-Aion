import { describe, expect, it } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { INSIGHTS_KEY, loadInsights, saveInsights } from "../src/core/insights";
import type { Insights } from "../src/core/insights";
import { silentLog } from "./helpers";

const SAMPLE: Insights = {
  version: 1,
  lastRunAt: 1_700_000_000_000,
  clusters: [
    {
      id: "cluster_1700000000000_ab12cd34",
      label: "宠物日常",
      recordIds: ["r1", "r2"],
      createdAt: 1_700_000_000_000,
    },
  ],
  conflicts: [
    {
      id: "conflict_1700000000000_ab12cd34",
      recordIds: ["r1", "r3"],
      note: "之前说养猫，现在说对猫过敏，互相矛盾",
      createdAt: 1_700_000_000_000,
    },
  ],
};

const EMPTY: Insights = { version: 1, lastRunAt: 0, clusters: [], conflicts: [] };

/** Map 后端的内存存储；insights 存取不依赖 rootDir。 */
function makeMapStorage(map: Map<string, unknown>): PluginStorage {
  return {
    get: (key) => map.get(key) as never,
    set: (key, value) => {
      map.set(key, value);
    },
    rootDir: () => "/mock/insights",
  };
}

describe("insights 存取（autoDream 洞察落盘）", () => {
  it("round-trip：save 后 load 原样读回", () => {
    const map = new Map<string, unknown>();
    const storage = makeMapStorage(map);
    saveInsights(storage, SAMPLE, silentLog);
    expect(loadInsights(storage)).toEqual(SAMPLE);
  });

  it("缺失 key：回退到从未整合过的空洞察", () => {
    const storage = makeMapStorage(new Map());
    expect(loadInsights(storage)).toEqual(EMPTY);
  });

  it("整体坏数据：非对象 / version 不对 / lastRunAt 坏 / 数组缺失，一律回退空洞察", () => {
    const bad: unknown[] = [
      "垃圾字符串",
      42,
      null,
      { version: 2, lastRunAt: 1, clusters: [], conflicts: [] },
      { version: 1, lastRunAt: "昨天", clusters: [], conflicts: [] },
      { version: 1, lastRunAt: Number.NaN, clusters: [], conflicts: [] },
      { version: 1, lastRunAt: 1, clusters: {}, conflicts: [] },
      { version: 1, lastRunAt: 1, clusters: [], conflicts: "没有" },
    ];
    for (const item of bad) {
      const map = new Map<string, unknown>();
      map.set(INSIGHTS_KEY, item);
      expect(loadInsights(makeMapStorage(map)), `坏数据: ${JSON.stringify(item)}`).toEqual(EMPTY);
    }
  });

  it("条目级坏数据：畸形条目逐个丢弃，合法条目保留", () => {
    const map = new Map<string, unknown>();
    map.set(INSIGHTS_KEY, {
      version: 1,
      lastRunAt: 7,
      clusters: [
        SAMPLE.clusters[0],
        { id: "c2", label: 123, recordIds: ["r1"], createdAt: 1 }, // label 非字符串
        { id: "", label: "无 id", recordIds: ["r1"], createdAt: 1 }, // id 空
        { id: "c3", label: "无成员", recordIds: [], createdAt: 1 }, // recordIds 空
        { id: "c4", label: "时间坏", recordIds: ["r1"], createdAt: "上周" },
        "彻底不是对象",
      ],
      conflicts: [
        SAMPLE.conflicts[0],
        { id: "k2", note: "缺一条", recordIds: ["r1"], createdAt: 1 }, // recordIds 不是两条
        { id: "k3", note: "成员非字符串", recordIds: ["r1", 2], createdAt: 1 },
      ],
    });
    const loaded = loadInsights(makeMapStorage(map));
    expect(loaded.lastRunAt).toBe(7);
    expect(loaded.clusters).toEqual([SAMPLE.clusters[0]]);
    expect(loaded.conflicts).toEqual([SAMPLE.conflicts[0]]);
  });

  it("写入异常不抛：storage.set 抛错只由 saveInsights 吞掉并 warn", () => {
    const storage: PluginStorage = {
      get: (key) => undefined,
      set: () => {
        throw new Error("disk full");
      },
      rootDir: () => "/mock/insights",
    };
    expect(() => saveInsights(storage, SAMPLE, silentLog)).not.toThrow();
  });

  it("读取异常不抛：storage.get 抛错回退空洞察", () => {
    const storage: PluginStorage = {
      get: () => {
        throw new Error("io error");
      },
      set: () => {},
      rootDir: () => "/mock/insights",
    };
    expect(loadInsights(storage)).toEqual(EMPTY);
  });
});
