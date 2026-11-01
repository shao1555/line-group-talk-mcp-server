import { z } from "zod";
import { reserveAI, settleAIUsage } from "./ai";
import { directUsage, DIRECT_LIMIT, UserBudgetExceeded, isUsageQuestion } from "./direct-usage";
import { accessibleConversations, verifyConversationAccess } from "./conversations";
import { recentMessages, messageContext } from "./knowledge-tools";
import { searchKnowledge } from "./search";
import { answerClock, evidenceDates } from "./answer-context";
import { DIRECT_MODELS, DEFAULT_DIRECT_MODEL, directCost, directReservation, decodeDirectDecision, type DirectModelName } from "./direct-model";
import { directRequest } from "./direct-protocol";
import { DirectEvidencePool, preferredEvidenceYears } from "./direct-evidence";

const args = z.object({
  conversationId: z.string().min(1).max(64), query: z.string().min(1).max(2000).optional(),
  date_basis: z.literal("message_time").optional(),
  messageId: z.string().min(1).max(160).optional(),
  limit: z.number().int().min(1).max(20).optional(), from: z.number().int().nonnegative().optional(), before: z.number().int().nonnegative().optional(),
}).strict();


export async function directEvidenceAvailable(ids: string[], userId: string, env: Env, signal?: AbortSignal): Promise<boolean> {
  const unique = [...new Set(ids)];
  if (!unique.length) return true;
  if (unique.length > 80) return false;
  const rows = await env.DB.prepare(`SELECT message_id, conversation_id FROM available_messages
    WHERE message_id IN (${unique.map(() => "?").join(",")}) AND unsent_at IS NULL`).bind(...unique)
    .all<{ message_id: string; conversation_id: string }>();
  if (rows.results.length !== unique.length) return false;
  const conversations = [...new Set(rows.results.map((r) => r.conversation_id))].filter((id) => id !== userId);
  try { for (const id of conversations) if (!await verifyConversationAccess(userId, id, env, false, signal)) return false; }
  catch { return false; }
  return true;
}

