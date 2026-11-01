import { randomBytes, createHash } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const conversationIds = args.filter((value, index) => index > 0 && args[index - 1] === "--conversation");
if (!conversationIds.length || conversationIds.some((id) => !/^[CUR][a-f0-9]{32}$/.test(id))) {
  throw new Error("Usage: node scripts/create-search-client.mjs --conversation <LINE group/user/room ID> [--conversation <ID>]");
}
const path = resolve("data/search-client.json");
try { await access(path); throw new Error(`Credentials already exist: ${path}. Move that file before issuing another token.`); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");
const ids = JSON.stringify([...new Set(conversationIds)]);
const sql = `INSERT INTO search_clients(token_hash, label, conversation_ids) VALUES ('${hash}', 'local-client', '${ids}');`;
const result = spawnSync("mise", ["exec", "--", "wrangler", "d1", "execute", "DB", "--remote", "--command", sql], { encoding: "utf8" });
if (result.status !== 0) throw new Error("Failed to register search client. Check Wrangler authentication and migrations.");
await mkdir(resolve("data"), { recursive: true });
await writeFile(path, JSON.stringify({ endpoint: "https://line-talk.example.com", token, conversationIds: JSON.parse(ids) }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(`Search credentials saved to ${path}. Keep this file private; the server stores only the token hash.`);
