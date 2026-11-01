# LINE Group Talk MCP Server

LINE グループの会話を記録し、グループ内の活動支援と外部 AI セッションからのナレッジ活用を可能にする bot / MCP サーバー。

## 構成方針

- Cloudflare Workers：LINE Webhook の受信、bot、認証付き MCP サーバー。
- Cloudflare D1：会話原文、決定事項、タスク、整理済みナレッジの正本。
- Cloudflare Vectorize：会話とナレッジの意味検索。埋め込みモデルは別途選定する。
- Codex スキル：ユーザーが明示的に起動したときに、未処理の会話を整理する。
- 過去ログ：LINE のテキスト書き出しを優先し、必要に応じて Computer Use で補完する。

## 設計上の要点

- 会話の記録とナレッジ整理を分離し、常時の LLM 要約は行わない。
- 整理したナレッジには根拠となる元発言を紐付ける。
- 処理済み位置を保存し、差分処理と途中再開に対応する。
- MCP のアクセス権限はグループ単位で検証する。
- 送信取消・訂正は、原文と派生ナレッジ・検索索引に反映する。
- 過去ログの表示名と LINE ユーザーIDは、根拠なく同一人物として扱わない。

現在は、署名検証付き Webhook、D1 への発言保存、`ping` → `pong`、添付の R2 保存、OCR・画像説明・文字起こし、Vectorize 検索、認証付き MCP、メンション回答を実装している。
送信取消は本文・添付・抽出文・検索索引に反映する。会話全体の要約・決定事項の整理・過去ログ取り込みは今後実装する。

設計判断と今回の範囲は [ADR 一覧](docs/adr/README.md) を参照。

## 開発環境

Node.js と Wrangler は `mise.toml` に固定し、mise で管理する。

```sh
mise install
mise exec -- npm ci
mise exec -- node --version
mise exec -- wrangler --version
```

Cloudflare の認証状態の確認と再ログイン：

```sh
mise exec -- wrangler whoami
mise exec -- wrangler logout
mise exec -- wrangler login
```

`login` で開いたブラウザーでは、このプロジェクトで使う Cloudflare アカウントを選ぶ。

## ローカル実行と検証

`.dev.vars.example` を `.dev.vars` にコピーし、LINE Developers Console で取得した Channel Secret と Channel Access Token を設定する。
`.dev.vars` は Git 管理対象外。値を README やチャットに貼らない。

```sh
cp .dev.vars.example .dev.vars
mise exec -- npm run db:local
mise exec -- npm run dev
```

- `GET /health`：稼働確認。DB・LINE 認証の疎通は確認しない。
- `POST /webhook`：LINE Webhook。未設定のシークレットは 503、不正な署名は 401。
- テキストは日時・会話ID・発言者IDとともに保存する。画像・動画・音声・添付ファイルは Queues 経由で非公開 R2 に保存する。
- 本文が厳密に `ping` のときだけ `pong` を返信する。`PING` や前後に空白のある発言には返信しない。
- 通常の発言にも返信しない。グループ、旧 room、1対1の発言を記録する。

```sh
mise exec -- npm run types
mise exec -- npm run check
```

テストはローカルの Workers / D1 / R2 実行環境を使い、LINE API・AI・Vectorize をモックする。実際のチャットには投稿せず、有料 AI 呼び出しも行わない。
`wrangler dev` で AI / Vectorize を使う場合は、リモートのリソース・有料推論に接続する点に注意する。通常のローカル D1 / R2 データとは別。
固定した workerd が対応する日付に合わせ、互換日付は `2026-10-30` としている。

## Cloudflare / LINE への接続

