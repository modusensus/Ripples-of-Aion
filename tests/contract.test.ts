import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { PLUGIN_ID } from "../src/plugin-id";
import { assertToolContract, createMockContext } from "./helpers";

/** 产物路径：vitest 工作目录 = 项目根。 */
const BUILT_ENTRY = path.resolve(process.cwd(), "dist/plugin/suiyue-lianyi/index.cjs");

/** 直接加载构建产物做契约测试——测的就是要发布的东西。 */
function loadPlugin(): { register: (ctx: unknown) => Promise<void>; unregister: () => Promise<void> } {
  expect(existsSync(BUILT_ENTRY), "产物不存在，先运行 npm run build").toBe(true);
  const require = createRequire(path.join(process.cwd(), "package.json"));
  return require(BUILT_ENTRY);
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

  it("register 注册 3 个工具 + 1 个 provider + 2 个 IPC + 轮次订阅", async () => {
    const ctx = createMockContext({ pluginId: PLUGIN_ID, deps: makeDeps() });
    await plugin.register(ctx);

    // 工具：前缀 + 契约断言
    expect(ctx.tools).toHaveLength(3);
    for (const tool of ctx.tools) {
      assertToolContract(tool, PLUGIN_ID);
    }
    const toolIds = ctx.tools.map((t) => t.id);
    expect(toolIds).toContain(`${PLUGIN_ID}_recall`);
    expect(toolIds).toContain(`${PLUGIN_ID}_search`);
    expect(toolIds).toContain(`${PLUGIN_ID}_forget`);

    // provider / IPC / 事件订阅
    expect(ctx.promptProviders.map((p) => (p as { id: string }).id)).toContain("hot-context");
    expect(ctx.ipcChannels.has("get-state")).toBe(true);
    expect(ctx.ipcChannels.has("forget")).toBe(true);
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

  it("unregister 幂等且可重复调用", async () => {
    const ctx = createMockContext({ pluginId: PLUGIN_ID });
    await plugin.register(ctx);
    await plugin.unregister();
    await plugin.unregister();
    await ctx.dispose();
  });
});
