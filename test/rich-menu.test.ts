import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ensureRichMenu, RICH_MENU_VERSION, richMenuConfig } from "../src/rich-menu";
import { bindings } from "./helpers";

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
let hasImage: boolean, failSet: boolean;
beforeEach(() => {
  hasImage = false; failSet = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input)), path = url.pathname;
    if (path === '/v2/bot/user/all/richmenu') return Response.json({ richMenuId: 'richmenu-previous' });
    if (path === '/v2/bot/richmenu/list') return Response.json({ richmenus: [] });
    if (path === '/v2/bot/richmenu') return Response.json({ richMenuId: 'richmenu-new' });
    if (path === '/v2/bot/richmenu/richmenu-new/content') {
      expect(url.hostname).toBe('api-data.line.me');
      if (init?.method === 'POST') {
        expect(init.body).toBeInstanceOf(ArrayBuffer); expect((init.body as ArrayBuffer).byteLength).toBeLessThan(1_000_000);
        hasImage = true; return Response.json({});
      }
      return new Response(hasImage ? new Uint8Array([1]) : null, { status: hasImage ? 200 : 404 });
    }
    if (path === '/v2/bot/user/all/richmenu/richmenu-new') return Response.json({}, { status: failSet ? 503 : 200 });
    throw new Error('Unexpected LINE operation');
  });
});
afterEach(() => vi.restoreAllMocks());

describe('LINE rich menu', () => {
  it('configures portal/upload/usage areas with canonical links', () => {
    const menu = richMenuConfig(bindings);
    expect(menu.areas[0].action).toMatchObject({ type: 'uri', uri: `${bindings.PORTAL_ORIGIN}/` });
    expect(menu.areas[1].action).toMatchObject({ type: 'uri', uri: `${bindings.PORTAL_ORIGIN}/?view=knowledge` });
    expect(menu.areas[2].action).toMatchObject({ type: 'message', text: '利用状況は' });
    expect(menu.areas.reduce((n, a) => n + a.bounds.width, 0)).toBe(2500);
  });
  it('sets the menu once, preserves the old default ID, and sends no chat messages', async () => {
    await ensureRichMenu(bindings);
    expect(await env.DB.prepare('SELECT previous_rich_menu_id, rich_menu_id, applied_at FROM line_rich_menus WHERE version = ?').bind(RICH_MENU_VERSION).first())
      .toMatchObject({ previous_rich_menu_id: 'richmenu-previous', rich_menu_id: 'richmenu-new', applied_at: expect.any(Number) });
    const count = vi.mocked(fetch).mock.calls.length;
    await ensureRichMenu(bindings); expect(fetch).toHaveBeenCalledTimes(count);
    expect(vi.mocked(fetch).mock.calls.every(([url]) => !String(url).includes('/message/'))).toBe(true);
  });
  it('retries default setup without recreating the menu or replacing its uploaded image', async () => {
    failSet = true; await ensureRichMenu(bindings);
    expect(await env.DB.prepare('SELECT last_error_code FROM line_rich_menus WHERE version = ?').bind(RICH_MENU_VERSION).first('last_error_code')).toBe('line_http_503');
    failSet = false; await env.DB.prepare('UPDATE line_rich_menus SET lease_until = 0').run(); await ensureRichMenu(bindings);
    const posts = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.filter(([url]) => String(url).endsWith('/richmenu'))).toHaveLength(1);
    expect(posts.filter(([url]) => String(url).endsWith('/content'))).toHaveLength(1);
    expect(await env.DB.prepare('SELECT applied_at FROM line_rich_menus WHERE version = ?').bind(RICH_MENU_VERSION).first('applied_at')).toEqual(expect.any(Number));
  });
});
