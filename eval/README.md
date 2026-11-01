# 1対1モデルの回帰ハーネス

本番と同じ `directRequest`・モデル設定・応答検証・料金計算を使う。最終応答は段落配列を返すv2契約で、全要素をサーバー側で連結する。導入文のみの最終応答とトークン上限による打ち切りは失敗として扱う。既定のモデルは GLM-5.3-Flash (`glm`)。比較用に `qwen` と `oss` も指定できる。

```sh
mise exec -- npm run check
mise exec -- npm run eval:direct -- --models glm,qwen,oss
mise exec -- npm run eval:direct -- --live --models glm --repeat 3 --max-usd 0.10
```

`--live` がなければネットワークを呼ばない。ライブ実行はプロジェクトの Cloudflare アカウントへ推論リクエストを送る。`CLOUDFLARE_API_TOKEN`、またはログイン済み Wrangler の OAuth 設定を利用する（macOSの既定パス。別の場所なら `WRANGLER_CONFIG_PATH`）。トークンを引数に指定しない。失敗した呼び出しは費用予約を維持し、合計が `--max-usd` を超える次のリクエストは実行しない。

## 試験の範囲

- 公開フィクスチャは架空の会話で、過去の告知・未来の予定・実施確認・旅行年の区別・資料内の指示への耐性を確認する。
- モデルごとに適切な出力上限と推論設定を使用する。GLM / OSS は low、4096トークン。Qwen は /no_think、1024トークン。モデル変更時は `src/direct-model.ts` の価格も確認する。
- ライブ試験は固定資料からの最終回答を比べる。各結果の機械的チェックは補助であり、事実に忠実かは回答本文も確認する。1件でも失敗したら終了コード1。
- 実際のツール実行・4回上限・回答専用の最終推論・権限・取消・ユーザー予算は `test/direct-chat.test.ts` で検証する。`test/direct-harness.test.ts` は価格、出力契約、資料配分を検証する。
- D1 / Vectorize / LINE の本番への書き込み・メッセージ送信は行わない。推論料金は Cloudflare で発生するが、ユーザー別の会話料金台帳は変更しない。

## 私有データを使った再現

```sh
mise exec -- npm run eval:direct -- --live --models glm --input data/private-case.json --max-usd 0.05 --output data/direct-eval/replay
```

入力は `fixtures/direct.json` と同じ配列形式、または本番同等の user ペイロード、または `messages` 配列を持つリクエストJSONを指定する。後者は user メッセージだけを取り出し、現在の本番プロンプトで再評価する。`--case ID` で1件だけ選べる。日時はフィクスチャの `now` に固定され、年のない日付をサーバーが推測することはない。

出力は `data/` 内に限り、0600の `results.json` / `report.md` に保存する。個人の会話や回答は git に追加しない。必要なモデル変更は、固定資料試験の結果と実際のツール選択を区別して評価する。

ロールバックは `src/direct-model.ts` の `DEFAULT_DIRECT_MODEL` を `qwen` に戻し、check / deployする。比較ハーネスだけの実行は本番の既定モデルを変更しない。
