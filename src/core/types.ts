export type MemoryId = string;

export interface TurnRef {
  conversationId: string;
  turnEventId: string;
  runId?: string;
}

/**
 * 一条记忆事实。
 * 内容是自然语言陈述；时间轴/实体等结构化信息单独附加，
 * 保持人类可读和可编辑。
 */
export interface MemoryRecord {
  id: MemoryId;
  createdAt: number;
  content: string;

  /** 来源轮次：用于去重和溯源。 */
  turn?: TurnRef;
  /** 反规范化，方便按会话过滤。 */
  conversationId?: string;

  /** 可选向量，仅当 embeddingModel 与当前配置匹配时参与检索。 */
  embedding?: number[];
  embeddingModel?: string;

  /** 提及的实体名。 */
  entities?: string[];

  /** 实体属性时间轴声明（dsh-mneme 独门能力）。 */
  entityClaims?: EntityClaim[];

  /** 软删标记；JSONL 追加 delete op 时设置。 */
  deleted?: boolean;
}

export interface EntityClaim {
  entity: string;
  attribute: string;
  value: string;
  validFrom?: number;
  /** null 表示当前仍然有效。 */
  validUntil?: number | null;
}

export interface SearchHit {
  record: MemoryRecord;
  score: number;
  source: "keyword" | "vector" | "hybrid";
}

export interface SearchQuery {
  text: string;
  conversationId?: string;
  limit?: number;
}

/** 后台摄入任务。 */
export interface IngestTask {
  conversationId: string;
  turnEventId: string;
  inputMessageId: string;
  finalMessageId?: string;
  runId?: string;
}

/** embedding 提供者接口。 */
export interface Embedder {
  readonly id: string;
  embed(texts: string[]): Promise<number[][] | null>;
}
