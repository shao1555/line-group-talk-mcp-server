# LINE Group Talk MCP Server

LINE の会話・添付・アップロード資料を記録し、LINE 上の bot と外部の MCP クライアントから検索・参照するサーバーです。Cloudflare Workers / D1 / R2 / Vectorize / Queues / Workers AI で動作します。

## 実装済みの機能

| 機能 | 内容 |
| --- | --- |
| 会話の記録 | 署名を検証した Webhook から、グループ・旧 room・1対1の発言を D1 に保存。`ping` に `pong` を返信 |
| 添付の保存・解析 | 画像・動画・音声・ファイルを非公開 R2 に保存。OCR・画像説明・文字起こし・本文抽出を非同期実行 |
| 検索 | 発言・添付の抽出文・共有資料・グループ内の bot 回答を Vectorize に索引化 |
| グループでの質問 | bot へのメンションや bot 回答へのリプライに、そのトークの記録と一般知識を使って回答 |
| 1対1のアシスタント | 本人と bot が参加するトークを横断して検索。ユーザー別の直近24時間予算を適用 |
| 管理ポータル | LINE ログイン、参加トークの確認、ナレッジ管理、履歴インポートと進捗表示、MCP 接続の解除 |
| 過去ログの取り込み | LINE の日本語テキスト書き出しをインポート。同じファイルでの再開と重複登録の防止に対応 |
| 共有ナレッジ | ファイルやノート本文をアップロードし、チャットごとに利用を設定。認証付きの全文閲覧・共同編集 |
| MCP | OAuth / DCR による接続、トーク一覧・意味検索・直近履歴・発言前後の取得 |
| 送信取消への対応 | 受信した取消イベントに基づき、本文・添付・抽出文・索引と、それを根拠にした bot 回答を無効化 |

会話全体の継続的な要約、決定事項・タスクの自動整理、明示起動する整理用スキルは未実装です。Web 検索、LINE のアルバム・ノートの自動取得、Computer Use による履歴取得も実装していません。ノートの内容はポータルから手動登録できます。

## 構成

| サービス | 用途 |
| --- | --- |
| Workers | LINE Webhook、ポータル、認証、MCP、bot の回答処理 |
| D1 | 会話原文、bot 回答、参加情報、資料の本文・共有設定、ジョブ状態、料金見積り |
| R2 | LINE 添付、インポートした履歴、アップロード資料の原本。バケットは非公開 |
| Queues / Cron | 添付取得・解析・索引化・削除の実行、処理待ちや失敗した配送の再投入 |
| Vectorize | 会話IDごとの namespace に分離した意味検索 |
| Workers AI | 埋め込み、OCR・画像説明、文字起こし、回答生成、文書の Markdown 変換 |
| KV | MCP の OAuth 認可情報 |

検索結果は D1 の最新状態と照合し、取消済み発言、無効な資料、旧版の資料を返さないようにしています。bot の提案・回答は、人間の決定や同意とは区別します。

設計判断は [ADR 一覧](docs/adr/README.md) を参照してください。

## セットアップ

以下のドメイン・IDはすべて設定例です。自分の環境の値に置き換えてください。

### 1. 開発ツールを準備する

Node.js と Wrangler のバージョンは [mise.toml](mise.toml) で固定しています。

```sh
mise install
mise exec -- npm ci
mise exec -- wrangler login
mise exec -- wrangler whoami
```

別の Cloudflare アカウントでログインしている場合は、`mise exec -- wrangler logout` 後にログインし直します。

### 2. 非公開の設定ファイルを作る

```sh
cp wrangler.jsonc wrangler.private.jsonc
cp .dev.vars.example .dev.vars
```

[wrangler.jsonc](wrangler.jsonc) は公開用の設定例です。本番の値は Git 管理外の `wrangler.private.jsonc` に設定します。

| 設定 | 内容 |
| --- | --- |
| `account_id` | 使用する Cloudflare アカウントID |
| `routes` | 独自ドメインを使う場合の Custom Domain |
| `vars.PORTAL_ORIGIN` | ポータル・MCP の正規オリジン。例：`https://line-talk.example.com` |
| `vars.LEGACY_PORTAL_ORIGIN` | 互換接続を残す旧オリジン。旧URLがなければ `PORTAL_ORIGIN` と同じ値 |
| `vars.LINE_LOGIN_CHANNEL_ID` | 同じ LINE プロバイダー内に作成した LINE Login チャンネルのID |
| `vars.LINE_FRIEND_URL` | 公式アカウントの `https://lin.ee/…` 形式の友だち追加リンク。省略時は追加ボタンを表示しない |
| `vars.LINE_FRIEND_QR_URL` | `https://qr-official.line.me/…` 形式の QR 画像URL。省略時は画像を表示しない |
| 各リソースのID・名前 | 次の手順で作成する D1 / KV / R2 / Queues / Vectorize の設定 |