`wrangler.jsonc` は公開用の設定例です。最初に `cp wrangler.jsonc wrangler.private.jsonc` を実行し、Git 管理外の `wrangler.private.jsonc` に自分のアカウントID・ドメイン・LINE ログインチャンネルID・D1/KV のリソースIDを設定してください。記載した URL と ID は架空の値です。
`LINE_FRIEND_URL` / `LINE_FRIEND_QR_URL` に公式アカウントの友だち追加リンクと QR 画像 URL を設定できます。未設定時は追加ボタンを表示しません。
`npm run dev` / `deploy` / `db:local` / `db:remote` はこの非公開設定があれば優先して使用します。`types` / `check` とテストは公開設定を使います。直接 Wrangler を実行するときも `--config wrangler.private.jsonc` を指定してください。
D1 `line-group-talk` を作成し、発行された ID を非公開設定に設定します。
ローカルの D1 とリモートの D1 は別のデータベース。
R2 / Queues / Vectorize / KV も自分のアカウントで作成してください。
リソース名は `wrangler.jsonc` に設定し、ローカル開発・テストではローカルの R2 / Queues を使用する。

```sh
mise exec -- npm run db:remote
mise exec -- npm run deploy
mise exec -- node scripts/wrangler.mjs secret put LINE_CHANNEL_SECRET
mise exec -- node scripts/wrangler.mjs secret put LINE_CHANNEL_ACCESS_TOKEN
```

`secret put` の対話入力に値を入れる。秘密情報は Wrangler のログイン情報とは別で、`.dev.vars` はデプロイ時に自動アップロードされない。

1. LINE 公式アカウントの Messaging API を有効にする。
2. LINE Developers Console に `https://legacy.example.com/webhook` を Webhook URL として設定する。
3. Webhook URL の「検証」、Webhook の利用、Webhook の再送を有効にする。
4. グループ参加を許可し、公式アカウントを対象グループに招待する。
5. 公式アカウント側の定型的な応答メッセージは無効にし、`ping` を送って `pong` を確認する。

保存件数は次のコマンドで確認できる（本文は出力しない）。

```sh
mise exec -- wrangler d1 execute DB --remote --command 'SELECT count(*) AS message_count FROM messages;'
```

記録対象のグループには保存を行う旨を周知する。送信取消はアプリ上の本文を NULL にするが、D1 バックアップの保持期間内に残る可能性がある。
返信には期限と一回限りの reply token を使うため、配送遅延・通信障害時の返信は保証しない。

## 添付の保存と送信取消

- 対象は画像・動画・音声・ファイル。ファイル名は D1 に保存し、R2 キーには使用しない。
- R2 は非公開。グループごとに保存キーを分け、HTTP のダウンロード機能はまだ提供しない。
- 初期上限は1ファイル100 MiB（`MAX_ATTACHMENT_BYTES`）。Content-Length がなくても、実際に読み込んだバイト数で制限する。
- 添付の取得は Webhook 応答後に Queues で行う。LINE 側の処理待ち・通信障害は再試行し、取得不能・サイズ超過は失敗状態を記録する。
- Queue への投入に失敗しても D1 の処理待ちは残り、Cron が毎分再投入する。
- 取消時は D1 上で直ちに削除待ちにし、R2 実体は非同期削除する。保存中の取消・再送でも復活しないよう最新状態を確認する。
- 削除失敗は `delete_pending` のまま再試行する。取得失敗が上限に達した場合は DLQ と `last_error_code` を確認する。
- LINE 側で取得期限を過ぎた添付は保存できない。過去に受信した添付の遡及取得、外部 content provider、アルバム・ノートは対象外。
- 保存完了後に解析キューへ渡し、処理上限内で OCR・画像説明・文字起こし・本文抽出を行う。

本文やファイル名を出さずに保存状態を確認する：

```sh
mise exec -- wrangler d1 execute DB --remote --command 'SELECT m.message_id, m.source_type, a.status, a.size_bytes, a.last_error_code FROM attachments a JOIN messages m USING(message_id) ORDER BY m.received_at DESC LIMIT 20;'
```

