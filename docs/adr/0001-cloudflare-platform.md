# ADR 0001: Cloudflare と共有ナレッジを使う

- 日付: 2026-11-01
- 状態: 採用（MCP / Vectorize は実装予定）

## 背景

LINE グループ内の活動を支援し、同じ会話の知識を外部 AI セッションから MCP で参照したい。

## 決定

- Workers で LINE Webhook、bot、認証付きリモート MCP を提供する。
- D1 を会話原文と整理済みナレッジの正本とする。グループID・発言ID・発言者ID・日時を保持する。
- LINE 内の bot と MCP は同じデータと検索処理を使う。
- Vectorize を再構築可能な意味検索索引とし、検索結果の本文・前後の会話・根拠は D1 から取得する。
- キーワード・期間検索も併用する。Vectorize の登録と検索には同じ埋め込みモデルを用い、そのモデルと版を管理する。
- 参照可能グループは認証からサーバー側で確定し、索引検索と本文取得の両方で制限する。
- 添付の実体が必要になったら R2、非同期処理が必要になったら Queues を追加する。Durable Objects は共有状態の調整が必要になるまで導入しない。
- Node.js と Wrangler は mise でバージョン固定する。ユーザーの希望に従い CLI は Wrangler を使う。

## 結果

会話の保存と検索・生成モデルを分離できる。MVP には Vectorize・MCP・LLM をまだ組み込まない。
本文の訂正・送信取消は、導入済みの派生ナレッジと検索索引にも伝播させる必要がある。
埋め込みモデル、認証方式、保持期間、規模に応じた D1 分割方針は未決定。

## 参照

- https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/
- https://developers.cloudflare.com/vectorize/reference/metadata-filtering/
