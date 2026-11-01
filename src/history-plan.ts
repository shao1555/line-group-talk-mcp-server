export type HistoryPlan = { query: string; keyword?: string; from?: number; before?: number };

function dateBoundary(value: unknown): number | undefined {
  if (value === undefined || value === "" || value === null) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Invalid date");
  const time = Date.parse(`${value}T00:00:00+09:00`);
  if (!Number.isFinite(time) || new Date(time + 9 * 3600_000).toISOString().slice(0, 10) !== value) throw new Error("Invalid date");
  return time;
}

export function parseHistoryPlan(value: unknown): HistoryPlan {
  if (typeof value === "string") value = JSON.parse(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid history search");
  const plan = value as Record<string, unknown>;
  // The model never controls a conversation ID, SQL, or arbitrary filters.
  if (Object.keys(plan).some((key) => !["query", "keyword", "from_date", "before_date"].includes(key))) throw new Error("Unsupported search option");
  if (typeof plan.query !== "string" || !plan.query.trim() || plan.query.length > 1000) throw new Error("Invalid query");
  if (plan.keyword !== undefined && (typeof plan.keyword !== "string" || plan.keyword.length > 80)) throw new Error("Invalid keyword");
  const from = dateBoundary(plan.from_date);
  const before = dateBoundary(plan.before_date);
  if (from !== undefined && before !== undefined && from >= before) throw new Error("Invalid date range");
  return { query: plan.query.trim(), keyword: typeof plan.keyword === "string" ? plan.keyword.trim() : undefined, from, before };
}
