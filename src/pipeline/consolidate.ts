import { randomUUID } from "node:crypto";
import type { PluginLlmMessage, PluginLlmService, PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import {
  loadInsights,
  saveInsights,
} from "../core/insights";
import type { Insights, MemoryCluster, MemoryConflict } from "../core/insights";
import { HEAT_DECAY_PER_DAY, effectiveHeatOf } from "../core/store";
import type { MemoryStore } from "../core/store";
import type { Embedder, MemoryRecord } from "../core/types";
import type { Logger } from "../logger";
import { canonicalAttr } from "../core/attributes";
import { cosineSimilarity } from "../retrieval/hybrid";

/**
 * autoDream 空闲整合引擎（v0.4.0）。
 *
 * 借鉴 dsh-mneme 的 autoDream：LLM 决策清单 + 服务端逐条校验（单条非法
 * 跳过、其余照常），evidence 强校验防 LLM 伪造序号。本插件裁定为「标注型
 * 整合」——只产出主题聚类与矛盾标注两类洞察存到插件存储，绝不改写、删除
 * 或归档任何原记忆（merge/archive 留待后续版本）。
 *
 * fail-safe 全面降级：记录不足、无材料、LLM 失败、落盘失败、中止——一律
 * warn 后返回 null，绝不抛异常阻断调用方；洞察是可再生的派生数据，丢了
 * 下次空闲重新整合即可。
 */

/** 参与整合的记录数下限：太少凑不出主题，跑一次 LLM 纯属浪费。 */
const MIN_RECORDS_FOR_RUN = 5;

/** 单次送 LLM 的簇数上限：主题过多说明选取过散，按簇大小取头部。 */
const MAX_CLUSTERS = 8;

/** 单簇最少记忆数：孤条没有「主题」可言。 */
const MIN_CLUSTER_SIZE = 2;

/** 候选矛盾对上限：控制 LLM 输入成本，超出按两记录热度之和截断。 */
const MAX_CANDIDATE_PAIRS = 40;

/** 单次落盘的矛盾标注上限：与候选对同量级，防 LLM 刷屏刷爆存储。 */
const MAX_CONFLICTS = MAX_CANDIDATE_PAIRS;

/** 簇内向量校验阈值：与簇中心余弦低于此值摘出，宁缺勿错分。 */
const MIN_CENTROID_COSINE = 0.5;

/** 矛盾摘要截断上限：LLM 派生字段一律先截断再入库。 */
const NOTE_MAX_CHARS = 80;

/** 主题标签截断上限：与 note 同规格，防异常长输出。 */
const LABEL_MAX_CHARS = 80;

/** 发给 LLM 的单条记忆内容截断：事实陈述都很短，200 字足够判断。 */
const SNIPPET_MAX_CHARS = 200;

/** 整合输出的 maxTokens：8 个标签 + 数十条矛盾摘要的宽松上限。 */
const MAX_OUTPUT_TOKENS = 2048;

/** 未命名簇的兜底标签。 */
const UNNAMED_LABEL = "未命名主题";

export interface ConsolidatorDeps {
  /** 只读消费 all({ includeDeleted: false }) / getStats()。 */
  store: MemoryStore;
  llm: PluginLlmService;
  /** 可选向量辅助；null 时纯实体聚类。 */
  embedder: Embedder | null;
  /** 洞察落盘。 */
  storage: PluginStorage;
  /** 单次参与整合的最大记录数。 */
  maxRecords: number;
  log: Logger;
}

export interface Consolidator {
  /**
   * 执行一次整合；成功返回新洞察并落盘。记录数不足/无实体可用/LLM 失败/
   * 落盘失败等一切异常：log.warn 后返回 null，绝不抛。
   */
  run(signal: AbortSignal): Promise<Insights | null>;
}

/** 并查集：实体共现聚类的连通分量，路径压缩够用（量级 ≤ maxRecords）。 */
function find(parent: number[], i: number): number {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
}

function union(parent: number[], a: number, b: number): void {
  const ra = find(parent, a);
  const rb = find(parent, b);
  if (ra !== rb) parent[rb] = ra;
}

/** 记录的关联实体：顶层 entities 与 entityClaims 的实体名取并集（去重、剔非字符串）。
 *  实测（v0.4.1 库 96 条）抽取器几乎只填 claims 不填顶层 entities——只看顶层
 *  字段会导致共现图为空，autoDream 永远空转。 */
function entitiesOf(record: MemoryRecord): string[] {
  const seen = new Set<string>();
  const collect = (candidates: unknown): void => {
    if (!Array.isArray(candidates)) return;
    for (const entity of candidates) {
      if (typeof entity === "string" && entity !== "") seen.add(entity);
    }
  };
  collect(record.entities);
  collect((record.entityClaims ?? []).map((claim) => claim.entity));
  return [...seen];
}

/** 枢纽判定：实体出现在超过这个比例的候选记录中即视为背景枢纽（如陪伴记忆库
 *  里的「用户」），不参与共现建图——它把所有记录连成一团，聚类失去区分度；
 *  记录本身仍可通过其它实体入簇。 */
const HUB_FRACTION = 0.5;
/** 枢纽的绝对下限：小样本里三五条共享是正常判别信号，不足这个量不判枢纽。 */
const HUB_MIN_RECORDS = 8;

/**
 * 实体共现贪心聚类：共享任一（非枢纽）实体名的记录并入同一连通分量。
 * 无实体的记录不入簇（不强行聚类）；分量不足 2 条直接丢弃。
 * 返回簇内记录下标数组，顺序即传入 records 的顺序（热度序，稳定可复现）。
 */
function entityClustersOf(records: MemoryRecord[]): number[][] {
  // 第一遍：统计实体频次，划出枢纽实体（频次按 entitiesOf 口径，与建图一致）。
  // 相对比例 + 绝对下限双条件：大库里过半即枢纽，小样本（测试/新库）不误伤。
  const frequency = new Map<string, number>();
  for (const record of records) {
    for (const entity of entitiesOf(record)) {
      frequency.set(entity, (frequency.get(entity) ?? 0) + 1);
    }
  }
  const hubMin = Math.max(Math.ceil(records.length * HUB_FRACTION), HUB_MIN_RECORDS);
  const isHub = (entity: string): boolean => (frequency.get(entity) ?? 0) >= hubMin;

  // 第二遍：仅用非枢纽实体建连通分量
  const parent = records.map((_, i) => i);
  const firstByEntity = new Map<string, number>();
  for (let i = 0; i < records.length; i += 1) {
    for (const entity of entitiesOf(records[i])) {
      if (isHub(entity)) continue;
      const first = firstByEntity.get(entity);
      if (first === undefined) firstByEntity.set(entity, i);
      else union(parent, first, i);
    }
  }
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < records.length; i += 1) {
    const root = find(parent, i);
    const members = byRoot.get(root);
    if (members) members.push(i);
    else byRoot.set(root, [i]);
  }
  return [...byRoot.values()].filter((members) => members.length >= MIN_CLUSTER_SIZE);
}

