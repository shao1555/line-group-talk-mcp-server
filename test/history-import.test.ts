import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { parseLineHistory } from "../src/history-import";

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

describe("LINE text exports", () => {
  it("handles BOM, CRLF, quotes, tabs in content, blank lines, and duplicate same-minute messages", () => {
    const parsed = parseLineHistory('\uFEFF[LINE] 家族のトーク履歴\r\n保存日時：2026/11/01 13:15\r\n2019/8/5(月)\r\n9:01\tA\t"改行\r\n\r\n本文"\r\n9:02\tA\t同じ\t内容\r\n9:02\tA\t同じ\t内容\r\n9:03\tB\t[スタンプ]\r\n9:04\t退出しました。\r\n');
    expect(parsed.entries.map((x) => [x.text, x.occurrence])).toEqual([['改行\n\n本文', 1], ['同じ\t内容', 1], ['同じ\t内容', 2]]);
    expect(parsed.entries[0].sentAt).toBe(Date.parse('2019-08-05T09:01:00+09:00'));
    expect(parsed.skipped).toBe(2);
  });
  it("preserves date and message-looking lines inside quoted multiline text", () => {
    const parsed = parseLineHistory('[LINE] 家族のトーク履歴\n2020/01/01(水)\n10:00\tA\t"本文\n2021/02/01(月)\n11:00\tB\tこれは引用内"\n\n2020/01/02(木)\n10:01\tA\t次の発言');
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].text).toBe('本文\n2021/02/01(月)\n11:00\tB\tこれは引用内');
    expect(parsed.entries[1].sentAt).toBe(Date.parse('2020-01-02T10:01:00+09:00'));
  });
  it("rejects invalid dates, times, empty exports, and unsupported formats", () => {
    for (const text of ['garbage', '[LINE] 家族のトーク履歴\n2020/02/30(日)\n10:00\tA\t本文', '[LINE] 家族のトーク履歴\n2020/02/20(木)\n24:00\tA\t本文', '[LINE] 家族のトーク履歴']) expect(() => parseLineHistory(text)).toThrow();
  });
});
