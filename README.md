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

現在は、署名検証付き Webhook、D1 への発言保存、`ping` → `pong`、添付の R2 保存、送信取消による本文・添付削除を実装している。
MCP・Vectorize・ナレッジ整理・過去ログ取り込みは今後実装する。

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

テストはローカルの Workers / D1 実行環境を使い、LINE API への送信をモックする。実際のチャットには投稿しない。
固定した workerd が対応する日付に合わせ、互換日付は `2026-10-30` としている。

## Cloudflare / LINE への接続

対象は `operator@example.com` のアカウント。D1 `line-group-talk` は作成済みで、ID は `wrangler.jsonc` に設定している。
ローカルの D1 とリモートの D1 は別のデータベース。
R2 `line-group-talk-attachments` と Queues `line-group-talk-attachments` / `line-group-talk-attachments-dlq` も作成済み。
リソース名は `wrangler.jsonc` に設定し、ローカル開発・テストではローカルの R2 / Queues を使用する。

```sh
mise exec -- npm run db:remote
mise exec -- npm run deploy
mise exec -- wrangler secret put LINE_CHANNEL_SECRET
mise exec -- wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
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
- Queue への投入に失敗しても D1 の処理待ちは残り、Cron が5分ごとに再投入する。
- 取消時は D1 上で直ちに削除待ちにし、R2 実体は非同期削除する。保存中の取消・再送でも復活しないよう最新状態を確認する。
- 削除失敗は `delete_pending` のまま再試行する。取得失敗が上限に達した場合は DLQ と `last_error_code` を確認する。
- LINE 側で取得期限を過ぎた添付は保存できない。過去に受信した添付の遡及取得、外部 content provider、アルバム・ノートは対象外。
- OCR・画像理解などの AI 処理は行わない。

本文やファイル名を出さずに保存状態を確認する：

```sh
mise exec -- wrangler d1 execute DB --remote --command 'SELECT m.message_id, m.source_type, a.status, a.size_bytes, a.last_error_code FROM attachments a JOIN messages m USING(message_id) ORDER BY m.received_at DESC LIMIT 20;'
```

取得が `failed` になった場合、認証・サイズ制限などの原因を修正後、対象の `attachments` 行を `status = 'pending', queued_at = NULL` に戻せば Cron が再投入する。
DLQ は Cloudflare Dashboard の Queues で確認する。削除待ちが長時間残る場合も運用確認が必要。