/** 均值向量（簇中心）；逐分量累加并容忍个别向量维度异常（余弦侧兜底为 0）。 */
function centroidOf(vectors: number[][]): number[] {
  const dims = vectors[0]?.length ?? 0;
  const sum = new Array<number>(dims).fill(0);
  let count = 0;
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== dims) continue;
    count += 1;
    for (let i = 0; i < dims; i += 1) sum[i] += vector[i];
  }
  if (count === 0) return sum;
  return sum.map((value) => value / count);
}

/**
 * 簇内向量校验：与簇中心余弦低于阈值的成员摘出（宁缺勿错分），摘完不足
 * 2 条的簇整个丢弃。embedder 缺席、调用失败、响应异常时跳过校验——
 * 向量只是辅助证据，任何故障都不应让整合整体失败。
 */
async function pruneClustersByCentroid(
  clusters: number[][],
  records: MemoryRecord[],
  embedder: Embedder,
  log: Logger,
): Promise<number[][]> {
  // 一次请求带全部簇成员，失败就是整体跳过校验，不做逐簇重试
  const texts = clusters.flat().map((i) => {
    const content = records[i].content;
    return typeof content === "string" ? content : "";
  });
  let vectors: number[][] | null;
  try {
    vectors = await embedder.embed(texts);
  } catch (err) {
    log.warn("整合向量获取失败，跳过簇内校验:", err);
    return clusters;
  }
  if (!vectors || vectors.length !== texts.length) {
    log.warn("整合向量响应异常，跳过簇内校验");
    return clusters;
  }
  const kept: number[][] = [];
  let offset = 0;
  for (const cluster of clusters) {
    const memberVectors = vectors.slice(offset, offset + cluster.length);
    offset += cluster.length;
    const centroid = centroidOf(memberVectors);
    const survivors = cluster.filter(
      (_, k) => cosineSimilarity(memberVectors[k], centroid) >= MIN_CENTROID_COSINE,
    );
    if (survivors.length >= MIN_CLUSTER_SIZE) kept.push(survivors);
  }
  return kept;
}

