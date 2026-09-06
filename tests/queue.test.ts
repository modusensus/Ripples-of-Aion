import { describe, expect, it, vi } from "vitest";
import { TaskQueue } from "../src/pipeline/queue";
import { silentLog } from "./helpers";

describe("TaskQueue", () => {
  it("默认串行执行，顺序与入队一致", async () => {
    const controller = new AbortController();
    const queue = new TaskQueue<number>({ signal: controller.signal, log: silentLog });
    const order: number[] = [];
    await Promise.all([
      queue.enqueue(1, async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(1);
      }),
      queue.enqueue(2, async () => {
        order.push(2);
      }),
      queue.enqueue(3, async () => {
        order.push(3);
      }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("processor 抛错只吞掉，不阻塞后续任务", async () => {
    const controller = new AbortController();
    const queue = new TaskQueue<number>({ signal: controller.signal, log: silentLog });
    let ran = false;
    await queue.enqueue(1, async () => {
      throw new Error("boom");
    });
    await queue.enqueue(2, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("signal 中止后：排队任务丢弃，enqueue 立即放行", async () => {
    const controller = new AbortController();
    const queue = new TaskQueue<number>({ signal: controller.signal, log: silentLog });
    let release: (() => void) | undefined;
    const blocked = queue.enqueue(1, async () => {
      await new Promise<void>((r) => {
        release = r;
      });
    });
    const pending = queue.enqueue(2, async () => {
      throw new Error("不应该执行");
    });
    controller.abort();
    await pending; // 立即 resolve，不执行 processor
    expect(queue.stats().pending).toBe(0);
    release?.();
    await blocked;
  });

  it("运行中任务的 signal 参数即队列信号，可被外部感知", async () => {
    const controller = new AbortController();
    const queue = new TaskQueue<number>({ signal: controller.signal, log: silentLog });
    let sawSignal: AbortSignal | undefined;
    await queue.enqueue(1, async (_task, signal) => {
      sawSignal = signal;
    });
    expect(sawSignal).toBe(controller.signal);
  });

  it("enqueue 在已中止的队列上直接丢弃并放行", async () => {
    const controller = new AbortController();
    controller.abort();
    const queue = new TaskQueue<number>({ signal: controller.signal, log: silentLog });
    const warnSpy = vi.fn();
    // silentLog 不记录，这里只验证不抛异常、立即 resolve
    await queue.enqueue(1, async () => {
      throw new Error("不应该执行");
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