export async function generateDirectAnswer(question: string, userId: string, messageId: string, env: Env, deadline: number, modelName: DirectModelName = DEFAULT_DIRECT_MODEL) {
  const model = DIRECT_MODELS[modelName];
  const billedEnv = { ...env, AI_BILLING_USER_ID: userId };
  if (await directUsage(userId, env) >= DIRECT_LIMIT) throw new UserBudgetExceeded();
  const access = await accessibleConversations(userId, env, false);
  if (access.incomplete) throw new Error("Membership verification unavailable");
  const allowed = new Map(access.conversations.map((c) => [c.id, c]));
  const usedIds = new Set<string>();
  const history: { role: string; text: string }[] = [];
  const seenDialogue = new Set<string>();
  const userHistoryIds = new Set<string>();
  const previous = await recentMessages(userId, 7, env);
  for (const row of previous) {
    if (row.message_id === messageId || !row.text || (row.sender_role === "user" && isUsageQuestion(row.text))) continue;
    const key = row.sender_role + ":" + row.text;
    if (seenDialogue.has(key)) continue;
    seenDialogue.add(key);
    if (row.sender_role === "bot") {
      const reply = await env.DB.prepare("SELECT b.evidence_ids, q.text AS question FROM bot_replies b JOIN messages q USING(message_id) WHERE b.message_id = ? AND b.status = 'sent' AND b.text IS NOT NULL")
        .bind(row.reply_to_message_id).first<{ evidence_ids: string | null; question: string | null }>();
      if (!reply || (reply.question && isUsageQuestion(reply.question))) continue;
      const refs: string[] = reply.evidence_ids ? JSON.parse(reply.evidence_ids) : [];
      if (refs.length > 16 || new Set([...usedIds, ...refs, row.message_id]).size > 40 || !await directEvidenceAvailable(refs, userId, env)) continue;
      for (const id of refs) usedIds.add(id);
    }
    if (usedIds.size >= 40) continue;
    if (row.sender_role === "user") userHistoryIds.add(row.message_id);
    history.push({ role: row.sender_role, text: row.text.slice(0, 500) }); usedIds.add(row.message_id);
  }
  const anchor = await env.DB.prepare("SELECT sent_at FROM messages WHERE message_id = ? AND conversation_id = ? AND unsent_at IS NULL")
    .bind(messageId, userId).first<number>("sent_at");
  if (anchor === null) throw new Error("Question unavailable");
  const toolResults: { name: string; conversationName?: string; data: unknown }[] = [];
  const pool = new DirectEvidencePool(preferredEvidenceYears(question, anchor));
  const questionSearched = new Set<string>();
  function addRows(rows: { messageId: string; text?: unknown; [key: string]: unknown }[], conversationName: string, kind: 'hit' | 'neighbor', group: string) {
    for (const row of rows) pool.add({ ...row, text: String(row.text ?? ''), conversationName }, kind, group);
    return rows.map((row) => row.messageId);
  }
  async function searchWithContext(query: string, conversationId: string, range: Parameters<typeof searchKnowledge>[5] = {}) {
    const queries = !questionSearched.has(conversationId) && query !== question ? [question, query] : [query];
    questionSearched.add(conversationId);
    const sets = await Promise.all(queries.map((q) => searchKnowledge(q, conversationId, billedEnv, undefined, 5,
      q === question ? { ...range, from: undefined, before: undefined } : range)));
    const hits = [...new Map(sets.flat().map((hit) => [hit.messageId, hit])).values()];
    const name = allowed.get(conversationId)!.name;
    const rows = hits.map((hit) => {
      const prefix = hit.sender_name ? '書き出し履歴・表示名: ' + hit.sender_name + '\n' : '';
      const text = prefix && hit.text.startsWith(prefix) ? hit.text.slice(prefix.length) : hit.text;
      return { messageId: hit.messageId, text: text.slice(0, 700), ...evidenceDates(text, hit.sentAt),
      sender_role: hit.sender_role, ...(hit.sender_name ? { sender_name: hit.sender_name } : {}),
      ...(hit.document_id ? { document_id: hit.document_id, document_title: hit.document_title, sourceUrl: hit.sourceUrl } : {}),
    }; });
    const ids = addRows(rows, name, 'hit', conversationId);
    const contexts = await Promise.all(hits.map((hit) => hit.document_id ? Promise.resolve([]) : messageContext(conversationId, hit.messageId, 12, env)));
    for (let i = 0; i < contexts.length; i++) addRows(contexts[i].map((row) => ({ messageId: row.message_id,
      text: row.text?.slice(0, 700), sender_role: row.sender_role, ...evidenceDates(row.text, row.sent_at), retrieval: 'neighbor',
    })), name, 'neighbor', conversationId + ':' + hits[i].messageId);
    return ids;
  }
  const initialRecent: { conversationId: string; conversationName: string; messages: unknown[] }[] = [];
  let initialBytes = 0;
  for (const conversation of access.conversations.slice(0, 5)) {
    const messages: unknown[] = [];
    // Read newest first when fitting the budget, then restore chronological order.
    const recent = await recentMessages(conversation.id, 6, env);
    const share = Math.floor(8000 / Math.min(access.conversations.length, 5));
    let conversationBytes = 0;
    for (const row of [...recent].reverse()) {
      const item = { ...row, ...evidenceDates(row.text, row.sent_at), text: row.text?.slice(0, 500) };
      const size = new TextEncoder().encode(JSON.stringify(item)).byteLength;
      if (usedIds.size >= 70 || initialBytes + size > 8000 || conversationBytes + size > share) break;
      usedIds.add(row.message_id); messages.unshift(item); initialBytes += size; conversationBytes += size;
    }
    initialRecent.push({ conversationId: conversation.id, conversationName: conversation.name, messages });
  }
  console.info(JSON.stringify({ event: "direct_context", messageId, accessibleConversations: access.conversations.length,
    recentConversations: initialRecent.length, recentMessages: initialRecent.reduce((n, c) => n + c.messages.length, 0) }));
  let calls = 0;
  let searched = false;
  let finishAfterSearch = false;
  for (let round = 0; round < 3; round++) {
    const final = round === 2 || calls >= 4 || finishAfterSearch || (searched && deadline - Date.now() < 20_000);
    const timeout = Math.min(25_000, deadline - Date.now() - 5000);
    if (timeout < 1000) throw new Error("Direct answer deadline reached");
    const evidence = pool.select(80 - (searched ? userHistoryIds.size : usedIds.size));
    const content = JSON.stringify({ question, ...answerClock(anchor),
      conversations: access.conversations.map(({ id, name }) => ({ id, name: name.slice(0, 40) })),
      initial_recent_messages: searched || evidence.length ? [] : initialRecent, untrusted_dialogue: searched ? history.filter((row) => row.role !== "bot") : history,
      untrusted_tool_results: toolResults, untrusted_evidence: evidence });
    if (new TextEncoder().encode(content).byteLength > 26_000) throw new Error("Direct context too large");
    const request = directRequest(model, content, final);
    const reservation = await reserveAI("answer", model.id, 1, directReservation(model, request.messages), billedEnv);
    const started = Date.now();
    const response = await env.AI.run(model.id, request, { signal: AbortSignal.timeout(timeout) });
    if (response && typeof response === 'object' && 'usage' in response) {
      const cost = directCost(model, response.usage);
      if (cost !== null) await settleAIUsage(reservation, cost, env);
    }
    const decision = decodeDirectDecision(response, final);
    console.info(JSON.stringify({ event: 'direct_inference', messageId, model: model.id, final, durationMs: Date.now() - started,
      evidenceCount: evidence.length, toolCalls: calls, answerChars: decision.action === 'answer' ? decision.answer.length : 0, answerParts: decision.action === 'answer' ? decision.partsCount : 0 }));
    console.info(JSON.stringify({ event: "direct_decision", messageId, round: round + 1, action: decision.action }));
    if (decision.action === "answer") {
      if (!searched && allowed.size && (decision.basis === 'history_records' || decision.basis === 'not_found')) {
        if (final) throw new Error('Direct historical answer without search');
        // Enforce retrieval even if the planner prematurely answers from its old dialogue.
        for (const conversation of access.conversations.slice(0, 3)) {
          if (calls >= 4) break;
          calls++;
          if (!await verifyConversationAccess(userId, conversation.id, env, false)) throw new Error("Membership changed");
          const ids = await searchWithContext(question, conversation.id, { includeBot: false, timeoutMs: 5000 });
          searched = true;
          toolResults.push({ name: 'search_knowledge', conversationName: conversation.name, data: { messageIds: ids } });
          console.info(JSON.stringify({ event: 'direct_tool', messageId, tool: 'search_knowledge', conversationId: conversation.id, results: ids.length, forced: true }));
        }
        if (!searched) throw new Error("Direct search tool budget exhausted");
        finishAfterSearch = true;
        continue;
      }
      if (!decision.complete) {
        finishAfterSearch = true;
        continue;
      }
      return { answer: decision.answer, evidenceIds: [...new Set([...(searched ? userHistoryIds : usedIds), ...evidence.map((row) => row.messageId)])] };
    }
    for (const call of decision.calls.slice(0, 4 - calls)) {
      calls++;
      if (call.name === "list_conversations") {
        if (!z.object({}).strict().safeParse(call.arguments).success) {
          toolResults.push({ name: call.name, data: { error: 'このツールに引数は不要です。' } }); continue;
        }
        toolResults.push({ name: call.name, data: access.conversations.map(({ id, name }) => ({ id, name: name.slice(0, 40) })) }); continue;
      }
      const parsed = args.safeParse(call.arguments);
      if (!parsed.success) { toolResults.push({ name: call.name, data: { error: 'ツールの引数が不正です。定義済みの項目と型を使ってください。' } }); continue; }
      const input = parsed.data;
      const conversation = allowed.get(input.conversationId);
      if (!conversation) { toolResults.push({ name: call.name, data: { error: "このトークへのアクセス権はありません。一覧から選んでください。" } }); continue; }
      if (!await verifyConversationAccess(userId, input.conversationId, env, false)) throw new Error("Membership changed");
      let ids: string[] = [];
      let rows: { messageId: string; [key: string]: unknown }[] = [];
      if (call.name === "get_recent_messages") {
        rows = (await recentMessages(input.conversationId, input.limit ?? 10, env)).map((m) => ({ ...m, messageId: m.message_id, ...evidenceDates(m.text, m.sent_at), text: m.text?.slice(0, 700) }));
      } else if (call.name === 'get_message_context') {
        if (!input.messageId) { toolResults.push({ name: call.name, data: { error: '前後確認には検索結果のmessageIdが必要です。' } }); continue; }
        rows = (await messageContext(input.conversationId, input.messageId, input.limit ?? 10, env)).map((m) => ({
          ...m, messageId: String(m.message_id), ...evidenceDates(m.text, m.sent_at), text: String(m.text ?? '').slice(0, 700),
        }));
      } else {
        searched = true;
        if (!input.query) { toolResults.push({ name: call.name, data: { error: '検索語queryが必要です。' } }); continue; }
        const validRange = input.date_basis === "message_time" && (input.from === undefined || input.before === undefined || input.from < input.before);
        // Malformed model-generated dates must not turn a valid user question into an error.
        ids = await searchWithContext(input.query, input.conversationId,
          { from: validRange ? input.from : undefined, before: validRange ? input.before : undefined, includeBot: true, fallbackToAllTime: true, timeoutMs: 5000 });
      }
      ids = rows.length ? addRows(rows, conversation.name, 'hit', conversation.id) : ids;
      console.info(JSON.stringify({ event: "direct_tool", messageId, tool: call.name, conversationId: conversation.id, results: ids?.length ?? 0 }));
      toolResults.push({ name: call.name, conversationName: conversation.name, data: { messageIds: ids, ...(input.query ? { query: input.query, date_basis: input.date_basis, from: input.from, before: input.before } : {}) } });
    }
  }
  throw new Error("Direct round limit");
}
