/**
 * 面板窗口边界的校验与收敛（纯函数，可单测）：
 * 保存的 bounds 来自插件存储（可能被手工改坏）或已断开的显示器（坐标在屏外），
 * 两者都不能直接信——坏数据回退默认值，越界数据收敛到可见范围。
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 横向至少露出这么多像素，窗口才不算「丢在屏外」。 */
const MIN_VISIBLE_X = 80;
/** 顶部标题栏至少露出这么多像素，用户才拖得回来。 */
const MIN_VISIBLE_Y = 40;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 校验并收敛保存的窗口边界。
 * 返回 null 表示数据不可用（非对象/缺字段/非有限数），调用方应回退默认尺寸。
 * 返回值保证：尺寸不小于 min 且不超出工作区（工作区比 min 还小时以工作区为准），
 * 位置保证标题栏在可见范围内、用户能拖回来。
 */
export function clampBounds(
  saved: unknown,
  workArea: Rect,
  min: { width: number; height: number },
): Rect | null {
  if (typeof saved !== "object" || saved === null) return null;
  const b = saved as Record<string, unknown>;
  if (
    !isFiniteNumber(b.x) ||
    !isFiniteNumber(b.y) ||
    !isFiniteNumber(b.width) ||
    !isFiniteNumber(b.height)
  ) {
    return null;
  }
  // 尺寸：不小于最小值，也不大于工作区（比屏幕还大的窗口同样拖不回来）；
  // 工作区比 min 还小的退化情形下 min 让位，保证不产生超屏尺寸。
  const width = Math.min(Math.max(b.width, min.width), workArea.width);
  const height = Math.min(Math.max(b.height, min.height), workArea.height);
  // 位置：允许左右部分越出（半隐半现是可恢复的），但保证至少 MIN_VISIBLE_X
  // 在工作区内；顶部不低于工作区上沿，且至少留出标题栏高度可抓取。
  const x = Math.min(
    Math.max(b.x, workArea.x - width + MIN_VISIBLE_X),
    workArea.x + workArea.width - MIN_VISIBLE_X,
  );
  const y = Math.min(Math.max(b.y, workArea.y), workArea.y + workArea.height - MIN_VISIBLE_Y);
  return { x, y, width, height };
}