/**
 * 候选矛盾对预选（控制 LLM 成本）：同实体记录对 ∪ 同簇记录对，去重后
 * 按（两记录有效热度之和）降序截断到上限。同分保持生成序（稳定排序）。
 */
function candidatePairsOf(
  records: MemoryRecord[],
  clusters: number[][],
  heatOf: (record: MemoryRecord) => number,
): Array<[number, number]> {
  const seen = new Set<string>();
  const pairs: Array<[number, number]> = [];
  const addPair = (i: number, j: number) => {
    if (i === j) return;
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    const key = `${lo}|${hi}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push([lo, hi]);
  };
  // 同实体对：实体名按原文精确匹配（与 store.bumpMentionedEntities 同口径）；
  // 实体来源用 entitiesOf（claims 实体计入），否则候选对与聚类一样会空转
  const byEntity = new Map<string, number[]>();
  for (let i = 0; i < records.length; i += 1) {
    for (const entity of entitiesOf(records[i])) {
      const indexes = byEntity.get(entity);
      if (indexes) indexes.push(i);
      else byEntity.set(entity, [i]);
    }
  }
  for (const indexes of byEntity.values()) {
    for (let a = 0; a < indexes.length; a += 1) {
      for (let b = a + 1; b < indexes.length; b += 1) addPair(indexes[a], indexes[b]);
    }
  }
  // 同簇对
  for (const cluster of clusters) {
    for (let a = 0; a < cluster.length; a += 1) {
      for (let b = a + 1; b < cluster.length; b += 1) addPair(cluster[a], cluster[b]);
    }
  }
  pairs.sort(
    (x, y) =>
      heatOf(records[y[0]]) + heatOf(records[y[1]]) - (heatOf(records[x[0]]) + heatOf(records[x[1]])),
  );
  return pairs.slice(0, MAX_CANDIDATE_PAIRS);
}

/**
 * 冲突预过滤：候选对若共享同一 (entity, attribute) 且任一侧带 validUntil
 * 非空的历史声明——该维度的时间轴已闭合，旧值被新值取代，矛盾已被时间线
 * 解决，从候选剔除（陈年旧值送 LLM 只会产出过期洞察）。attribute 两侧都
 * 按 canonical 口径比较（与 store 的闭合逻辑一致）；宁可漏报不可错报。
 */
function hasClosedTimelineOverlap(a: MemoryRecord, b: MemoryRecord): boolean {
  const keysOf = (record: MemoryRecord): Map<string, boolean> => {
    const map = new Map<string, boolean>();
    if (!Array.isArray(record.entityClaims)) return map;
    for (const claim of record.entityClaims) {
      if (typeof claim?.entity !== "string" || claim.entity === "") continue;
      const attr = canonicalAttr(claim.attribute);
      const key = `${claim.entity}\u0000${attr}`;
      const closed = claim.validUntil != null;
      map.set(key, (map.get(key) ?? false) || closed);
    }
    return map;
  };
  const aKeys = keysOf(a);
  const bKeys = keysOf(b);
  for (const [key, aClosed] of aKeys) {
    const bClosed = bKeys.get(key);
    if (bClosed !== undefined && (aClosed || bClosed)) return true;
  }
  return false;
}

/** 截断单条记忆内容用于 prompt；内容是 LLM 派生数据，重放时类型不可信。 */
function snippetOf(record: MemoryRecord): string {
  const content = typeof record.content === "string" ? record.content.trim() : "";
  if (content.length <= SNIPPET_MAX_CHARS) return content;
  return `${content.slice(0, SNIPPET_MAX_CHARS)}…`;
}

function buildSystemPrompt(): string {
  return [
    "你是记忆整合器，根据给定的候选材料完成两件事。",
    "一、主题命名：给每个簇起一个简短的中文主题标签（不超过 12 个字），概括簇内记忆的共同主题。",
    "二、矛盾甄别：逐对检查疑似矛盾候选对，只把确实互相矛盾的对报告出来（同一事实有两种互斥说法、状态互斥等），并给一句不超过 40 字的中文矛盾摘要；不确定或不矛盾的不要输出。",
    "要求：",
    '- 只输出一个 JSON 对象，格式：{"clusters":[{"index":<簇编号>,"label":"..."}],"conflicts":[{"a":<记忆序号>,"b":<记忆序号>,"note":"..."}]}，不要任何解释或 Markdown。',
    "- index 必须是给定的簇编号，a、b 必须是给定的记忆序号，绝不编造材料里没有的编号。",
    "- 材料只列出了和任务相关的记忆，序号不连续属正常现象。",
    "- 没有矛盾就输出空的 conflicts 数组。",
  ].join("\n");
}

function buildUserPrompt(
  records: MemoryRecord[],
  clusters: number[][],
  pairs: Array<[number, number]>,
): string {
  const lines: string[] = [];
  if (clusters.length > 0) {
    lines.push("【主题候选簇】（#数字 是记忆序号）");
    clusters.forEach((cluster, ci) => {
      lines.push(`簇${ci}：`);
      for (const i of cluster) lines.push(`  #${i}. ${snippetOf(records[i])}`);
    });
  }
  if (pairs.length > 0) {
    lines.push("【疑似矛盾候选对】（只是候选，未必真的矛盾）");
    pairs.forEach(([a, b], pi) => {
      lines.push(`对${pi}：#${a}. ${snippetOf(records[a])} ←→ #${b}. ${snippetOf(records[b])}`);
    });
  }
  return lines.join("\n");
}

