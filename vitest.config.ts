import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        TEST_MIGRATIONS: [{
          name: "0001_messages.sql",
          queries: readFileSync(new URL("./migrations/0001_messages.sql", import.meta.url), "utf8")
            .split(";").filter((query) => query.trim()),
        }],
      },
    },
  })],
});
