# ADR 0004: Webhook で発言を保存し ping に pong を返す

- 日付: 2026-11-01
- 状態: 採用

## 背景

LINE → Workers → D1 と LINE への返信を、LLM なしの最小構成で動作確認したい。

## 決定

- `POST /webhook` の生のリクエスト本文を HMAC-SHA256 で検証し、検証後に JSON を解釈する。本文は 1 MiB までとする。
- `message` イベントのID、グループ等の会話ID、取得できた発言者ID、種別、日時を D1 に保存する。
- テキスト本文を保存する。非テキストはメタデータのみ保存し、画像・音声・ファイルの実体は取得しない。
- 本文が厳密に `ping` のテキストに、Reply API で `pong` を返す。空白除去・大文字小文字変換はしない。
- グループ・旧 room・1対1に対応する。standby モードでは返信しない。
- メッセージIDと Webhook イベントIDを一意にし、再送による重複保存を防ぐ。返信成功日時を記録し、成功済みの発言には再返信しない。
- 保存と短時間の返信を await し、失敗したら 5xx を返す。返信失敗時も会話原文は残し、再送時に返信を試行できるようにする。
- `unsend` では本文を NULL にし、取消記録で遅延した元発言の再保存も防ぐ。バックアップの保持期間内の消去は別途の運用課題とする。
- 生イベントと reply token は保存しない。ログに本文やシークレットを出さない。
- 秘密情報は `.dev.vars` または Workers secrets で設定する。

## 結果と制限

Queues を増やさずに開始できるが、LINE の応答遅延が Webhook に影響する。規模が増えたら受信の永続化と返信処理を Queues で分離する。
Webhook 再送は LINE 側で有効にする必要があり、配送保証はない。
Reply API と D1 は単一トランザクションにできず、API 成功直後に応答が失われると返信状態は不確定になる。reply token は一度しか使えず、期限切れ後の返信も保証しない。
発言の編集イベント、プロフィール取得、bot 自身の送信履歴、過去ログ取り込み、ナレッジ整理、MCP、意味検索は今回の範囲外。
Worker と D1 は対象アカウントを固定し、LINE 本番確認には Channel Secret / Channel Access Token と Webhook URL の設定が必要。

## 参照

- https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/
- https://developers.line.biz/en/docs/messaging-api/receiving-messages/
- https://developers.line.biz/en/reference/messaging-api/#send-reply-message
