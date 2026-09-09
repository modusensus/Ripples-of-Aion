import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { PLUGIN_ID } from "../src/plugin-id";
import { assertToolContract, createMockContext } from "./helpers";

/** 产物路径：vitest 工作目录 = 项目根。 */
const BUILT_ENTRY = path.resolve(process.cwd(), "dist/plugin/ripples-of-aion/index.cjs");

/** 直接加载构建产物做契约测试——测的就是要发布的东西。 */
function loadPlugin(): { register: (ctx: unknown) => Promise<void>; unregister: () => Promise<void> } {
  expect(existsSync(BUILT_ENTRY), "产物不存在，先运行 npm run build").toBe(true);
  const require = createRequire(path.join(process.cwd(), "package.json"));
  // 加载目标必须是字符串字面量：路径来自本仓库固定产物而非外部输入，
  // 字面量让静态安全扫描可判定这一点；变更产物位置时与 BUILT_ENTRY 同步。
  return require("./dist/plugin/ripples-of-aion/index.cjs");
}

/** 注册插件所需的最小宿主服务假实现。 */
function makeDeps() {
  return {
    conversations: {
      list: async () => ({ items: [] }),
      getMessages: async () => ({ items: [], range: {} }),
    },
    llm: { generateText: async () => "[]" },
  };
}

describe("插件契约（构建产物）", () => {
  let plugin: ReturnType<typeof loadPlugin>;

  beforeAll(() => {
    plugin = loadPlugin();
  });

  it("register 注册 4 个工具 + 1 个 provider + 6 个 IPC + 轮次订阅", async () => {
    const ctx = createMockContext({ pluginId: PLUGIN_ID, deps: makeDeps() });
    await plugin.register(ctx);

    // 工具：前缀 + 契约断言
    expect(ctx.tools).toHaveLength(4);
    for (const tool of ctx.tools) {
      assertToolContract(tool, PLUGIN_ID);
    }
    const toolIds = ctx.tools.map((t) => t.id);
    expect(toolIds).toContain(`${PLUGIN_ID}_recall`);
    expect(toolIds).toContain(`${PLUGIN_ID}_search`);
    expect(toolIds).toContain(`${PLUGIN_ID}_timeline`);
    expect(toolIds).toContain(`${PLUGIN_ID}_forget`);

    // provider / IPC / 事件订阅
    expect(ctx.promptProviders.map((p) => (p as { id: string }).id)).toContain("hot-context");
    expect(ctx.ipcChannels.has("get-state")).toBe(true);
    expect(ctx.ipcChannels.has("forget")).toBe(true);
    expect(ctx.ipcChannels.has("dream-now")).toBe(true);
    expect(ctx.ipcChannels.has("get-config")).toBe(true);
    expect(ctx.ipcChannels.has("save-config")).toBe(true);
    expect(ctx.ipcChannels.has("browse-memories")).toBe(true);
    expect(ctx.subscriptions.some((s) => s.event === "host:turn:finished")).toBe(true);

    // 模拟宿主停止：清理回调按序执行，不抛异常
    await ctx.dispose();
  });

  it("recall 工具在空记忆时返回可读提示", async () => {
    const ctx = createMockContext({ pluginId: PLUGIN_ID, deps: makeDeps() });
    await plugin.register(ctx);
    const recall = ctx.tools.find((t) => t.id === `${PLUGIN_ID}_recall`);
    expect(recall).toBeTruthy();

    // storage rootDir 是 mock 假路径，store 读失败会降级——工具仍应返回字符串
    const output = await recall!.execute({});
    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
    await ctx.dispose();
  });

  it("get-state 返回的 state 含 insights 字段且默认空形态", async () => {
    const ctx = createMockContext({ pluginId: PLUGIN_ID, deps: makeDeps() });
    await plugin.register(ctx);
    const getState = ctx.ipcChannels.get("get-state");
    expect(getState).toBeTruthy();

    // mock storage 没有 insights key：按「从未整合」返回空形态
    const state = (await getState!()) as {
      insights: { lastRunAt: number; dreaming: boolean; clusters: unknown[]; conflicts: unknown[] };
    };
    expect(state.insights.lastRunAt).toBe(0);
    expect(state.insights.dreaming).toBe(false);
    expect(state.insights.clusters).toEqual([]);
    expect(state.insights.conflicts).toEqual([]);
    await ctx.dispose();
  });

  it("dream-now 经 single-flight 入队返回 ok，配置读写走白名单合并", async () => {
    const ctx = createMockContext({ pluginId: PLUGIN_ID, deps: makeDeps() });
    await plugin.register(ctx);

    // dream-now：触发器存在（conversations/llm 齐备）→ 入队成功；空库整合静默结束
    const dreamNow = ctx.ipcChannels.get("dream-now")!;
    expect(dreamNow()).toMatchObject({ ok: true });
    // 等队列任务跑完再 dispose，避免异步任务跨 dispose 产生竞态
    await new Promise((resolve) => setTimeout(resolve, 50));

    // save-config：白名单外的键被丢弃、类型不符的键被跳过、合法键合并生效
    const saveConfig = ctx.ipcChannels.get("save-config")!;
    const saved = saveConfig({
      hotContextBudgetChars: 1234,
      heatWeight: "不是数字",
      bogusKey: "越界",
    }) as { ok: boolean; config?: Record<string, unknown> };
    expect(saved.ok).toBe(true);
    expect(saved.config!.hotContextBudgetChars).toBe(1234);
    // heatWeight 类型不符跳过，保持默认值
    expect(saved.config!.heatWeight).toBe(0.5);
    expect(saved.config).not.toHaveProperty("bogusKey");

    // get-config 读回持久化的新值（save 后再 get 走同一 storage）
    const getConfig = ctx.ipcChannels.get("get-config")!;
    const config = getConfig() as Record<string, unknown>;
    expect(config.hotContextBudgetChars).toBe(1234);
    await ctx.dispose();
  });

  it("unregister 幂等且可重复调用", async () => {
    const ctx = createMockContext({ pluginId: PLUGIN_ID });
    await plugin.register(ctx);
    await plugin.unregister();
    await plugin.unregister();
    await ctx.dispose();
  });
});
