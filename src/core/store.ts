import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import type { Logger } from "../logger";
import { appendJsonl, readJsonl } from "../util/jsonl";
import type { MemoryId, MemoryRecord } from "./types";

/**
 * 记录级去重键：内容哈希（saveWithDedupe 方案）。
 * 全局按内容去重——同一事实（完全相同措辞）只存一份；
 * turnEventId 保留在记录里做溯源，轮次摄入标记用 hasTurnEvent 查询。
 */
export function dedupKeyOf(record: MemoryRecord): string | undefined {
  if (!record.content) return undefined;
  return createHash("sha256").update(record.content).digest("hex").slice(0, 16);
}

/** 追加日志里的一行操作。 */
type JournalOp =
  | { op: "put"; record: MemoryRecord }
  | { op: "del"; id: MemoryId };

/** getStats 的返回结构。 */
export interface MemoryStats {
  total: number;
  active: number;
  byConversation: Record<string, number>;
}

/** all() 的过滤选项。 */
export interface AllOptions {
  includeDeleted?: boolean;
  conversationId?: string;
}

/**
 * 简单分词：中文按字拆，英文/数字按连续段拆，标点等符号丢弃。
 * 供关键词检索使用，不求语义，只求覆盖面和可预期。
 */
export function tokenizeText(text: string): string[] {
  const tokens: string[] = [];
  // 只保留字母/数字/汉字，统一小写，其余一律当分隔符
  const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");
  for (const chunk of cleaned.split(" ")) {
    if (chunk === "") continue;
    // 带捕获组的 split 会把每个汉字（CJK 统一表意文字及扩展 A 区）单独切出来，英文/数字段保持整块
    for (const piece of chunk.split(/([㐀-䶿一-鿿])/)) {
      if (piece === "") continue;
      tokens.push(piece);
    }
  }
  return tokens;
}

/**
 * 记忆存储：memories.jsonl 追加日志 + 内存索引。
 * 写入只追加不重写；put/del 操作重放即可完整重建状态，
 * 崩溃最多丢最后一行，坏行由 readJsonl 跳过，天然抗损坏。
 */
export class MemoryStore {
  /** 追加日志文件路径（存储根目录下固定文件名）。 */
  private readonly filePath: string;
  private readonly log: Logger;
  /** 内存索引：id -> record，保持插入（重放）顺序即时间顺序。 */
  private readonly byId = new Map<MemoryId, MemoryRecord>();
  /** 去重索引：dedupKeyOf(record) -> record。删除时移除。 */
  private readonly byDedupKey = new Map<string, MemoryRecord>();
  /** 已摄入过的轮次标记：append 后永久保留，删除记忆也不清除，防止同轮重复摄入复活。 */
  private readonly turnEventIds = new Set<string>();
  /** load 只重放一次；并发调用复用同一个 promise。 */
  private loadPromise: Promise<void> | null = null;

  constructor(storage: PluginStorage, log: Logger) {
    // join 对 rootDir 末尾是否带分隔符都能正确处理
    this.filePath = join(storage.rootDir(), "memories.jsonl");
    this.log = log;
  }

  /** 从 JSONL 重放全部操作，构建内存索引。幂等，可安全多次调用。 */
  load(): Promise<void> {
    this.loadPromise ??= this.replay();
    return this.loadPromise;
  }

