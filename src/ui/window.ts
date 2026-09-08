import type { PluginContext } from "@playa0v0/cyrene-plugin-sdk";
import type { BrowserWindow } from "electron";
import type { Logger } from "../logger";
import { clampBounds } from "./bounds";

/** electron 主进程模块的最小视图；运行时通过 require 懒加载，避免硬依赖。 */
type ElectronMainModule = typeof import("electron");

export interface WindowManagerDeps {
  log: Logger;
}

export interface WindowManager {
  /** 打开（或聚焦）记忆图谱窗口；ctx.signal 中止（插件注销）时自动关闭。 */
  open(ctx: PluginContext): Promise<void>;
  /** 关闭窗口；重复调用安全。 */
  close(): void;
}

/** 面板窗口标题与默认尺寸（承接更多后端能力的展示位，v0.3.1 起）。 */
const WINDOW_TITLE = "岁月涟漪 · 记忆图谱";
const WINDOW_WIDTH = 720;
const WINDOW_HEIGHT = 900;
const WINDOW_MIN_WIDTH = 560;
const WINDOW_MIN_HEIGHT = 620;

/** 窗口边界在插件存储里的键。 */
const BOUNDS_KEY = "panel-bounds";
/** resize/move 防抖：拖动事件连发，落盘收敛到停止后的一次。 */
const SAVE_DEBOUNCE_MS = 600;

/**
 * 记忆图谱窗口管理器：
 * - 懒加载 electron（BrowserWindow），无 GUI / 未打包环境下降级为 warn；
 * - 同一时刻只保留一个窗口，重复 open 时聚焦已有窗口；
 * - 窗口大小位置持久化到插件存储：坏数据回退默认、越界收敛到可见范围，
 *   最大化状态不落盘（下次按常规尺寸恢复）；
 * - 绑定 ctx.signal，插件 unregister 即关窗。
 */
export function createWindowManager(deps: WindowManagerDeps): WindowManager {
  const { log } = deps;

  let win: BrowserWindow | null = null;
  let boundSignal: AbortSignal | null = null;
  let abortHandler: (() => void) | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const detachSignal = (): void => {
    if (boundSignal && abortHandler) {
      boundSignal.removeEventListener("abort", abortHandler);
    }
    boundSignal = null;
    abortHandler = null;
  };

  const clearSaveTimer = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  };

  const close = (): void => {
    clearSaveTimer();
    const target = win;
    win = null;
    if (!target) return;
    try {
      if (!target.isDestroyed()) target.close();
    } catch (err) {
      log.warn("关闭记忆图谱窗口失败：", err);
    }
  };

  const open = async (ctx: PluginContext): Promise<void> => {
    // 已注销（或正在注销）就不再开窗。
    if (ctx.signal.aborted) return;

    // 生命周期绑定：插件 unregister（signal 中止）时自动关窗。
    detachSignal();
    abortHandler = close;
    ctx.signal.addEventListener("abort", abortHandler, { once: true });
    boundSignal = ctx.signal;

    // 已有窗口：聚焦即可。
    if (win && !win.isDestroyed()) {
      try {
        if (win.isMinimized()) win.restore();
        win.focus();
      } catch (err) {
        log.warn("聚焦记忆图谱窗口失败：", err);
      }
      return;
    }
    // 走到这里说明没有窗口，或残留了已销毁的引用，清掉再建。
    win = null;

    try {
      const electron = require("electron") as ElectronMainModule;
      // 恢复上次窗口边界：坏数据回退默认尺寸（主工作区居中偏上）；
      // 默认与保存的边界都过同一道收敛，小屏笔记本上 900 高也不会撑出屏幕。
      const workArea = electron.screen.getPrimaryDisplay().workArea;
      const centered = {
        x: Math.round(workArea.x + (workArea.width - WINDOW_WIDTH) / 2),
        y: Math.round(workArea.y + Math.max(0, workArea.height - WINDOW_HEIGHT) / 3),
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
      };
      const bounds =
        clampBounds(ctx.storage.get(BOUNDS_KEY), workArea, {
          width: WINDOW_MIN_WIDTH,
          height: WINDOW_MIN_HEIGHT,
        }) ?? centered;

      const created = new electron.BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        minWidth: WINDOW_MIN_WIDTH,
        minHeight: WINDOW_MIN_HEIGHT,
        title: WINDOW_TITLE,
        autoHideMenuBar: true,
        backgroundColor: "#fff8fb",
        // 面板加载的是随插件分发的受信静态页，panel.js 需要直接使用 ipcRenderer。
        webPreferences: { nodeIntegration: true, contextIsolation: false },
      });
      created.on("closed", () => {
        if (win === created) win = null;
      });

      // 大小位置持久化：拖动/缩放防抖落盘；关闭前补一次，覆盖「拖完立刻关窗」。
      const saveBounds = (): void => {
        // 最大化尺寸不是用户的常规布局，跳过让下次按常规恢复。
        if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
        try {
          ctx.storage.set(BOUNDS_KEY, win.getBounds());
        } catch (err) {
          log.warn("保存窗口边界失败：", err);
        }
      };
      const scheduleSaveBounds = (): void => {
        clearSaveTimer();
        saveTimer = setTimeout(() => {
          saveTimer = null;
          saveBounds();
        }, SAVE_DEBOUNCE_MS);
      };
      created.on("resize", scheduleSaveBounds);
      created.on("move", scheduleSaveBounds);
      created.on("close", () => {
        clearSaveTimer();
        saveBounds();
      });

      win = created;
      // index.cjs 与 panel/ 部署在同一目录，直接用 __dirname 相对路径加载。
      await created.loadFile(`${__dirname}/panel/index.html`);
      // signal 可能在上面 await 期间刚好中止，补一次兜底。
      if (ctx.signal.aborted) close();
    } catch (err) {
      log.warn("打开记忆图谱窗口失败：", err);
      close();
    }
  };

  return { open, close };
}
