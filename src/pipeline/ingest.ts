import type {
  PluginConversationMessage,
  PluginConversationsService,
  PluginLlmService,
} from "@playa0v0/cyrene-plugin-sdk";
import type { PluginConfig } from "../config";
import { remember } from "../core/remember";
import type { Embedder, IngestTask, MemoryRecord } from "../core/types";
import type { MemoryStore } from "../core/store";
import type { Logger } from "../logger";
import { extractFacts } from "./extractor";

/** createTurnIngestor 的依赖。 */
export interface TurnIngestorDeps {
  conversations: PluginConversationsService;
  llm: PluginLlmService;
  embedder: Embedder;
  store: MemoryStore;
  config: PluginConfig;
  log: Logger;
}

/** turn 摄入处理器：作为 TaskQueue<IngestTask> 的 processor 使用，signal 由队列传入。 */
export type TurnIngestHandler = (task: IngestTask, signal?: AbortSignal) => Promise<void>;

/** 每页读取的消息数；配合冻结边界分页，翻页不会混入后续轮次。 */
const PAGE_SIZE = 50;
/** 防御性总量上限：正常一轮远小于此，异常宿主时避免无限翻页。 */
const MAX_MESSAGES = 200;

/** 按冻结边界读取本轮消息；翻页错误向上抛出，由 handle 统一吞掉。 */
async function readFrozenRange(
  conversations: PluginConversationsService,
  task: IngestTask,
  signal?: AbortSignal,
): Promise<PluginConversationMessage[]> {
  const messages: PluginConversationMessage[] = [];
  let cursor: string | undefined;
  do {
    if (signal?.aborted) break;
    const page = await conversations.getMessages({
      conversationId: task.conversationId,
      fromMessageId: task.inputMessageId,
      throughMessageId: task.finalMessageId,
      limit: PAGE_SIZE,
      cursor,
    });
    messages.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && messages.length < MAX_MESSAGES);
  return messages;
}

/**
 * 创建 turn 摄入器：读冻结范围 -> 抽取事实 -> 可选向量化 -> 逐条 remember 收口写入。
 * 一轮允许多条事实，每条一个记忆记录（利于检索精度和实体时间轴）；
 * 同轮重复摄入由 remember 的「轮次+内容」去重拦截。
 * 任何一步失败只 warn，绝不抛出；signal 中止时尽快安静退出。
 */
export function createTurnIngestor(deps: TurnIngestorDeps): TurnIngestHandler {
  const { conversations, llm, embedder, store, config, log } = deps;

  return async function handle(task, signal) {
    if (signal?.aborted) return;
    try {
      const messages = await readFrozenRange(conversations, task, signal);
      if (messages.length === 0 || signal?.aborted) return;

      const facts = await extractFacts(llm, messages, {
        maxFacts: config.maxMemoriesPerTurn,
        log,
        signal,
      });
      if (facts.length === 0 || signal?.aborted) return;

      // 向量可能为 null（未配置 / 请求失败），此时只写关键词可检索的内容。
      const vectors = await embedder.embed(facts).catch((err) => {
        log.warn("向量获取失败，本轮降级为纯关键词:", err);
        return null;
      });
      if (signal?.aborted) return;

      for (let i = 0; i < facts.length; i += 1) {
        if (signal?.aborted) return;
        const record: MemoryRecord = {
          id: "",
          createdAt: Date.now(),
          content: facts[i],
          turn: {
            conversationId: task.conversationId,
            turnEventId: task.turnEventId,
            runId: task.runId,
          },
          conversationId: task.conversationId,
          embedding: vectors?.[i],
          embeddingModel: vectors ? embedder.id : undefined,
        };
        // remember 内部已完成内容哈希去重和失败降级，返回 false 不需要额外告警。
        await remember(store, record, log);
      }
    } catch (err) {
      log.warn("turn 摄入失败（已忽略）:", err);
    }
  };
}
