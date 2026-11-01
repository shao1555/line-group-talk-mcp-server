import { sha256 } from "./ai";
import { accessibleConversations, verifyConversationAccess } from "./conversations";
import { readLimitedBody } from "./http";

export const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
type Entry = { sentAt: number; sender: string; text: string; line: number; occurrence: number };
export type ParsedHistory = { title: string; entries: Entry[]; skipped: number };

// LINE's Japanese desktop export. Preserve display names as names, never as LINE user IDs.
export function parseLineHistory(input: string): ParsedHistory {
  const lines = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const header = lines[0].match(/^\[LINE\] (.+)のトーク履歴$/);
  if (!header) throw new Error("LINE の日本語トーク書き出し（.txt）を選んでください。");
  const entries: Entry[] = [];
  let day = "", pending: Omit<Entry, "occurrence"> | undefined, skipped = 0, inQuote = false;
  const occurrences = new Map<string, number>();
  function finish() {
    if (!pending) return;
    if (inQuote) throw new Error("複数行の引用が閉じられていません。書き出しファイルを確認してください。");
    pending.text = pending.text.trimEnd();
    // LINE encloses multiline messages in double quotes in text exports.
    if (pending.text.startsWith('"') && pending.text.endsWith('"')) pending.text = pending.text.slice(1, -1).replaceAll('""', '"');
    if (!pending.text.trim() || /^\[(写真|画像|スタンプ|動画|ファイル|ボイスメッセージ)\]$/.test(pending.text)) { skipped++; pending = undefined; return; }
    if (pending.text.length > 30_000 || pending.sender.length > 200) throw new Error("長すぎる発言があります。取り込み形式を確認してください。");
    const key = JSON.stringify([pending.sentAt, pending.sender, pending.text]);
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    entries.push({ ...pending, occurrence }); pending = undefined;
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (pending && inQuote) {
      pending.text += `\n${line}`; inQuote = !line.endsWith('"'); continue;
    }
    const date = line.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[（(].*[）)])?$/);
    if (date) {
      finish(); day = `${date[1]}-${date[2].padStart(2, "0")}-${date[3].padStart(2, "0")}`;
      const t = Date.parse(`${day}T00:00:00+09:00`);
      if (!Number.isFinite(t) || new Date(t + 9 * 3600_000).toISOString().slice(0, 10) !== day) throw new Error("日付を読み取れませんでした。");
      continue;
    }
    const message = line.match(/^(\d{1,2}):(\d{2})\t([^\t]+)\t(.*)$/);
    if (message && day) {
      finish();
      const hour = Number(message[1]), minute = Number(message[2]);
      if (hour > 23 || minute > 59) throw new Error("発言時刻を読み取れませんでした。");
      pending = { sentAt: Date.parse(`${day}T${String(hour).padStart(2, "0")}:${message[2]}:00+09:00`), sender: message[3], text: message[4], line: i + 1 };
      inQuote = pending.text.startsWith('"') && (pending.text.length === 1 || !pending.text.endsWith('"'));
    } else if (/^\d{1,2}:\d{2}\t/.test(line)) {
      finish(); skipped++; // membership/call/system notices are not attributed to a person.
    } else if (pending) pending.text += `\n${line}`;
    else if (day && line.trim()) skipped++;
  }
  finish();
  if (!entries.length) throw new Error("取り込める発言がありません。");
  if (entries.length > 20_000) throw new Error("1ファイルの発言は20,000件までです。");
  return { title: header[1], entries, skipped };
}

// Read bounded, transactionally maintained counters; never rescan imported messages for the dashboard.
export async function historyImportStatus(userId: string, env: Env): Promise<Response> {
  const { conversations, incomplete } = await accessibleConversations(userId, env, false);
  if (!conversations.length) return Response.json({ imports: [], incomplete });
  const names = new Map(conversations.map((c) => [c.id, c.name]));
  const { results } = await env.DB.prepare(`WITH recent AS (
      SELECT id, conversation_id, file_name, total, cursor, created_at FROM history_imports
      WHERE conversation_id IN (${conversations.map(() => '?').join(',')}) ORDER BY created_at DESC, id DESC LIMIT 20
    ) SELECT h.*, coalesce(sum(c.count), 0) AS imported,
      coalesce(sum(CASE WHEN c.status = 'cancelled' THEN c.count END), 0) AS cancelled,
      coalesce(sum(CASE WHEN c.status = 'ready' THEN c.count END), 0) AS ready,
      coalesce(sum(CASE WHEN c.status = 'failed' THEN c.count END), 0) AS failed,
      coalesce(sum(CASE WHEN c.status = 'skipped' THEN c.count END), 0) AS skipped,
      coalesce(sum(CASE WHEN c.status = 'budget_wait' THEN c.count END), 0) AS budget_wait
    FROM recent h LEFT JOIN history_import_counts c ON c.import_id = h.id
    GROUP BY h.id ORDER BY h.created_at DESC, h.id DESC`)
    .bind(...conversations.map((c) => c.id)).all<{
      id: string; conversation_id: string; file_name: string; total: number; cursor: number; created_at: number;
      imported: number; cancelled: number; ready: number; failed: number; skipped: number; budget_wait: number;
    }>();
  return Response.json({ imports: results.map((row) => ({ ...row, conversationName: names.get(row.conversation_id),
    duplicates: row.cursor - row.imported,
    pending: row.imported - row.cancelled - row.ready - row.failed - row.skipped - row.budget_wait,
  })), incomplete });
}

