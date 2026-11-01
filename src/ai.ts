import { DIRECT_MODELS, DEFAULT_DIRECT_MODEL } from "./direct-model";
import { DAY_MS, DIRECT_LIMIT, UserBudgetExceeded, directUsage } from "./direct-usage";
export const VISION_MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";
export const DIRECT_MODEL = DIRECT_MODELS[DEFAULT_DIRECT_MODEL].id;
export const AUDIO_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const PROCESSOR_VERSION = "2026-11-01-v1";

export class ProcessingError extends Error {
  constructor(readonly code: string, readonly permanent = false) { super(code); }
}
export class BudgetExceeded extends ProcessingError {
  constructor() { super("budget_exceeded"); }
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) => n.toString(16).padStart(2, "0")).join("");
}

export async function reserveAI(kind: "image" | "audio" | "embedding" | "answer", model: string, units: number, cost: number, env: Env): Promise<string> {
  const limits = {
    image: Number(env.AI_DAILY_IMAGES), audio: Number(env.AI_DAILY_AUDIO_SECONDS),
    embedding: Number(env.AI_DAILY_EMBEDDING_BYTES), answer: Number(env.AI_DAILY_ANSWERS),
  };
  const budget = Math.floor(Number(env.AI_MONTHLY_BUDGET_USD) * 1_000_000);
  if (!Number.isSafeInteger(budget) || budget < 0 || !Number.isSafeInteger(limits[kind]) || limits[kind] < 0) {
    throw new ProcessingError("invalid_budget_configuration", true);
  }
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const id = crypto.randomUUID();
  // A single conditional INSERT serializes both checks in D1, across all workers.
  const results = await env.DB.batch([env.DB.prepare(`INSERT INTO ai_usage
    (id, month, day, kind, model, units, reserved_microusd, charged_microusd, created_at, owner_user_id)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE COALESCE((SELECT charged_microusd FROM ai_usage_totals WHERE period = ? AND bucket = 'all'), 0) + ? <= ?
    AND COALESCE((SELECT units FROM ai_usage_totals WHERE period = ? AND bucket = ?), 0) + ? <= ?
    AND (? IS NULL OR COALESCE((SELECT SUM(charged_microusd) FROM ai_usage WHERE owner_user_id = ? AND created_at > ?), 0) + ? <= ?)` )
    .bind(id, month, day, kind, model, units, cost, cost, now.getTime(), env.AI_BILLING_USER_ID ?? null, `month:${month}`, cost, budget, `day:${day}`, kind, units, limits[kind],
      env.AI_BILLING_USER_ID ?? null, env.AI_BILLING_USER_ID ?? null, now.getTime() - DAY_MS, cost, DIRECT_LIMIT),
    env.DB.prepare(`INSERT INTO ai_usage_totals(period, bucket, units, charged_microusd)
      SELECT 'month:' || month, 'all', units, charged_microusd FROM ai_usage WHERE id = ?
      ON CONFLICT(period, bucket) DO UPDATE SET units = units + excluded.units, charged_microusd = charged_microusd + excluded.charged_microusd`).bind(id),
    env.DB.prepare(`INSERT INTO ai_usage_totals(period, bucket, units, charged_microusd)
      SELECT 'day:' || day, kind, units, charged_microusd FROM ai_usage WHERE id = ?
      ON CONFLICT(period, bucket) DO UPDATE SET units = units + excluded.units, charged_microusd = charged_microusd + excluded.charged_microusd`).bind(id),
  ]);
  const result = results[0];
  if (!result.meta.changes) {
    if (env.AI_BILLING_USER_ID && await directUsage(env.AI_BILLING_USER_ID, env) + cost > DIRECT_LIMIT) throw new UserBudgetExceeded();
    throw new BudgetExceeded();
  }
  return id;
}

export async function settleVisionUsage(id: string, usage: { prompt_tokens?: number; completion_tokens?: number } | undefined, env: Env): Promise<void> {
  if (!usage || !Number.isSafeInteger(usage.prompt_tokens) || !Number.isSafeInteger(usage.completion_tokens)
    || usage.prompt_tokens! < 0 || usage.completion_tokens! < 0) return;
  // USD per million tokens equals micro-USD per token. Rates checked 2026-11-01.
  const actual = Math.ceil(usage.prompt_tokens! * 0.351 + usage.completion_tokens! * 0.555);
  await settleAIUsage(id, actual, env);
}

export async function embed(texts: string[], env: Env, timeoutMs = 60_000): Promise<number[][]> {
  const bytes = texts.reduce((n, text) => n + new TextEncoder().encode(text).byteLength, 0);
  await reserveAI("embedding", EMBEDDING_MODEL, bytes, Math.max(1, Math.ceil((bytes + texts.length * 32) * 0.012)), env);
  const result = await env.AI.run(EMBEDDING_MODEL, { text: texts, truncate_inputs: false }, { signal: AbortSignal.timeout(timeoutMs) });
  if (!("data" in result) || !result.data || result.data.length !== texts.length
    || result.data.some((vector) => vector.length !== 1024 || vector.some((n) => !Number.isFinite(n)))) {
    throw new ProcessingError("invalid_embedding_response");
  }
  return result.data;
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export async function settleAIUsage(id: string, actual: number, env: Env): Promise<void> {
  if (!Number.isSafeInteger(actual) || actual < 0) return;
  await env.DB.batch([
    env.DB.prepare(`UPDATE ai_usage_totals SET charged_microusd = charged_microusd + ? - (SELECT charged_microusd FROM ai_usage WHERE id = ?)
      WHERE period = (SELECT 'month:' || month FROM ai_usage WHERE id = ?) AND bucket = 'all'`).bind(actual, id, id),
    env.DB.prepare(`UPDATE ai_usage_totals SET charged_microusd = charged_microusd + ? - (SELECT charged_microusd FROM ai_usage WHERE id = ?)
      WHERE period = (SELECT 'day:' || day FROM ai_usage WHERE id = ?) AND bucket = (SELECT kind FROM ai_usage WHERE id = ?)`).bind(actual, id, id, id),
    env.DB.prepare("UPDATE ai_usage SET charged_microusd = ? WHERE id = ?").bind(actual, id),
  ]);
}
