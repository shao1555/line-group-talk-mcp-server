import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { DIRECT_MODELS, DEFAULT_DIRECT_MODEL, directCost, directReservation, decodeDirectDecision, type DirectModelName } from '../src/direct-model';
import { directRequest } from '../src/direct-protocol';
import { answerClock, evidenceDates } from '../src/answer-context';

type EvalCase = { id: string; question: string; now: string; records: { messageId: string; text: string; sentAt: string; conversationName: string }[];
  checks?: { label: string; pattern: string; absent?: boolean }[] };
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('npm run eval:direct -- [--live] [--models glm,qwen,oss] [--repeat 1..5] [--case ID] [--input JSON] [--max-usd 0.10] [--timeout-ms 25000] [--output data/DIR]'); process.exit(0); }
function option(name: string, fallback: string) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
const models = option('--models', DEFAULT_DIRECT_MODEL).split(',') as DirectModelName[];
const repeat = Number(option('--repeat', '1'));
const maxUsd = Number(option('--max-usd', '0.10'));
const timeoutMs = Number(option('--timeout-ms', '25000'));
if (models.some((m) => !Object.hasOwn(DIRECT_MODELS,m)) || !Number.isInteger(repeat) || repeat < 1 || repeat > 5
  || !Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 5 || !Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 45000) throw Error('Invalid model, repeat, budget or timeout option');
const input = option('--input', 'eval/fixtures/direct.json');
const raw = JSON.parse(readFileSync(input,'utf8'));
const cases: { id: string; payload: unknown; checks: NonNullable<EvalCase['checks']> }[] = Array.isArray(raw)
  ? (raw as EvalCase[]).map((c) => ({ id: c.id, checks: c.checks ?? [], payload: {
      question: c.question, ...answerClock(Date.parse(c.now),Date.parse(c.now)),
      conversations: [{ id: 'fixture-chat', name: '家族トーク' }], initial_recent_messages: [], untrusted_dialogue: [],
      untrusted_tool_results: [{ name: 'search_knowledge', conversationName: '家族トーク', data: { messageIds: c.records.map((r)=>r.messageId) } }],
      untrusted_evidence: c.records.map((r) => ({ messageId:r.messageId, text:r.text, conversationName:r.conversationName,
        sender_role:'user', ...evidenceDates(r.text,Date.parse(r.sentAt),Date.parse(c.now)) })),
    } }))
  : [{ id: 'private-replay', checks: [], payload: raw.messages ? JSON.parse(raw.messages.find((m: {role:string})=>m.role==='user').content) : raw }];
const only = option('--case','');
const selected = cases.filter((c)=>!only || c.id===only);
if (!selected.length || selected.length > 30) throw Error('No cases selected or too many cases');
if (!args.includes('--live')) {
  console.log(JSON.stringify({ mode:'dry-run', models, cases:selected.map((c)=>c.id), calls:models.length*selected.length*repeat,
    maxUsd, hint:'Add --live to invoke Workers AI. Production prompts, model settings and pricing are reused.' },null,2));
  process.exit(0);
}
const config = readFileSync('wrangler.jsonc','utf8');
const account = config.match(/"account_id"\s*:\s*"([a-f0-9]{32})"/)?.[1];
if (!account) throw Error('Missing project account_id');
const profile = process.env.WRANGLER_CONFIG_PATH ?? join(homedir(),'Library/Preferences/.wrangler/config/default.toml');
const token = process.env.CLOUDFLARE_API_TOKEN ?? readFileSync(profile,'utf8').match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
if (!token) throw Error('Set CLOUDFLARE_API_TOKEN or log in with project Wrangler');
const output = resolve(option('--output','data/direct-eval/'+new Date().toISOString().replaceAll(':','-')));
const privateRoot=resolve('data');
if (!output.startsWith(privateRoot+'/')) throw Error('Evaluation output must be inside ignored data/');
mkdirSync(output,{recursive:true,mode:0o700});
let charged = 0;
const results: Record<string,unknown>[] = [];
for (const name of models) for (const c of selected) for(let n=1;n<=repeat;n++) {
  const model = DIRECT_MODELS[name], content = JSON.stringify(c.payload);
  if (new TextEncoder().encode(content).byteLength>26_000) throw Error("Case exceeds production context budget");
  const request = directRequest(model,content,true);
  const reserved = directReservation(model,request.messages);
  if (charged+reserved>maxUsd*1e6) throw Error('Evaluation budget exhausted; raise --max-usd explicitly to continue');
  charged+=reserved;
  const begin=performance.now();
  let row: Record<string,unknown>;
  let incurred=reserved;
  try {
    const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model.id}`, {
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','User-Agent':'LINE-Talk-Eval/1.0'},
      body:JSON.stringify(request),signal:AbortSignal.timeout(timeoutMs),
    });
    if(!response.ok) throw Error('Workers AI HTTP '+response.status);
    const data=await response.json() as {success:boolean;result?:{usage?:unknown}};
    if(!data.success || !data.result) throw Error('Workers AI returned an error');
    const actual=directCost(model,data.result.usage);
    incurred=actual ?? reserved;
    charged+=incurred-reserved;
    const decision=decodeDirectDecision(data.result,true);
    if(decision.action!=='answer') throw Error('Final answer required');
    const checks=c.checks.map((check)=>({label:check.label,pass:check.absent?!new RegExp(check.pattern,'u').test(decision.answer):new RegExp(check.pattern,'u').test(decision.answer)}));
    row={model:name,case:c.id,repeat:n,seconds:(performance.now()-begin)/1000,microUsd:actual ?? reserved,usage:data.result.usage,
      answer:decision.answer,answerParts:decision.partsCount,basis:decision.basis,checks,pass:checks.every((check)=>check.pass)};
  } catch(error) { row={model:name,case:c.id,repeat:n,seconds:(performance.now()-begin)/1000,microUsd:incurred,pass:false,error:String(error)}; }
  results.push(row);
  writeFileSync(join(output,'results.json'),JSON.stringify({input,models,repeat,maxUsd,chargedUSD:charged/1e6,results},null,2),{mode:0o600});
  console.log(JSON.stringify({model:name,case:c.id,repeat:n,seconds:row.seconds,pass:row.pass,error:row.error,costUSD:Number(row.microUsd)/1e6}));
}
const report=['# Direct model regression','',`Input: ${input}`,`Estimated total: $${(charged/1e6).toFixed(6)}`,'',
  'Rule checks assist review; they are not a complete factual accuracy score. No LINE sends or production DB writes occur. Failed calls retain their conservative reservation.','',
  ...results.flatMap((r)=>[`## ${r.model} / ${r.case} / ${r.repeat}`,'',`Pass: ${r.pass}; seconds: ${Number(r.seconds).toFixed(2)}; cost: $${(Number(r.microUsd)/1e6).toFixed(6)}`,'',String(r.answer??r.error),'',JSON.stringify(r.checks??[]),''])];
writeFileSync(join(output,'report.md'),report.join('\n'),{mode:0o600});
console.log('Report: '+join(output,'report.md'));
if(results.some((r)=>!r.pass)) process.exitCode=1;