`npm run dev` / `deploy` / `db:local` / `db:remote` は、`wrangler.private.jsonc` があれば優先して使います。`scripts/create-search-client.mjs` とライブ評価ハーネスも同様です。

`npm run types` / `check` とテストは、公開用の `wrangler.jsonc` を使います。バインディングを追加する場合は、公開用・非公開用の両方に反映してください。

直接 Wrangler を実行する場合も、対象の設定を指定します。次のラッパーを使うと npm scripts と同じ設定を選べます。

```sh
mise exec -- node scripts/wrangler.mjs --help
```

### 3. Cloudflare のリソースを作る

Wrangler または Cloudflare Dashboard で次のリソースを作成し、ID・名前を `wrangler.private.jsonc` に設定します。

| リソース | 設定例 |
| --- | --- |
| D1 | `line-group-talk`。`database_id` を設定し、`migrations_dir` は `migrations` |
| R2 | `line-group-talk-attachments` |
| Queues | `line-group-talk-attachments` / `line-group-talk-knowledge` と、それぞれの `-dlq` |
| Vectorize | `line-group-talk-knowledge`。BGE-M3 用の1024次元。日時フィルター用に `sent_at` の number 型メタデータインデックスも作成 |
| KV | `OAUTH_KV` バインディングの namespace。発行された `id` を設定 |
| Workers AI | `AI` バインディングを使用 |

ナレッジ用キューの名前 `line-group-talk-knowledge` は、現状では `src/index.ts` の配送先判定にも使っています。変更する場合はコードと設定の両方を変更してください。

### 4. LINE のチャンネルを準備する

1. LINE 公式アカウントの Messaging API を有効にします。
2. **Messaging API と同じプロバイダー**内に、ウェブアプリ用の LINE Login チャンネルを作成します。
3. LINE Login のコールバックURLに `https://line-talk.example.com/auth/line/callback` を登録します。
4. `LINE_LOGIN_CHANNEL_ID` を非公開設定に記入し、次の秘密情報を `.dev.vars` に設定します。

| 秘密情報 | 取得元 |
| --- | --- |
| `LINE_CHANNEL_SECRET` | Messaging API チャンネルの Channel Secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API の Channel Access Token |
| `LINE_LOGIN_CHANNEL_SECRET` | LINE Login チャンネルの Channel Secret |

LINE Login のスコープは `openid profile` です。開発中のチャンネルでは開発メンバーで動作確認し、一般利用者に提供する際はチャンネルを公開します。

旧URLでの接続を維持する場合は、旧オリジンの `/auth/line/callback` も登録したままにします。MCP の接続先オリジンを変更すると issuer / resource も変わるため、新URLでの再認可が必要です。

### 5. デプロイして Webhook を接続する

```sh
mise exec -- npm run db:remote
mise exec -- npm run deploy
mise exec -- node scripts/wrangler.mjs secret put LINE_CHANNEL_SECRET
mise exec -- node scripts/wrangler.mjs secret put LINE_CHANNEL_ACCESS_TOKEN
mise exec -- node scripts/wrangler.mjs secret put LINE_LOGIN_CHANNEL_SECRET
```

`secret put` の対話入力で値を登録します。`.dev.vars` の値はデプロイ時に自動アップロードされません。

1. LINE Developers Console の Webhook URL に `https://line-talk.example.com/webhook` を登録します。
2. Webhook URL の「検証」を実行し、Webhook の利用・再送を有効にします。
3. 公式アカウントのグループ参加を許可し、対象グループに招待します。
4. 公式アカウント側の定型的な応答メッセージを無効にします。
5. `ping` を送信して `pong` が返ること、ポータルで LINE ログインできることを確認します。

`GET /health` は稼働確認用です。DB・LINE 認証の疎通は確認しません。`POST /webhook` はシークレット未設定時に503、不正な署名には401を返します。

## ローカル開発と検証

セットアップで設定ファイルと `.dev.vars` を用意してから実行します。

```sh
mise exec -- npm run db:local
mise exec -- npm run dev
```

