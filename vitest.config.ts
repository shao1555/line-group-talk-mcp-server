import { readFileSync, readdirSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        TEST_MIGRATIONS: readdirSync(new URL("./migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort().map((name) => ({
          name,
          queries: readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8")
            .split(";").filter((query) => query.trim()),
        })),
      },
    },
  })],
});