取得が `failed` になった場合、認証・サイズ制限などの原因を修正後、対象の `attachments` 行を `status = 'pending', queued_at = NULL` に戻せば Cron が再投入する。
DLQ は Cloudflare Dashboard の Queues で確認する。削除待ちが長時間残る場合も運用確認が必要。

## ナレッジ解析と検索

発言と保存済み添付は `line-group-talk-knowledge` Queue で処理する。既存の有効な発言・保存済み添付も取り込み対象。
抽出文・埋め込みは D1 に保持し、Vectorize の namespace を会話IDで分ける。検索結果を返す前に D1 の会話ID・取消状態を確認する。
解析・索引の反映は非同期なので、送信直後には検索できない場合がある。

| 対象 | 処理 |
| --- | --- |
| 発言・UTF-8 テキスト・CSV・JSON | 本文を分割して BGE-M3 で埋め込み |
| JPEG / PNG / WebP | Mistral Small 3.1 で文字抽出と短い画像説明 |
| 音声・動画 | Whisper Large V3 Turbo で日本語文字起こし。LINE から取得できる時間が必要 |
| PDF・対応 Office 文書 | Markdown Conversion で本文抽出。本文なしの PDF は上限付き画像変換も実施 |

文字起こしはコンテナ・コーデックによって失敗する場合がある。時間不明の音声ファイル、暗号化PDF、非対応形式は原本だけ保存する。
低価格モデルを使うため、OCR・説明・文字起こしには誤りがあり得る。

既定の上限（`wrangler.jsonc` の変数で変更）：

| 設定 | 既定値 |
| --- | --- |
| AI の月予算見積り | $5（`AI_MONTHLY_BUDGET_USD`、0ならモデル呼び出しを保留） |
| 日次画像処理 | 20件、PDFの画像変換はページ数換算 |
| 日次文字起こし | 60分 |
| 日次埋め込み入力 | 500,000 UTF-8 bytes |
| 日次メンション回答モデル呼び出し | 100回（1質問につき最大2回） |
| 解析対象のファイル | 10 MiBまで、画像4 MiBまで、PDF10ページまで、音声・動画10分まで |
| 抽出文 | 40,000文字まで。打ち切りは抽出文に明記 |

日・月の境界は UTC。アプリ側でモデル呼び出し前に料金枠を予約し、上限で `budget_wait` にする。
予算待ちは Cron で再確認し、記録・原本保存は継続する。失敗・応答不明の呼び出しも費用枠を消費する扱い。
公開単価を基にした保守的な見積りであり、Cloudflare の請求を強制制限するものではない。無料枠の控除、料金改定、R2 / D1 / Queues / Vectorize の料金は含めない。

```sh
mise exec -- wrangler d1 execute DB --remote --command 'SELECT status, count(*) AS count FROM knowledge_jobs GROUP BY status;'
mise exec -- wrangler d1 execute DB --remote --command 'SELECT month, kind, sum(charged_microusd) / 1000000.0 AS estimated_usd FROM ai_usage GROUP BY month, kind;'
```

`failed` の原因を修正して再処理する場合は、対象の `knowledge_jobs` の `status = 'pending', next_attempt_at = 0, queued_at = NULL` と該当段階の試行回数をリセットする。
既存の抽出文・埋め込みは再利用する。モデル・処理バージョンを変更する場合は、対象のキャッシュ・チャンクと索引を再構築する。

## 外部セッションからの検索

### LINE ログインのポータル

`https://line-talk.example.com/` で LINE ログインし、本人と bot が参加しているトークを確認できる。
MCP クライアントに `https://line-talk.example.com/mcp` を追加すると、OAuth / DCR によりブラウザーで接続を許可できる。トークンの手動発行は不要。
接続は本人に紐付き、本人と bot が現在ともに参加しているすべての把握済みトークを参照できる。トークの選別・検索は手元のエージェントがツールで行う。
後から参加したトークも自動で対象になり、退会や bot の退出後は対象から外れる。接続アプリの一覧・解除はポータルから行える。
LINE API で参加確認できないときはアクセスを許可しない。過去の発言者一覧をアクセス権として流用しない。

