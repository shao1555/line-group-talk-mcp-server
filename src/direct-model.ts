import { z } from "zod";
import { formatLineText } from "./line-text";

// USD per million tokens equals micro-USD per token. Verified 2026-11-01.
export const DIRECT_MODELS = {
  glm: { id: "@cf/zai-org/glm-5.3-flash", input: 0.15, cachedInput: 0.03, output: 0.50, maxTokens: 4096, reasoning: "low" },
  qwen: { id: "@cf/qwen/qwen3-30b-a3b-fp8", input: 0.0509, cachedInput: 0.0509, output: 0.335, maxTokens: 1024, reasoning: undefined },
  oss: { id: "@cf/openai/gpt-oss-120b", input: 0.35, cachedInput: 0.35, output: 0.75, maxTokens: 4096, reasoning: "low" },
} as const;
export type DirectModelName = keyof typeof DIRECT_MODELS;
export const DEFAULT_DIRECT_MODEL: DirectModelName = "glm";
export type DirectModel = (typeof DIRECT_MODELS)[DirectModelName];
export const directAnswerSchema = z.object({
  action: z.literal("answer"), answer: z.string().trim().min(1).max(4000),
  basis: z.enum(["general", "recent_records", "history_records", "not_found"]),
}).strict();
const answerParts = z.array(z.string().trim().min(1).max(1000)).min(1).max(8);
export const directFinalWireSchema = directAnswerSchema.extend({ answer: answerParts.min(2) });
export const directDecisionSchema = z.discriminatedUnion("action", [
  directAnswerSchema,
  z.object({ action: z.literal("tools"), calls: z.array(z.object({
    name: z.enum(["list_conversations", "get_recent_messages", "get_message_context", "search_knowledge"]),
    arguments: z.record(z.string(), z.unknown()),
  }).strict()).min(1).max(3) }).strict(),
]);

const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(),
  prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().optional() }).optional(),
});
export function directCost(model: DirectModel, usage: unknown): number | null {
  const parsed = usageSchema.safeParse(usage);
  if (!parsed.success) return null;
  const { prompt_tokens: input, completion_tokens: output, prompt_tokens_details: details } = parsed.data;
  const reported = details?.cached_tokens ?? 0;
  const cached = reported <= input ? reported : 0;
  // completion_tokens already includes billed reasoning; don't add it again.
  return Math.ceil((input - cached) * model.input + cached * model.cachedInput + output * model.output);
}
export function directReservation(model: DirectModel, messages: { content: string }[]): number {
  const bytes = messages.reduce((n, m) => n + new TextEncoder().encode(m.content).byteLength, 0);
  return Math.ceil((bytes + 512) * model.input + model.maxTokens * model.output);
}
export function decodeDirectDecision(response: unknown, final: boolean) {
  const envelope = z.object({ choices: z.array(z.object({ finish_reason: z.string().nullable().optional(),
    message: z.object({ content: z.string().nullable() }) })).min(1) }).parse(response);
  if (envelope.choices[0].finish_reason === 'length') throw new Error('Incomplete direct completion');
  const raw = envelope.choices[0].message.content?.trim().replace(/^<think>[\s\S]*?<\/think>\s*/, "")
    .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!raw) throw new Error("Empty direct response");
  const parsed = z.object({ action: z.string() }).passthrough().parse(JSON.parse(raw));
  if (final) directFinalWireSchema.parse(parsed);
  let complete = false;
  let partsCount = 0;
  if (parsed.action === 'answer' && Array.isArray(parsed.answer)) {
    const parts = answerParts.parse(parsed.answer);
    partsCount = parts.length;
    parsed.answer = parts.join('\n\n');
    complete = parsed.basis === 'general' || parts.length >= 2;
  } else if (parsed.action === 'answer') {
    // Accept old planning responses as drafts; only an array can be delivered.
    complete = false;
  }
  const decision = (final ? directAnswerSchema : directDecisionSchema).parse(parsed);
  return decision.action === 'answer' ? { ...decision, answer: formatLineText(decision.answer), complete, partsCount } : decision;
}
