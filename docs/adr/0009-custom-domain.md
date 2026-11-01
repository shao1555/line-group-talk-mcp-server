# ADR 0009: MCP の公開先を独自ドメインに移す

- 日付: 2026-11-01
- 状態: 採用

## 背景

Python 標準 User-Agent のリクエストが Worker に到達する前に Error 1010 となった。Cloudflare の `workers.dev` に適用される共有の Browser Integrity Check は利用者側で無効化できない。

## 決定

- 同じ Worker に Custom Domain `line-talk.example.com` を割り当てる。新規ポータル・MCP 接続はこのドメインを使う。
- Configuration Rule の条件を `http.host eq "line-talk.example.com"` とし、Browser Integrity Check を Off にする。他のホストは対象にしない。Wrangler の OAuth 認証はルール編集権限がないため、この設定はダッシュボードで管理する。
- `workers_dev: true` を維持し、旧 LINE Webhook と既存クライアントの URL を保持する。旧ホストの共有 BIC は引き続き適用される。
- `PORTAL_ORIGIN` に新ドメイン、`LEGACY_PORTAL_ORIGIN` に旧ドメインを設定する。OAuth issuer・resource・LINE callback はリクエスト先がこれらの許可済み Origin のどちらかに応じて生成する。任意の Host を転送先に採用しない。
- LINE Login のコールバックは新旧両方を登録する。旧 issuer 用のトークンを新 issuer 用に流用せず、新 URL に接続するクライアントは再認可する。
- 同じ D1・KV・R2・Vectorize を利用し、ユーザー・接続・会話のデータは移行しない。既存の参加トーク確認と認証は維持する。

## 検証

- 両 Origin の discovery と LINE callback、および未登録 Host を認証先へ反映しないことを自動テストする。
- 新ドメインの HTTPS と OAuth discovery は本番で確認済み。BIC の例外適用前は、Python 標準 User-Agent が新旧とも 1010 となることを確認した。
- 例外適用後、Python 標準 User-Agent により discovery が 200、未認証 MCP が認証要求（WWW-Authenticate 付き）の 401 となることを本番で確認済み。ユーザー側でも接続成功を確認した。

## 参照

- https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/
- https://developers.cloudflare.com/rules/configuration-rules/settings/
- https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
