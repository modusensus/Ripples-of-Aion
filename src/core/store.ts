import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import type { Logger } from "../logger";
import { appendJsonl, readJsonl } from "../util/jsonl";
import { canonicalAttr } from "./attributes";
import type { EntityClaim, MemoryId, MemoryRecord } from "./types";

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

/* ── 主观热度（v0.3.0）──────────────────────────────────────────────
 * 常被想起的记忆浮在前面，长期不用的自然沉底。
 * 所有默认值集中在此（单一事实源）：bump 落盘发生在 store（拿不到
 * config），检索融合发生在 hybrid（拿得到 config），两边必须同一套数，
 * config.ts 的 DEFAULT_CONFIG 也从这里取值。
 * ─────────────────────────────────────────────────────────────── */

/** 中性热度：从未被触碰的记忆视为 0.5（getter 语义，不落盘缺省值）。 */
export const HEAT_NEUTRAL = 0.5;
/** 每天惰性衰减系数：exp(-0.05 * 14) ≈ 0.5，约两周衰到一半。 */
export const HEAT_DECAY_PER_DAY = 0.05;
/** 单次访问/提及 bump 向 1 靠拢的比例。 */
export const HEAT_BUMP = 0.15;
/** 检索融合的热度增益权重：score *= 1 + HEAT_WEIGHT * effectiveHeat。 */
export const HEAT_WEIGHT = 0.5;
/** 抖动抑制：距上次触碰不足 30 分钟的重复 bump 不再落盘，防日志暴涨。 */
export const MIN_BUMP_INTERVAL_MS = 30 * 60 * 1000;

/** bumpHeat 的可选参数：有 config 的调用方透传配置值，缺省用上面的内置默认。 */
export interface BumpHeatOptions {
  /** 计算当前有效热度用的每天衰减系数。 */
  decayPerDay?: number;
  /** 单次 bump 向 1 靠拢的比例。 */
  amount?: number;
  /** 显式时钟（毫秒）；测试固定时间用，缺省 Date.now()。 */
  now?: number;
}

function clampHeat(value: number): number {
  // NaN 视为中性：脏数据不抛、不产 NaN，退化成「无热度信号」
  if (Number.isNaN(value)) return HEAT_NEUTRAL;
  return Math.min(1, Math.max(0, value));
}

/**
 * 有效热度：持久化 heat 经惰性衰减后的现值 ∈ [0,1]。
 * 查询时现算（零定时器、零后台任务，符合 fail-safe 原则）：
 * - heat 缺省按中性 0.5（getter 语义，不写缺省值进 JSONL）；
 * - 衰减锚点取 lastTouchedAt，从未触碰的记忆从 createdAt 起算——
 *   老而未被想起的记忆自然沉底；
 * - 时钟回拨/未来时间戳一律不放大热度（衰减天数不为负）。
 */
export function effectiveHeatOf(record: MemoryRecord, decayPerDay: number, now: number): number {
  const stored = typeof record.heat === "number" ? clampHeat(record.heat) : HEAT_NEUTRAL;
  const anchor = typeof record.lastTouchedAt === "number"
    ? record.lastTouchedAt
    : record.createdAt;
  if (typeof anchor !== "number" || now <= anchor) return stored;
  const days = (now - anchor) / 86_400_000;
  return clampHeat(stored * Math.exp(-decayPerDay * days));
}

/** all() 的过滤选项。 */
export interface AllOptions {
  includeDeleted?: boolean;
  conversationId?: string;
}

/** 实体时间轴条目：一条 claim 加上承载它的记录。 */
export interface ClaimEntry {
  record: MemoryRecord;
  claim: EntityClaim;
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
  /**
   * 串行写链：所有 JSONL 追加都挂在这条 promise 链上按序落盘。
   * bumpHeat 的节流写是 fire-and-forget，若与 await 中的 claim 闭合写
   * 并发乱序，重放时旧快照会覆盖闭合结果——统一入链杜绝乱序。
   */
  private writeChain: Promise<void> = Promise.resolve();
  /** load 只重放一次；并发调用复用同一个 promise。 */
  private loadPromise: Promise<void> | null = null;

  constructor(storage: PluginStorage, log: Logger) {
    // join 对 rootDir 末尾是否带分隔符都能正确处理
    this.filePath = join(storage.rootDir(), "memories.jsonl");
    this.log = log;
  }

  /**
   * 把一条 op 追加到串行写链末尾，返回本次写入的 promise。
   * 链条本身吞掉失败继续走（后续写入不受前一次失败影响），
   * 错误交还给各调用方按自己的降级策略处理。
   */
  private enqueueAppend(op: JournalOp): Promise<void> {
    const write = this.writeChain.then(() => appendJsonl(this.filePath, op));
    this.writeChain = write.catch(() => {});
    return write;
  }

