// Secret bindings are configured with `wrangler secret put`, not in wrangler.jsonc.
interface Env extends Cloudflare.Env {
  // Internal per-request value; never supplied by an arbitrary Host header.
  REQUEST_ORIGIN?: string;
  // Internal billing scope, derived exclusively from a signed LINE direct webhook.
  AI_BILLING_USER_ID?: string;
  LINE_LOGIN_CHANNEL_SECRET?: string;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
}