LINE Developers Console で、Messaging API と**同じプロバイダー**に LINE Login チャンネル（ウェブアプリ）を作成する。
LINEログイン設定のコールバック URL は次の値を登録する。

```text
https://line-talk.example.com/auth/line/callback
```

旧 `workers.dev` URL も互換用に稼働する。既存接続を残す場合は旧コールバック URL も削除しない。新ドメインでは OAuth issuer / resource が変わるため、MCP クライアントには新 URL を追加して再認可する。LINE Webhook の URL は変更不要。

チャンネルIDは `wrangler.private.jsonc` の `LINE_LOGIN_CHANNEL_ID` に設定し、secret は次で登録する。

```sh
mise exec -- node scripts/wrangler.mjs secret put LINE_LOGIN_CHANNEL_SECRET
```

スコープは `openid profile`。開発中のチャンネルはチャンネルの開発メンバーでテストし、一般利用者への公開時にチャンネルを公開する。
LINE Login では所属グループ全体を取得できないため、bot が把握しているトーク（初期実装は直近100件まで）を参加確認の候補にする。
一覧にない場合は bot を招待してグループで発言し、「更新」を押す。詳細は [ADR 0008](docs/adr/0008-line-login-portal.md)。

初めて使う人は [公式アカウントを友だち追加](（非公開設定の LINE_FRIEND_URL）) し、対象グループに bot を招待する。ポータルにも追加用 QR コードと招待の案内を設置している。

OAuth 認可サーバーは `@cloudflare/workers-oauth-provider` と `OAUTH_KV` を使う。MCP クライアントの同意を得てから LINE に遷移し、認可コードとトークンを発行する。PKCE S256 が必要。アクセストークンは1時間、接続・更新トークンは30日間で、更新トークンはローテーションする。

| 用途 | パス |
| --- | --- |
| MCP 接続先 | `/mcp` |
| 保護リソースメタデータ | `/.well-known/oauth-protected-resource/mcp` |
| OAuth サーバーメタデータ | `/.well-known/oauth-authorization-server` |
| 動的クライアント登録 | `/oauth/register` |
| 接続の同意 | `/authorize` |
| トークン交換・更新 | `/oauth/token` |

MCP ツールは次を公開する。

- `list_conversations`：参加トークのID・名前・記録件数・記録の開始/終了日時。
- `search_knowledge`：トークを指定した意味検索。送信済み bot 回答も含め、`sender_role`（`user` / `bot`）・表示名・返信先IDを返す。任意の発言日時範囲 `from` / `before`（Unixミリ秒）に対応。
- `get_recent_messages`：指定トークの直近の未取消メッセージを bot 回答も含め時系列で取得。bot の本文は省略せず返す。`sender_role` と `reply_to_message_id` で bot 自身の発言と回答先を区別する。

bot の提案・回答は、人間が決定・同意した事実とは区別して扱う。既存の送信済み回答も履歴に移し、順次索引化する。質問や根拠の取消後は関連する bot 回答も取得対象から外す。詳細は [ADR 0010](docs/adr/0010-bot-messages-mcp.md)。

索引化ジョブは毎分最大100件を100件単位でキューに投入し、最大5件を同時処理する。処理中のジョブには10分のロックを付け、重複配送によるモデルの二重呼び出しを防ぐ。送信済みジョブの再投入は10分経過後とし、月額・日次予算は維持する。

### アップロードするナレッジ

ポータルの「ナレッジをアップロード」で、タイトルとファイル、またはノート等からコピーした本文を登録し、利用するチャットをチェックする。

