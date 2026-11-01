export function portalHtml(configured: boolean): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LINE Talk — ナレッジポータル</title><link rel="stylesheet" href="/portal.css"><script src="/portal.js" defer></script></head>
<body><header><a class="brand" href="/">LINE Talk<span>KNOWLEDGE PORTAL</span></a><div id="account" hidden><span id="user-name"></span><button id="logout" class="quiet">ログアウト</button></div></header>
<main><section id="welcome" class="welcome"><p class="eyebrow">会話の記憶を、次の活動へ。</p><h1>いつものトークを<br>あなたのナレッジに。</h1><p class="lead">あなたと bot が参加するトークを確認して、<br>AI セッションから会話の記憶を活用できます。</p>
${configured ? '<a class="button login" href="/auth/line">LINE でログイン</a>' : '<p class="notice">LINE ログインの準備中です。</p>'}
<p class="muted small">ログイン後に参加情報を確認します。トークへのメッセージ送信は行いません。</p></section>
<p id="status" role="status" aria-live="polite"></p>
<div id="workspace" hidden><div class="intro"><p class="eyebrow">YOUR WORKSPACE</p><h1>参加しているトーク</h1><p class="muted">あなたと bot が、どちらも参加中のトークです。</p></div>
<div class="columns"><section class="panel"><div class="section-title"><h2>参照するトーク</h2><button id="refresh" class="quiet">更新</button></div><p id="membership-warning" class="notice" hidden>一部の参加情報を確認できませんでした。時間をおいて更新してください。</p>
<div id="conversations" class="conversations"></div><p class="muted small">参加中のすべてのトークが参照対象です。検索するトークは手元の AI が判断します。</p></section>
<aside><section class="panel"><p class="eyebrow">CONNECT YOUR AI</p><h2>MCP サーバーに接続</h2><p>MCP クライアントに次の URL を追加し、ブラウザーで LINE ログインと接続の許可を行ってください。</p><label for="endpoint">サーバー URL</label><input id="endpoint" readonly><p class="muted small">OAuth / DCR による自動接続に対応しています。トークンの手動コピーは不要です。</p></section></aside></div>
<section class="panel"><p class="eyebrow">IMPORT HISTORY</p><h2>過去のトークを取り込む</h2><p>LINE から書き出した日本語のテキスト履歴（UTF-8、2MBまで）をアップロードできます。</p>
<form id="import-form"><label for="import-conversation">取り込み先のトーク</label><select id="import-conversation" required><option value="">トークを選んでください</option></select><label for="import-file">トーク履歴（.txt）</label><input id="import-file" type="file" accept=".txt,text/plain" required><button class="button" id="import-preview">内容を確認</button></form>
<div id="import-confirmation" hidden><p id="import-summary"></p><p class="muted small">書き出しのトーク名と取り込み先が一致することを確認してください。履歴はこのトークの参加者から検索可能になります。画像・ファイルの実体は含まれません。表示名からユーザーIDへの対応付けや、Webhook で受信済みの発言との重複照合は行いません。</p><button class="button" id="import-start">このトークに取り込む</button></div><p id="import-progress" role="status" aria-live="polite"></p><p class="muted small">途中で閉じた場合は、同じファイルを選んで再開できます。再アップロード時は同一の書き出し発言を重複登録しません。検索への反映は費用上限に従って順次進みます。</p></section>
<section class="panel token-list"><div class="section-title"><h2>接続を許可したアプリ</h2><span class="muted small">不要になった接続は解除できます</span></div><div id="connections"></div></section></div>
<section class="panel onboarding"><div><p class="eyebrow">GET STARTED</p><h2>まだ bot を使っていない方へ</h2><ol><li>公式アカウントを友だち追加します。</li><li>記録したいグループに bot を招待します。</li><li>グループで一度発言してから、ログインして参加トークを確認します。</li></ol><a class="button" href="https://lin.ee/EXAMPLE" target="_blank" rel="noopener noreferrer">bot を友だち追加</a><p class="muted small">友だち追加だけではグループは記録されません。グループへの招待も必要です。</p></div><a href="https://lin.ee/EXAMPLE" target="_blank" rel="noopener noreferrer"><img src="https://qr-official.line.me/gs/EXAMPLE.png" width="180" height="180" alt="LINE 公式アカウントを友だち追加する QR コード" loading="lazy"></a></section>
</main><footer>LINE Talk · あなたの参加トークだけを、必要なセッションへ。</footer></body></html>`;
}

export const portalJs = String.raw`
const $ = (id) => document.getElementById(id);
let csrf = '';
let importPreview = null;
let importing = false;
function say(message) { $('status').textContent = message; }
function el(tag, text, className) { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; }
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'X-CSRF-Token': csrf, ...options.headers } });
  if (!response.ok) { let message = '接続できませんでした。少し待って再試行してください。'; try { message = (await response.json()).error || message; } catch {} throw new Error(message); }
  return response.status === 204 ? null : response.json();
}
async function load() {
  $('refresh').disabled = true;
  try {
    const response = await fetch('/api/portal', { credentials: 'same-origin' });
    if (response.status === 401) { $('workspace').hidden = true; $('account').hidden = true; $('welcome').hidden = false; return; }
    if (!response.ok) throw new Error('参加情報を確認できませんでした。少し待って再読み込みしてください。');
    const data = await response.json(); csrf = data.csrfToken;
    $('welcome').hidden = true; $('workspace').hidden = false; $('account').hidden = false;
    $('user-name').textContent = data.user.displayName; $('endpoint').value = data.mcpEndpoint;
    $('membership-warning').hidden = !data.incomplete;
    const groups = $('conversations'); groups.replaceChildren();
    const select = $('import-conversation'); const selected = select.value; select.replaceChildren(el('option', 'トークを選んでください')); select.firstChild.value = '';
    for (const group of data.conversations) { const option = el('option', group.name); option.value = group.id; select.append(option); } select.value = selected;
    if (!data.conversations.length) groups.append(el('p', '参加を確認できるトークがありません。bot をグループに招待して発言し、更新してください。', 'muted empty'));
    for (const group of data.conversations) {
      const label = el('div', null, 'conversation');
      const details = el('span'); details.append(el('strong', group.name), el('span', group.messageCount + ' 件の記録 · 参加確認済み', 'muted small'));
      label.append(details); groups.append(label);
    }
    const tokens = $('connections'); tokens.replaceChildren();
    if (!data.connections.length) tokens.append(el('p', 'まだ接続を許可したアプリはありません。', 'muted'));
    for (const token of data.connections) {
      const row = el('div', null, 'token-row'); const details = el('div');
      details.append(el('strong', token.client_name), el('span', '参加中の全トーク · ' + new Date(token.expires_at).toLocaleDateString('ja-JP') + ' まで', 'muted small'));
      const revoke = el('button', '接続を解除', 'quiet'); revoke.addEventListener('click', async () => {
        revoke.disabled = true; try { await api('/api/connections/' + token.id, { method: 'DELETE' }); say('接続を解除しました。'); await load(); } catch (error) { say(error.message); revoke.disabled = false; }
      }); row.append(details, revoke); tokens.append(row);
    }
  } catch (error) { say(error.message); }
  finally { $('refresh').disabled = false; }
}
function resetImport() { if (importing) return; importPreview = null; $('import-confirmation').hidden = true; $('import-progress').textContent = ''; }
$('import-conversation').addEventListener('change', resetImport);
$('import-file').addEventListener('change', resetImport);
$('import-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (importing) return; resetImport(); const file = $('import-file').files[0]; if (!file) return;
  if (file.size > 2 * 1024 * 1024) { $('import-progress').textContent = 'ファイルは2MBまでです。'; return; }
  const conversationId = $('import-conversation').value; const target = $('import-conversation').selectedOptions[0].textContent;
  $('import-preview').disabled = true;
  try {
    const data = await api('/api/imports?' + new URLSearchParams({ conversationId, fileName: file.name }), { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: file });
    if ($('import-conversation').value !== conversationId || $('import-file').files[0] !== file) return;
    importPreview = data;
    const date = (n) => new Date(n).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
    $('import-summary').textContent = '書き出し: ' + data.title + ' → 取り込み先: ' + target + ' / ' + data.total + '件 / ' + date(data.from) + '〜' + date(data.before) + '（添付の表示・システム通知など ' + data.skipped + '件を除外）';
    $('import-confirmation').hidden = false;
  } catch (error) { $('import-progress').textContent = error.message; }
  finally { $('import-preview').disabled = false; }
});
$('import-start').addEventListener('click', async () => {
  if (!importPreview || importing) return;
  importing = true; for (const id of ['import-start','import-preview','import-file','import-conversation']) $(id).disabled = true;
  try {
    while (true) {
      const data = await api('/api/imports/' + importPreview.id + '/continue', { method: 'POST' });
      $('import-progress').textContent = data.cursor + ' / ' + data.total + '件を確認しました。';
      if (data.done) { $('import-progress').textContent = '取り込み完了: 新規 ' + data.inserted + '件、重複 ' + (data.total - data.inserted) + '件。検索には順次反映されます。'; $('import-confirmation').hidden = true; await load(); break; }
    }
  } catch (error) { $('import-progress').textContent = error.message + ' 同じファイルを選び直すと続きから再開できます。'; }
  finally { importing = false; for (const id of ['import-start','import-preview','import-file','import-conversation']) $(id).disabled = false; }
});
$('refresh').addEventListener('click', () => { say(''); load(); });
$('logout').addEventListener('click', async () => { try { const response = await fetch('/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf } }); if (!response.ok) throw new Error('ログアウトできませんでした。'); location.assign('/'); } catch (error) { say(error.message); } });
if (new URL(location.href).searchParams.get('login') === 'failed') say('ログインできませんでした。もう一度お試しください。');
load();
`;

export const portalCss = String.raw`
:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;color:#17312b;background:#f5f8f6;font-synthesis:none}*{box-sizing:border-box}body{margin:0}button,input,textarea,select{font:inherit}button,a,input,textarea{outline-offset:4px}button,a{touch-action:manipulation}[hidden]{display:none!important}header{height:88px;padding:0 max(24px,calc((100vw - 1120px)/2));display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #dde6df;background:#fff}.brand{color:#17312b;font-size:25px;font-weight:800;text-decoration:none;letter-spacing:-1px}.brand span{display:block;color:#789087;font-size:9px;font-weight:650;letter-spacing:2.5px;margin-top:4px}#account{display:flex;gap:20px;align-items:center;font-size:14px}main{max-width:1168px;margin:auto;padding:32px 24px 64px}.welcome{padding:70px 0 90px;max-width:680px}.eyebrow{color:#388269;letter-spacing:2px;font-weight:700;font-size:12px;margin:0 0 18px}h1{font-size:clamp(32px,5vw,56px);letter-spacing:-1.6px;line-height:1.4;margin:0 0 20px;font-weight:750}h2{font-size:18px;margin:0 0 20px}.lead{font-size:17px;line-height:1.9;color:#64756e;margin:24px 0 32px}.button{background:#06c755;color:#fff;border:0;border-radius:8px;padding:14px 19px;display:inline-block;text-decoration:none;font-weight:700;font-size:14px;cursor:pointer}.button:hover{background:#05ad49}.button:disabled{opacity:.45;cursor:default}.login{min-width:210px;text-align:center;margin-bottom:16px}.muted{color:#6d8077}.small{font-size:12px;line-height:1.7}.intro{margin:12px 0 36px}.intro h1{font-size:32px;letter-spacing:-.8px}.columns{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:24px;align-items:start}.panel{background:#fff;border:1px solid #dde6df;border-radius:14px;padding:28px;margin-bottom:24px;box-shadow:0 2px 5px #17312b03}.panel p{font-size:14px;line-height:1.8}.section-title{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.section-title h2{margin:0}.quiet{border:0;background:transparent;color:#33705b;cursor:pointer;font-size:13px;padding:8px 0}.quiet:hover{text-decoration:underline}label{display:block;font-size:13px;font-weight:600;margin-bottom:8px}input:not([type=checkbox]),textarea,select{width:100%;border:1px solid #ccd9d0;background:#fafcfb;border-radius:7px;padding:12px;color:#253e33;margin-bottom:16px;font-size:14px}input[readonly],textarea{font-family:ui-monospace,monospace;font-size:12px}input[type=checkbox]{accent-color:#06a647;width:18px;height:18px;margin:3px 14px 0 0;flex:none}.conversation{display:flex;align-items:start;padding:20px 0;border-bottom:1px solid #edf1ee;margin:0;}.conversation:first-child{padding-top:8px}.conversation strong,.token-row strong{display:block;font-size:15px;line-height:1.6;margin-bottom:4px}.conversation span span,.token-row span{display:block;font-weight:400}.token-form{padding-top:28px}.token-form .button{width:100%}.token-form p{margin-bottom:0}.issued{border-color:#8cddae;background:#f5fff8}.token-row{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px 0;border-top:1px solid #edf1ee}.token-row:first-child{border:0}.token-list{margin-top:4px}.notice,#status:not(:empty){padding:14px 18px;background:#eef5ef;border:1px solid #d9e8dc;border-radius:8px;font-size:13px;line-height:1.8}.empty{padding:12px 0}footer{padding:24px;border-top:1px solid #dde6df;text-align:center;color:#7a8d82;font-size:12px}.onboarding{display:flex;justify-content:space-between;gap:30px;align-items:center}.onboarding ol{padding-left:22px;font-size:14px;line-height:2}.onboarding img{border-radius:8px;background:white}@media(max-width:720px){header{height:76px;padding:0 20px}.columns{grid-template-columns:1fr}.panel{padding:22px}main{padding:24px 18px}.welcome{padding:50px 0}.section-title{flex-wrap:wrap}.onboarding{align-items:start;flex-direction:column}#account{gap:10px}.brand{font-size:22px}}
`;
