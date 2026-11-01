import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import { beginLineLogin, portalSession, portalOrigin } from "./portal-auth";
import { completeMcpAuthorization, oauthServer, READ_SCOPE } from "./oauth-server";
import { readLimitedBody } from "./http";

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function continueAuthorization(target: string, inherited: Headers): Response {
  const headers = new Headers(inherited);
  headers.delete("Location");
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  // Commit a document before navigating. A form POST's CSP can otherwise block
  // redirects further down a client's callback chain, after consent was consumed.
  const destination = escape(target);
  return new Response(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${destination}"><title>接続を続けています — LINE Talk</title><link rel="stylesheet" href="/portal.css"></head><body><main><section class="panel welcome"><h1>接続を続けています</h1><p>自動で画面が切り替わらない場合は、下のボタンで続けてください。</p><a class="button" href="${destination}" rel="noreferrer">接続を続ける</a></section></main></body></html>`, { headers });
}
export async function handleMcpConsent(request: Request, env: Env): Promise<Response> {
  const oauth = oauthServer(env).getOAuthApi(env);
  try {
    if (request.method === "GET") {
      const parsed = await oauth.parseAuthRequest(request);
      if (!parsed.codeChallenge || parsed.codeChallengeMethod !== "S256") return new Response("PKCE S256 is required", { status: 400 });
      const description = await oauth.describeConsent(parsed);
      const consent = await oauth.beginConsent(parsed);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      consent.headers.set("Content-Security-Policy", "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP 接続の許可 — LINE Talk</title><link rel="stylesheet" href="/portal.css"></head><body><main><section class="panel welcome"><p class="eyebrow">CONNECT YOUR AI</p><h1>MCP 接続を許可しますか？</h1><h2>${escape(description.clientName)}</h2><p>このクライアントは、あなたと bot が現在どちらも参加している、把握済みの<strong>すべてのトークの保存済み記録</strong>を検索できます。今後追加したトークも対象です。メッセージ送信や削除は許可しません。</p><p>接続先：<strong>${escape(description.redirectHost)}</strong></p><p class="muted small">クライアント名は登録者の申告で、提供元を保証するものではありません。</p>${description.redirectIsLoopback ? '<p class="notice">手元のアプリへの接続です。そのアプリから今接続を開始した場合にだけ許可してください。</p>' : ''}<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(consent.handle)}"><button class="button" name="decision" value="approve">許可して続ける</button> <button class="quiet" name="decision" value="deny">キャンセル</button></form><p class="muted small">LINE ログイン後に接続します。接続はポータルからいつでも解除できます。</p></section></main></body></html>`;
      return new Response(html, { headers: consent.headers });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const origin = request.headers.get("Origin");
    // Referrer policies and embedded browsers can omit/opaque the Origin on form POST.
    // The provider still requires a secret handle bound to this browser's __Host- cookie.
    if (origin !== null && origin !== "null" && origin !== portalOrigin(env)) {
      console.warn(JSON.stringify({ event: "oauth_consent_origin_rejected" }));
      return new Response("Forbidden", { status: 403 });
    }
    const form = new URLSearchParams(new TextDecoder().decode(await readLimitedBody(request, 4000)));
    const handle = form.get("handle") ?? "";
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return continueAuthorization(denied.redirectTo, denied.headers);
    }
    const approved = await oauth.approveConsent(request, handle, { scope: [READ_SCOPE, "offline_access"] });
    const session = await portalSession(request, env);
    if (!session) {
      const login = await beginLineLogin(env, approved.request, approved.headers);
      const target = login.headers.get("Location");
      return login.status === 303 && target ? continueAuthorization(target, login.headers) : login;
    }
    const redirectTo = await completeMcpAuthorization(approved.request, session.userId, env);
    return continueAuthorization(redirectTo, approved.headers);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.redirectTo) return continueAuthorization(error.redirectTo, new Headers());
      return new Response("認可要求が無効か期限切れです。MCP クライアントから接続をやり直してください。", { status: 400 });
    }
    throw error;
  }
}
