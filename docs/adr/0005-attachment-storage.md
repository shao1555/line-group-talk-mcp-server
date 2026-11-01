# ADR 0005: 添付を非公開 R2 に非同期保存する

- 日付: 2026-11-01
- 状態: 採用
- ADR 0004 の非テキストをメタデータのみ保存する範囲を拡張する。

## 背景

チャットに送られた画像・動画・音声・ファイルも保存したい。大きなファイルの取得で Webhook の応答や ping / pong を遅らせず、送信取消にも対応する必要がある。

## 決定

- `image` / `video` / `audio` / `file` を対象に、LINE の Get content API から取得する。
- 外部 content provider の URL は取得しない。アルバム・ノートの一括収集も行わない。
- 非公開 R2 バケット `line-group-talk-attachments` に保存する。公開 URL や認証なしのダウンロード API は作らない。
- R2 のキーは `line/<source_type>/<conversation_id>/<message_id>` とし、各要素をエスケープする。ファイル名はキーに使わない。
- D1 の `attachments` を `message_id` で会話原文に紐付け、元ファイル名・申告サイズ・実サイズ・Content-Type・保存状態・保存日時・失敗コードを保持する。
- Queues に送るのは発言IDのみ。Consumer は毎回 D1 の最新状態を読んで保存または削除する。
- ダウンロードは最大120秒、初期上限は100 MiB。ヘッダー・申告サイズの確認に加え、実際の受信バイト数にも上限を適用する。
- 最大5 MiBのパート単位で読み込み、必要に応じて R2 Multipart Upload を使う。失敗した未完了アップロードは abort する。
- Queue は `max_concurrency: 1`、バッチ内も逐次処理とし、同じキーの保存と削除を直列化する。
- 一時的なエラーには指数的な待ち時間を設け、初回を含め最大6回試行する。取得不能・サイズ超過は `failed`、試行上限超過は失敗状態を記録して DLQ に送る。
- D1 を durable outbox とし、Webhook 応答前に処理待ちを記録する。Queue への投入失敗と滞留した `pending` / `delete_pending` は5分ごとの Cron で最大100件ずつ再投入する。
- 送信取消の記録、本文削除、添付の `delete_pending` 化は同一 D1 トランザクションで行う。ファイル名等も消去し、Consumer が R2 の削除を確認してから `deleted` にする。
- 保存完了後に取消状態を再確認する。保存直後の障害では R2 の head から回復し、LINE 側での取得期限切れによる再取得失敗を避ける。

## 結果と制限

R2 と D1 は単一トランザクションではないため、取消から R2 実体削除まで一時的な遅延がある。
削除に失敗した添付は `delete_pending` を維持し、Queue と Cron で再試行する。長期障害や DLQ の滞留は運用で確認する。
`failed` になった取得は自動で無限再試行しない。原因を修正し、D1 の状態を `pending` / `queued_at = NULL` に戻すと Cron が再投入する。
Webhook で既に受信しただけの古い添付は、自動では過去に遡って取得しない。LINE 側で取得不能になった実体は復元できない。
実行環境の強制終了で abort が実行できなかった未完了パートは R2 の incomplete multipart lifecycle に従って削除される。
認証付き閲覧 API、MCP からの取得、OCR、AI による画像理解は今後実装する。参照時は D1 経由で会話のアクセス権と取消状態を必ず確認する。

## 参照

- https://developers.line.biz/en/reference/messaging-api/nojs/#get-content
- https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/
- https://developers.cloudflare.com/queues/configuration/batching-retries/
