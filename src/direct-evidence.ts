export type DirectEvidence = { messageId: string; text: string; conversationName: string; sent_at_jst?: string; [key: string]: unknown };
type Candidate = { row: DirectEvidence; kind: "hit" | "neighbor"; group: string };
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function fit(rows: DirectEvidence[], budget: number): DirectEvidence[] {
  const result: DirectEvidence[] = [];
  const quota = Math.min(1500, Math.floor(budget / Math.max(1, rows.length)));
  for (const row of rows) {
    let text = row.text;
    const available = Math.min(quota, budget - size(result) - 2);
    const overhead = size({ ...row, text: "" }) + 24;
    if (available - overhead < 60) continue;
    let bytes = 0, clipped = "";
    for (const char of text) {
      bytes += new TextEncoder().encode(char).byteLength;
      if (bytes > available - overhead) break;
      clipped += char;
    }
    if (clipped.length < text.length) text = clipped + " [一部省略]";
    const item = { ...row, text };
    if (size([...result, item]) <= budget) result.push(item);
  }
  return result;
}
function roundRobin(candidates: Candidate[]): DirectEvidence[] {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.group) ?? []; group.push(candidate); groups.set(candidate.group, group);
  }
  const rows: DirectEvidence[] = [];
  for (let i = 0; rows.length < candidates.length; i++) for (const group of groups.values()) if (group[i]) rows.push(group[i].row);
  return rows;
}
export function preferredEvidenceYears(question: string, questionAt: number): number[] {
  const year = new Date(questionAt + 9 * 3600_000).getUTCFullYear();
  const offsets: Record<string, number> = { 今年: 0, 本年: 0, 去年: -1, 昨年: -1, 来年: 1, 一昨年: -2, 再来年: 2 };
  const years = new Set<number>();
  for (const match of question.normalize('NFKC').matchAll(/一昨年|再来年|今年|本年|去年|昨年|来年|(\d{4})年/g)) {
    years.add(match[1] ? Number(match[1]) : year + offsets[match[0]]);
  }
  return [...years];
}
export class DirectEvidencePool {
  constructor(private years: number[] = []) {}
  private candidates = new Map<string, Candidate>();
  add(row: DirectEvidence, kind: Candidate["kind"], group: string) {
    const previous = this.candidates.get(row.messageId);
    if (!previous && this.candidates.size >= 160) {
      const removable = [...this.candidates].find(([, candidate]) => candidate.kind === 'neighbor');
      if (kind === 'neighbor' || !removable) return;
      this.candidates.delete(removable[0]);
    }
    if (!previous || kind === "hit") this.candidates.set(row.messageId, { row, kind, group });
  }
  select(maxIds = 70, budget = 12_000): DirectEvidence[] {
    const candidates = [...this.candidates.values()];
    const matchesYear = (c: Candidate) => this.years.some((year) => c.row.sent_at_jst?.startsWith(String(year))
      || (Array.isArray(c.row.mentioned_dates) && c.row.mentioned_dates.some((d: { date?: string }) => d.date?.startsWith(String(year)))));
    const order = (rows: Candidate[]) => this.years.length
      ? [...roundRobin(rows.filter(matchesYear)), ...roundRobin(rows.filter((c) => !matchesYear(c)))] : roundRobin(rows);
    const hits = order(candidates.filter((c) => c.kind === "hit")).slice(0, Math.min(12, maxIds));
    // Reserve room for context; raw hits must not consume all of it.
    const primary = fit(hits, Math.floor(budget * 0.55));
    const neighbors = candidates.filter((c) => c.kind === "neighbor");
    // Prefer substantive context over acknowledgements or bare URLs, within each window.
    neighbors.sort((a, b) => Number(b.row.text.replace(/https?:\/\/\S+/g, "").trim().length >= 20)
      - Number(a.row.text.replace(/https?:\/\/\S+/g, "").trim().length >= 20));
    const context = fit(order(neighbors).slice(0, Math.min(12, maxIds - primary.length)), budget - size(primary) - 2);
    return [...primary, ...context].sort((a, b) => a.conversationName.localeCompare(b.conversationName)
      || String(a.sent_at_jst).localeCompare(String(b.sent_at_jst)));
  }
}