- PDF / Office 文書 / UTF-8 テキスト・Markdown・CSV / JPEG・PNG・WebP に対応する。ファイル10MB・画像4MB・PDF10ページ・抽出本文40,000文字まで。原本は非公開 R2 に保存する。
- 原本を一度だけ解析・埋め込みし、チェックしたチャットの検索で利用する。複数チャットでも埋め込みを再利用する。チェックなしの資料は本人だけが管理できる状態で保存する。
- チャットの参加者は、他人が登録した資料でも、そのチャットの利用チェックを外したり再び付けたりできる。チェック状態はチャット全体に適用する。他人の資料を別チャットに共有追加することはできない。
- 他人の資料は削除できない。アップロードした本人の削除は、すべてのチャットでの利用と原本を対象とする。
- チェックを外すと、そのチャットの検索・回答・過去回答の再利用から即座に除外する。既に LINE に送信済みの文章を取り消す機能ではない。
- MCP の検索結果には `document_id` / `document_title` / `sourceUrl` を付け、bot 回答にも全文リンクを添える。資料の登録日時は会話での発言日時・出来事の日付とは区別する。

全文ページ `/knowledge/<id>?conversationId=<トークID>` は LINE ログイン必須。関連付いたチャットに現在参加していれば、アップロード者以外でも全文を閲覧・編集できる。利用チェックを外しても、チャット参加者の全文閲覧・編集は維持する。編集は全共有先に反映し、同時編集の上書きは拒否する。旧版を即座に無効化して新版を再索引化する。編集対象は抽出本文で、アップロード原本は保持する。

詳細は [ADR 0012](docs/adr/0012-uploaded-knowledge.md)。

### 1対1トークのリッチメニュー

スマートフォン版 LINE の LINE Talk bot の1対1画面に「管理画面」「ナレッジ追加」「利用状況」を表示する。ナレッジ追加はアップロード欄へ進み、未ログインの場合もログイン後に戻る。「利用状況」は無料の定型コマンドを送る。リッチメニューは PC 版 LINE には表示されない。

画像とタップ範囲はリポジトリで管理し、デプロイ後の Cron が Messaging API でバージョンごとに一度設定する。以前の API 既定メニューIDは D1 に保持し、既存メニューを削除しない。適用後は手動変更を毎分上書きしない。画像を変更するときは `RICH_MENU_VERSION` を更新する。画像の再生成は `scripts/render-rich-menu.py`（Pillow と日本語フォントが必要）。

詳細は [ADR 0013](docs/adr/0013-line-rich-menu.md)。

### 過去のトーク履歴の取り込み

1. LINE アプリからトーク履歴を日本語の `.txt`（UTF-8）として書き出す。
2. ポータルでログインし、「履歴インポート」→「過去のトークを取り込む」で取り込み先とファイルを選ぶ。
3. 「内容を確認」で書き出しのトーク名・取り込み先・件数・期間を確認し、「このトークに取り込む」を押す。

2MB・20,000発言まで対応する。途中で閉じた場合も同じファイルの再アップロードで再開できる。同一の書き出し発言は重複登録しない。原本を非公開 R2 に保存し、D1 には表示名・発言日時・元の行番号を保持する。検索用の索引化は既存のキュー・予算上限で順次処理する。

「履歴インポート」の上部に、参加中のトークの最新20ファイルと、取り込み・検索反映済み・予算待ち・失敗などの件数を表示する。画面を開くか「更新」を押すと再取得する。件数はジョブ状態の変更と同じトランザクションで更新するカウンタを読み、メッセージの再集計は行わない。詳細は [ADR 0015](docs/adr/0015-history-import-progress.md)。

画像・添付の実体はテキスト書き出しに含まれない。表示名を LINE ユーザーIDと同一視せず、Webhook の既存発言との照合や送信取消の同期は行わない。詳細は [ADR 0003](docs/adr/0003-history-import.md)。