/**
 * 解析模型输出。与 extractor.parseTurn 同级容错：剥栅栏、容忍 JSON 前后
 * 的解释文字。clusters / conflicts 至少出现一个数组才算有效输出——两个
 * 都缺说明模型完全没按要求回答，按解析失败处理，避免用空洞察覆盖旧结果。
 */
function parseIntegrationOutput(raw: string): { clusters: unknown[]; conflicts: unknown[] } | null {
  let text = raw.trim();
  if (!text) return null;
  // 容忍模型包一层 Markdown 代码栅栏
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 容忍模型在 JSON 前后附加解释文字
    const brace = text.match(/\{[\s\S]*\}/);
    if (!brace) return null;
    try {
      parsed = JSON.parse(brace[0]);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as { clusters?: unknown; conflicts?: unknown };
  if (!Array.isArray(obj.clusters) && !Array.isArray(obj.conflicts)) return null;
  return {
    clusters: Array.isArray(obj.clusters) ? obj.clusters : [],
    conflicts: Array.isArray(obj.conflicts) ? obj.conflicts : [],
  };
}

/** 容忍模型把序号写成字符串（与 extractor 对 fact 下标的宽容度一致）。 */
function toIndex(value: unknown, bound: number): number | null {
  const index = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(index) || index < 0 || index >= bound) return null;
  return index;
}

