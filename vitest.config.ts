import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Stage logs go to stderr. Quiet them so a failing assertion is easy to find.
    env: { COLDSPARK_LOG_LEVEL: "error" },
  },
});
