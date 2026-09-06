import type { Logger } from "../logger";

/** 队列选项。 */
export interface TaskQueueOptions {
  /** 插件生命周期信号；aborted 后不再启动新任务，排队任务直接丢弃。 */
  signal: AbortSignal;
  log: Logger;
  /** 最大并发数，默认 1（串行）；非法值收敛为 1。 */
  concurrency?: number;
}

interface QueueItem<T> {
  task: T;
  processor: (task: T, signal: AbortSignal) => Promise<void>;
  /** 任务结束（完成、失败或因中止被丢弃）时放行 enqueue 的等待方。 */
  settle: () => void;
}

/**
 * 后台任务队列：限制并发、按序派发、全程 fail-safe。
 * processor 抛错只记 warn，不阻塞后续任务；signal 中止后不再启动
 * 新任务，正在运行的任务由 processor 自行响应 signal 停止。
 */
export class TaskQueue<T> {
  private readonly signal: AbortSignal;
  private readonly log: Logger;
  private readonly concurrency: number;
  private readonly queue: QueueItem<T>[] = [];
  private running = 0;

  private readonly handleAbort = (): void => {
    if (this.queue.length === 0) return;
    const dropped = this.queue.splice(0, this.queue.length);
    for (const item of dropped) item.settle();
    this.log.log(`队列已中止，丢弃 ${dropped.length} 个排队任务`);
    this.detachAbortListener();
  };

  constructor(options: TaskQueueOptions) {
    this.signal = options.signal;
    this.log = options.log;
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
    this.signal.addEventListener("abort", this.handleAbort);
  }

  /**
   * 入队一个任务。返回的 Promise 在任务结束（成功、失败被吞掉或
   * 因中止被丢弃）时 resolve，不会 reject。
   */
  enqueue(task: T, processor: (task: T, signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.signal.aborted) {
      this.log.log("队列已中止，直接丢弃任务:", task);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push({ task, processor, settle: resolve });
      this.pump();
    });
  }

  stats(): { pending: number; running: number } {
    return { pending: this.queue.length, running: this.running };
  }

  /** 派发排队任务直到占满并发额度；空闲时摘掉 abort 监听，避免泄漏。 */
  private pump(): void {
    while (!this.signal.aborted && this.running < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;
      this.running += 1;
      void this.run(item);
    }
    this.detachAbortListener();
  }

  private async run(item: QueueItem<T>): Promise<void> {
    try {
      await item.processor(item.task, this.signal);
    } catch (err) {
      this.log.warn("任务处理失败（已忽略）:", err);
    } finally {
      this.running -= 1;
      item.settle();
      this.pump();
    }
  }

  private detachAbortListener(): void {
    if (this.signal.aborted || this.running > 0 || this.queue.length > 0) return;
    this.signal.removeEventListener("abort", this.handleAbort);
  }
}
