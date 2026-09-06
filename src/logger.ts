import type { PluginContext } from "@playa0v0/cyrene-plugin-sdk";

export interface Logger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(raw: Pick<PluginContext, "log">): Logger {
  const prefix = "[岁月涟漪]";
  const log = raw.log.bind(raw);
  return {
    log: (...args) => log(prefix, ...args),
    warn: (...args) => log(prefix, "[warn]", ...args),
    error: (...args) => log(prefix, "[error]", ...args),
  };
}
