import { BudgetExceeded } from "./ai";
import { searchKnowledge, type SearchHit } from "./search";
import type { HistoryPlan } from "./history-plan";

type ContextKind = "recent" | "neighbor" | "semantic" | "quoted";
export type AnswerEvidence = SearchHit & { kind: ContextKind; userId: string | null };
type ConversationRow = { message_id: string; text: string; sent_at: number; user_id: string | null };

export function japaneseTime(timestamp: number): string {
  return `${new Date(timestamp + 9 * 60 * 60_000).toISOString().slice(0, 19).replace("T", " ")} JST`;
}

function render(hit: AnswerEvidence, index: number): string {
  const kind = { recent: "直近の会話", neighbor: "検索された発言の前後", semantic: "検索された過去の資料", quoted: "今回の質問が引用した発言" }[hit.kind];
  return `[${index + 1}] ${kind} 発言ID:${hit.messageId} 日時:${japaneseTime(hit.sentAt)} 送信者:${hit.userId ?? "不明"}\n${hit.text}`;
}

export function formatAnswerEvidence(hits: AnswerEvidence[]): string {
  return hits.map(render).join("\n\n");
}

function fit(rows: AnswerEvidence[], budget: number, chronological = false): AnswerEvidence[] {
  const selected: AnswerEvidence[] = [];
  let remaining = budget;
  for (const row of rows) {
    // Preserve a bounded amount of each utterance, reserving space for attribution.
    const allowance = Math.min(1000, remaining - render({ ...row, text: "" }, 99).length - 2);
    if (allowance < 40) break;
    const text = row.text.length <= allowance ? row.text : `${row.text.slice(0, allowance - 12)}\n[一部省略]`;
    const hit = { ...row, text };
    remaining -= render(hit, 99).length + 2;
    selected.push(hit);
  }
  return chronological ? selected.sort((a, b) => a.sentAt - b.sentAt) : selected;
}

function fromConversation(row: ConversationRow, kind: ContextKind): AnswerEvidence {
  return { messageId: row.message_id, text: row.text, sentAt: row.sent_at, userId: row.user_id, fileName: null, score: 0, kind };
}

