import { describe, expect, it } from "vitest";
import type { PluginLlmService } from "@playa0v0/cyrene-plugin-sdk";
import { extractTurn } from "../src/pipeline/extractor";
import { silentLog } from "./helpers";

const MESSAGES = [
  { id: "m1", role: "user" as const, text: "我上个月搬到上海了，现在养了只猫叫月饼。", at: new Date().toISOString() },
  { id: "m2", role: "assistant" as const, text: "新家还习惯吗？月饼真是个好名字。", at: new Date().toISOString() },
];

function makeLlm(raw: string): PluginLlmService {
  return { generateText: async () => raw };
}

function extract(raw: string, maxFacts = 3) {
  return extractTurn(makeLlm(raw), MESSAGES, { maxFacts, log: silentLog });
}

describe("extractTurn（事实 + 属性声明）", () => {
  it("对象格式：facts 与 claims 正常解析，claim 字段与下标校验通过", async () => {
    const raw = JSON.stringify({
      facts: ["用户上个月搬到了上海", "用户养了一只猫，名叫月饼"],
      claims: [
        { entity: "用户", attribute: "居住地", value: "上海", fact: 0 },
        { entity: "月饼", attribute: "物种", value: "猫", fact: 1 },
      ],
    });
    const turn = await extract(raw);
    expect(turn.facts).toHaveLength(2);
    expect(turn.claims).toEqual([
      { entity: "用户", attribute: "居住地", value: "上海", factIndex: 0 },
      { entity: "月饼", attribute: "物种", value: "猫", factIndex: 1 },
    ]);
  });

  it("旧格式纯字符串数组：只有 facts，claims 为空", async () => {
    const turn = await extract('["用户在准备期末考试"]');
    expect(turn.facts).toEqual(["用户在准备期末考试"]);
    expect(turn.claims).toEqual([]);
  });

  it("容忍栅栏包裹和 JSON 前后的解释文字", async () => {
    const fenced = '好的，以下是抽取结果：\n```json\n{"facts": ["用户住在上海"], "claims": [{"entity": "用户", "attribute": "居住地", "value": "上海", "fact": 0}]}\n```';
    const turn = await extract(fenced);
    expect(turn.facts).toEqual(["用户住在上海"]);
    expect(turn.claims).toHaveLength(1);

    const prose = '结果如下 {"facts": ["用户喜欢咖啡"], "claims": []} 希望有帮助';
    const turn2 = await extract(prose);
    expect(turn2.facts).toEqual(["用户喜欢咖啡"]);
  });

  it("坏 claim 逐条丢弃：缺字段、下标越界、非字符串值都不入库，facts 保留", async () => {
    const raw = JSON.stringify({
      facts: ["事实A", "事实B"],
      claims: [
        { entity: "", attribute: "居住地", value: "上海", fact: 0 },
        { entity: "用户", attribute: "居住地", value: "上海", fact: 99 },
        { entity: "用户", attribute: "职业", value: 42, fact: 0 },
        { entity: "用户", attribute: "宠物", value: "月饼", fact: "1" },
      ],
    });
    const turn = await extract(raw);
    expect(turn.facts).toHaveLength(2);
    expect(turn.claims).toEqual([
      { entity: "用户", attribute: "宠物", value: "月饼", factIndex: 1 },
    ]);
  });

  it("claims 超过单轮上限时截断", async () => {
    const claims = Array.from({ length: 12 }, (_, i) => ({
      entity: "用户",
      attribute: `属性${i}`,
      value: `值${i}`,
      fact: 0,
    }));
    const turn = await extract(JSON.stringify({ facts: ["事实A"], claims }));
    expect(turn.claims).toHaveLength(8);
    expect(turn.claims[7].attribute).toBe("属性7");
  });

  it("完全无法解析时返回空结果，不抛异常", async () => {
    const turn = await extract("这不是 JSON");
    expect(turn.facts).toEqual([]);
    expect(turn.claims).toEqual([]);
  });
});
