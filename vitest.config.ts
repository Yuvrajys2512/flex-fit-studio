import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    // Each file gets its own process so the module-level libsql client in
    // src/db/index.ts cannot leak between suites.
    pool: "forks",
    poolOptions: { forks: { singleFork: false } },
  },
});
