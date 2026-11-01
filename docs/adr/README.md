# Architecture Decision Records

| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-cloudflare-platform.md) | Workers / D1 / Vectorize と共通ナレッジ | 採用 |
| [0002](0002-on-demand-knowledge.md) | ナレッジ整理は明示起動するスキル | 採用・実装予定 |
| [0003](0003-history-import.md) | 過去ログはテキスト書き出しを優先 | 採用・テキスト取り込み実装済み |
| [0004](0004-line-webhook-mvp.md) | 最初の bot は記録と ping / pong | 採用 |
| [0005](0005-attachment-storage.md) | 添付を非公開 R2 に非同期保存する | 採用 |
| [0006](0006-automatic-knowledge-indexing.md) | 安価なモデルで自動解析し Vectorize に索引化する | 採用 |
| [0007](0007-mention-answers.md) | bot へのメンションにグループ内の根拠から回答する | 採用 |
| [0008](0008-line-login-portal.md) | LINE ログインと参加トークに基づくポータル認可 | 採用 |

| [0009](0009-custom-domain.md) | MCP の公開先を独自ドメインに移す | 採用 |

| [0010](0010-bot-messages-mcp.md) | bot の回答を発言者を区別して MCP に公開する | 採用 |

| [0011](0011-direct-chat-assistant.md) | 1対1で参加トークを検索し、ユーザー別24時間予算を適用する | 採用 |

| [0012](0012-uploaded-knowledge.md) | ナレッジのチャット別利用設定と共同編集 | 採用 |
| [0013](0013-line-rich-menu.md) | 1対1のリッチメニューから管理・登録・利用状況へ進む | 採用 |

| [0014](0014-d1-read-efficiency.md) | AI 料金判定と定期処理の D1 読み取りを定数化する | 採用 |
| [0015](0015-history-import-progress.md) | 履歴取り込みの進捗を状態別カウンタで表示する | 採用 |
| [0016](0016-direct-history-retrieval.md) | 1対1の履歴検索を実行で保証し、発言の前後も読む | 採用 |
| [0017](0017-glm-direct-harness.md) | GLM-5.3-Flash と1対1の回答ハーネス | 採用 |

各 ADR は 2026-11-01 のユーザーとの設計議論を記録する。将来の機能と今回の実装範囲を区別する。