export async function collectAnswerEvidence(question: string, conversationId: string, questionId: string, env: Env, plan?: HistoryPlan): Promise<{ hits: AnswerEvidence[]; questionSentAt: number }> {
  const anchor = await env.DB.prepare("SELECT sent_at FROM messages WHERE message_id = ? AND conversation_id = ? AND unsent_at IS NULL")
    .bind(questionId, conversationId).first<{ sent_at: number }>();
  if (!anchor) return { hits: [], questionSentAt: Date.now() };

  // Explicit quotations outrank recency and semantic similarity, including old messages.
  const quoted = await env.DB.prepare(`SELECT p.message_id, substr(COALESCE(p.text,
      CASE WHEN j.status = 'ready' THEN j.extracted_text END), 1, 1200) AS text, p.sent_at, p.user_id
    FROM messages q JOIN messages p ON p.message_id = q.quoted_message_id
    LEFT JOIN knowledge_jobs j ON j.message_id = p.message_id
    WHERE q.message_id = ? AND q.conversation_id = ? AND p.conversation_id = ?
    AND q.unsent_at IS NULL AND p.unsent_at IS NULL AND p.sent_at <= ? AND p.message_id != q.message_id`)
    .bind(questionId, conversationId, conversationId, anchor.sent_at).first<ConversationRow>();
  const quote = quoted?.text ? fit([fromConversation(quoted, "quoted")], 1000) : [];
  const quoteIds = new Set(quote.map((hit) => hit.messageId));

  // Recent raw utterances must not depend on asynchronous embedding/index visibility.
  // Exclude bot-directed questions from evidence; they are requests, not known facts.
  const recent = await env.DB.prepare(`SELECT m.message_id, substr(m.text, 1, 1200) AS text, m.sent_at, m.user_id
    FROM messages m WHERE m.conversation_id = ? AND m.unsent_at IS NULL AND m.message_type = 'text'
    AND m.text IS NOT NULL AND m.message_id != ? AND m.sent_at <= ?
    AND NOT EXISTS (SELECT 1 FROM bot_replies b WHERE b.message_id = m.message_id)
    ORDER BY m.sent_at DESC, m.received_at DESC, m.message_id DESC LIMIT 20`)
    .bind(conversationId, questionId, anchor.sent_at).all<ConversationRow>();

  let semantic: SearchHit[];
  try { semantic = await searchKnowledge(plan?.query ?? question, conversationId, env, questionId, 5,
    plan ? { from: plan.from, before: plan.before, fallbackToAllTime: true, timeoutMs: 5000 } : {}); }
  catch (error) {
    if (error instanceof BudgetExceeded || (!recent.results.length && !quote.length)) throw error;
    semantic = []; // A temporary Vectorize/embedding failure must not hide recent conversation.
  }
  if (plan?.keyword) {
    const keyword = `%${plan.keyword.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const lexical = await env.DB.prepare(`SELECT m.message_id, substr(m.text, 1, 1200) AS text, m.sent_at, m.user_id
      FROM messages m WHERE m.conversation_id = ? AND m.unsent_at IS NULL AND m.message_id != ?
      AND m.sent_at <= ? AND m.sent_at >= ? AND m.sent_at < ? AND m.text LIKE ? ESCAPE '\\'
      AND NOT EXISTS (SELECT 1 FROM bot_replies b WHERE b.message_id = m.message_id)
      ORDER BY m.sent_at DESC LIMIT 5`)
      .bind(conversationId, questionId, anchor.sent_at, plan.from ?? 0, plan.before ?? Number.MAX_SAFE_INTEGER, keyword).all<ConversationRow>();
    semantic.unshift(...lexical.results.map((row) => ({ messageId: row.message_id, text: row.text, sentAt: row.sent_at, fileName: null, score: 1 })));
  }
  const ids = [...new Set(semantic.map((hit) => hit.messageId))];
  const allowed = ids.length ? await env.DB.prepare(`SELECT m.message_id, m.user_id FROM messages m
    WHERE m.message_id IN (${ids.map(() => "?").join(",")}) AND m.conversation_id = ? AND m.unsent_at IS NULL
    AND m.sent_at <= ? AND NOT EXISTS (SELECT 1 FROM bot_replies b WHERE b.message_id = m.message_id)`)
    .bind(...ids, conversationId, anchor.sent_at).all<{ message_id: string; user_id: string | null }>() : { results: [] };
  const authors = new Map(allowed.results.map((row) => [row.message_id, row.user_id]));
  semantic = semantic.filter((hit) => authors.has(hit.messageId));

  const used = new Set([...recent.results.map((row) => row.message_id), ...quoteIds]);
  const neighbors: AnswerEvidence[] = [];
  // Short replies such as "お鍋だよ" need the question immediately before them.
  // Expand at most three semantic anchors, within two minutes, in the same group.
  const seenAnchors = new Set<string>();
  for (const hit of semantic) {
    if (seenAnchors.has(hit.messageId)) continue;
    seenAnchors.add(hit.messageId);
    const window = await env.DB.prepare(`SELECT m.message_id, substr(m.text, 1, 1200) AS text, m.sent_at, m.user_id
      FROM messages m WHERE m.conversation_id = ? AND m.unsent_at IS NULL AND m.message_type = 'text'
      AND m.text IS NOT NULL AND m.message_id != ? AND m.sent_at BETWEEN ? AND ? AND m.sent_at <= ?
      AND NOT EXISTS (SELECT 1 FROM bot_replies b WHERE b.message_id = m.message_id)
      ORDER BY abs(m.sent_at - ?), m.sent_at LIMIT 6`)
      .bind(conversationId, questionId, hit.sentAt - 120_000, hit.sentAt + 120_000, anchor.sent_at, hit.sentAt).all<ConversationRow>();
    for (const row of window.results) {
      if (!used.has(row.message_id)) { neighbors.push(fromConversation(row, "neighbor")); used.add(row.message_id); }
    }
    if (seenAnchors.size >= 3) break;
  }

  // Allocate separate space to current dialogue and old documents, so long OCR
  // results cannot crowd out a fresh question/answer exchange. Total stays <5000 chars.
  const current = fit(recent.results.filter((row) => !quoteIds.has(row.message_id)).map((row) => fromConversation(row, "recent")),
    plan ? 1200 : quote.length ? 1800 : 2800, true);
  const context = fit(neighbors, 700, true);
  const currentIds = new Set([...quote, ...current, ...context].map((row) => row.messageId));
  const documents = fit(semantic.filter((hit) => !currentIds.has(hit.messageId))
    .map((hit) => ({ ...hit, userId: authors.get(hit.messageId) ?? null, kind: "semantic" as const })), plan ? quote.length ? 2000 : 3000 : 1400);
  return { hits: [...quote, ...current, ...context, ...documents], questionSentAt: anchor.sent_at };
}
