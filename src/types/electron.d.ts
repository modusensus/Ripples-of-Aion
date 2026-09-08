/**
 * electron 最小类型声明：只为本插件的调用点过 typecheck，
 * 不把 electron 安装为依赖。真实 API 以运行时为准，
 * 需要更多方法/字段时按需补充。
 */
declare module "electron" {
  /** BrowserWindow 构造参数（仅列出本插件用到的字段）。 */
  export interface BrowserWindowConstructorOptions {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    title?: string;
    autoHideMenuBar?: boolean;
    /** 无外框窗口：标题栏由面板自绘。 */
    frame?: boolean;
    /** 窗口底色，避免面板加载前闪黑。 */
    backgroundColor?: string;
    webPreferences?: {
      nodeIntegration?: boolean;
      contextIsolation?: boolean;
    };
  }

  /** 窗口边界（screen 工作区收敛与持久化用）。 */
  export interface Rectangle {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  export class BrowserWindow {
    constructor(opts?: BrowserWindowConstructorOptions);
    /** 加载本地页面（panel/index.html）。 */
    loadFile(path: string): Promise<void>;
    focus(): void;
    restore(): void;
    show(): void;
    close(): void;
    isDestroyed(): boolean;
    isMinimized(): boolean;
    isMaximized(): boolean;
    getBounds(): Rectangle;
    /** 最小事件订阅：closed 等一律用字符串事件名。 */
    on(event: string, listener: (...args: unknown[]) => void): void;
  }

  export const screen: {
    /** 主显示器工作区（刨去任务栏），窗口边界收敛的参照系。 */
    getPrimaryDisplay(): { workArea: Rectangle };
  };

  export const ipcMain: {
    /** 注册 invoke 处理器（渲染进程 ipcRenderer.invoke 的对端）。 */
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
    removeHandler(channel: string): void;
    on(channel: string, listener: (...args: unknown[]) => void): void;
    removeListener(channel: string, listener: (...args: unknown[]) => void): void;
  };

  export const ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<any>;
    send(channel: string, ...args: unknown[]): void;
  };
}
