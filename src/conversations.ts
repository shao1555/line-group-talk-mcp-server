export type ConversationEvent = {
  type: string; timestamp: number;
  source: { type: string; groupId?: string; roomId?: string; userId?: string };
  joined?: { members?: { userId?: string }[] };
  left?: { members?: { userId?: string }[] };
};

export async function recordConversation(event: ConversationEvent, env: Env): Promise<void> {
  const { source } = event;
  if (source.type !== "group" && source.type !== "room") return;
  const id = source.type === "group" ? source.groupId : source.roomId;
  if (!id || !["message", "join", "leave", "memberJoined", "memberLeft"].includes(event.type)) return;
  const statements = [env.DB.prepare(`INSERT INTO conversations(conversation_id, source_type, bot_active, last_event_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET
    bot_active = excluded.bot_active, last_event_at = excluded.last_event_at
    WHERE excluded.last_event_at >= conversations.last_event_at`)
    .bind(id, source.type, event.type === "leave" ? 0 : 1, event.timestamp)];
  const members = event.type === "memberLeft" ? event.left?.members : event.type === "memberJoined" ? event.joined?.members
    : event.type === "message" && source.userId ? [{ userId: source.userId }] : [];
  for (const member of members ?? []) {
    if (!member.userId) continue;
    statements.push(env.DB.prepare(`INSERT INTO conversation_members(conversation_id, user_id, status, last_event_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id, user_id) DO UPDATE SET
      status = excluded.status, last_event_at = excluded.last_event_at, verified_at = NULL
      WHERE excluded.last_event_at >= conversation_members.last_event_at`)
      .bind(id, member.userId, event.type === "memberLeft" ? "left" : "observed", event.timestamp));
  }
  await env.DB.batch(statements);
}

export class MembershipUnavailable extends Error {}
export type AccessibleConversation = { id: string; name: string; type: string; messageCount: number; firstMessageAt: string | null; lastMessageAt: string | null };

export async function verifyConversationAccess(userId: string, conversationId: string, env: Env, includeStats = true, signal?: AbortSignal): Promise<AccessibleConversation | null> {
  const candidate = await env.DB.prepare(`SELECT c.source_type, c.last_event_at, cm.status,
    ${includeStats ? `(SELECT count(*) FROM messages m WHERE m.conversation_id = c.conversation_id AND m.unsent_at IS NULL AND m.knowledge_document_id IS NULL)` : '0'} AS message_count,
    ${includeStats ? `(SELECT min(sent_at) FROM messages m WHERE m.conversation_id = c.conversation_id AND m.unsent_at IS NULL AND m.knowledge_document_id IS NULL)` : 'NULL'} AS first_at,
    ${includeStats ? `(SELECT max(sent_at) FROM messages m WHERE m.conversation_id = c.conversation_id AND m.unsent_at IS NULL AND m.knowledge_document_id IS NULL)` : 'NULL'} AS last_at
    FROM conversations c LEFT JOIN conversation_members cm ON cm.conversation_id = c.conversation_id AND cm.user_id = ?
    WHERE c.conversation_id = ? AND c.bot_active = 1`)
    .bind(userId, conversationId).first<{ source_type: string; last_event_at: number; status: string | null; message_count: number; first_at: number | null; last_at: number | null }>();
  if (!candidate || candidate.status === "left" || !["group", "room"].includes(candidate.source_type)) return null;
  const root = `https://api.line.me/v2/bot/${candidate.source_type}/${encodeURIComponent(conversationId)}`;
  const options = { headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` }, signal: signal ?? AbortSignal.timeout(5000) };
  try {
    const member = await fetch(`${root}/member/${encodeURIComponent(userId)}`, options);
    if (member.status === 404) { await member.body?.cancel(); return null; }
    if (!member.ok) { await member.body?.cancel(); throw new MembershipUnavailable(); }
    const profile = await member.json() as { userId?: unknown };
    if (profile.userId !== userId) throw new MembershipUnavailable();
    let name = "複数人トーク";
    if (candidate.source_type === "group") {
      const summary = await fetch(`${root}/summary`, { ...options, signal: signal ?? AbortSignal.timeout(5000) });
      if (summary.status === 404) { await summary.body?.cancel(); return null; }
      if (!summary.ok) { await summary.body?.cancel(); throw new MembershipUnavailable(); }
      const data = await summary.json() as { groupId?: unknown; groupName?: unknown };
      if (data.groupId !== conversationId || typeof data.groupName !== "string") throw new MembershipUnavailable();
      name = data.groupName.slice(0, 200);
    }
    // Recheck lifecycle changes that may have arrived while LINE was responding.
    const active = await env.DB.prepare(`SELECT c.conversation_id FROM conversations c
      LEFT JOIN conversation_members cm ON cm.conversation_id = c.conversation_id AND cm.user_id = ?
      WHERE c.conversation_id = ? AND c.bot_active = 1 AND (cm.status IS NULL OR cm.status != 'left')`)
      .bind(userId, conversationId).first();
    if (!active) return null;
    return { id: conversationId, name, type: candidate.source_type, messageCount: candidate.message_count,
      firstMessageAt: candidate.first_at === null ? null : new Date(candidate.first_at).toISOString(),
      lastMessageAt: candidate.last_at === null ? null : new Date(candidate.last_at).toISOString() };
  } catch (error) {
    if (error instanceof MembershipUnavailable) throw error;
    throw new MembershipUnavailable();
  }
}

export async function accessibleConversations(userId: string, env: Env, includeStats = true): Promise<{ conversations: AccessibleConversation[]; incomplete: boolean }> {
  const rows = await env.DB.prepare("SELECT conversation_id FROM conversations WHERE bot_active = 1 ORDER BY last_event_at DESC LIMIT 101")
    .all<{ conversation_id: string }>();
  const conversations: AccessibleConversation[] = [];
  let incomplete = rows.results.length > 100;
  for (let offset = 0; offset < Math.min(rows.results.length, 100); offset += 5) {
    const batch = await Promise.allSettled(rows.results.slice(offset, Math.min(offset + 5, 100))
      .map((row) => verifyConversationAccess(userId, row.conversation_id, env, includeStats)));
    for (const result of batch) {
      if (result.status === "rejected") incomplete = true;
      else if (result.value) conversations.push(result.value);
    }
  }
  return { conversations, incomplete };
}
