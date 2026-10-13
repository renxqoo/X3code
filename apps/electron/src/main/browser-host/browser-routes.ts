import { BROWSER_URL_SCHEMES, type BrowserInputEvent } from '@x3code/contracts';
import { appError } from '@x3code/api';

import { PICK_COLLECT_EXPRESSION, toPickedElement, type RawPick } from './element-picker';
import type { createBrowserHost } from './browser-host';

/**
 * browser/* invoke 路由（T61 §3.1）：懒启动 → cdp-client 操作面。
 * URL 归一化与 scheme 白名单在此层（渲染层输入不可信）。
 */

type BrowserHost = ReturnType<typeof createBrowserHost>;

/** URL 归一化：无协议智能补全（localhost/私网 http、公网 https）+ scheme 白名单拒绝。 */
export function normalizeBrowserUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  let candidate = trimmed;
  // scheme 判定排除「host:port」形态：字母冒号后跟数字 = 端口而非协议
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:(\/\/|.)/.test(candidate) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\d/.test(candidate);
  if (!hasScheme) {
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(candidate);
    candidate = `${isLocal ? 'http' : 'https'}://${candidate}`;
  }
  const scheme = candidate.slice(0, candidate.indexOf(':') + 1);
  if (!(BROWSER_URL_SCHEMES as readonly string[]).includes(scheme)) return null;
  return candidate;
}

export function createBrowserRoutes(deps: { host: BrowserHost }) {
  const client = () => deps.host.currentClient();
  const unavailable = { ok: false as const, error: appError('browser_unavailable') };
  const invalidUrl = { ok: false as const, error: appError('browser_invalid_url') };

  return {
    routes: {
      'browser/bootstrap': async () => {
    await Promise.resolve();
        const c = client();
        const phase = deps.host.currentPhase();
        const tabs = c?.currentTabs() ?? [];
        return {
          ok: true as const,
          data: {
            status: phase === 'ready' ? ('ready' as const) : phase === 'chromeMissing' ? ('chromeMissing' as const) : phase === 'failed' ? ('failed' as const) : ('starting' as const),
            cdpEndpoint: deps.host.currentPort() > 0 ? `http://127.0.0.1:${deps.host.currentPort()}` : null,
            chromePath: null,
            tabs,
            activeTargetId: tabs.find((tab) => tab.active)?.targetId ?? null,
            viewport: null,
            navStates: [],
          },
        };
      },
      'browser/navigate': async (params: { targetId: string; url: string }) => {
        await deps.host.ensureStarted();
        const c = client();
        if (c === null) return unavailable;
        const url = normalizeBrowserUrl(params.url);
        if (url === null) return invalidUrl;
        await c.navigate(params.targetId, url);
        return { ok: true as const, data: { url } };
      },
      'browser/input': async (params: { targetId: string; input: BrowserInputEvent }) => {
        await deps.host.ensureStarted();
        const c = client();
        if (c === null) return unavailable;
        await c.dispatchInput(params.targetId, params.input);
        return { ok: true as const, data: {} };
      },
      'browser/tabOpen': async (params: { url?: string }) => {
        await deps.host.ensureStarted();
        const c = client();
        if (c === null) return unavailable;
        const url = params.url !== undefined ? normalizeBrowserUrl(params.url) : 'about:blank';
        if (url === null) return invalidUrl;
        const targetId = await c.openTab(url);
        return { ok: true as const, data: { targetId } };
      },
      'browser/tabClose': async (params: { targetId: string }) => {
        const c = client();
        if (c === null) return unavailable;
        await c.closeTab(params.targetId);
        return { ok: true as const, data: {} };
      },
      'browser/tabActivate': async (params: { targetId: string }) => {
        const c = client();
        if (c === null) return unavailable;
        await c.activateTab(params.targetId);
        return { ok: true as const, data: {} };
      },
      'browser/viewportSet': async (params: { targetId: string; width: number; height: number }) => {
        const c = client();
        if (c === null) return unavailable;
        await c.setViewport(params.targetId, params.width, params.height);
        return { ok: true as const, data: {} };
      },
      'browser/streamStart': async (params: { targetId: string; maxWidth: number; maxHeight: number }) => {
        const c = client();
        if (c === null) return unavailable;
        await c.startScreencast(params.targetId, { maxWidth: params.maxWidth, maxHeight: params.maxHeight });
        return { ok: true as const, data: {} };
      },
      'browser/streamStop': async (params: { targetId: string }) => {
        await Promise.resolve();
        const c = client();
        if (c === null) return unavailable;
        c.stopScreencast(params.targetId);
        return { ok: true as const, data: {} };
      },
      'browser/pickElement': async (params: { targetId: string; x: number; y: number }) => {
        const c = client();
        if (c === null) return unavailable;
        const expression = PICK_COLLECT_EXPRESSION.replace('PICK_X', String(Math.round(params.x))).replace('PICK_Y', String(Math.round(params.y)));
        const raw = await c.evaluate<RawPick>(params.targetId, expression);
        if (raw === null) return { ok: false as const, error: appError('browser_pick_miss') };
        const element = toPickedElement(raw);
        const shotB64 = (await c.screenshot(params.targetId)) ?? '';
        return { ok: true as const, data: { element, shotB64 } };
      },
    } as Record<string, (params: never) => Promise<unknown>>,
  };
}