ローカルとリモートの D1 / R2 は別データです。`wrangler dev` の AI / Vectorize はリモートのリソースを使うため、有料推論が発生する場合があります。

```sh
mise exec -- npm run types
mise exec -- npm run check
```

`check` は型チェック、Vitest、デプロイのドライランを実行します。テストはローカルの Workers / D1 / R2 を使い、LINE API・AI・Vectorize をモックします。実際のチャットへの投稿や有料推論は行いません。

互換日付は、固定した workerd が対応する `2026-10-30` です。

## ポータルの使い方

設定した `PORTAL_ORIGIN` にアクセスし、LINE でログインします。管理画面は4つのタブに分かれています。

| タブ | 操作 |
| --- | --- |
| トーク | 本人と bot が参加するトークの確認・更新 |
| ナレッジ | 資料の登録、利用チャットの変更、全文閲覧・編集、本人が登録した資料の削除 |
| 履歴インポート | 過去ログの取り込み、取り込み・索引化の進捗確認 |
| 接続設定 | MCP 接続先の確認、認可したアプリの一覧・解除 |

初めて使う人は公式アカウントを友だち追加し、記録対象のグループに bot を招待します。友だち追加用のリンク・QRコードは、運用者が設定するとポータルに表示されます。

### 参加トークとアクセス権

LINE Login から全所属グループを取得することはできないため、bot が把握しているグループ・旧 room を候補に、LINE API で現在の参加を確認します。現在の実装では、活動日時が新しい最大100トークを確認します。

本人と bot がともに参加する確認済みトークが、OAuth MCP 接続と1対1アシスタントの参照対象です。過去の発言者一覧をアクセス権として流用しません。退出や参加確認の失敗時にはアクセスを許可しません。

トークが見つからない場合は、bot を招待してグループで一度発言し、ポータルの「更新」を押してください。1対1の会話履歴は、この参加トーク一覧や通常の MCP 検索の対象には含めません。

### 過去のトーク履歴を取り込む

1. LINE アプリから、日本語形式のトーク履歴を `.txt`（UTF-8）で書き出します。
2. 「履歴インポート」で取り込み先のトークとファイルを選びます。
3. 「内容を確認」でトーク名・件数・期間を確認し、「このトークに取り込む」を押します。

1ファイル2 MiB・20,000発言まで対応します。画面を閉じた場合は、同じファイルを選ぶと再開できます。同一の書き出し発言は重複登録しません。

原本は非公開 R2 に保存し、D1 には本文・表示名・発言日時・元の行番号を記録します。索引化はキューと予算上限に従って順次実行します。

タブの上部には、参加トークの最新20ファイルの取り込み件数、検索反映済み・予算待ち・失敗などの件数を表示します。タブを開くか「更新」を押すと再取得します。進捗は状態別カウンタで管理し、画面表示のたびに全履歴を集計しません。

画像・添付の実体は書き出しに含まれません。表示名を LINE ユーザーIDに対応付けること、Webhook で保存済みの発言との重複照合、取り込んだ発言と LINE の送信取消との同期は行いません。

### ナレッジを登録・共有する

「ナレッジ」で、タイトルとファイル、またはノートなどからコピーした本文を登録し、利用するチャットを選びます。PDF / 対応 Office 文書 / UTF-8 テキスト・Markdown・CSV・JSON / JPEG・PNG・WebP などに対応します。

- 原本の解析・埋め込みは一度行い、選択したチャットで再利用します。チャット未選択の資料は、登録者だけが管理できる状態で保存します。
- 参加者は、他人の資料でも、そのチャットでの利用を有効・無効にできます。この設定はチャット全体に適用します。他人の資料を別チャットに共有追加することはできません。
- 削除できるのは登録者本人だけです。削除すると、原本とすべてのチャットでの利用が対象になります。
- 利用を無効にすると、そのチャットの検索・回答と過去回答の再利用から除外します。既に LINE に送った文章を取り消す機能ではありません。

MCP の検索結果には `document_id` / `document_title` / `sourceUrl` を付け、bot 回答にも全文リンクを添えます。資料の登録日時は、会話の発言日時や出来事の日付とは区別します。

全文ページ `/knowledge/<id>?conversationId=<トークID>` は LINE ログイン必須です。登録者と、関連チャットの現在の参加者が全文を閲覧・編集できます。利用チェックを外しても、そのチャットの参加者による閲覧・編集は維持します。

編集は抽出本文に対して行い、アップロード原本は変更しません。変更は全共有先に反映し、旧版を無効化して新版を再索引化します。同時編集で古い版を上書きしようとすると拒否します。

