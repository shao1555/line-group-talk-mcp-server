
export const DIRECT_LIMIT = 500_000; // micro-USD, rolling 24 hours
export const DIRECT_WARNING = 400_000;
export const DAY_MS = 24 * 3600_000;
export class UserBudgetExceeded extends Error {
  constructor() { super("user_budget_exceeded"); this.name = "UserBudgetExceeded"; }
}
export async function directUsage(userId: string, env: Env): Promise<number> {
  return await env.DB.prepare("SELECT COALESCE(sum(charged_microusd), 0) AS cost FROM ai_usage WHERE owner_user_id = ? AND created_at > ?")
    .bind(userId, Date.now() - DAY_MS).first<number>("cost") ?? 0;
}
export function isUsageQuestion(text: string): boolean {
  const normalized = text.trim().replace(/[\s。！!]/g, "");
  if (/^(?:いま|今|現在)?(?:どのくらい|どれくらい|いくら)(?:使った|使ってる|使っていますか|使ったの|使ったか)(?:[？?])?$/.test(normalized)) return true;
  return /^(?:今の|現在の|私の|自分の|直近24時間の)?(?:利用状況|使用状況|利用料金|使用料金|利用量|利用率|使用率|残り予算|usage)(?:は|は[？?]|[？?]|を教えて|を教えてください|を見せて)?$/i.test(normalized);
}
export async function usageAnswer(userId: string, env: Env): Promise<string> {
  const cost = await directUsage(userId, env);
  const money = (n: number) => (n / 1_000_000).toFixed(4);
  return `直近24時間の利用料金（見積り）: $${money(cost)} / $0.5000\n残り: $${money(Math.max(0, DIRECT_LIMIT - cost))}\n${cost >= DIRECT_LIMIT ? "上限に達したため、通常の質問への回答を停止しています。" : cost >= DIRECT_WARNING ? "直近24時間の利用量の80%に達しました。" : "ユーザー別の上限には達していません。"}\n24時間を過ぎた利用分から順に集計対象外になります。処理中・失敗時の予約額も含みます。`;
}
