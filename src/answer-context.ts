import { BudgetExceeded } from "./ai";
import { searchKnowledge, type SearchHit } from "./search";
import type { HistoryPlan } from "./history-plan";

type ContextKind = "recent" | "neighbor" | "semantic" | "quoted";
export type AnswerEvidence = SearchHit & { kind: ContextKind; userId: string | null };
type ConversationRow = { message_id: string; text: string; sent_at: number; user_id: string | null };

export function japaneseTime(timestamp: number): string {
  return `${new Date(timestamp + 9 * 60 * 60_000).toISOString().slice(0, 19).replace("T", " ")} JST`;
}

export const TEMPORAL_INSTRUCTIONS = `回答時点はcurrent_time（日本時間）です。mentioned_datesはサーバー側で西暦に正規化した本文の日付です。relative_to_current_time=pastはすでに過去の日付なので、開催日の値がpastなら未来の開催案内として答えないでください。日付の意味が誕生日・引用・登録日などの場合は開催日と混同しません。「今年・去年・来年・今日」はquestion_sent_atを基準に解釈してください。発言日時・資料の登録日時・本文中の開催日を区別し、和暦と全角数字を西暦に直して開催日と現在日時を比較してください（令和n年は2018+n年）。
現在より前のイベントに「開催される予定です」「参加費は〜です」のような未来・現在の案内をそのまま使わず、当時の記録として過去形で説明してください。実施の裏付けがあれば「開催されました」、開催前の告知・予定しかなければ「開催予定でした」「〜として案内されていました」と答えます。予定日が過ぎただけで実施済みと断定しません。中止・延期・変更の記録があれば優先し、未来のイベントだけ未来形で案内します。`;

export function answerClock(questionSentAt: number, now = Date.now()) {
  return { current_time: japaneseTime(now), question_sent_at: japaneseTime(questionSentAt), timezone: 'Asia/Tokyo' };
}

export function evidenceDates(text: string | null, sentAt: number, now = Date.now()) {
  const today = japaneseTime(now).slice(0, 10);
  const dates = new Set<string>();
  const normalized = (text ?? '').normalize('NFKC');
  const pattern = /(?:(令和|平成|昭和)(元|\d{1,2})|(\d{4}))年\s*(\d{1,2})月\s*(\d{1,2})日|(\d{4})[/-](\d{1,2})[/-](\d{1,2})/g;
  for (const match of normalized.matchAll(pattern)) {
    const year = match[1] ? ({ 令和: 2018, 平成: 1988, 昭和: 1925 }[match[1]]! + (match[2] === '元' ? 1 : Number(match[2]))) : Number(match[3] ?? match[6]);
    const month = Number(match[4] ?? match[7]), day = Number(match[5] ?? match[8]);
    if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) continue;
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== date) continue;
    dates.add(date); if (dates.size >= 8) break;
  }
  return { sent_at_jst: japaneseTime(sentAt), mentioned_dates: [...dates].map((date) => ({ date,
    relative_to_current_time: date < today ? 'past' : date > today ? 'future' : 'today',
  })) };
}

function render(hit: AnswerEvidence, index: number): string {
  const dates = evidenceDates(hit.text, hit.sentAt).mentioned_dates;
  const calendar = dates.length ? '\n本文の明記日付（発言日とは別）: ' + dates.map((d) => `${d.date}（${d.relative_to_current_time === 'past' ? '回答時点より過去' : d.relative_to_current_time === 'future' ? '回答時点より未来' : '回答当日'}）`).join('、') : '';
  const kind = { recent: "直近の会話", neighbor: "検索された発言の前後", semantic: "検索された過去の資料", quoted: "今回の質問が引用した発言" }[hit.kind];
  if (hit.document_id) return `[${index + 1}] アップロード資料「${hit.document_title ?? hit.fileName ?? "資料"}」 資料ID:${hit.messageId} 登録日時:${japaneseTime(hit.sentAt)}${calendar}\n${hit.text}`;
  return `[${index + 1}] ${kind} 発言ID:${hit.messageId} 日時:${japaneseTime(hit.sentAt)} 送信者:${hit.userId ?? "不明"}${calendar}\n${hit.text}`;
}

export function formatAnswerEvidence(hits: AnswerEvidence[]): string {
  return hits.map(render).join("\n\n");
}

