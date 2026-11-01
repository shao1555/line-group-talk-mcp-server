import image from "../assets/rich-menu.png";

export const RICH_MENU_VERSION = "LINE Talk bot-portal-v1";
export function richMenuConfig(env: Env) {
  const origin = new URL(env.PORTAL_ORIGIN).origin;
  return { size: { width: 2500, height: 843 }, selected: true, name: RICH_MENU_VERSION, chatBarText: "LINE Talk bot メニュー", areas: [
    { bounds: { x: 0, y: 0, width: 834, height: 843 }, action: { type: "uri", label: "ログイン・管理画面", uri: `${origin}/` } },
    { bounds: { x: 834, y: 0, width: 833, height: 843 }, action: { type: "uri", label: "ナレッジを追加", uri: `${origin}/?view=knowledge` } },
    { bounds: { x: 1667, y: 0, width: 833, height: 843 }, action: { type: "message", label: "利用状況", text: "利用状況は" } },
  ] };
}
async function line(env: Env, path: string, init: RequestInit = {}, data = false) {
  return fetch(`https://${data ? "api-data" : "api"}.line.me/v2/bot/${path}`, { ...init,
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, ...init.headers }, signal: AbortSignal.timeout(10_000) });
}
async function json(response: Response): Promise<{ richMenuId?: string; richmenus?: { name: string; richMenuId: string }[] }> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`line_http_${response.status}`); }
  return response.json();
}

// Deployment configuration only; never exposed as a portal API. Once applied,
// manual menu changes aren't overwritten by subsequent scheduled runs.
export async function ensureRichMenu(env: Env): Promise<void> {
  await env.DB.prepare("INSERT INTO line_rich_menus(version) VALUES (?) ON CONFLICT(version) DO NOTHING").bind(RICH_MENU_VERSION).run();
  const claim = await env.DB.prepare("UPDATE line_rich_menus SET lease_until = ? WHERE version = ? AND applied_at IS NULL AND lease_until <= ?")
    .bind(Date.now() + 5 * 60_000, RICH_MENU_VERSION, Date.now()).run();
  if (!claim.meta.changes) return;
  try {
    const state = await env.DB.prepare("SELECT rich_menu_id FROM line_rich_menus WHERE version = ?").bind(RICH_MENU_VERSION).first<{ rich_menu_id: string | null }>();
    let id = state?.rich_menu_id;
    if (!id) {
      const existingDefault = await line(env, "user/all/richmenu");
      const previous = existingDefault.status === 404 ? (await existingDefault.body?.cancel(), null) : (await json(existingDefault)).richMenuId ?? null;
      await env.DB.prepare("UPDATE line_rich_menus SET previous_rich_menu_id = ? WHERE version = ?").bind(previous, RICH_MENU_VERSION).run();
      const existing = await json(await line(env, "richmenu/list"));
      id = existing.richmenus?.find((menu) => menu.name === RICH_MENU_VERSION)?.richMenuId;
      if (!id) id = (await json(await line(env, "richmenu", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(richMenuConfig(env)) }))).richMenuId;
      if (!id || !/^richmenu-[a-zA-Z0-9-]+$/.test(id)) throw new Error("invalid_rich_menu_id");
      await env.DB.prepare("UPDATE line_rich_menus SET rich_menu_id = ? WHERE version = ?").bind(id, RICH_MENU_VERSION).run();
    }
    const currentImage = await line(env, `richmenu/${id}/content`, {}, true);
    if (currentImage.status === 404) {
      await currentImage.body?.cancel();
      await json(await line(env, `richmenu/${id}/content`, { method: "POST", headers: { "Content-Type": "image/png" }, body: image }, true));
    } else {
      if (!currentImage.ok) { await currentImage.body?.cancel(); throw new Error(`line_http_${currentImage.status}`); }
      await currentImage.body?.cancel();
    }
    await json(await line(env, `user/all/richmenu/${id}`, { method: "POST" }));
    await env.DB.prepare("UPDATE line_rich_menus SET applied_at = ?, lease_until = 0, last_error_code = NULL WHERE version = ?").bind(Date.now(), RICH_MENU_VERSION).run();
    console.info(JSON.stringify({ event: "rich_menu_applied", version: RICH_MENU_VERSION }));
  } catch (error) {
    const code = error instanceof Error && /^line_http_\d+$|^invalid_rich_menu_id$/.test(error.message) ? error.message : "rich_menu_setup_failed";
    await env.DB.prepare("UPDATE line_rich_menus SET last_error_code = ?, lease_until = ? WHERE version = ?").bind(code, Date.now() + 5 * 60_000, RICH_MENU_VERSION).run();
    console.error(JSON.stringify({ event: "rich_menu_setup_failed", code }));
  }
}
