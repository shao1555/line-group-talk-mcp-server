import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { DIRECT_MODELS, directCost, decodeDirectDecision } from "../src/direct-model";
import { directRequest } from "../src/direct-protocol";
import { formatLineText } from "../src/line-text";
import { DirectEvidencePool, preferredEvidenceYears } from "../src/direct-evidence";

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

describe('LINE answer layout', () => {
  it('preserves existing paragraphs, lists, URLs, code and literal file path escapes', () => {
    const text = '案内です。\n\n・1つ目\n・2つ目\nhttps://example.com/path\n```js\nconst path = "C:\\node";\n```';
    expect(formatLineText(text)).toBe(text);
  });
  it('separates long prose and inline list items without changing the words', () => {
    const text = 'これは以前の会話で共有されたイベントに関する案内です。'.repeat(7);
    const formatted = formatLineText(text);
    expect(formatted).toContain('\n\n'); expect(formatted.replaceAll('\n','')).toBe(text);
    expect(formatLineText(formatted)).toBe(formatted);
    expect(formatLineText('案内内容です（当時の情報）・日時：10月26日・コース：公園まで・参加費：400円')).toBe('案内内容です（当時の情報）\n\n・日時：10月26日\n・コース：公園まで\n・参加費：400円');
    expect(formatLineText('概要です：・日時：10月26日・コース：公園まで・持ち物：氏名・住所のメモ')).toBe('概要です：\n\n・日時：10月26日\n・コース：公園まで\n・持ち物：氏名・住所のメモ');
    expect(formatLineText('概要です：・項目1です。・項目2です。')).toBe('概要です：\n\n・項目1です。\n\n・項目2です。');
    expect(formatLineText('内容はこちらです。・会場は公園です。・時刻は9時です。')).toBe('内容はこちらです。\n\n・会場は公園です。\n\n・時刻は9時です。');
  });
  it('keeps serialized JSON newlines as real LINE newlines after decoding', () => {
    const response = { choices: [{ message: { content: JSON.stringify({action:'answer',basis:'general',answer:['概要です。','・日時\n・場所']}) } }] };
    expect(decodeDirectDecision(response,true)).toMatchObject({answer:'概要です。\n\n・日時\n・場所'});
  });
});

describe('direct model contract', () => {
  it('uses each model price and discounts only valid cached input tokens', () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 600 },
      completion_tokens_details: { reasoning_tokens: 80 } };
    expect(directCost(DIRECT_MODELS.glm, usage)).toBe(128);
    expect(directCost(DIRECT_MODELS.qwen, usage)).toBe(85);
    expect(directCost(DIRECT_MODELS.oss, usage)).toBe(425);
    expect(directCost(DIRECT_MODELS.glm, { ...usage, prompt_tokens: -1 })).toBeNull();
    expect(directCost(DIRECT_MODELS.glm, {})).toBeNull();
    expect(directCost(DIRECT_MODELS.glm, { ...usage, prompt_tokens_details: { cached_tokens: 999999 } })).toBe(200);
  });
  it('joins every answer part and rejects a preface-only final or token-truncated completion', () => {
    const parts=['概要です。','・十勝川温泉の相談がありました。','・旭山動物園の情報が共有されました。','訪問実績までは確認できません。'];
    const response=(answer:unknown,finish_reason='stop')=>({choices:[{finish_reason,message:{content:JSON.stringify({action:'answer',basis:'history_records',answer})}}]});
    const result=decodeDirectDecision(response(parts),true);
    expect(result).toMatchObject({answer:parts.join('\n\n'),complete:true});
    expect(()=>decodeDirectDecision(response(['概要だけです。']),true)).toThrow();
    expect(()=>decodeDirectDecision(response(parts,'length'),true)).toThrow('Incomplete');
    expect(decodeDirectDecision(response('古い文字列の下書きです。'),false)).toMatchObject({complete:false});
  });
  it('configures reasoning and makes the final round an answer-only contract', () => {
    const planning = directRequest(DIRECT_MODELS.glm, '{}', false);
    expect(planning).toMatchObject({ reasoning_effort: 'low', max_completion_tokens: 4096, response_format: { type: 'json_object' } });
    expect(JSON.stringify(planning)).not.toContain('/no_think');
    const final = directRequest(DIRECT_MODELS.glm, '{}', true);
    expect(final.response_format).toMatchObject({ type: 'json_schema', json_schema: { schema: {
      properties: { action: { const: 'answer' }, answer: { type: 'array', minItems: 2 } }, required: ['action','answer','basis'], additionalProperties: false,
    } } });
    const tools = { choices: [{ message: { content: JSON.stringify({ action: 'tools', calls: [{ name: 'list_conversations', arguments: {} }] }) } }] };
    expect(decodeDirectDecision(tools,false).action).toBe('tools');
    expect(() => decodeDirectDecision(tools,true)).toThrow();
    expect(JSON.stringify(directRequest(DIRECT_MODELS.qwen,'{}',false))).toContain('/no_think');
  });
});

