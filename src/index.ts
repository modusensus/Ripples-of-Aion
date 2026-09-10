import type { CyrenePlugin, PluginContext, PluginTurnFinishedEvent } from "@playa0v0/cyrene-plugin-sdk";
import {
  DEFAULT_CONSOLIDATION_ENABLED,
  DEFAULT_CONSOLIDATION_IDLE_MINUTES,
  DEFAULT_CONSOLIDATION_MAX_RECORDS,
  loadConfig,
} from "./config";
import { MemoryStore } from "./core/store";
import { loadInsights } from "./core/insights";
import { TaskQueue } from "./pipeline/queue";
import type { IngestTask } from "./core/types";
import { createTurnIngestor } from "./pipeline/ingest";
import { createEmbedderByProvider } from "./pipeline/embedder";
import { createConsolidator } from "./pipeline/consolidate";
import { createHotContextProvider } from "./provider/hot-context";
import { createLlmReranker } from "./retrieval/rerank";
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

/** 启动补跑延迟：给宿主启动期（加载会话/模型/窗口）让路，2 分钟后再补跑整合。 */
const REGISTER_CATCHUP_DELAY_MS = 2 * 60_000;

/** 后台队列任务：轮次摄入任务，或 autoDream 整合的哨兵标记（字符串）。 */
type QueueTask = IngestTask | "autoDream";

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

    // 面板「立即做梦」的入口：整合链路缺失（宿主服务异常）时保持 undefined，
    // dream-now IPC 会得到 unavailable 降级而不是报错弹窗。
    let triggerDream: (() => boolean) | undefined;
    let isDreaming: (() => boolean) | undefined;

    // 宿主服务提前解构：LLM 精排与摄入管线共用。缺失时各自降级——
    // search 工具不接精排（初排原序），摄入与整合整条停用。
    const { conversations, llm } = ctx.deps;
    // 精排只接 search 工具的检索出口；hot-context 注入保持纯关键词（2 秒红线）。
    const reranker = llm ? createLlmReranker(llm, { log }) : undefined;

    // 四个 AI 工具
    ctx.registerTool(createRecallTool({ store, log }));
    ctx.registerTool(createSearchTool({ store, config, embedder, reranker, log }));
    ctx.registerTool(createTimelineTool({ store, log }));
    ctx.registerTool(createForgetTool({ store, log }));

    // 热记忆注入 provider（v0.3.0 轻量化：不传 embedder，纯关键词检索）
    ctx.registerPromptProvider(
      createHotContextProvider({ store, config, log }),
    );

    // 轮次摄入管线 + autoDream 空闲整合：turn:finished 是旁路通知（宿主不等），
    // 必须自己排队异步做；整合与摄入复用同一条串行队列，天然互斥不抢并发。
    if (!conversations || !llm) {
      // manifest 已声明依赖，正常不会走到这里；防御宿主异常注入。
      // 摄入与整合都依赖 llm，缺失时两者一起停用。
      log.warn("宿主服务缺失（conversations/llm），摄入管线与空闲整合停用");
    } else {
      const ingest = createTurnIngestor({
        conversations,
        llm,
        embedder,
        store,
        config,
        log,
      });
      const queue = new TaskQueue<QueueTask>({ signal: ctx.signal, log });
      // 整合配置字段可选（旧存档无此键），与 heat* 同口径回退默认常量
      const consolidationEnabled =
        config.consolidationEnabled ?? DEFAULT_CONSOLIDATION_ENABLED;
      const consolidationIdleMinutes =
        config.consolidationIdleMinutes ?? DEFAULT_CONSOLIDATION_IDLE_MINUTES;
      // 整合器：run 内部吞一切异常返回 null（洞察是可再生派生数据），绝不波及主流程
      const consolidator = createConsolidator({
        store,
        llm,
        embedder,
        storage: ctx.storage,
        maxRecords: config.consolidationMaxRecords ?? DEFAULT_CONSOLIDATION_MAX_RECORDS,
        log,
      });

      // single-flight 空闲整合：防抖句柄与在途标记只在这条链上动
      let consolidationTimer: ReturnType<typeof setTimeout> | null = null;
      let catchupTimer: ReturnType<typeof setTimeout> | null = null;
      let consolidationInFlight = false;

      // 空闲触发的唯一入队口：总开关 + 无在途 + 未中止三重守卫；
      // 摄入完成防抖、启动补跑与面板 dream-now 都走这里，single-flight 语义完全一致。
      const runConsolidation = (): boolean => {
        if (!consolidationEnabled || consolidationInFlight || ctx.signal.aborted) return false;
        consolidationInFlight = true;
        void queue.enqueue("autoDream", async (_task, signal) => {
          try {
            await consolidator.run(signal);
          } finally {
            consolidationInFlight = false;
          }
        });
        return true;
      };
      triggerDream = runConsolidation;
      isDreaming = () => consolidationInFlight;

      const scheduleConsolidation = (): void => {
        if (consolidationTimer !== null) clearTimeout(consolidationTimer);
        consolidationTimer = setTimeout(runConsolidation, consolidationIdleMinutes * 60_000);
      };

      ctx.events.on("host:turn:finished", (event: PluginTurnFinishedEvent) => {
        // 只收桌面成功轮次；finalMessageId 只有宿主确认落盘后才存在，非成功终态不得自己补
        if (event.source !== "desktop" || event.status !== "success") return;
        if (!event.finalMessageId || !event.inputMessageId) return;
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
            try {
              // 该处理器只会收到摄入任务；字符串哨兵只在 autoDream 入队口出现
              if (typeof task !== "string") await ingest(task, signal);
            } finally {
              // 摄入真正跑完（含失败）才重置防抖：静默满 consolidationIdleMinutes
              // 分钟才允许整合。重置发生在队列任务回调内部，不占宿主 5 秒窗口。
              scheduleConsolidation();
            }
          },
        );
      });

      // 启动补跑：从未整合（lastRunAt === 0）或距上次已超过空闲间隔，就沿
      // 同一条 single-flight 路径补跑一次；延迟 2 分钟给宿主启动期让路。
      try {
        const insights = loadInsights(ctx.storage);
        const idleMs = consolidationIdleMinutes * 60_000;
        if (insights.lastRunAt === 0 || Date.now() - insights.lastRunAt > idleMs) {
          catchupTimer = setTimeout(runConsolidation, REGISTER_CATCHUP_DELAY_MS);
        }
      } catch (err) {
        // loadInsights 自身 fail-safe，这里兜底只为 register 绝不抛
        log.warn("启动补跑判定失败（跳过补跑）:", err);
      }

      // 生命周期收口：signal 中止时清掉全部定时器与在途标记（与窗口清理同风格）
      ctx.signal.addEventListener(
        "abort",
        () => {
          if (consolidationTimer !== null) {
            clearTimeout(consolidationTimer);
            consolidationTimer = null;
          }
          if (catchupTimer !== null) {
            clearTimeout(catchupTimer);
            catchupTimer = null;
          }
          consolidationInFlight = false;
        },
        { once: true },
      );
    }

    // 图谱窗口 IPC + 窗口管理器；open 由宿主插件卡片的「打开」按钮触发。
    // config/embedder/reranker 供检索台走真·混合检索 + 可选精排（均可选，缺席自动降级）。
    registerUiIpc(ctx, {
      store,
      storage: ctx.storage,
      config,
      embedder,
      reranker,
      log,
      triggerDream,
      isDreaming,
    });
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
