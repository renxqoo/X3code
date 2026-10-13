import { describe, expect, test } from 'bun:test';
import * as React from 'react';

import { render } from '@/testing/render';

import { BrowserDebugDrawer } from '../browser-debug-drawer';

/** 调试 drawer：tab 切换拉取、数据渲染、空态降级。 */

function makeBridge(respond: (source: string) => unknown) {
  return {
    invoke(method: string, params: unknown): Promise<unknown> {
      if (method !== 'browser/debugQuery') return Promise.resolve({ ok: true, data: {} });
      const source = (params as { source: string }).source ?? '';
      return Promise.resolve(respond(source));
    },
  };
}

describe('BrowserDebugDrawer', () => {
  test('console 行渲染（level + text）', async () => {
    const h = render(<BrowserDebugDrawer bridge={makeBridge(() => ({ ok: true, data: { source: 'console', rows: [{ level: 'log', text: 'hello' }, { level: 'error', text: 'boom' }] } }))} targetId="t1" />);
    await new Promise<void>((r) => { setTimeout(r, 80); });
    expect(h.container.textContent).toContain('[log]');
    expect(h.container.textContent).toContain('hello');
    expect(h.container.textContent).toContain('boom');
  });

  test('requests 行渲染（status/method/url/duration）', async () => {
    const h = render(<BrowserDebugDrawer bridge={makeBridge(() => ({ ok: true, data: { source: 'requests', rows: [{ url: 'https://a.com/x', method: 'GET', status: 404, durationMs: 120, size: 300 }] } }))} targetId="t1" />);
    React.act(() => {
      const tabs = h.container.querySelectorAll('button');
      const network = [...tabs].find((b) => b.textContent === '网络');
      network?.click();
    });
    await new Promise<void>((r) => { setTimeout(r, 80); });
    expect(h.container.textContent).toContain('404');
    expect(h.container.textContent).toContain('GET');
    expect(h.container.textContent).toContain('https://a.com/x');
  });

  test('perf summary 文本渲染', async () => {
    const h = render(<BrowserDebugDrawer bridge={makeBridge(() => ({ ok: true, data: { source: 'perf', summary: 'TTFB 42ms LCP 1.2s' } }))} targetId="t1" />);
    React.act(() => {
      const tabs = h.container.querySelectorAll('button');
      const perf = [...tabs].find((b) => b.textContent === '性能');
      perf?.click();
    });
    await new Promise<void>((r) => { setTimeout(r, 80); });
    expect(h.container.textContent).toContain('TTFB 42ms');
  });

  test('失败/无会话 → 空态文案', async () => {
    const h = render(<BrowserDebugDrawer bridge={makeBridge(() => ({ ok: false }))} targetId="t1" />);
    await new Promise<void>((r) => { setTimeout(r, 80); });
    expect(h.container.textContent).toContain('暂无数据');
  });

  test('bridge null 不崩（空态）', async () => {
    const h = render(<BrowserDebugDrawer bridge={null} targetId="t1" />);
    await new Promise<void>((r) => { setTimeout(r, 50); });
    expect(h.container.textContent).not.toBeNull();
  });
});
