// Secret bindings are configured with `wrangler secret put`, not in wrangler.jsonc.
interface Env extends Cloudflare.Env {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
}
