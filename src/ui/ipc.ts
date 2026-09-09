import type { PluginContext, PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { loadInsights } from "../core/insights";
import { effectiveHeatOf, HEAT_DECAY_PER_DAY, type MemoryStore } from "../core/store";
import { loadConfig, saveConfig, type PluginConfig } from "../config";
import type { Logger } from "../logger";

/**
 * 面板私有 IPC：通过 ctx.registerIpc 注册，channel 只用短名，
 * 框架自动命名空间化为 plugin:ripples-of-aion:<channel>（panel.js 用完整名调用）。
 */
const GET_STATE_CHANNEL = "get-state";
const FORGET_CHANNEL = "forget";
const DREAM_NOW_CHANNEL = "dream-now";
const GET_CONFIG_CHANNEL = "get-config";
const SAVE_CONFIG_CHANNEL = "save-config";
const BROWSE_CHANNEL = "browse-memories";

/** get-state 最多返回多少条最近记忆。 */
const RECENT_LIMIT = 20;

/** 洞察摘要各截前多少条：面板首屏够用，全量留给后续 UI 扩展阶段。 */
const INSIGHTS_SUMMARY_LIMIT = 8;

/** 每个主题簇最多带多少条成员原文（防 IPC 载荷膨胀，面板端可再展开/收起）。 */
const CLUSTER_MEMBERS_LIMIT = 8;

/** 保存配置时允许写入的键：白名单外一律丢弃（面板表单按此收口，storage 只暴露最小面）。 */
const EDITABLE_CONFIG_KEYS: ReadonlyArray<keyof PluginConfig> = [
  "embeddingProvider",
  "embeddingBaseUrl",
  "embeddingModel",
  "embeddingApiKeyName",
  "embeddingDimensions",
  "hotContextBudgetChars",
  "maxMemoriesPerTurn",
  "heatDecayPerDay",
  "heatWeight",
  "heatBump",
  "consolidationEnabled",
  "consolidationIdleMinutes",
  "consolidationMaxRecords",
];

/** get-state 返回的单条记忆：只挑面板需要的字段，避免把 embedding 等大对象送进 IPC。 */
interface PanelMemory {
  id: string;
  content: string;
  createdAt: number;
}

/** get-state 返回的单条时间轴声明（已拍平，面板直接渲染）。 */
interface PanelClaim {
  entity: string;
  attribute: string;
  value: string;
  validFrom: number;
  validUntil: number | null;
}

/** 主题簇摘要：成员解析成原文，用户才能看到「这个簇里到底有什么」。 */
interface PanelCluster {
  label: string;
  size: number;
  members: string[];
}

/** 矛盾标注摘要：附上两条记忆的原文，用户才能自行裁决哪边是对的。 */
interface PanelConflict {
  note: string;
  records: string[];
}

interface PanelInsights {
  lastRunAt: number;
  /** 整合是否正在后台进行（面板据此显示「做梦中」动效并轮询）。 */
  dreaming: boolean;
  clusters: PanelCluster[];
  conflicts: PanelConflict[];
}

interface PanelState {
  total: number;
  active: number;
  memories: PanelMemory[];
  claims: PanelClaim[];
  insights: PanelInsights;
}

/** 洞察空形态：从未整合过（lastRunAt === 0）或读取失败时的标准初始态。 */
const EMPTY_INSIGHTS: PanelInsights = { lastRunAt: 0, dreaming: false, clusters: [], conflicts: [] };

/** 拉取失败/异常时的兜底状态，面板据此显示空态而不是报错弹窗。 */
const EMPTY_STATE: PanelState = {
  total: 0,
  active: 0,
  memories: [],
  claims: [],
  insights: EMPTY_INSIGHTS,
};

/** 浏览器单条记忆：三栏浏览器的数据行（含热度与实体供面板端过滤/着色）。 */
interface BrowseRecord {
  id: string;
  content: string;
  createdAt: number;
  /** 有效热度 0..1（已含衰减），面板据此渲染火焰徽章与热度过滤。 */
  heat: number;
  entities: string[];
  /** 软删标记：面板按「已遗忘」来源过滤展示。 */
  deleted: boolean;
}

export interface UiIpcDeps {
  store: MemoryStore;
  /** 洞察读取：autoDream 产物独立于记忆本体，走插件 KV。 */
  storage: PluginStorage;
  log: Logger;
  /** 手动触发一次整合（single-flight 守卫在 index.ts 侧）；返回是否真正入队。 */
  triggerDream?: () => boolean;
  /** 整合是否在途（用于「做梦中」展示与轮询终止判定）。 */
  isDreaming?: () => boolean;
}

/**
 * 注册记忆图谱面板的五个 IPC channel：
 * - get-state：统计 + 最近 20 条活跃记忆 + 实体时间轴 + autoDream 洞察摘要；
 * - forget：按 id 软删一条记忆；
 * - dream-now：手动触发一次整合（守卫与串行队列都在 index.ts 侧）；
 * - get-config / save-config：读取与白名单合并保存插件配置。
 * 整体 fail-safe：读失败返回空状态、写失败返回 { ok: false }，只 warn 不抛。
 */
export function registerUiIpc(ctx: PluginContext, deps: UiIpcDeps): void {
  const { store, storage, log } = deps;

  const getState = async (): Promise<PanelState> => {
    try {
      // 读接口依赖内存索引，先确保 JSONL 重放完成。
      await store.load();
      const stats = store.getStats();
      const activeRecords = store.all({ includeDeleted: false });
      // all() 按时间升序返回活跃记录：取尾部 20 条再反转，即最近 20 条、最新在前。
      const memories: PanelMemory[] = activeRecords
        .slice(-RECENT_LIMIT)
        .reverse()
        .map((record) => ({
          id: record.id,
          content: record.content,
          createdAt: record.createdAt,
        }));
      // 活跃记录的全部属性声明拍平送出，面板按实体/属性分组画时间轴。
      const claims: PanelClaim[] = [];
      for (const record of activeRecords) {
        for (const claim of record.entityClaims ?? []) {
          claims.push({
            entity: claim.entity,
            attribute: claim.attribute,
            value: claim.value,
            validFrom: claim.validFrom ?? record.createdAt,
            validUntil: claim.validUntil ?? null,
          });
        }
      }
      return {
        total: stats.total,
        active: stats.active,
        memories,
        claims,
        insights: readInsights(activeRecords),
      };
    } catch (err) {
      log.warn("get-state 失败，返回空状态：", err);
      return EMPTY_STATE;
    }
  };

  /** 把持久化的洞察解析成面板摘要：recordIds 解析成原文（软删/缺失的成员静默剔除）。 */
  function readInsights(activeRecords: ReturnType<MemoryStore["all"]>): PanelInsights {
    const dreaming = deps.isDreaming?.() ?? false;
    // loadInsights 读不到/坏数据自身回退空洞察，这里再兜一层，保证绝不因洞察抛异常。
    try {
      const loaded = loadInsights(storage);
      // id -> 原文：洞察成员引用的记录可能已被软删，解析不到就静默剔除
      const contentById = new Map(activeRecords.map((record) => [record.id, record.content]));
      const pickContent = (id: unknown): string | null =>
        typeof id === "string" ? (contentById.get(id) ?? null) : null;
      const clusters = loaded.clusters.slice(0, INSIGHTS_SUMMARY_LIMIT).map((cluster) => {
        const members = cluster.recordIds.map(pickContent).filter((c): c is string => c !== null);
        return { label: cluster.label, size: cluster.recordIds.length, members: members.slice(0, CLUSTER_MEMBERS_LIMIT) };
      });
      const conflicts = loaded.conflicts.slice(0, INSIGHTS_SUMMARY_LIMIT).map((conflict) => ({
        note: conflict.note,
        records: conflict.recordIds.map(pickContent).filter((c): c is string => c !== null),
      }));
      return { lastRunAt: loaded.lastRunAt, dreaming, clusters, conflicts };
    } catch (err) {
      log.warn("读取洞察失败，返回空洞察：", err);
      return { ...EMPTY_INSIGHTS, dreaming };
    }
  }

  const forget = async (id: unknown): Promise<{ ok: boolean }> => {
    if (typeof id !== "string" || !id) return { ok: false };
    try {
      // 软删：JSONL 追加 del op；失败已在 store 内 warn，这里兜一层底。
      await store.delete(id);
      return { ok: true };
    } catch (err) {
      log.warn("forget 失败：", id, err);
      return { ok: false };
    }
  };

  const dreamNow = (): { ok: boolean; reason?: string } => {
    if (!deps.triggerDream) return { ok: false, reason: "unavailable" };
    return { ok: deps.triggerDream() };
  };

  /** 记忆浏览器数据源：关键词命中或全量，带热度/实体/软删标记供面板端交互过滤。 */
  const browseMemories = async (query: unknown): Promise<{ records: BrowseRecord[]; total: number }> => {
    try {
      await store.load();
      const options = (typeof query === "object" && query !== null ? query : {}) as {
        text?: unknown;
        limit?: unknown;
        includeDeleted?: unknown;
      };
      const text = typeof options.text === "string" ? options.text.trim() : "";
      const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
      const includeDeleted = options.includeDeleted === true;
      // 关键词命中时 store 已按相关度排序；空文本走全量（时间升序），统一反转成新者在前
      const base = text ? store.searchKeyword(text) : store.all({ includeDeleted });
      const records = base
        .slice(-limit)
        .reverse()
        .map((record) => ({
          id: record.id,
          content: record.content,
          createdAt: record.createdAt,
          heat: effectiveHeatOf(record, HEAT_DECAY_PER_DAY, Date.now()),
          entities: [
            ...(record.entities ?? []),
            ...(record.entityClaims ?? []).map((claim) => claim.entity),
          ].filter((entity, index, all) => typeof entity === "string" && entity !== "" && all.indexOf(entity) === index),
          deleted: record.deleted === true,
        }));
      return { records, total: base.length };
    } catch (err) {
      log.warn("browse-memories 失败，返回空列表：", err);
      return { records: [], total: 0 };
    }
  };

  const getConfig = (): PluginConfig => loadConfig(storage);

  const saveConfigPatch = (patch: unknown): { ok: boolean; config?: PluginConfig } => {
    if (typeof patch !== "object" || patch === null) return { ok: false };
    try {
      const current = loadConfig(storage);
      const incoming = patch as Record<string, unknown>;
      // 只接受白名单内的键，且按现值类型校验（数值必须有限数字、布尔必须布尔、
      // 其余必须字符串）——面板表单半填也不至于把配置写坏。
      for (const key of EDITABLE_CONFIG_KEYS) {
        if (!(key in incoming)) continue;
        const value = incoming[key];
        const currentType = typeof current[key];
        if (currentType === "number") {
          if (typeof value !== "number" || !Number.isFinite(value)) continue;
        } else if (currentType === "boolean") {
          if (typeof value !== "boolean") continue;
        } else if (typeof value !== "string") {
          continue;
        }
        // 白名单内的键按现值类型覆写；PluginConfig 无索引签名，经 unknown 中转
        (current as unknown as Record<string, unknown>)[key] = value;
      }
      saveConfig(storage, current);
      return { ok: true, config: current };
    } catch (err) {
      log.warn("save-config 失败：", err);
      return { ok: false };
    }
  };

  // 重复注册幂等：先移除旧处理器。首次注册时通道不存在，宿主会抛
  // 「不能注销不属于当前插件的 IPC channel」——这里只吞掉 unregister 的失败，
  // 绝不能让 catch 波及下面的 register。
  for (const channel of [GET_STATE_CHANNEL, FORGET_CHANNEL, DREAM_NOW_CHANNEL, GET_CONFIG_CHANNEL, SAVE_CONFIG_CHANNEL, BROWSE_CHANNEL]) {
    try {
      ctx.unregisterIpc(channel);
    } catch {
      /* 通道尚未注册，忽略 */
    }
  }
  try {
    ctx.registerIpc(GET_STATE_CHANNEL, () => getState());
    ctx.registerIpc(FORGET_CHANNEL, (id) => forget(id));
    ctx.registerIpc(DREAM_NOW_CHANNEL, () => dreamNow());
    ctx.registerIpc(GET_CONFIG_CHANNEL, () => getConfig());
    ctx.registerIpc(SAVE_CONFIG_CHANNEL, (patch) => saveConfigPatch(patch));
    ctx.registerIpc(BROWSE_CHANNEL, (query) => browseMemories(query));
  } catch (err) {
    log.warn("注册图谱 IPC 失败：", err);
  }

  // 插件注销时收口：移除面板 IPC 处理器。
  ctx.onDispose(() => {
    try {
      for (const channel of [GET_STATE_CHANNEL, FORGET_CHANNEL, DREAM_NOW_CHANNEL, GET_CONFIG_CHANNEL, SAVE_CONFIG_CHANNEL, BROWSE_CHANNEL]) {
        ctx.unregisterIpc(channel);
      }
    } catch (err) {
      log.warn("移除图谱 IPC 监听失败：", err);
    }
  });
}
