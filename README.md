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

現在は、署名検証付き Webhook、D1 への発言保存、`ping` → `pong`、送信取消による本文削除を実装している。
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
- テキストは日時・会話ID・発言者IDとともに保存する。非テキストは種別等のメタデータのみ。
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