  /** 等待全部挂起写入完成。生产路径无需调用；测试据此确认 fire-and-forget 的节流写已落盘。 */
  awaitPendingWrites(): Promise<void> {
    return this.writeChain;
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
   * 带 entityClaims 时先把 attribute 归一化成 canonical 形式（LLM 选词
   * 不稳定，比较与落库一律在 canonical 口径上，见 core/attributes.ts），
   * 再去掉与既有活跃 claim 完全相同的条目（重述同一属性不制造时间轴
   * 噪音，别名变体也算同属性），落盘后再闭合旧的活跃 claim。
   * 返回是否成功落盘；失败已 warn，不抛异常。
   */
  async append(record: MemoryRecord): Promise<boolean> {
    await this.load();
    if (!record.id) record.id = randomUUID();
    if (typeof record.createdAt !== "number") record.createdAt = Date.now();
    if (!record.conversationId && record.turn?.conversationId) {
      record.conversationId = record.turn.conversationId;
    }
    if (record.entityClaims?.length) {
      for (const claim of record.entityClaims) {
        // 属性先归一化再比较、再落库：新 claim 存进 JSONL 的就是 canonical 形式
        claim.attribute = canonicalAttr(claim.attribute);
        if (typeof claim.validFrom !== "number") claim.validFrom = record.createdAt;
        if (claim.validUntil === undefined) claim.validUntil = null;
      }
      const fresh = record.entityClaims.filter(
        (claim) => !this.hasActiveClaim(claim.entity, claim.attribute, claim.value),
      );
      if (fresh.length === 0) {
        delete record.entityClaims;
      } else {
        record.entityClaims = fresh;
      }
    }
    try {
      await this.enqueueAppend({ op: "put", record } satisfies JournalOp);
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
    // 闭合属于已有记录的更新而非新记忆写入，且绝不能影响已落盘的新记录
    await this.closeConflictingClaims(record);
    // 被提及加权放在闭合之后：串行写链保证 bump 的 put 排在闭合 put 之后，
    // 重放不会用 bump 快照覆盖掉闭合结果
    this.bumpMentionedEntities(record);
    return true;
  }

  /**
   * 是否存在同 (entity, attribute, value) 且仍活跃的 claim（软删记录不算）。
   * attribute 两侧都按 canonical 口径比较：入参已在 append 侧归一化，存量
   * claim 可能还是 v0.2.0 的旧字面量，比较时现归一——老数据不迁移也能判重。
   */
  private hasActiveClaim(entity: string, attribute: string, value: string): boolean {
    const want = canonicalAttr(attribute);
    for (const existing of this.byId.values()) {
      if (existing.deleted || !existing.entityClaims?.length) continue;
      for (const claim of existing.entityClaims) {
        if (
          claim.entity === entity
          && canonicalAttr(claim.attribute) === want
          && claim.value === value
          && claim.validUntil == null
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 属性时间轴闭合：新记录的每条 claim 会把同 (entity, attribute) 的
   * 旧活跃 claim 的 validUntil 置为新记录的 createdAt。
   * 冲突比较一律在 canonical 口径上（两侧都归一）：存量 claim 的旧字面量
   * （如「工作所在地」）与新 claim 的 canonical 词条（如「工作地点」）
   * 视为同一属性，v0.2.0 的历史数据不迁移也能被正确闭合。
   * 更新已有记录 = 追加一个 put op（重放时同 id 覆盖）；失败只 warn，
   * 时间轴查询按「最新者为准」兜底，绝不因此抛异常或回滚新记录。
   */
  private async closeConflictingClaims(record: MemoryRecord): Promise<void> {
    const newClaims = record.entityClaims;
    if (!newClaims?.length) return;
    // 预归一化新 claim 的 (entity, attribute) 对：内层循环不必重复计算，
    // 且保证 entity 与 attribute 的匹配始终落在同一条新 claim 上
    const newPairs = newClaims.map((c) => ({
      entity: c.entity,
      attr: canonicalAttr(c.attribute),
    }));
    // 先收集闭合目标，同一旧记录的多条冲突 claim 合并成一次落盘
    const targets = new Map<MemoryId, { record: MemoryRecord; indexes: Set<number> }>();
    for (const existing of this.byId.values()) {
      if (existing.deleted || existing.id === record.id) continue;
      if (!existing.entityClaims?.length) continue;
      for (let i = 0; i < existing.entityClaims.length; i += 1) {
        const claim = existing.entityClaims[i];
        if (claim.validUntil != null) continue;
        const conflicted = newPairs.some(
          (c) => c.entity === claim.entity && c.attr === canonicalAttr(claim.attribute),
        );
        if (!conflicted) continue;
        let target = targets.get(existing.id);
        if (!target) {
          target = { record: existing, indexes: new Set<number>() };
          targets.set(existing.id, target);
        }
        target.indexes.add(i);
      }
    }
    for (const { record: oldRecord, indexes } of targets.values()) {
      const closedClaims = oldRecord.entityClaims!.map((claim, i) =>
        indexes.has(i) && claim.validUntil == null
          ? { ...claim, validUntil: record.createdAt }
          : claim,
      );
      const updated: MemoryRecord = { ...oldRecord, entityClaims: closedClaims };
      try {
        await this.enqueueAppend({ op: "put", record: updated } satisfies JournalOp);
      } catch (err) {
        this.log.warn("闭合旧属性声明失败:", oldRecord.id, err);
        continue;
      }
      // Map.set 已有键不改变插入顺序，时间序保持稳定
      this.byId.set(oldRecord.id, updated);
    }
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
      await this.enqueueAppend({ op: "del", id } satisfies JournalOp);
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
   * 访问/提及加权：把这批 id 的有效热度向 1 靠拢一档，并刷新触碰时间。
   * bumped = effective + amount * (1 - effective)，落盘快照即 bumped
   * （put op 覆盖同 id，与 claim 闭合同一模式，重放一致）。
   *
   * 落盘节流（抖动抑制）：距 lastTouchedAt 不足 MIN_BUMP_INTERVAL_MS 的
   * 重复 bump 只更新内存索引（本轮排序立刻受益），不追加日志——
   * 否则每次检索命中都写一行，JSONL 会暴涨；重启后损失的只是节流窗口
   * 内的增量，heat 是主观信号，最终一致即可。
   *
   * 写入走 fire-and-forget（挂到串行写链，失败只 warn）：本方法保持同步、
   * 绝不抛异常——热度只是排序信号，任何故障不得波及检索主流程。
   * 注意：不等待 load()（同步约束），调用方须先完成 load——现有调用点
   * （hot-context / recall / search）都在检索之后，天然满足。
   */
  bumpHeat(ids: readonly MemoryId[], options?: BumpHeatOptions): void {
    try {
      const now = options?.now ?? Date.now();
      const decayPerDay = options?.decayPerDay ?? HEAT_DECAY_PER_DAY;
      const amount = options?.amount ?? HEAT_BUMP;
      for (const id of ids) {
        const record = this.byId.get(id);
        // 未加载 / 未知 / 已软删的 id 静默跳过
        if (!record || record.deleted) continue;
        const effective = effectiveHeatOf(record, decayPerDay, now);
        const bumped = clampHeat(effective + amount * (1 - effective));
        // 内存先生效；节流窗口内不再落盘
        const throttled =
          typeof record.lastTouchedAt === "number"
          && now - record.lastTouchedAt < MIN_BUMP_INTERVAL_MS;
        record.heat = bumped;
        record.lastTouchedAt = now;
        if (throttled) continue;
        const snapshot: MemoryRecord = { ...record };
        void this.enqueueAppend({ op: "put", record: snapshot } satisfies JournalOp).catch(
          (err) => {
            // 落盘失败只降级：内存热度已更新，重启后损失一次 bump 而已
            this.log.warn("热度落盘失败:", id, err);
          },
        );
      }
    } catch (err) {
      this.log.warn("热度更新失败（已忽略）", err);
    }
  }

  /**
   * 被提及加权：新记忆落库后，与新记忆 entities 有交集的既有记录 bump 一次
   * （同 bumpHeat 的抖动抑制）——用户又提到这批记忆关联的人/事，是「被想起」
   * 的信号。实体名按原文精确匹配（与 claim 闭合同口径），归一化由抽取侧负责。
   */
  private bumpMentionedEntities(record: MemoryRecord): void {
    const mentioned = record.entities;
    if (!mentioned?.length) return;
    const wanted = new Set(mentioned);
    const ids: MemoryId[] = [];
    for (const existing of this.byId.values()) {
      if (existing.deleted || existing.id === record.id) continue;
      if (!existing.entities?.length) continue;
      if (existing.entities.some((entity) => wanted.has(entity))) ids.push(existing.id);
    }
    if (ids.length > 0) this.bumpHeat(ids);
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

  /**
   * 实体属性时间轴：按 validFrom 升序返回该实体（可选限定单一属性）的
   * 全部 claim。只含未软删记录；某属性的「当前值」由调用方取时间序
   * 最新一条判断 validUntil 是否为空——这样即使闭合落盘失败过，
   * 查询侧也能容忍「多条同时活跃」的脏状态。
   *
   * 属性过滤按 canonical 口径（两侧都归一）：存量旧字面量与词表变体
   * （「出差行程」/「行程」）并入同一 track；返回的 claim 保留原始
   * attribute 字面量，面板展示不丢真。
   */
  getEntityTimeline(entity: string, attribute?: string): ClaimEntry[] {
    const wantAttr = attribute === undefined ? undefined : canonicalAttr(attribute);
    const entries: ClaimEntry[] = [];
    for (const record of this.byId.values()) {
      if (record.deleted || !record.entityClaims?.length) continue;
      for (const claim of record.entityClaims) {
        if (claim.entity !== entity) continue;
        if (wantAttr !== undefined && canonicalAttr(claim.attribute) !== wantAttr) continue;
        entries.push({ record, claim });
      }
    }
    entries.sort(
      (a, b) =>
        (a.claim.validFrom ?? a.record.createdAt) - (b.claim.validFrom ?? b.record.createdAt),
    );
    return entries;
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