1対1の過去の記録への質問は、検索せずに「見つからない」と回答できないようにする。最初の検索では質問文とモデルが短く言い換えた検索語を併用し、候補の前後の発言も取得する。追加の前後確認は MCP / 1対1の `get_message_context` で行える。検索後は今回の結果を優先し、過去の bot 回答や別の年の旅行を混同しない。詳細は [ADR 0016](docs/adr/0016-direct-history-retrieval.md)。

### Cloudflare の API クライアント向け設定

`workers.dev` では共有の Browser Integrity Check により Python の標準 User-Agent などが Error 1010 になることがある。新ドメインでも既定のゾーン設定によって同じ制限があるため、Cloudflare の `example.com` → Rules → Configuration Rules に次を設定する。

- 条件: `http.host eq "line-talk.example.com"`
- 設定: Browser Integrity Check を Off

この設定は Wrangler の OAuth 権限では編集できないためダッシュボードで管理する。ドメイン全体の設定は変更しない。設定後、標準 User-Agent の Python `urllib.request.urlopen("https://line-talk.example.com/.well-known/oauth-authorization-server")` が 200、未認証の `/mcp` が OAuth の 401 を返すことを確認する。詳細は [ADR 0009](docs/adr/0009-custom-domain.md)。

### 運用者の固定スコープトークン

未認証の `/search` と `/mcp` は拒否する。参照可能なグループを指定してトークンを発行する：

```sh
mise exec -- node scripts/create-search-client.mjs --conversation C0123456789abcdef0123456789abcdef
mise exec -- node scripts/search.mjs '集合場所は？'
```

`--conversation` は繰り返し指定できる。実際の会話IDは D1 の `messages.conversation_id` で確認する。
トークンは Git 対象外の `data/search-client.json` に保存し、サーバーにはハッシュのみ登録する。既存ファイルを自動上書きしない。
他人に渡すトークンは、その人が参照してよいグループだけに制限する。トークンを失効させるには対象の `search_clients.revoked_at` を設定する。

- HTTP：`POST /search`、`Authorization: Bearer <token>`、JSON `{ "query": "...", "conversationId": "..." }`
- MCP：`https://line-talk.example.com/mcp` に同じ Bearer ヘッダーで接続
- 管理用トークンでは認可済みの固定スコープを維持する。通常利用者はポータルの OAuth 接続を使う。

## bot との1対1トーク

LINE Talk bot にテキストを直接送ると、メンションなしで回答する。例：「参加しているトークは？」「家族グループ の最近の買い物の話を教えて」「去年の旅行はどこに行ったっけ」。モデルは Workers AI の `@cf/zai-org/glm-5.3-flash` を推論強度 low で使用する。最大3回の推論・4回のツール呼び出しを許し、最終推論は回答専用の型とプロンプトへ切り替える。

LINE Webhook のユーザーIDで本人を識別し、MCP と同じ参加確認を行う。現在本人と bot が参加するトーク一覧・直近履歴・意味検索をモデルが選んで使う。参加トークの直近会話を毎回読み直し、前の話題だけに検索範囲を固定しない。1対1の直近の対話も引き継ぎ、過去の bot 回答を使う場合は参照元トークへの現在のアクセスを確認する。bot の提案と人間の決定は区別する。1対1では引用付きの返信にせず、通常のメッセージで返す。グループ内のメンション回答は従来どおり、そのグループだけを参照する。

- ユーザー別に、生成と検索用埋め込みの見積り料金を直近24時間で集計する。日付変更で一斉リセットせず、古い利用分から順に対象外になる。
- $0.40 以上では返信に「直近24時間の利用量の80%に達しました」を添える。
- $0.50 以上では通常の質問への返信を停止する。呼び出し前に費用枠を予約するため、残りが予約額に足りない場合もモデルを呼ばない。
- 「利用状況は」「今の利用状況を教えて」「利用率は？」「いまどのくらい使った？」「残り予算」「usage」には、上限到達後もモデルを使わず利用額・残額を返す。
- 推論の正常終了時に予約額をトークン数による見積りへ更新する。処理中・失敗・使用量不明の呼び出しは予約額を含める。LINE・D1・R2・Queues 等のインフラ料金は含めない。
- アプリ全体の月 $5・日次の処理上限も引き続き適用する。1対1の過去本文は D1 から読み、本文や回答の自動埋め込みは行わない。
- `ping` → `pong` はモデルを呼ばず維持する。現段階の1対1アシスタントはテキスト入力に対応する。

