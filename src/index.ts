import type { CyrenePlugin, PluginContext, PluginTurnFinishedEvent } from "@playa0v0/cyrene-plugin-sdk";
import { loadConfig } from "./config";
import { MemoryStore } from "./core/store";
import { TaskQueue } from "./pipeline/queue";
import type { IngestTask } from "./core/types";
import { createTurnIngestor } from "./pipeline/ingest";
import { createEmbedderByProvider } from "./pipeline/embedder";
import { createHotContextProvider } from "./provider/hot-context";
import { createRecallTool } from "./tools/recall";
import { createSearchTool } from "./tools/search";
import { createTimelineTool } from "./tools/timeline";
import { createForgetTool } from "./tools/forget";
import { createWindowManager, type WindowManager } from "./ui/window";
import { registerUiIpc } from "./ui/ipc";
import { createLogger } from "./logger";

/**
 * 模块级状态：宿主保证插件单实例，register 与 open/unregister
 * 之间用模块变量传递上下文和窗口管理器。
 */
let activeCtx: PluginContext | null = null;
let winManager: WindowManager | null = null;

const plugin: CyrenePlugin = {
  async register(ctx) {
    const log = createLogger(ctx);
    log.log("启用");

    const config = loadConfig(ctx.storage);
    const store = new MemoryStore(ctx.storage, log);
    // 后台预热 JSONL 重放，不阻塞 register；失败只 warn
    void store.load().catch((err) => log.warn("记忆日志预热失败:", err));

    // embedding 工厂：未配置时返回恒 null 的降级 embedder（纯关键词检索）
    const embedder = createEmbedderByProvider(config, { secrets: ctx.deps.secrets, log });

    // 四个 AI 工具
    ctx.registerTool(createRecallTool({ store, log }));
    ctx.registerTool(createSearchTool({ store, config, embedder, log }));
    ctx.registerTool(createTimelineTool({ store, log }));
    ctx.registerTool(createForgetTool({ store, log }));

    // 热记忆注入 provider
    ctx.registerPromptProvider(
      createHotContextProvider({ store, config, embedder, log }),
    );

    // 轮次摄入管线：turn:finished 是旁路通知（宿主不等），必须自己排队异步做
    const { conversations, llm } = ctx.deps;
    if (!conversations || !llm) {
      // manifest 已声明依赖，正常不会走到这里；防御宿主异常注入
      log.warn("宿主服务缺失（conversations/llm），摄入管线停用");
    }
    const ingest = createTurnIngestor({
      conversations: conversations!,
      llm: llm!,
      embedder,
      store,
      config,
      log,
    });
    const queue = new TaskQueue<IngestTask>({ signal: ctx.signal, log });
    ctx.events.on("host:turn:finished", (event: PluginTurnFinishedEvent) => {
      // 只收桌面成功轮次；finalMessageId 只有宿主确认落盘后才存在，非成功终态不得自己补
      if (event.source !== "desktop" || event.status !== "success") return;
      if (!event.finalMessageId || !event.inputMessageId) return;
      if (!conversations) return;
      // 只投队列、绝不 await：enqueue 的 promise 要等任务跑完才 resolve，
      // await 它会让监听器超过宿主 5 秒上限（实测会刷「异步执行超时」日志）。
      // enqueue 从不 reject，void 丢弃 promise 即可。
      void queue.enqueue(
        {
          conversationId: event.conversationId,
          turnEventId: event.eventId,
          inputMessageId: event.inputMessageId,
          finalMessageId: event.finalMessageId,
          runId: event.runId,
        },
        async (task, signal) => {
          await ingest(task, signal);
        },
      );
    });

    // 图谱窗口 IPC + 窗口管理器；open 由宿主插件卡片的「打开」按钮触发
    registerUiIpc(ctx, { store, log });
    winManager = createWindowManager({ log });
    ctx.onDispose(() => {
      winManager?.close();
      winManager = null;
    });

    activeCtx = ctx;
  },

  async unregister() {
    // ctx.signal 在 unregister 前已被框架取消，队列排队任务已被丢弃；
    // 这里只收窗口，保证幂等且有界（远小于 5 秒上限）。
    winManager?.close();
    winManager = null;
    activeCtx = null;
  },

  async open() {
    if (activeCtx && winManager) {
      await winManager.open(activeCtx);
    }
  },
};

export = plugin;