## LINE で bot に質問する

### グループ内での質問

LINE のメンション操作で bot を選び、`@bot 集合場所はどこ？` のように送ります。表示名を文字として打つだけではメンションになりません。通常の発言は記録のみ行い、bot 宛ての質問には、そのグループの履歴・添付抽出文・有効な共有資料を使って回答します。

bot の回答へのリプライは、メンションなしでも会話を続けられます。他人へのメンションが明示されている場合は返答しません。他人の発言へのリプライに bot のメンションを付けると、引用先の発言や解析済み添付を優先して参照します。

直近の会話を優先し、過去の質問で根拠が足りなければ、検索語・キーワード・発言期間を変えて追加検索します。発言日と出来事の日付を区別し、期間を絞って見つからなければ全期間へ広げます。

記録で足りない説明やおすすめは、モデルの一般知識で補い、記録上の事実と区別します。個人の旅行先や贈り物の日付は記録を根拠とし、一般知識から推測で補わない方針です。Web 検索は行いません。

### 1対1での質問

bot にテキストを直接送ると、メンションなしで回答します。例：「参加しているトークは？」「家族グループの最近の買い物の話を教えて」「去年の旅行はどこに行ったっけ」。1対1では引用付きの返信にせず、通常のメッセージで返します。

モデルは GLM-5.3-Flash（`@cf/zai-org/glm-5.3-flash`、推論強度 low）です。参加トークの直近履歴と1対1の直近の対話を参照し、必要に応じてトーク一覧・検索・発言前後の取得を使います。最大3回の推論・4回のツール呼び出しで、最後の推論は回答専用です。

1対1の本文と bot 回答は D1 に保存しますが、自動埋め込みはしません。過去の bot 回答を再利用する際も、参照元トークへの現在のアクセスを確認します。現時点ではテキストでの質問に対応します。

| 直近24時間のユーザー別見積り額 | 動作 |
| --- | --- |
| $0.40 未満 | 通常どおり回答 |
| $0.40 以上 | 回答に「直近24時間の利用量の80%に達しました」を追加 |
| $0.50 以上 | 通常の質問への回答を停止 |

生成と検索用埋め込みの見積りを集計します。呼び出し前に費用を予約するため、上限未満でも残額が予約額に足りなければ呼び出しません。正常終了時は使用トークン数による見積りへ更新し、処理中・失敗・使用量不明の場合は予約額を含めます。24時間を過ぎた利用分から順に集計対象外になります。

「利用状況は」「残り予算」「usage」などの問い合わせには、上限到達後もモデルを使わず利用額・残額を返します。厳密に `ping` と送った場合の `pong` もモデルを使いません。アプリ全体の予算上限も別途適用します。

### リッチメニュー

1対1のリッチメニューから「管理画面」「ナレッジ追加」「利用状況」に進めます。未ログインでも、ログイン後にナレッジ登録画面へ戻ります。

デプロイ後の Cron が、画像とタップ範囲をバージョンごとに一度設定します。適用済みメニューの手動変更を毎分上書きせず、既存メニューも削除しません。画像変更時は `src/rich-menu.ts` の `RICH_MENU_VERSION` を更新します。画像の再生成には `scripts/render-rich-menu.py`、Pillow、日本語フォントを使います。

## MCP クライアントから使う

MCP クライアントに `https://line-talk.example.com/mcp` を追加し、ブラウザーで接続に同意して LINE ログインします。OAuth / DCR 対応クライアントではトークンの手動発行は不要です。

本人と bot がともに参加する把握済みトークが参照対象です。接続時にトークを固定選択する方式ではなく、手元のエージェントがツールでトークを選びます。後から参加したトークも対象となり、接続はポータルから解除できます。

| ツール | 用途 |
| --- | --- |
| `list_conversations` | 参照できるトークのID・名前・記録件数・最初と最後の記録日時 |
| `search_knowledge` | 指定トークの意味検索。任意の発言日時範囲 `from` / `before`（Unixミリ秒）に対応 |
| `get_recent_messages` | 指定トークの直近の未取消メッセージを時系列で取得。最大50件 |
| `get_message_context` | 発言IDを指定し、そのトーク内の前後を時系列で取得。最大20件 |

送信済み bot 回答も取得対象です。`sender_role`（`user` / `bot`）、表示名、`reply_to_message_id` で発言者と回答先を区別します。質問や根拠が取り消された bot 回答、共有が無効になった資料に基づく回答は取得対象から外します。