権限と料金制御は [ADR 0011](docs/adr/0011-direct-chat-assistant.md)、現在のモデルと実行制御は [ADR 0017](docs/adr/0017-glm-direct-harness.md) を参照。モデル変更前には [評価ハーネス](eval/README.md) を使い、`mise exec -- npm run eval:direct -- --live --models glm --max-usd 0.10` で私有データを送信せずライブ回帰試験を実行できる。

## D1 の利用量

料金判定は `ai_usage_totals` の月別・日別集計を主キーで参照する。詳細の `ai_usage` は監査用に残し、予約・実績反映と集計値の更新を同じ D1 バッチで実行する。定期処理は未登録メッセージと配送期限が来たジョブのインデックスを使う。権限確認だけの際には全履歴の件数集計をしない。

会計方式の変更・旧版へのロールバック・監査行の直接修正後は、既存リクエストの終了を待って次で集計を再照合する。

```sh
mise exec -- wrangler d1 execute DB --remote --file scripts/rebuild-ai-usage-totals.sql
```

D1・R2・Queues 等のインフラ料金は AI の月額予算とは別である。無料枠の上限を使い切ると、AI 予算が残っていてもログイン・記録・検索に影響する。詳細は [ADR 0014](docs/adr/0014-d1-read-efficiency.md)。

## LINE での質問

LINE のメンション操作で bot を選び、`@bot 集合場所はどこ？` のように送る。
単に表示名を文字として打つだけではメンションにならない。
bot の回答に LINE のリプライ機能で返信すると、メンションなしでも会話を続けられる（対応後に送られた bot の回答が対象）。
ただし bot の回答へのリプライでも、他人へのメンションが含まれていれば返答しない。
他人の発言にリプライしながら bot をメンションすると、引用先の発言や解析済みの添付内容を優先して参照する。
同じグループの発言・添付の抽出文だけを検索し、資料番号付きの短い回答を返す。
記録だけで足りない説明やおすすめはモデルの一般知識で具体化し、記録の事実と一般的な提案を区別する。Web 検索は行わない。
個人の旅行先・贈り物の日付などは記録の根拠が必要で、一般知識から推測しない。
直近20件のテキストは D1 から直接読み、検索で見つかった発言の前後も補う。
過去の質問で根拠が不足すると、モデルが検索語・人名等のキーワード・必要な発言期間を選び、1回だけ追加検索する。
「去年」は質問日時を基準にするが、出来事の時期と発言日時を区別する。期間内で見つからなければ全期間へ広げる。
bot 宛てのメンションや bot の回答へのリプライ以外には回答しない。処理上限・一時的な障害は固定文で通知する。

回答生成は記録後にバックグラウンドで行い、reply token は保存しない。通信遅延や期限切れによって返信できない場合がある。
会話全体の要約は行わない。元発言の取消後、既に LINE に送信済みの回答自体を自動で取り消すことはできない。

## ライセンス

Copyright (c) 2026 shao.

[GNU Affero General Public License v3.0 only](LICENSE)（`AGPL-3.0-only`）。

## 個人情報の扱い

実際の設定、秘密情報、チャット履歴、評価結果は Git に追加しないでください。
`wrangler.private.jsonc`、`.dev.vars`、`data/`、`imports/`、`exports/` は Git 管理外です。
本リポジトリの例にあるトーク名・ドメイン・リソースIDは架空のものです。