type ImportRow = { id: string; conversation_id: string; owner_user_id: string; object_key: string; total: number; cursor: number };
export async function handleHistoryImport(request: Request, env: Env, userId: string): Promise<Response> {
  const url = new URL(request.url);
  const continuation = url.pathname.match(/^\/api\/imports\/([a-f0-9]{64})\/continue$/);
  if (continuation) {
    const job = await env.DB.prepare("SELECT * FROM history_imports WHERE id = ? AND owner_user_id = ?")
      .bind(continuation[1], userId).first<ImportRow>();
    if (!job) return Response.json({ error: "取り込みが見つかりません。" }, { status: 404 });
    const access = await verifyConversationAccess(userId, job.conversation_id, env, false);
    if (!access) return Response.json({ error: "取り込み先のトークに参加していません。" }, { status: 403 });
    if (job.cursor < job.total) {
      const object = await env.ATTACHMENTS.get(job.object_key);
      if (!object) throw new Error("Missing history source");
      const parsed = parseLineHistory(await object.text());
      const part = parsed.entries.slice(job.cursor, job.cursor + 100);
      const statements: D1PreparedStatement[] = [];
      for (const entry of part) {
        const id = `import-${await sha256(JSON.stringify([job.conversation_id, entry.sentAt, entry.sender, entry.text, entry.occurrence]))}`;
        // The cursor predicate makes a concurrent/retried continuation a no-op.
        statements.push(env.DB.prepare(`INSERT INTO messages(message_id, source_type, conversation_id, message_type, text, sent_at, received_at, import_id, source_line, sender_name, knowledge_registered)
          SELECT ?, ?, ?, 'text', ?, ?, ?, ?, ?, ?, 1 WHERE EXISTS (SELECT 1 FROM history_imports WHERE id = ? AND cursor = ?)
          ON CONFLICT(message_id) DO NOTHING`)
          .bind(id, access.type, job.conversation_id, entry.text, entry.sentAt, Date.now(), job.id, entry.line, entry.sender, job.id, job.cursor));
        statements.push(env.DB.prepare(`INSERT INTO knowledge_jobs(message_id) SELECT message_id FROM messages
          WHERE message_id = ? AND unsent_at IS NULL ON CONFLICT(message_id) DO NOTHING`).bind(id));
      }
      statements.push(env.DB.prepare("UPDATE history_imports SET cursor = ? WHERE id = ? AND cursor = ?")
        .bind(job.cursor + part.length, job.id, job.cursor));
      await env.DB.batch(statements);
    }
    const state = await env.DB.prepare(`SELECT cursor, total, (SELECT coalesce(sum(count), 0) FROM history_import_counts WHERE import_id = history_imports.id) AS inserted
      FROM history_imports WHERE id = ?`).bind(job.id).first<{ cursor: number; total: number; inserted: number }>();
    return Response.json({ ...state, done: state!.cursor >= state!.total });
  }
  const conversationId = url.searchParams.get("conversationId") ?? "";
  if (!/^[CR][a-f0-9]{32}$/.test(conversationId)) return Response.json({ error: "取り込み先を選んでください。" }, { status: 400 });
  if (!await verifyConversationAccess(userId, conversationId, env, false)) return Response.json({ error: "取り込み先のトークに参加していません。" }, { status: 403 });
  let bytes: Uint8Array;
  try { bytes = await readLimitedBody(request, MAX_HISTORY_BYTES); }
  catch { return Response.json({ error: "ファイルは2MBまでです。" }, { status: 413 }); }
  let parsed: ParsedHistory;
  try { parsed = parseLineHistory(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch (error) { return Response.json({ error: error instanceof TypeError ? "UTF-8 のテキストファイルを選んでください。" : (error as Error).message }, { status: 400 }); }
  const fileHash = await sha256(new TextDecoder().decode(bytes));
  const id = await sha256(JSON.stringify(["line-export-v1", conversationId, userId, fileHash]));
  const key = `history-imports/${conversationId}/${id}.txt`;
  const exists = await env.DB.prepare("SELECT id FROM history_imports WHERE id = ?").bind(id).first();
  if (!exists) {
    await env.ATTACHMENTS.put(key, bytes, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    await env.DB.prepare(`INSERT INTO history_imports(id, conversation_id, owner_user_id, file_name, file_hash, object_key, total, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .bind(id, conversationId, userId, (url.searchParams.get("fileName") ?? "LINE.txt").slice(0, 200), fileHash, key, parsed.entries.length, Date.now()).run();
  }
  const times = parsed.entries.map((e) => e.sentAt);
  return Response.json({ id, title: parsed.title, total: parsed.entries.length, skipped: parsed.skipped, from: Math.min(...times), before: Math.max(...times) });
}
