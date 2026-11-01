export function documentUrl(id: string, conversationId: string, env: Env): string {
  return `${new URL(env.PORTAL_ORIGIN).origin}/knowledge/${id}?conversationId=${encodeURIComponent(conversationId)}`;
}
export async function evidenceDocumentLinks(ids: string[], env: Env): Promise<string> {
  if (!ids.length) return "";
  const rows = await env.DB.prepare(`SELECT DISTINCT d.id, d.title, m.conversation_id FROM available_messages m
    JOIN knowledge_documents d ON d.id = m.knowledge_document_id WHERE m.message_id IN (SELECT value FROM json_each(?)) LIMIT 10`)
    .bind(JSON.stringify(ids)).all<{ id: string; title: string; conversation_id: string }>();
  const unique = new Map(rows.results.map((row) => [row.id, row]));
  const links = [...unique.values()].slice(0, 5).map((row) => `・${row.title.slice(0, 70)}\n${documentUrl(row.id, row.conversation_id, env)}`);
  return links.length ? `\n\n資料の全文（LINEログイン）\n${links.join("\n")}` : "";
}