describe('retrieval context allocation', () => {
  it('keeps a later hit and substantive neighbors when another hit is large', () => {
    const pool = new DirectEvidencePool();
    pool.add({ messageId: 'large', text: 'とても長い資料'.repeat(2000), conversationName: '家族' }, 'hit', 'family');
    pool.add({ messageId: 'zoo', text: '動物園の安全情報', conversationName: '家族' }, 'hit', 'family');
    for (let i=0;i<40;i++) pool.add({ messageId: 'ack'+i, text: '了解', conversationName: '家族' }, 'neighbor', 'zoo-window');
    pool.add({ messageId: 'spa', text: '2日目、十勝川温泉の近くにガーデンスパがあり、水着を忘れずに持っていきましょう。', conversationName: '家族' }, 'neighbor', 'zoo-window');
    const result=pool.select();
    expect(result.map((r)=>r.messageId)).toEqual(expect.arrayContaining(['large','zoo','spa']));
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(12000);
    expect(result.find((r)=>r.messageId==='large')!.text).toContain('一部省略');
  });
  it('retains the original lower-ranked anchor after more queries add many hits', () => {
    const pool=new DirectEvidencePool();
    for(let i=0;i<5;i++) pool.add({messageId:'initial'+i,text:i===3?'旭山動物園のニュースです。':'別の候補の説明です。',conversationName:'家族',sent_at_jst:'2026-07-27 21:00:00 JST',mentioned_dates:[]},'hit','family');
    for(let i=0;i<30;i++) pool.add({messageId:'refine'+i,text:'追加検索で見つかった候補です。',conversationName:'テスト',sent_at_jst:'2025-01-01 00:00:00 JST',mentioned_dates:[]},'hit','test');
    expect(pool.select().find((r)=>r.messageId==='initial3')!.text).toContain('旭山動物園');
  });
  it('softly prioritizes the requested year without excluding a prior-year booking for that event', () => {
    const at=Date.parse('2026-01-01T00:30:00+09:00');
    expect(preferredEvidenceYears('今年と去年の旅行',at)).toEqual([2026,2025]);
    const pool=new DirectEvidencePool([2026]);
    for(let i=0;i<20;i++) pool.add({messageId:'old'+i,text:'昔の長い旅行のメモです。'.repeat(5),conversationName:'家族',sent_at_jst:'2022-10-01 JST'},'neighbor','old'+i);
    pool.add({messageId:'spa',text:'2日目は十勝川温泉の近くのスパ。水着を忘れずに。',conversationName:'家族',sent_at_jst:'2026-07-26 JST'},'neighbor','summer');
    pool.add({messageId:'booking',text:'2026年1月10日に会場を予約しました。',conversationName:'家族',sent_at_jst:'2025-12-20 JST',mentioned_dates:[{date:'2026-01-10'}]},'hit','booking');
    expect(pool.select().map((r)=>r.messageId)).toEqual(expect.arrayContaining(['spa','booking']));
  });
  it('deduplicates evidence and leaves room for hits from another chat and later searches', () => {
    const pool=new DirectEvidencePool();
    for(let i=0;i<160;i++) pool.add({messageId:'old'+i,text:'以前の周辺会話の説明です。'.repeat(5),conversationName:'A'},'neighbor','old');
    pool.add({messageId:'fresh',text:'今回見つかった資料です。',conversationName:'B'},'hit','new');
    pool.add({messageId:'fresh',text:'今回見つかった資料です。',conversationName:'B'},'neighbor','new');
    const rows=pool.select(8,2000);
    expect(rows.filter((r)=>r.messageId==='fresh')).toHaveLength(1);
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(new TextEncoder().encode(JSON.stringify(rows)).byteLength).toBeLessThanOrEqual(2000);
  });
});