/**
 * 清洗 LLM 返回的簇标签：index 必须落在送审簇范围内，label 非空字符串，
 * 截断到上限；同一簇多条时取第一条合法的。返回 簇下标 -> 标签。
 */
function sanitizeLabels(raw: unknown[], clusterCount: number): Map<number, string> {
  const labels = new Map<number, string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { index, label } = item as Record<string, unknown>;
    const idx = toIndex(index, clusterCount);
    if (idx === null || typeof label !== "string") continue;
    const trimmed = label.trim();
    if (!trimmed || labels.has(idx)) continue;
    labels.set(idx, trimmed.slice(0, LABEL_MAX_CHARS));
  }
  return labels;
}

/**
 * evidence 强校验（防伪造）：a/b 序号必须能映射回真实参与记录，a === b、
 * 序号越界、note 非空字符串之外的情况一律跳过该条，其余照常（单条非法
 * 跳过是 dsh-mneme 的 dreamSkipInvalid 思想）。同一对重复报告只取第一条，
 * note 截断到 80 字符。返回的条目 id/createdAt 由调用方统一补齐。
 */
function sanitizeConflicts(
  raw: unknown[],
  records: MemoryRecord[],
): Array<Omit<MemoryConflict, "id" | "createdAt">> {
  const out: Array<Omit<MemoryConflict, "id" | "createdAt">> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { a, b, note } = item as Record<string, unknown>;
    const ai = toIndex(a, records.length);
    const bi = toIndex(b, records.length);
    if (ai === null || bi === null || ai === bi) continue;
    if (typeof note !== "string") continue;
    const trimmed = note.trim();
    if (!trimmed) continue;
    const lo = Math.min(ai, bi);
    const hi = Math.max(ai, bi);
    const key = `${lo}|${hi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      recordIds: [records[lo].id, records[hi].id],
      note: trimmed.slice(0, NOTE_MAX_CHARS),
    });
    if (out.length >= MAX_CONFLICTS) break;
  }
  return out;
}

/** 洞察 id 的短随机段：8 位十六进制，碰撞概率可忽略。 */
function shortRandom(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

/**
 * 创建整合器。run 的完整流程：
 * 记录选取（heat 降序截断）→ 实体共现聚类 → 可选向量校验 → 簇截断
 * → 候选矛盾对预选 → 冲突预过滤（时间轴已闭合的剔除）→ 单次 LLM
 * （命名 + 甄别）→ 逐条 evidence 校验 → 落盘 + 回读校验。
 */
export function createConsolidator(deps: ConsolidatorDeps): Consolidator {
  const { store, llm, embedder, storage, maxRecords, log } = deps;

  async function run(signal: AbortSignal): Promise<Insights | null> {
    try {
      if (signal.aborted) {
        log.warn("记忆整合被中止，本次跳过");
        return null;
      }
      // all() 依赖内存索引，先确保日志重放完成（幂等）
      await store.load();
      if (signal.aborted) {
        log.warn("记忆整合被中止，本次跳过");
        return null;
      }

      // 1. 记录选取：活跃记录按有效热度降序取前 maxRecords（同分新者优先），
      //    聚焦「重要」记忆——整合成本花在被反复想起的内容上
      const now = Date.now();
      const heatOf = (record: MemoryRecord) => effectiveHeatOf(record, HEAT_DECAY_PER_DAY, now);
      const active = store.all({ includeDeleted: false });
      const selected = [...active]
        .sort((a, b) => heatOf(b) - heatOf(a) || (b.createdAt ?? 0) - (a.createdAt ?? 0))
        .slice(0, Number.isFinite(maxRecords) ? Math.max(0, Math.floor(maxRecords)) : 0);
      if (selected.length < MIN_RECORDS_FOR_RUN) {
        log.warn(`活跃记忆仅 ${selected.length} 条（不足 ${MIN_RECORDS_FOR_RUN}），跳过整合`);
        return null;
      }

      // 2. 实体共现聚类
      let clusters = entityClustersOf(selected);

      // 3. 可选向量校验：embedder 可用时对每簇做中心相似度抽查
      if (embedder && clusters.length > 0) {
        clusters = await pruneClustersByCentroid(clusters, selected, embedder, log);
        if (signal.aborted) {
          log.warn("记忆整合被中止，本次跳过");
          return null;
        }
      }

      // 4. 簇总数超限时按簇大小取前 MAX_CLUSTERS（稳定排序，同大小保持实体序）
      clusters = [...clusters].sort((a, b) => b.length - a.length).slice(0, MAX_CLUSTERS);

      // 5. 候选矛盾对预选 + 冲突预过滤
      const pairs = candidatePairsOf(selected, clusters, heatOf).filter(
        ([a, b]) => !hasClosedTimelineOverlap(selected[a], selected[b]),
      );

      // 6. 没有任何可整合的材料：不花那次 LLM 调用
      if (clusters.length === 0 && pairs.length === 0) {
        log.warn("没有可整合的主题簇或候选矛盾对，跳过整合");
        return null;
      }

      // 7. 单次 LLM 调用同时完成簇命名与矛盾甄别
      const requestMessages: PluginLlmMessage[] = [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildUserPrompt(selected, clusters, pairs) },
      ];
      const raw = await llm.generateText(requestMessages, {
        maxTokens: MAX_OUTPUT_TOKENS,
        signal,
        purpose: "consolidate-insights",
      });
      if (signal.aborted) {
        log.warn("记忆整合被中止，本次跳过");
        return null;
      }
      const parsed = parseIntegrationOutput(raw);
      if (parsed === null) {
        log.warn("记忆整合输出无法解析，本次跳过:", raw.slice(0, 200));
        return null;
      }

      // 8. 逐条校验 + 构建洞察（LLM 输出只进 label/note 字符串，先截断）
      const labels = sanitizeLabels(parsed.clusters, clusters.length);
      const conflicts = sanitizeConflicts(parsed.conflicts, selected);
      const insights: Insights = {
        version: 1,
        lastRunAt: now,
        clusters: clusters.map((cluster, ci) => ({
          id: `cluster_${now}_${shortRandom()}`,
          label: labels.get(ci) ?? UNNAMED_LABEL,
          recordIds: cluster.map((i) => selected[i].id),
          createdAt: now,
        })),
        conflicts: conflicts.map((conflict) => ({
          ...conflict,
          id: `conflict_${now}_${shortRandom()}`,
          createdAt: now,
        })),
      };

      // 9. 落盘 + 回读校验：saveInsights 吞异常只 warn，这里用回读确认
      //    真写进去了，写失败按「本次未整合」处理（旧洞察保持不动）
      saveInsights(storage, insights, log);
      if (loadInsights(storage).lastRunAt !== insights.lastRunAt) {
        log.warn("洞察落盘校验失败，本次整合结果放弃");
        return null;
      }

      log.log(`记忆整合完成：${insights.clusters.length} 个主题簇，${insights.conflicts.length} 对矛盾标注`);
      return insights;
    } catch (err) {
      // 兜底：任何未预期异常都不得波及调用方，降级为「本次没跑」
      log.warn("记忆整合失败（本次跳过）:", err);
      return null;
    }
  }

  return { run };
}
