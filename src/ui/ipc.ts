import type { PluginContext, PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { loadInsights } from "../core/insights";
import type { MemoryStore } from "../core/store";
import type { Logger } from "../logger";

/**
 * 面板私有 IPC：通过 ctx.registerIpc 注册，channel 只用短名，
 * 框架自动命名空间化为 plugin:ripples-of-aion:<channel>（panel.js 用完整名调用）。
 */
const GET_STATE_CHANNEL = "get-state";
const FORGET_CHANNEL = "forget";

/** get-state 最多返回多少条最近记忆。 */
const RECENT_LIMIT = 20;

/** 洞察摘要各截前多少条：面板首屏够用，全量留给后续 UI 扩展阶段。 */
const INSIGHTS_SUMMARY_LIMIT = 8;

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

/** get-state 返回的洞察摘要（autoDream 产物）：簇只给标签+规模，矛盾只给摘要。 */
interface PanelInsights {
  lastRunAt: number;
  clusters: Array<{ label: string; size: number }>;
  conflicts: Array<{ note: string }>;
}

interface PanelState {
  total: number;
  active: number;
  memories: PanelMemory[];
  claims: PanelClaim[];
  insights: PanelInsights;
}

/** 洞察空形态：从未整合过（lastRunAt === 0）或读取失败时的标准初始态。 */
const EMPTY_INSIGHTS: PanelInsights = { lastRunAt: 0, clusters: [], conflicts: [] };

/** 拉取失败/异常时的兜底状态，面板据此显示空态而不是报错弹窗。 */
const EMPTY_STATE: PanelState = {
  total: 0,
  active: 0,
  memories: [],
  claims: [],
  insights: EMPTY_INSIGHTS,
};

export interface UiIpcDeps {
  store: MemoryStore;
  /** 洞察读取：autoDream 产物独立于记忆本体，走插件 KV。 */
  storage: PluginStorage;
  log: Logger;
}

/**
 * 注册记忆图谱面板的两个 IPC channel：
 * - get-state：统计 + 最近 20 条活跃记忆 + autoDream 洞察摘要；
 * - forget：按 id 软删一条记忆。
 * 整体 fail-safe：读失败返回空状态、删失败返回 { ok: false }，只 warn 不抛。
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
      // autoDream 洞察摘要：loadInsights 读不到/坏数据自身回退空洞察，
      // 这里再兜一层 try/catch，保证 get-state 绝不因洞察抛异常。
      let insights = EMPTY_INSIGHTS;
      try {
        const loaded = loadInsights(storage);
        insights = {
          lastRunAt: loaded.lastRunAt,
          clusters: loaded.clusters
            .slice(0, INSIGHTS_SUMMARY_LIMIT)
            .map((cluster) => ({ label: cluster.label, size: cluster.recordIds.length })),
          conflicts: loaded.conflicts
            .slice(0, INSIGHTS_SUMMARY_LIMIT)
            .map((conflict) => ({ note: conflict.note })),
        };
      } catch (err) {
        log.warn("读取洞察失败，返回空洞察：", err);
      }
      return { total: stats.total, active: stats.active, memories, claims, insights };
    } catch (err) {
      log.warn("get-state 失败，返回空状态：", err);
      return EMPTY_STATE;
    }
  };

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

  // 重复注册幂等：先移除旧处理器。首次注册时通道不存在，宿主会抛
  // 「不能注销不属于当前插件的 IPC channel」——这里只吞掉 unregister 的失败，
  // 绝不能让 catch 波及下面的 register。
  for (const channel of [GET_STATE_CHANNEL, FORGET_CHANNEL]) {
    try {
      ctx.unregisterIpc(channel);
    } catch {
      /* 通道尚未注册，忽略 */
    }
  }
  try {
    ctx.registerIpc(GET_STATE_CHANNEL, () => getState());
    ctx.registerIpc(FORGET_CHANNEL, (id) => forget(id));
  } catch (err) {
    log.warn("注册图谱 IPC 失败：", err);
  }

  // 插件注销时收口：移除面板 IPC 处理器。
  ctx.onDispose(() => {
    try {
      ctx.unregisterIpc(GET_STATE_CHANNEL);
      ctx.unregisterIpc(FORGET_CHANNEL);
    } catch (err) {
      log.warn("移除图谱 IPC 监听失败：", err);
    }
  });
}
