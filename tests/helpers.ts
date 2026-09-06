import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  PluginContext,
  PluginDeps,
  PluginStorage,
  PluginTool,
  PluginEventListener,
} from "@playa0v0/cyrene-plugin-sdk";

/** 临时目录 + 内存 config 的 PluginStorage 假实现。 */
export async function createTempStorage(): Promise<{
  storage: PluginStorage;
  rootDir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "suiyue-test-"));
  const map = new Map<string, unknown>();
  return {
    storage: {
      get: (key) => map.get(key) as never,
      set: (key, value) => {
        map.set(key, value);
      },
      rootDir: () => dir,
    },
    rootDir: dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** 空日志器：测试里静音。 */
export const silentLog = {
  log: () => {},
  warn: () => {},
  error: () => {},
};

/** 插件契约测试用的最小 PluginContext 假实现。 */
export function createMockContext(
  options: { pluginId: string; deps?: PluginDeps } = { pluginId: "suiyue-lianyi" },
): MockContext {
  const id = options.pluginId;
  const deps = options.deps ?? {};
  const controller = new AbortController();
  const tools: PluginTool[] = [];
  const promptProviders: unknown[] = [];
  const ipcChannels = new Map<string, (...args: unknown[]) => unknown>();
  const subscriptions: Array<{ event: string; listener: PluginEventListener<any> }> = [];
  const cleanups: Array<() => void | Promise<void>> = [];
  const storageMap = new Map<string, unknown>();
  let disposed = false;

  const ctx: MockContext = {
    id,
    signal: controller.signal,
    deps,
    tools,
    promptProviders,
    ipcChannels,
    subscriptions,
    registerTool: (tool) => {
      tools.push(tool);
    },
    registerPromptProvider: (provider) => {
      promptProviders.push(provider);
    },
    registerIpc: (channel, handler) => {
      ipcChannels.set(channel, handler);
    },
    registerChannelAdapter: async () => {},
    events: {
      on: (event, listener) => {
        subscriptions.push({ event, listener });
        return () => {};
      },
      emit: async () => {},
    },
    storage: {
      get: (key) => storageMap.get(key) as never,
      set: (key, value) => {
        storageMap.set(key, value);
      },
      rootDir: () => "/mock/plugin-data",
    },
    log: () => {},
    onDispose: (cleanup) => {
      cleanups.push(cleanup);
    },
    unregisterTool: () => {},
    unregisterPromptProvider: () => {},
    unregisterIpc: () => {},
    unregisterChannelAdapter: async () => {},
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      controller.abort();
      for (const cleanup of [...cleanups].reverse()) {
        await cleanup();
      }
    },
  };
  return ctx;
}

/** MockContext 公开测试观察面。 */
export interface MockContext extends PluginContext {
  tools: PluginTool[];
  promptProviders: unknown[];
  ipcChannels: Map<string, (...args: unknown[]) => unknown>;
  subscriptions: Array<{ event: string; listener: PluginEventListener<any> }>;
  dispose: () => Promise<void>;
}

/** 本地契约断言：工具 id 前缀 + 必填字段 + execute 可调用。 */
export function assertToolContract(tool: PluginTool, pluginId: string): void {
  expectPrefix(tool.id, pluginId);
  if (!tool.name) throw new Error(`${tool.id}: 缺少 name`);
  if (!tool.description) throw new Error(`${tool.id}: 缺少 description`);
  if (tool.enabled !== true) throw new Error(`${tool.id}: enabled 必须为 true`);
  if (!tool.inputSchema || tool.inputSchema.type !== "object") {
    throw new Error(`${tool.id}: inputSchema.type 必须为 object`);
  }
  if (typeof tool.execute !== "function") throw new Error(`${tool.id}: 缺少 execute`);
}

function expectPrefix(id: string, pluginId: string): void {
  if (!id.startsWith(`${pluginId}_`)) {
    throw new Error(`工具 id ${id} 未以 ${pluginId}_ 开头`);
  }
}
