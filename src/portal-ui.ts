export function portalHtml(configured: boolean, returnTo = "/"): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LINE Talk — ナレッジポータル</title><link rel="stylesheet" href="/portal.css"><script src="/portal.js" defer></script></head>
<body><header><a class="brand" href="/">LINE Talk<span>KNOWLEDGE PORTAL</span></a><div id="account" hidden><span id="user-name"></span><button id="logout" class="quiet">ログアウト</button></div></header>
<main><section id="welcome" class="welcome"><p class="eyebrow">会話の記憶を、次の活動へ。</p><h1>いつものトークを<br>あなたのナレッジに。</h1><p class="lead">あなたと bot が参加するトークを確認して、<br>AI セッションから会話の記憶を活用できます。</p>
${configured ? `<a class="button login" href="/auth/line?returnTo=${encodeURIComponent(returnTo)}">LINE でログイン</a>` : '<p class="notice">LINE ログインの準備中です。</p>'}
<p class="muted small">ログイン後に参加情報を確認します。トークへのメッセージ送信は行いません。</p></section>
<p id="status" role="status" aria-live="polite"></p>
<div id="workspace" hidden><section id="knowledge-detail" class="panel" hidden><p class="eyebrow">KNOWLEDGE</p><h1 id="knowledge-title">ナレッジ全文</h1><p id="knowledge-info" class="muted small"></p><p>参加チャットのメンバーが閲覧・編集できます。変更はこの資料を利用するすべてのチャットに反映されます。編集は抽出した本文に反映され、アップロード原本は変更しません。</p><form id="knowledge-edit"><label for="knowledge-text">本文</label><textarea id="knowledge-text" rows="20" maxlength="40000" required></textarea><button id="knowledge-save" class="button">保存して検索へ反映</button></form><p id="knowledge-save-status" role="status"></p><div class="document-actions"><a href="/?view=knowledge" class="quiet">ナレッジ一覧へ戻る</a><a id="knowledge-original" class="quiet">アップロード原本をダウンロード</a></div></section><div id="portal-home"><nav class="workspace-nav" aria-label="管理画面のメニュー"><a href="/" data-view="talks">トーク</a><a href="/?view=knowledge" data-view="knowledge">ナレッジ</a><a href="/?view=history" data-view="history">履歴インポート</a><a href="/?view=connections" data-view="connections">接続設定</a></nav><div class="intro"><p class="eyebrow">YOUR WORKSPACE</p><h1 id="view-title" tabindex="-1">参加しているトーク</h1><p id="view-description" class="muted">あなたと bot が、どちらも参加中のトークです。</p></div>
<div data-page="talks"><section class="panel"><div class="section-title"><h2>参照するトーク</h2><button id="refresh" class="quiet">更新</button></div><p id="membership-warning" class="notice" hidden>一部の参加情報を確認できませんでした。時間をおいて更新してください。</p>
<div id="conversations" class="conversations"></div><p class="muted small">参加中のすべてのトークが参照対象です。検索するトークは手元の AI が判断します。</p></section>
</div><div data-page="knowledge" hidden>
<section id="knowledge-upload" class="panel"><p class="eyebrow">SHARED KNOWLEDGE</p><h2>ナレッジをアップロード</h2><p>ノートの本文、PDF、画像などを登録し、利用するチャットを選べます。抽出後の本文は4万字まで対応します。</p>
<form id="document-form"><fieldset id="document-fields"><label for="document-title">タイトル</label><input id="document-title" maxlength="160" required placeholder="例：家族旅行の持ち物リスト"><label for="document-file">ファイル（10MBまで、画像は4MBまで）</label><input id="document-file" type="file" accept=".txt,.md,.csv,.json,.log,.pdf,.docx,.xlsx,.xls,.ods,.odt,.html,.xml,.jpg,.jpeg,.png,.webp"><label for="document-body">または本文を貼り付け</label><textarea id="document-body" rows="5" maxlength="40000" placeholder="LINE のノートなどからコピーした本文"></textarea><p class="muted small">ファイルと本文は、どちらか一方を指定してください。</p><p>利用するチャット</p><div id="document-upload-chats"></div><p class="muted small">選択したチャットの参加者が、この資料を検索・回答に利用できます。何も選ばない場合は自分だけが管理できる状態で保存します。</p><button class="button" type="submit">アップロード</button></fieldset></form><p id="document-status" role="status" aria-live="polite"></p></section>
<section class="panel"><div class="section-title"><h2>登録されたナレッジ</h2><button class="quiet" id="document-refresh">更新</button></div><p class="muted small">最新100件を表示します。チェック状態はチャット全体の設定です。他の人の資料も、そのチャットの参加者なら利用を切り替えられます。原本を削除できるのはアップロードした本人だけです。</p><div id="documents"></div></section>
</div><div data-page="history" hidden><section class="panel"><div class="section-title"><h2>取り込み・検索への反映状況</h2><button id="imports-refresh" class="quiet">更新</button></div><p class="muted small">参加中のトークの最新20ファイルを表示します。取り込み完了後も、検索への反映は順次進みます。重複した発言は再登録しません。</p><p id="imports-status" role="status" aria-live="polite"></p><div id="imports"></div></section><section class="panel"><p class="eyebrow">IMPORT HISTORY</p><h2>過去のトークを取り込む</h2><p>LINE から書き出した日本語のテキスト履歴（UTF-8、2MBまで）をアップロードできます。</p>
<form id="import-form"><label for="import-conversation">取り込み先のトーク</label><select id="import-conversation" required><option value="">トークを選んでください</option></select><label for="import-file">トーク履歴（.txt）</label><input id="import-file" type="file" accept=".txt,text/plain" required><button class="button" id="import-preview">内容を確認</button></form>
<div id="import-confirmation" hidden><p id="import-summary"></p><p class="muted small">書き出しのトーク名と取り込み先が一致することを確認してください。履歴はこのトークの参加者から検索可能になります。画像・ファイルの実体は含まれません。表示名からユーザーIDへの対応付けや、Webhook で受信済みの発言との重複照合は行いません。</p><button class="button" id="import-start">このトークに取り込む</button></div><p id="import-progress" role="status" aria-live="polite"></p><p class="muted small">途中で閉じた場合は、同じファイルを選んで再開できます。再アップロード時は同一の書き出し発言を重複登録しません。検索への反映は費用上限に従って順次進みます。</p></section>
</div><div data-page="connections" hidden><section class="panel"><p class="eyebrow">CONNECT YOUR AI</p><h2>MCP サーバーに接続</h2><p>MCP クライアントに次の URL を追加し、ブラウザーで LINE ログインと接続の許可を行ってください。</p><label for="endpoint">サーバー URL</label><input id="endpoint" readonly><p class="muted small">OAuth / DCR による自動接続に対応しています。トークンの手動コピーは不要です。</p></section>
<section class="panel token-list"><div class="section-title"><h2>接続を許可したアプリ</h2><span class="muted small">不要になった接続は解除できます</span></div><div id="connections"></div></section></div></div></div>
<section id="onboarding" class="panel onboarding"><div><p class="eyebrow">GET STARTED</p><h2>まだ bot を使っていない方へ</h2><ol><li>公式アカウントを友だち追加します。</li><li>記録したいグループに bot を招待します。</li><li>グループで一度発言してから、ログインして参加トークを確認します。</li></ol><a class="button" href="https://lin.ee/EXAMPLE" target="_blank" rel="noopener noreferrer">bot を友だち追加</a><p class="muted small">友だち追加だけではグループは記録されません。グループへの招待も必要です。</p></div><a href="https://lin.ee/EXAMPLE" target="_blank" rel="noopener noreferrer"><img src="https://qr-official.line.me/gs/EXAMPLE.png" width="180" height="180" alt="LINE 公式アカウントを友だち追加する QR コード" loading="lazy"></a></section>
</main><footer>LINE Talk · あなたの参加トークだけを、必要なセッションへ。</footer></body></html>`;
}

export const portalJs = String.raw`
const $ = (id) => document.getElementById(id);
let csrf = '';
let importPreview = null;
let importing = false;
let importsLoading = false;
let documentUploading = false;
let knowledgeRevision = null;
const knowledgeId = location.pathname.match(/^\/knowledge\/([a-f0-9-]{36})$/)?.[1];
const views = {
  talks: ['参加しているトーク', 'あなたと bot が、どちらも参加中のトークです。'],
  knowledge: ['ナレッジ', '資料の登録・編集と、チャットごとの利用設定を管理します。'],
  history: ['履歴インポート', 'LINE から書き出した過去の会話を取り込みます。'],
  connections: ['接続設定', 'MCP の接続先と、アクセスを許可したアプリを管理します。'],
};
function showView(focus = false) {
  const requested = new URL(location.href).searchParams.get('view');
  const view = Object.hasOwn(views, requested) ? requested : 'talks';
  for (const page of document.querySelectorAll('[data-page]')) page.hidden = page.dataset.page !== view;
  for (const link of document.querySelectorAll('[data-view]')) {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  $('view-title').textContent = views[view][0]; $('view-description').textContent = views[view][1];
  $('onboarding').hidden = !$('workspace').hidden && (Boolean(knowledgeId) || view !== 'talks');
  if (view === 'history' && !$('workspace').hidden && !knowledgeId) loadImports();
  document.title = (knowledgeId ? 'ナレッジ全文' : views[view][0]) + ' — LINE Talk';
  if (focus) { $('view-title').focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }
}
for (const link of document.querySelectorAll('[data-view]')) link.addEventListener('click', (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); history.pushState(null, '', link.href); say(''); showView(true);
});
window.addEventListener('popstate', () => showView(true));
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
    if (response.status === 401) { $('workspace').hidden = true; $('account').hidden = true; $('welcome').hidden = false; $('onboarding').hidden = false; return; }
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
    renderDocuments(data);
    $('portal-home').hidden = Boolean(knowledgeId); $('knowledge-detail').hidden = !knowledgeId;
    showView();
    if (knowledgeId) await loadKnowledge();
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
async function loadImports() {
  if (importsLoading) return;
  importsLoading = true; $('imports-refresh').disabled = true; $('imports-status').textContent = '状況を確認しています…';
  try {
    const data = await api('/api/imports'); const container = $('imports'); container.replaceChildren();
    for (const item of data.imports) {
      const card = el('article', null, 'document-card');
      card.append(el('h3', item.conversationName), el('p', item.file_name + ' · ' + new Date(item.created_at).toLocaleString('ja-JP'), 'muted small'));
      card.append(el('p', '取り込み' + (item.cursor >= item.total ? '完了' : '途中') + '：' + item.cursor.toLocaleString() + ' / ' + item.total.toLocaleString() + '件を確認（新規 ' + item.imported.toLocaleString() + '件・重複 ' + item.duplicates.toLocaleString() + '件）'));
      const eligible = item.imported - item.cancelled;
      const progress = el('progress'); progress.max = Math.max(eligible, 1); progress.value = item.ready;
      progress.setAttribute('aria-label', item.conversationName + 'の検索反映済み件数');
      card.append(progress, el('p', '検索反映済み：' + item.ready.toLocaleString() + ' / ' + eligible.toLocaleString() + '件', 'index-summary'));
      const counts = [['処理待ち・処理中', item.pending], ['予算枠の回復待ち', item.budget_wait], ['失敗', item.failed], ['索引化対象外', item.skipped], ['送信取り消し', item.cancelled]].filter(([, count]) => count > 0);
      if (counts.length) card.append(el('p', counts.map(([label, count]) => label + ' ' + count.toLocaleString() + '件').join(' · '), 'muted small'));
      if (item.cursor < item.total) card.append(el('p', '取り込みが途中です。同じファイルを下のフォームから選び直して再開してください。', 'notice'));
      container.append(card);
    }
    if (!data.imports.length) container.append(el('p', 'まだ取り込んだ履歴はありません。', 'muted'));
    $('imports-status').textContent = (data.incomplete ? '一部のトークの参加情報を確認できませんでした。' : '') + '最終確認 ' + new Date().toLocaleTimeString('ja-JP');
  } catch (error) { $('imports-status').textContent = error.message; }
  finally { importsLoading = false; $('imports-refresh').disabled = false; }
}
$('imports-refresh').addEventListener('click', () => loadImports());
async function loadKnowledge() {
  const data = await api('/api/documents/' + knowledgeId + '/content' + location.search);
  $('knowledge-original').href = '/api/documents/' + knowledgeId + '/file';
  $('knowledge-title').textContent = data.title; $('knowledge-info').textContent = data.fileName + ' · 更新 ' + new Date(data.updatedAt).toLocaleString('ja-JP');
  $('knowledge-text').value = data.text || ''; knowledgeRevision = data.revision;
  $('knowledge-save-status').textContent = data.text === null ? (data.processing?.last_error_code === 'document_text_limit' ? '本文が4万字を超えています。ファイルを分けるか、4万字以内の本文を入力してください。' : data.processing?.status === 'failed' ? '本文を抽出できませんでした。原本を確認して本文を入力できます。' : '本文を解析しています。しばらく待って再読み込みするか、本文を入力してください。') : '';
}
$('knowledge-edit').addEventListener('submit', async (event) => {
  event.preventDefault(); $('knowledge-save').disabled = true;
  try {
    const data = await api('/api/documents/' + knowledgeId + '/content' + location.search, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: $('knowledge-text').value, revision: knowledgeRevision }) });
    knowledgeRevision = data.revision; $('knowledge-save-status').textContent = '保存しました。検索へ順次反映します。';
  } catch (error) { $('knowledge-save-status').textContent = error.message; }
  finally { $('knowledge-save').disabled = false; }
});
function checkbox(name, checked, action) {
  const label = el('label', null, 'document-check'); const input = document.createElement('input'); input.type = 'checkbox'; input.checked = checked;
  if (action) input.addEventListener('change', () => action(input)); label.append(input, el('span', name)); return { label, input };
}
function renderDocuments(data) {
  const upload = $('document-upload-chats'); const previous = new Set([...upload.querySelectorAll('input:checked')].map((c) => c.value)); upload.replaceChildren();
  for (const chat of data.conversations) { const box = checkbox(chat.name, previous.has(chat.id)); box.input.value = chat.id; upload.append(box.label); }
  if (!data.conversations.length) upload.append(el('p', '参加を確認できるチャットはありません。', 'muted small'));
  const container = $('documents'); container.replaceChildren();
  if (!data.documents.length) container.append(el('p', 'まだナレッジは登録されていません。', 'muted'));
  const states = { pending: '処理待ち', ready: '解析完了', retry: '再試行待ち', budget_wait: '予算枠の回復待ち', failed: '解析できませんでした', skipped: '抽出できる本文がありません' };
  for (const doc of data.documents) {
    const card = el('article', null, 'document-card'); card.append(el('h3', doc.title));
    card.append(el('p', doc.file_name + ' · ' + (doc.is_owner ? '自分がアップロード' : (doc.owner_name || '他の参加者') + 'がアップロード') + ' · ' + (doc.last_error_code === 'document_text_limit' ? '本文が4万字を超えています。ファイルを分けて登録してください。' : states[doc.status] || '処理中'), 'muted small'));
    const shared = new Map(doc.chats.map((c) => [c.conversation_id, c]));
    for (const chat of data.conversations) {
      const link = shared.get(chat.id); if (!doc.is_owner && !link) continue;
      const box = checkbox(chat.name + (link && link.enabled && link.index_status !== 'ready' ? '（検索への反映待ち）' : ''), Boolean(link && link.enabled), async (input) => {
        const target = input.checked; input.disabled = true;
        try { await api('/api/documents/' + doc.id + '/chats/' + chat.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: target }) }); say(target ? 'このチャットでの利用を有効にしました。検索へ順次反映します。' : 'このチャットでの利用を無効にしました。'); await load(); }
        catch (error) { input.checked = !target; say(error.message); input.disabled = false; }
      }); card.append(box.label);
    }
    const actions = el('div', null, 'document-actions');
    const full = el('a', '全文を見る・編集', 'quiet'); full.href = '/knowledge/' + doc.id; actions.append(full);
    if (doc.is_owner || doc.chats.some((c) => c.enabled)) { const download = el('a', '原本をダウンロード', 'quiet'); download.href = '/api/documents/' + doc.id + '/file'; actions.append(download); }
    if (doc.is_owner) {
      const remove = el('button', '削除', 'quiet'); remove.type = 'button'; remove.addEventListener('click', async () => {
        if (!confirm('「' + doc.title + '」の原本と、すべてのチャットでの利用を削除しますか？')) return;
        remove.disabled = true; try { await api('/api/documents/' + doc.id, { method: 'DELETE' }); say('ナレッジを削除しました。'); await load(); } catch (error) { say(error.message); remove.disabled = false; }
      }); actions.append(remove);
    }
    card.append(actions); container.append(card);
  }
}
$('document-refresh').addEventListener('click', () => load());
$('document-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (documentUploading) return;
  const file = $('document-file').files[0]; const text = $('document-body').value.trim();
  if ((!file && !text) || (file && text)) { $('document-status').textContent = 'ファイルか本文のどちらか一方を指定してください。'; return; }
  const body = file || new Blob([text], { type: 'text/plain' });
  if (body.size > 10 * 1024 * 1024) { $('document-status').textContent = 'ファイルは10MBまでです。'; return; }
  const ids = [...$('document-upload-chats').querySelectorAll('input:checked')].map((c) => c.value);
  const params = new URLSearchParams({ title: $('document-title').value.trim(), fileName: file ? file.name : 'knowledge.txt', conversationIds: JSON.stringify(ids) });
  documentUploading = true; $('document-fields').disabled = true; $('document-status').textContent = 'アップロードしています…';
  try { await api('/api/documents?' + params, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body }); $('document-form').reset(); $('document-status').textContent = '登録しました。解析と検索への反映を順次進めます。'; await load(); }
  catch (error) { $('document-status').textContent = error.message; }
  finally { documentUploading = false; $('document-fields').disabled = false; }
});
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
:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;color:#17312b;background:#f5f8f6;font-synthesis:none}*{box-sizing:border-box}body{margin:0}button,input,textarea,select{font:inherit}button,a,input,textarea{outline-offset:4px}button,a{touch-action:manipulation}[hidden]{display:none!important}header{height:88px;padding:0 max(24px,calc((100vw - 1120px)/2));display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #dde6df;background:#fff}.brand{color:#17312b;font-size:25px;font-weight:800;text-decoration:none;letter-spacing:-1px}.brand span{display:block;color:#789087;font-size:9px;font-weight:650;letter-spacing:2.5px;margin-top:4px}#account{display:flex;gap:20px;align-items:center;font-size:14px}main{max-width:1168px;margin:auto;padding:32px 24px 64px}.welcome{padding:70px 0 90px;max-width:680px}.eyebrow{color:#388269;letter-spacing:2px;font-weight:700;font-size:12px;margin:0 0 18px}h1{font-size:clamp(32px,5vw,56px);letter-spacing:-1.6px;line-height:1.4;margin:0 0 20px;font-weight:750}h2{font-size:18px;margin:0 0 20px}.lead{font-size:17px;line-height:1.9;color:#64756e;margin:24px 0 32px}.button{background:#06c755;color:#fff;border:0;border-radius:8px;padding:14px 19px;display:inline-block;text-decoration:none;font-weight:700;font-size:14px;cursor:pointer}.button:hover{background:#05ad49}.button:disabled{opacity:.45;cursor:default}.login{min-width:210px;text-align:center;margin-bottom:16px}.muted{color:#6d8077}.small{font-size:12px;line-height:1.7}.intro{margin:12px 0 36px}.intro h1{font-size:32px;letter-spacing:-.8px}.workspace-nav{position:sticky;top:0;z-index:2;display:flex;gap:6px;padding:10px 0;margin-bottom:28px;background:#f5f8f6;border-bottom:1px solid #dde6df;overflow-x:auto}.workspace-nav a{flex:none;padding:12px 18px;border-radius:8px;color:#526d60;text-decoration:none;font-size:14px;font-weight:650;white-space:nowrap}.workspace-nav a:hover{background:#e8f0eb}.workspace-nav a[aria-current=page]{background:#173e30;color:#fff}.intro h1:focus{outline:none}.panel{background:#fff;border:1px solid #dde6df;border-radius:14px;padding:28px;margin-bottom:24px;box-shadow:0 2px 5px #17312b03}.panel p{font-size:14px;line-height:1.8}.section-title{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.section-title h2{margin:0}.quiet{border:0;background:transparent;color:#33705b;cursor:pointer;font-size:13px;padding:8px 0}.quiet:hover{text-decoration:underline}label{display:block;font-size:13px;font-weight:600;margin-bottom:8px}input:not([type=checkbox]),textarea,select{width:100%;border:1px solid #ccd9d0;background:#fafcfb;border-radius:7px;padding:12px;color:#253e33;margin-bottom:16px;font-size:14px}input[readonly],textarea{font-family:ui-monospace,monospace;font-size:12px}input[type=checkbox]{accent-color:#06a647;width:18px;height:18px;margin:3px 14px 0 0;flex:none}.conversation{display:flex;align-items:start;padding:20px 0;border-bottom:1px solid #edf1ee;margin:0;}.conversation:first-child{padding-top:8px}.conversation strong,.token-row strong{display:block;font-size:15px;line-height:1.6;margin-bottom:4px}.conversation span span,.token-row span{display:block;font-weight:400}.token-form{padding-top:28px}.token-form .button{width:100%}.token-form p{margin-bottom:0}.issued{border-color:#8cddae;background:#f5fff8}.token-row{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px 0;border-top:1px solid #edf1ee}.token-row:first-child{border:0}.token-list{margin-top:4px}.notice,#status:not(:empty){padding:14px 18px;background:#eef5ef;border:1px solid #d9e8dc;border-radius:8px;font-size:13px;line-height:1.8}.empty{padding:12px 0}footer{padding:24px;border-top:1px solid #dde6df;text-align:center;color:#7a8d82;font-size:12px}.onboarding{display:flex;justify-content:space-between;gap:30px;align-items:center}.onboarding ol{padding-left:22px;font-size:14px;line-height:2}fieldset{border:0;padding:0;margin:0;min-width:0}progress{display:block;width:100%;height:10px;accent-color:#06a647}.index-summary{font-weight:600}.document-card{padding:22px 0;border-top:1px solid #edf1ee}.document-card h3{font-size:17px;margin:0 0 8px}.document-check{display:flex;align-items:center;gap:4px;font-weight:400;padding:8px 0}.document-actions{display:flex;flex-wrap:wrap;gap:12px 24px;margin-top:12px}.onboarding img{border-radius:8px;background:white}@media(max-width:720px){header{height:76px;padding:0 20px}.workspace-nav{gap:2px;margin-bottom:24px}.workspace-nav a{padding:12px 10px;font-size:13px}.panel{padding:22px}main{padding:24px 18px}.welcome{padding:50px 0}.section-title{flex-wrap:wrap}.onboarding{align-items:start;flex-direction:column}#account{gap:10px}.brand{font-size:22px}}
`;