  private async replay(): Promise<void> {
    let ops: JournalOp[];
    try {
      ops = await readJsonl<JournalOp>(this.filePath, this.log);
    } catch (err) {
      // 降级：日志读不出来就当空库启动，不阻塞插件运行
      this.log.warn("记忆日志读取失败，按空库启动", err);
      return;
    }
    for (const entry of ops) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.op === "put") {
        const record = entry.record;
        if (!record || typeof record.id !== "string" || record.id === "") {
          this.log.warn("跳过非法的 put 记录");
          continue;
        }
        this.byId.set(record.id, record);
        const dedupKey = dedupKeyOf(record);
        if (dedupKey) this.byDedupKey.set(dedupKey, record);
        const turnEventId = record.turn?.turnEventId;
        if (turnEventId) this.turnEventIds.add(turnEventId);
      } else if (entry.op === "del") {
        if (typeof entry.id !== "string") continue;
        const record = this.byId.get(entry.id);
        if (!record) continue;
        record.deleted = true;
        const dedupKey = dedupKeyOf(record);
        if (dedupKey && this.byDedupKey.get(dedupKey) === record) {
          this.byDedupKey.delete(dedupKey);
        }
      }
    }
  }

  /**
   * 追加一条记忆（put op）。id / createdAt 缺失时自动补齐；
   * conversationId 缺失时从 turn 反规范化兜底。
   * 返回是否成功落盘；失败已 warn，不抛异常。
   */
  async append(record: MemoryRecord): Promise<boolean> {
    await this.load();
    if (!record.id) record.id = randomUUID();
    if (typeof record.createdAt !== "number") record.createdAt = Date.now();
    if (!record.conversationId && record.turn?.conversationId) {
      record.conversationId = record.turn.conversationId;
    }
    try {
      await appendJsonl(this.filePath, { op: "put", record } satisfies JournalOp);
    } catch (err) {
      // 磁盘写入失败时内存索引不同步更新，保持两边一致
      this.log.warn("记忆写入失败", record.id, err);
      return false;
    }
    this.byId.set(record.id, record);
    const dedupKey = dedupKeyOf(record);
    if (dedupKey) this.byDedupKey.set(dedupKey, record);
    const turnEventId = record.turn?.turnEventId;
    if (turnEventId) this.turnEventIds.add(turnEventId);
    return true;
  }

  /** 追加删除标记（del op），并把内存中的记录标记为软删。 */
  async delete(id: string): Promise<void> {
    await this.load();
    const record = this.byId.get(id);
    if (!record) {
      this.log.warn("删除了未知的记忆", id);
      return;
    }
    try {
      await appendJsonl(this.filePath, { op: "del", id } satisfies JournalOp);
    } catch (err) {
      this.log.warn("记忆删除失败", id, err);
      return;
    }
    record.deleted = true;
    const dedupKey = dedupKeyOf(record);
    if (dedupKey && this.byDedupKey.get(dedupKey) === record) {
      this.byDedupKey.delete(dedupKey);
    }
  }

  /**
   * 全量记录（按时间顺序）。注意：调用前应先 await load()，
   * 否则拿到的是已重放部分的数据。
   */
  all(options?: AllOptions): MemoryRecord[] {
    const includeDeleted = options?.includeDeleted ?? false;
    const conversationId = options?.conversationId;
    const out: MemoryRecord[] = [];
    for (const record of this.byId.values()) {
      if (!includeDeleted && record.deleted) continue;
      if (conversationId !== undefined && record.conversationId !== conversationId) continue;
      out.push(record);
    }
    return out;
  }

  /** 该轮次是否已摄入过（append 后永久标记，删除记忆不清除）。 */
  hasTurnEvent(turnEventId: string): boolean {
    return this.turnEventIds.has(turnEventId);
  }

  /** 该去重键是否已有存活记录（软删会移除键，允许事后重写）。 */
  hasDedupKey(key: string): boolean {
    return this.byDedupKey.has(key);
  }

  /** 简单关键词检索：匹配的查询词个数当分数，多者在前，同分新者在前。 */
  searchKeyword(query: string): MemoryRecord[] {
    const queryTokens = [...new Set(tokenizeText(query))];
    if (queryTokens.length === 0) return [];
    const hits: { record: MemoryRecord; score: number }[] = [];
    for (const record of this.byId.values()) {
      if (record.deleted) continue;
      const contentTokens = new Set(tokenizeText(record.content));
      let score = 0;
      for (const token of queryTokens) {
        if (contentTokens.has(token)) score += 1;
      }
      if (score > 0) hits.push({ record, score });
    }
    hits.sort(
      (a, b) => b.score - a.score || b.record.createdAt - a.record.createdAt,
    );
    return hits.map((hit) => hit.record);
  }

  /** 统计信息：total 含已软删，active 不含；byConversation 只统计活跃记录。 */
  getStats(): MemoryStats {
    let active = 0;
    const byConversation: Record<string, number> = {};
    for (const record of this.byId.values()) {
      if (record.deleted) continue;
      active += 1;
      if (record.conversationId) {
        byConversation[record.conversationId] =
          (byConversation[record.conversationId] ?? 0) + 1;
      }
    }
    return { total: this.byId.size, active, byConversation };
  }
}
