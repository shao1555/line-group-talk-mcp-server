import { readFile } from "node:fs/promises";
const credentials = JSON.parse(await readFile("data/search-client.json", "utf8"));
const query = process.argv[2];
const conversationId = process.argv[3] ?? credentials.conversationIds[0];
if (!query) throw new Error("Usage: node scripts/search.mjs <query> [conversationId]");
const response = await fetch(`${credentials.endpoint}/search`, {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials.token}` },
  body: JSON.stringify({ query, conversationId }), signal: AbortSignal.timeout(20_000),
});
if (!response.ok) throw new Error(`Search failed: ${response.status}`);
console.log(JSON.stringify(await response.json(), null, 2));
