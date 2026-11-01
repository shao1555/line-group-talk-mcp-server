# ADR 0013: 1対1トークのリッチメニュー

- 日付: 2026-11-01
- 状態: 採用

## 決定

- LINE Messaging API の既定リッチメニューを使い、スマートフォン版の1対1画面に「管理画面」「ナレッジ追加」「利用状況」の3項目を表示する。グループトークにはメニューを追加しない。LINE の仕様上、PC 版には表示されない。
- 管理画面はポータル、ナレッジ追加は `/?view=knowledge` のアップロード欄へ進む URI action とする。利用状況は課金されない定型質問 `利用状況は` を送る message action とする。設定時にチャットメッセージは送信しない。
- 2500×843 PNG と領域定義をリポジトリで管理する。画像はコードで描画し、必要時に再生成する。Workers の Data module として配置し、LINE の画像アップロード用 API に渡す。
- 設定には Worker 内の既存チャンネルアクセストークンを使い、管理用の公開 API は作らない。Cron が `line_rich_menus` の適用状態と期限付き claim を確認し、バージョンごとに一度だけ作成・画像登録・既定設定する。
- API で取得可能な旧既定IDを保存し、他のメニューは削除しない。適用済みの版は手動変更を上書きしない。途中失敗時は保存済みIDと画像を再利用し、5分後に再試行する。
- ログイン後の戻り先はサーバーの一回限りのログインフローに保存する。ポータルのアップロード欄と UUID による全文ページだけを許可し、外部 URL や任意パスへの転送を許可しない。

## 参照

- https://developers.line.biz/en/docs/messaging-api/rich-menus-overview/
- https://developers.line.biz/en/docs/messaging-api/using-rich-menus/
- https://developers.line.biz/en/reference/messaging-api/nojs/#upload-rich-menu-image
- https://developers.line.biz/en/reference/messaging-api/nojs/#set-default-rich-menu