アクセストークンは1時間、接続・更新トークンは30日間です。PKCE S256 に対応し、更新トークンはローテーションします。

| 用途 | パス |
| --- | --- |
| MCP 接続先 | `/mcp` |
| 保護リソースメタデータ | `/.well-known/oauth-protected-resource/mcp` |
| OAuth サーバーメタデータ | `/.well-known/oauth-authorization-server` |
| 動的クライアント登録 | `/oauth/register` |
| 接続の同意 | `/authorize` |
| トークン交換・更新 | `/oauth/token` |

### 運用者用の固定スコープトークン

OAuth 接続とは別に、参照する会話IDを指定した管理用トークンも発行できます。

```sh
mise exec -- node scripts/create-search-client.mjs --conversation C0123456789abcdef0123456789abcdef
mise exec -- node scripts/search.mjs '集合場所は？'
```

`--conversation` は繰り返し指定できます。トークンは Git 管理外の `data/search-client.json` に保存し、サーバーにはハッシュのみを登録します。既存ファイルは上書きしません。

このトークンは発行時の固定スコープを使い、LINE ログイン接続のような本人の参加確認はしません。通常利用者には OAuth 接続を使います。失効させるには `search_clients.revoked_at` を設定します。

- HTTP：`POST /search`、`Authorization: Bearer <token>`、JSON `{ "query": "...", "conversationId": "..." }`
- MCP：`/mcp` に同じ Bearer ヘッダーで接続

## 添付解析・索引化と料金上限

添付取得とナレッジ処理は別キューで非同期に行います。索引反映前の発言・資料は意味検索に出ない場合があります。Cron は毎分、処理待ちのナレッジジョブを最大100件投入し、キューは最大5件を同時処理します。1件のジョブが複数のモデル呼び出しを行う場合があり、これは API 呼び出し数の毎分上限ではありません。

処理中ジョブと送信済みジョブの再投入には10分のロック・待ち時間を設け、重複配送を制御します。

| 対象 | 処理 |
| --- | --- |
| 発言・UTF-8 テキスト・CSV・JSON | 本文を分割し、BGE-M3 で埋め込み |
| JPEG / PNG / WebP | Mistral Small 3.1 で文字抽出・画像説明 |
| 音声・動画 | Whisper Large V3 Turbo で日本語文字起こし。取得できた再生時間が必要 |
| PDF・対応 Office 文書 | Markdown Conversion で本文抽出。本文のない PDF は上限付き画像変換 |
| グループ内の回答生成 | Mistral Small 3.1 |
| 1対1の回答生成 | GLM-5.3-Flash |

### 処理サイズと制限

| 項目 | 上限 |
| --- | --- |
| LINE 添付の原本保存 | 既定100 MiB（`MAX_ATTACHMENT_BYTES`） |
| 解析するファイル・アップロード資料 | 10 MiB、画像4 MiB、PDF10ページ |
| 音声・動画の解析 | 既定10分（`AI_MAX_AUDIO_SECONDS`） |
| 抽出本文 | 40,000文字。LINE 添付は打ち切りを明記、アップロード資料は超過時に解析失敗 |
| 履歴インポート | 2 MiB・20,000発言 |

時間不明の音声、暗号化PDF、非対応形式などは解析できません。LINE 添付では原本だけ保存される場合があります。OCR・画像説明・文字起こしには誤りがあり得ます。

### アプリ全体の AI 上限

`wrangler.private.jsonc` の変数で変更できます。

| 変数 | 既定値 |
| --- | --- |
| `AI_MONTHLY_BUDGET_USD` | 月 $5。0ではモデル呼び出しを保留 |
| `AI_DAILY_IMAGES` | 日20画像。PDF画像変換はページ数換算 |
| `AI_DAILY_AUDIO_SECONDS` | 日3,600秒 |
| `AI_DAILY_EMBEDDING_BYTES` | 日500,000 UTF-8 bytes |
| `AI_DAILY_ANSWERS` | 日100回の回答生成モデル呼び出し。1質問で複数回消費する場合あり |

日・月の境界は UTC です。索引化の予算待ちは `budget_wait` として Cron が再確認し、その間も記録・原本保存は続けます。失敗・応答不明の呼び出しも予約額を消費する扱いです。

料金はアプリ内の保守的な見積りで、Cloudflare の請求上限を強制するものではありません。無料枠の控除や料金改定、D1 / R2 / Queues / Vectorize 等の料金は含めません。

