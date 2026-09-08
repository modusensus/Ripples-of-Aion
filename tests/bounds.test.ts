import { describe, expect, it } from "vitest";
import { clampBounds } from "../src/ui/bounds";

/** 常用测试工作区：1920×1040（1080p 减任务栏），起点在屏幕原点。 */
const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };
const MIN = { width: 560, height: 620 };

describe("clampBounds 窗口边界收敛", () => {
  it("非对象/缺字段/非有限数返回 null，调用方回退默认值", () => {
    expect(clampBounds(null, WORK_AREA, MIN)).toBeNull();
    expect(clampBounds("720x900", WORK_AREA, MIN)).toBeNull();
    expect(clampBounds({ x: 10, y: 10, width: 720 }, WORK_AREA, MIN)).toBeNull();
    expect(
      clampBounds({ x: Number.NaN, y: 10, width: 720, height: 900 }, WORK_AREA, MIN),
    ).toBeNull();
    expect(
      clampBounds({ x: Infinity, y: 10, width: 720, height: 900 }, WORK_AREA, MIN),
    ).toBeNull();
  });

  it("屏内正常边界原样保留", () => {
    const saved = { x: 100, y: 50, width: 720, height: 900 };
    expect(clampBounds(saved, WORK_AREA, MIN)).toEqual(saved);
  });

  it("尺寸收敛：小于最小值抬到 min，大于工作区压到工作区", () => {
    // 过小 → 至少 min（保证控件不挤爆）
    expect(clampBounds({ x: 0, y: 0, width: 200, height: 300 }, WORK_AREA, MIN)).toMatchObject({
      width: 560,
      height: 620,
    });
    // 过大 → 不超过工作区（比屏幕还大的窗口拖不回来）
    expect(
      clampBounds({ x: 0, y: 0, width: 4000, height: 3000 }, WORK_AREA, MIN),
    ).toMatchObject({ width: 1920, height: 1040 });
  });

  it("屏外窗口收敛到可见范围：标题栏至少露出可抓取的高度", () => {
    // 整窗飞到屏幕右下方很远处：x 收敛到右侧留 80px 可见，y 收敛到底沿上方 40px
    const rescued = clampBounds({ x: 5000, y: 8000, width: 720, height: 900 }, WORK_AREA, MIN);
    expect(rescued).not.toBeNull();
    expect(rescued!.x).toBe(1920 - 80);
    expect(rescued!.y).toBe(1040 - 40);
  });

  it("位置钳制不产生越界：多显示器负坐标起点同样成立", () => {
    // 左侧副屏工作区从 -1920 起（主屏在右的常见布局）
    const left = { x: -1920, y: 0, width: 1920, height: 1040 };
    const saved = { x: -5000, y: 100, width: 720, height: 900 };
    const result = clampBounds(saved, left, MIN);
    // 左边至少露出 80px：x >= workArea.x - width + 80
    expect(result).toMatchObject({ x: -1920 - 720 + 80, y: 100 });
  });

  it("退化工作区（比最小尺寸还小）以工作区为准，不产生超屏尺寸", () => {
    const tiny = { x: 0, y: 0, width: 400, height: 300 };
    const result = clampBounds({ x: 0, y: 0, width: 720, height: 900 }, tiny, MIN);
    expect(result).toMatchObject({ width: 400, height: 300 });
  });
});
