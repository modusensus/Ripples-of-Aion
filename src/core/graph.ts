import type { MemoryRecord } from "./types";

/**
 * 实体共现图谱（v0.6.0 面板「记忆图谱」页的数据源）。
 * 纯函数、零依赖：输入记录数组，输出节点/边两个列表；本模块不依赖 store 实例，
 * 有效热度经可选的 heatOf 函数注入（IPC 层负责柯里化 store 的 effectiveHeatOf）。
 */

/** 图谱节点：一个实体的聚合画像。 */
export interface EntityGraphNode {
  /** 实体名（原文精确匹配口径，与 claim 闭合、被提及加权同侧）。 */
  name: string;
  /**
   * 不同共现实体数。全量口径：截断只影响输出的边，不改节点画像——
   * 半径 ∝ sqrt(degree) 反映的是实体在全部记忆里的枢纽程度。
   */
  degree: number;
  /** 提及该实体的记录数。 */
  count: number;
  /** 相关记录有效热度均值 ∈ [0,1]；未注入 heatOf 时一律中性 0.5。 */
  heat: number;
}

/** 图谱边：两个实体在同一条记录中的共现。 */
export interface EntityGraphEdge {
  /** 端点实体名，恒有 a < b（字典序），同一条边只出现一次。 */
  a: string;
  b: string;
  /** 共现次数（同时出现两实体的记录条数）。 */
  weight: number;
}

/** 实体共现图谱。 */
export interface EntityGraph {
  nodes: EntityGraphNode[];
  edges: EntityGraphEdge[];
}

/** 图谱规模上限：超过按 (degree, count) 降序截断，边只在保留节点间重算。 */
export const GRAPH_MAX_NODES = 40;

export interface BuildEntityGraphOptions {
  /**
   * 有效热度计算函数（通常注入 effectiveHeatOf 的柯里化版本）；
   * 缺省一律视为中性 0.5。返回非有限值也按 0.5 处理，脏数据不产 NaN。
   */
  heatOf?: (record: MemoryRecord) => number;
}

/** 未注入 heatOf 时的中性热度（与 store.HEAT_NEUTRAL 同值，这里不引 store 依赖）。 */
const NEUTRAL_HEAT = 0.5;

/**
 * 记录的关联实体：顶层 entities 与 entityClaims 的实体名取并集（去重、剔非字符串）。
 * 与 pipeline/consolidate.ts 的 entitiesOf 同口径：实测抽取器几乎只填 claims
 * 不填顶层 entities，只看顶层字段会让图谱变成空图。
 */
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

/**
 * 构建实体共现图谱：
 * - 软删（deleted）记录整体排除；
 * - 节点 count = 提及该实体的记录数，heat = 相关记录有效热度均值；
 * - 边 = 同一记录内实体两两共现，weight = 共现记录数，端点按 a < b 字典序归一；
 * - 超过 GRAPH_MAX_NODES 时按 (degree, count) 降序截断节点，边只在保留节点间重算。
 * 记录/实体极少时返回合理空结构，绝不抛异常。
 */
export function buildEntityGraph(
  records: readonly MemoryRecord[],
  options?: BuildEntityGraphOptions,
): EntityGraph {
  const heatOf = options?.heatOf;

  /** 提及计数与热度累加：entity -> 数值。 */
  const countByEntity = new Map<string, number>();
  const heatSumByEntity = new Map<string, number>();
  /** 共现边权：a -> (b -> weight)，恒 a < b，嵌套 Map 避免拼 key 的分隔符歧义。 */
  const weightByPair = new Map<string, Map<string, number>>();

  for (const record of records) {
    if (record.deleted === true) continue;
    const entities = entitiesOf(record);
    if (entities.length === 0) continue;

    const rawHeat = typeof heatOf === "function" ? heatOf(record) : NEUTRAL_HEAT;
    const heat = Number.isFinite(rawHeat) ? rawHeat : NEUTRAL_HEAT;
    for (const entity of entities) {
      countByEntity.set(entity, (countByEntity.get(entity) ?? 0) + 1);
      heatSumByEntity.set(entity, (heatSumByEntity.get(entity) ?? 0) + heat);
    }

    // 同一记录内两两共现；entities 已去重，端点按字典序归一防同边重复
    for (let i = 0; i < entities.length; i += 1) {
      for (let j = i + 1; j < entities.length; j += 1) {
        const [a, b] =
          entities[i] < entities[j] ? [entities[i], entities[j]] : [entities[j], entities[i]];
        let inner = weightByPair.get(a);
        if (!inner) {
          inner = new Map<string, number>();
          weightByPair.set(a, inner);
        }
        inner.set(b, (inner.get(b) ?? 0) + 1);
      }
    }
  }

  if (countByEntity.size === 0) return { nodes: [], edges: [] };

  // 邻接集合：degree = 不同共现实体数（全量口径，在截断之前算好）
  const neighborsByEntity = new Map<string, Set<string>>();
  for (const [a, inner] of weightByPair) {
    for (const b of inner.keys()) {
      if (!neighborsByEntity.has(a)) neighborsByEntity.set(a, new Set());
      if (!neighborsByEntity.has(b)) neighborsByEntity.set(b, new Set());
      neighborsByEntity.get(a)!.add(b);
      neighborsByEntity.get(b)!.add(a);
    }
  }

  const allNodes: EntityGraphNode[] = [...countByEntity.entries()].map(([name, count]) => ({
    name,
    count,
    degree: neighborsByEntity.get(name)?.size ?? 0,
    heat: (heatSumByEntity.get(name) ?? 0) / count,
  }));

  // 截断：按 (degree, count) 降序取前 40；同分按名字典序稳定收尾，输出可复现
  const kept = [...allNodes]
    .sort(
      (x, y) =>
        y.degree - x.degree ||
        y.count - x.count ||
        (x.name < y.name ? -1 : x.name > y.name ? 1 : 0),
    )
    .slice(0, GRAPH_MAX_NODES);
  const keptNames = new Set(kept.map((node) => node.name));

  // 边只在保留节点间重算：端点被截掉的共现对直接丢弃
  const edges: EntityGraphEdge[] = [];
  for (const [a, inner] of weightByPair) {
    if (!keptNames.has(a)) continue;
    for (const [b, weight] of inner) {
      if (!keptNames.has(b)) continue;
      edges.push({ a, b, weight });
    }
  }
  edges.sort(
    (x, y) => y.weight - x.weight || x.a.localeCompare(y.a) || x.b.localeCompare(y.b),
  );

  return { nodes: kept, edges };
}