## 運用と障害確認

本文・ファイル名を出さずに状態を確認する例です。すべてリモートの D1 を参照します。

```sh
mise exec -- node scripts/wrangler.mjs d1 execute DB --remote --command 'SELECT count(*) AS message_count FROM messages;'
mise exec -- node scripts/wrangler.mjs d1 execute DB --remote --command 'SELECT status, count(*) AS count FROM attachments GROUP BY status;'
mise exec -- node scripts/wrangler.mjs d1 execute DB --remote --command 'SELECT status, count(*) AS count FROM knowledge_jobs GROUP BY status;'
mise exec -- node scripts/wrangler.mjs d1 execute DB --remote --command "SELECT period, charged_microusd / 1000000.0 AS estimated_usd FROM ai_usage_totals WHERE bucket = 'all' ORDER BY period DESC;"
```

添付取得が `failed` になった場合は、認証・サイズ制限などの原因を修正し、対象行を `status = 'pending', queued_at = NULL` に戻すと Cron が再投入します。DLQ と `last_error_code` も確認してください。

ナレッジ処理を再試行する場合は、原因を修正し、対象の `knowledge_jobs` の `status = 'pending', next_attempt_at = 0, queued_at = NULL` と該当段階の試行回数をリセットします。モデル・処理バージョンの変更では、キャッシュ・チャンク・索引の再構築も必要です。

### D1 の利用量

アプリ全体の料金判定には、`ai_usage_totals` の月別・日別集計を使います。明細の `ai_usage` は監査とユーザー別24時間集計に使います。定期処理は未登録メッセージと配送期限が来たジョブのインデックスを参照し、権限確認だけの際には全履歴の件数集計をしません。

会計方式の変更・旧版へのロールバック・監査行の直接修正後には、既存リクエストの終了を待って次を実行します。

```sh
mise exec -- node scripts/wrangler.mjs d1 execute DB --remote --file scripts/rebuild-ai-usage-totals.sql
```

D1 等の上限に達すると、AI 予算が残っていてもログイン・記録・検索に影響します。詳しくは [ADR 0014](docs/adr/0014-d1-read-efficiency.md) を参照してください。

### API クライアントが Error 1010 になる場合

Cloudflare の Browser Integrity Check などで、Python の標準 User-Agent を使うクライアントが拒否される場合があります。独自ドメイン側の設定を確認し、必要ならそのホストだけを対象とする Configuration Rule で Browser Integrity Check を Off にします。

設定後は OAuth メタデータが取得でき、未認証の `/mcp` が OAuth の401を返すことを確認します。詳しくは [ADR 0009](docs/adr/0009-custom-domain.md) を参照してください。

### モデル変更の検証

モデル設定は `src/direct-model.ts` にあります。[評価ハーネス](eval/README.md) は、本番と同じプロンプト・応答検証・料金計算を使います。

```sh
mise exec -- npm run eval:direct -- --models glm,qwen,oss
mise exec -- npm run eval:direct -- --live --models glm --max-usd 0.10
```

`--live` なしでは推論を呼びません。上のライブ試験は架空の公開フィクスチャを使い、LINE への送信や本番 DB の更新は行いませんが、Cloudflare の推論料金は発生します。

## 保存・取消とプライバシー

記録対象のグループには保存と AI 処理を行うことを周知してください。

- LINE 添付の R2 キーは会話ごとに分け、ファイル名は含めません。通常の LINE 添付の HTTP ダウンロード機能は提供していません。アップロード資料の原本は認証・権限確認付きで取得できます。
- 取消時は D1 の本文・抽出文・派生回答を直ちに無効化し、R2 実体と Vectorize 索引は非同期で削除します。失敗時は削除待ちとして再試行します。
- D1 バックアップの保持期間内には取消前のデータが残る場合があります。既に LINE に送った bot 回答自体は自動で取り消せません。
- LINE 側で取得期限を過ぎた添付の遡及取得、外部 content provider、アルバム・ノートの自動取得は対象外です。
- 返信には期限と一回限りの reply token を使うため、通信障害・配送遅延時の返信は保証しません。reply token は永続化しません。

実際の設定、秘密情報、チャット履歴、評価結果は Git に追加しないでください。`wrangler.private.jsonc`、`.dev.vars`、`data/`、`imports/`、`exports/` は Git 管理外です。

## ライセンス

Copyright (c) 2026 shao.

[GNU Affero General Public License v3.0 only](LICENSE)（`AGPL-3.0-only`）。
