# ADR 0008: LINE ログインと参加トークに基づくポータル認可

- 日付: 2026-11-01
- 状態: 採用

## 決定

- 同じ Worker の `/` に簡単なポータルを設置する。LINE Login チャンネルは Messaging API と同じプロバイダーで作成し、共通の LINE ユーザーIDで本人を照合する。LINE Developers の「チャンネル」と、ユーザーの参加する「トーク」は区別する。
- Authorization Code Flow + PKCE S256 + nonce を使う。state はブラウザーの HttpOnly Cookie と D1 のハッシュで結び付け、10分以内・一度限りとする。ID token は LINE の検証 API に送り、audience・issuer・nonce・有効期限・subject を確認する。
- LINE の access token / refresh token / ID token は永続化しない。独自のセッションを7日間有効とし、D1 にハッシュだけを保存する。Cookie は `__Host-`・Secure・HttpOnly・SameSite=Lax。変更 API には同一 Origin とセッションに対応した CSRF token を要求する。
- `conversations` が bot の把握するトーク、`conversation_members` が発言や参加・退出イベントから得た関連を表す。既存メッセージを初期候補として移行する。古いイベントで退出状態を復活させない。
- LINE Login から全グループを列挙する API はない。bot が把握する group / room を候補とし、LINE Messaging API のメンバープロフィールで本人の現在の参加を確認する。group はサマリー API でも bot の現在の参加とグループ名を確認する。発言履歴だけでは認可しない。未発言のユーザーでも参加が確認できれば表示する。
- ポータルのトーク一覧は現在の参加を確認したものだけ返す。LINE API 障害時は未確認トークを表示せず、部分的な確認失敗を示す。初期実装は候補100件まで・同時確認5件とする。
- 外部 MCP クライアントには OAuth 認可サーバーと DCR を公開する。Cloudflare 公式 `@cloudflare/workers-oauth-provider` の認可サーバー・リソースサーバーを同じ Worker に配置し、登録・認可コード・PKCE・更新・失効・audience・discovery を扱う。DCR のクライアント名は未検証として表示する。クライアントの名前・リダイレクト先ホスト・許可内容を提示し、同意後に LINE ログインへ遷移する。LINE のコールバック URL はポータルログインと共通。
- 認可はトークの固定リストでなく本人の LINE ユーザーIDに紐付ける。MCP リクエストごとに本人と bot の現在の参加を再確認し、把握済みの全トークを対象にする。追加参加を自動で反映し、本人の退会・bot の退出・LINE API の確認失敗時には該当する内容を返さない。
- クライアントごとの接続は `oauth_connections` に管理し、本人がポータルから解除できる。アクセストークンは1時間・接続と更新トークンは30日間、接続は最大20個。D1 の解除状態を API とトークン更新の両方で確認し、KV の反映待ちだけに依存しない。許可する操作は `knowledge:read` と更新用 `offline_access` に限定する。
- トークの選別は手元のエージェントが行う。`list_conversations` で名前・記録件数・記録範囲、`search_knowledge` で意味検索と任意の発言期間、`get_recent_messages` で直近の文脈を公開する。ポータルでトークの個別選択は行わない。
- 既存の運用者発行トークン（owner がないもの）は明示的に指定された管理用スコープを維持する。ポータルからは発行・閲覧できない。旧ポータルのトークン API は互換用に残すが UI では使わない。
- ポータルには本文や添付を表示せず、参加トーク名・記録件数・接続設定を表示する。トークへメッセージを送信しない。認証・トークン関連レスポンスをキャッシュせず、CSP と textContent によって外部文字列を HTML として扱わない。
- 初回利用者に、公式アカウントの友だち追加リンク・QR コードとグループへの bot 招待を案内する。友だち追加だけでグループの記録が開始するとは説明しない。
- 認可フォームは `Referrer-Policy: same-origin` とする。`no-referrer` によってフォーム POST の Origin が `null` になり得るため、Origin が欠落・`null` の場合にも provider のブラウザー Cookie に紐付いた一度限りの認可ハンドルで検証する。明示的な異なる Origin は拒否する。ポータルの変更 API は従来どおり同一 Origin と CSRF token を必須とする。
- 認可フォームの POST 後は外部 URL へ直接リダイレクトせず、HTTP 200 の遷移ページを返す。検証済みの転送先だけを HTML エスケープして meta refresh と通常リンクに設定する。フォーム送信からクライアントの多段リダイレクトを切り離すため。Muse では認可コード発行後に交換されず、元フォームの再クリックで使用済みハンドルが拒否される状態を確認した。
- 認可画面の CSP `form-action` は同一 Origin のみ、遷移ページは `form-action 'none'` とし、`frame-ancestors 'none'` を維持する。Cookie 設定・一度限りのハンドル・PKCE は維持し、自動遷移できない環境には「接続を続ける」リンクを用意する。

## 制限

bot がまだ把握していないトークは一覧に出ない。bot を招待して1件発言すると候補になる。対応前に退出していたトークも候補に残り得るが、現在の参加確認で除外する。
現時点の参加者は、参加時点より前を含む保存済み記録を検索できる。参加前の履歴の閲覧制限や管理者承認は今後の設計対象。

## 参照

- https://developers.line.biz/en/docs/messaging-api/getting-user-ids/
- https://developers.line.biz/en/docs/line-login/integrate-line-login/
- https://developers.line.biz/en/docs/line-login/integrate-pkce/
- https://developers.line.biz/en/reference/line-login/#verify-id-token
- https://developers.line.biz/en/reference/messaging-api/#get-group-member-profile
- https://github.com/cloudflare/workers-oauth-provider
- https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/form-action
