import type { SearchHit } from "../core/types";

/**
 * 精排层。
 * 当前只提供直通实现（不做任何重排）；后续要上 LLM 精排时，
 * 实现同一个接口在检索出口处替换即可，调用方无感。
 */

/** 精排器：对初排候选重排序，输入输出是同一批记录。 */
export interface Reranker {
  rerank(hits: SearchHit[]): Promise<SearchHit[]>;
}

/** 直通精排：原样返回初排结果，保持顺序不变。 */
export function createPassThroughReranker(): Reranker {
  return {
    async rerank(hits: SearchHit[]): Promise<SearchHit[]> {
      return hits;
    },
  };
}