function fit(rows: AnswerEvidence[], budget: number, chronological = false): AnswerEvidence[] {
  const selected: AnswerEvidence[] = [];
  let remaining = budget;
  for (const row of rows) {
    // Preserve a bounded amount of each utterance, reserving space for attribution.
    const allowance = Math.min(1000, remaining - (render(row, 99).length - row.text.length) - 2);
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
  const anchor = await env.DB.prepare("SELECT sent_at FROM available_messages WHERE message_id = ? AND conversation_id = ? AND unsent_at IS NULL")
    .bind(questionId, conversationId).first<{ sent_at: number }>();
  if (!anchor) return { hits: [], questionSentAt: Date.now() };

  // Explicit quotations outrank recency and semantic similarity, including old messages.
  const quoted = await env.DB.prepare(`SELECT p.message_id, substr(COALESCE(p.text,
      CASE WHEN j.status = 'ready' THEN j.extracted_text END), 1, 1200) AS text, p.sent_at, COALESCE(p.user_id, '書き出し表示名: ' || p.sender_name) AS user_id
    FROM available_messages q JOIN available_messages p ON p.message_id = q.quoted_message_id
    LEFT JOIN knowledge_jobs j ON j.message_id = p.message_id
    WHERE q.message_id = ? AND q.conversation_id = ? AND p.conversation_id = ?
    AND q.unsent_at IS NULL AND p.unsent_at IS NULL AND p.sender_role = 'user' AND p.sent_at <= ? AND p.message_id != q.message_id`)
    .bind(questionId, conversationId, conversationId, anchor.sent_at).first<ConversationRow>();
  const quote = quoted?.text ? fit([fromConversation(quoted, "quoted")], 1000) : [];
  const quoteIds = new Set(quote.map((hit) => hit.messageId));

  // Recent raw utterances must not depend on asynchronous embedding/index visibility.
  // Exclude bot-directed questions from evidence; they are requests, not known facts.
  const recent = await env.DB.prepare(`SELECT m.message_id, substr(m.text, 1, 1200) AS text, m.sent_at, COALESCE(m.user_id, '書き出し表示名: ' || m.sender_name) AS user_id
    FROM available_messages m WHERE m.conversation_id = ? AND m.unsent_at IS NULL AND m.sender_role = 'user' AND m.message_type = 'text'
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
    const lexical = await env.DB.prepare(`SELECT m.message_id, substr(m.text, 1, 1200) AS text, m.sent_at, COALESCE(m.user_id, '書き出し表示名: ' || m.sender_name) AS user_id
      FROM available_messages m WHERE m.conversation_id = ? AND m.unsent_at IS NULL AND m.sender_role = 'user' AND m.message_id != ?
      AND m.sent_at <= ? AND m.sent_at >= ? AND m.sent_at < ? AND m.text LIKE ? ESCAPE '\\'
      AND NOT EXISTS (SELECT 1 FROM bot_replies b WHERE b.message_id = m.message_id)
      ORDER BY m.sent_at DESC LIMIT 5`)
      .bind(conversationId, questionId, anchor.sent_at, plan.from ?? 0, plan.before ?? Number.MAX_SAFE_INTEGER, keyword).all<ConversationRow>();
    semantic.unshift(...lexical.results.map((row) => ({ messageId: row.message_id, text: row.text, sentAt: row.sent_at, fileName: null, score: 1 })));
  }
  const ids = [...new Set(semantic.map((hit) => hit.messageId))];
  const allowed = ids.length ? await env.DB.prepare(`SELECT m.message_id, COALESCE(m.user_id, '書き出し表示名: ' || m.sender_name) AS user_id FROM available_messages m
    WHERE m.message_id IN (${ids.map(() => "?").join(",")}) AND m.conversation_id = ? AND m.unsent_at IS NULL AND m.sender_role = 'user'
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
    if (hit.document_id || seenAnchors.has(hit.messageId)) continue;
    seenAnchors.add(hit.messageId);
    const window = await env.DB.prepare(`SELECT m.message_id, substr(m.text, 1, 1200) AS text, m.sent_at, COALESCE(m.user_id, '書き出し表示名: ' || m.sender_name) AS user_id
      FROM available_messages m WHERE m.conversation_id = ? AND m.unsent_at IS NULL AND m.sender_role = 'user' AND m.message_type = 'text'
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
