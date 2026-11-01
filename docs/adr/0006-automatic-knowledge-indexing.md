# ADR 0006: 安価なモデルで自動解析し Vectorize に索引化する

- 日付: 2026-11-01
- 状態: 採用
- ADR 0002 の明示起動方針は会話の要約・決定事項整理に維持し、OCR・画像理解・文字起こしは自動化する。

## 決定

- 保存済み添付と発言を専用 Queues `line-group-talk-knowledge` で解析・索引化する。
- 画像は Workers AI `@cf/mistralai/mistral-small-3.1-24b-instruct` で OCR と短い説明を1回で取得する。画像中の指示には従わない。
- 音声・動画の音声トラックは `@cf/openai/whisper-large-v3-turbo` で日本語文字起こしを試みる。対応しないコンテナ・コーデックは失敗として記録し、高価なモデルへ自動切替しない。
- テキスト・CSV・JSON は UTF-8 として直接抽出し、PDF / Office は `AI.toMarkdown` を用いる。埋め込み画像変換は最初は無効にする。
- テキストが抽出できない PDF は、確認したページ数を上限に埋め込み画像変換を行う。この変換は Cloudflare 側のモデルを利用するため、ページ数分の保守的な料金枠を予約する。日本語の OCR 精度は完全ではない。
- BGE-M3 で1024次元の埋め込みを生成し、Vectorize に登録する。入力800文字・100文字重複で分割し、最大64チャンク。モデル変更時は索引・キャッシュを再構築する。
- Vectorize は会話IDを namespace とする。索引に原文は入れず、結果のチャンクIDから D1 の本文を取得する。
- 検索時は namespace と D1 の会話ID・取消状態・索引状態を確認する。索引の反映遅延があっても取消済み本文は返さない。
- 解析結果と埋め込みを D1 に保存し、保存済み結果を再利用する。同一ファイルの解析キャッシュは SHA-256 と会話ID・処理バージョンで区別し、グループ間では共有しない。
- 取消時は本文・抽出文・チャンク本文・保存済み埋め込みを同一 D1 トランザクションで無効化し、Queue で Vectorize から削除する。他の有効な発言から参照されない解析キャッシュも削除する。
- 索引化の Cron は毎分・最大100件を100件単位の sendBatch で投入する。同時処理を最大5件にし、大量インポートの投入待ちを短縮する。ジョブ単位に10分の期限付きロックを条件付き UPDATE で取得し、重複配送の同時処理を防ぐ。期限切れは再処理可能とし、ロックの解放は所有トークンに一致する場合だけ行う。送信済みジョブは10分経過後に再投入し、取消の削除ジョブを優先する。
- 解析失敗のモデル呼び出しは各段階最大2回。Queue の配送は最大3回。予算待ちは試行回数を消費せず、Cron で再投入する。

## 費用と処理上限

- 既定の見積り予算は月 $5。`AI_MONTHLY_BUDGET_USD` で変更でき、0なら有料のモデル呼び出しを保留する。
- D1 の条件付き INSERT で月予算・日次処理量を同時に予約し、並列実行で上限を超えないようにする。
- 画像・回答生成は最大コンテキストと出力上限を考慮して1回 $0.05 を予約し、正常な利用トークン数が返れば実績相当額に更新する。不明・失敗時の予約は返金扱いにしない。
- 埋め込みは UTF-8 バイト数に余裕を加えて、文字起こしは LINE から受信した音声時間を基に予約する。参照単価は2026-11-01の Cloudflare 公開料金。
- 日次既定値は画像20件（PDF画像変換はページ数換算）、音声3600秒、埋め込み入力500,000バイト。UTC で日・月を区切る。
- 解析対象は最大10 MiB、画像は4 MiB、PDFは10ページ、音声・動画は10分。時間が不明な音声添付は自動解析しない。画像は JPEG / PNG / WebP に対応する。
- 抽出文は40,000文字で打ち切りを明記する。画像説明・OCR は最大1024出力トークン。
- 実際の請求上限を Cloudflare に設定する機能ではなく、アプリ側の見積りに基づく抑制。無料枠は見積りから控除しない。料金改定や期間途中の設定変更、インフラ料金には別途注意が必要。
- R2 / D1 / Queues / Vectorize の料金は AI 予算に含めない。予算超過時も会話・添付の原本保存は継続する。

## 外部検索

- `POST /search` とステートレス MCP `/mcp` を提供する。
- ランダムな Bearer token を発行し、D1 には SHA-256 ハッシュと参照可能会話IDのみ保存する。未認証は拒否する。
- MCP は `search_knowledge` と `list_conversations` を提供する。Agents SDK の `createMcpHandler` を使用し、ホスト・Origin を制限する。
- OAuth や利用者を LINE グループ参加者に自動対応する仕組みは未実装。運用者が明示した会話IDだけをトークンに許可する。

## 参照

- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://developers.cloudflare.com/workers-ai/features/markdown-conversion/usage/binding/
- https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/
- https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
