/**
 * 插件 id 单一事实源。
 * 工具 id、事件名、存储目录、安装目录都从此派生，不要硬编码。
 */
export const PLUGIN_ID = "ripples-of-aion" as const;
export type PluginId = typeof PLUGIN_ID;
