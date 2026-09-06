import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 覆盖率只统计 src/：tests 与 scripts 不计入分母
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json"],
      include: ["src/**"],
    },
  },
});
