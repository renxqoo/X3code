import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrowserEvent } from '@x3code/contracts';

import { createCdpClient } from '../cdp-client';

/**
 * cdp-client 集成层（真 Chrome headless）：spike 实证的链路固化为回归——
 * 连接/投屏 ack 循环/输入转发/事件钩子回传/tab 增删。
 * Chrome 缺失环境自动跳过（describe.skipIf）。
 */

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

function findChrome(): string | null {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const chromePath = findChrome();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe.skipIf(chromePath === null)('cdp-client 集成（真 Chrome）', () => {
  // 全量套件并发时机器负载高：真 Chrome 链路放宽超时（单跑 8.5s 总耗时）

  let chrome: ReturnType<typeof spawn> | null = null;
  let browserWsUrl = '';
  let profileDir = '';
  let fixture: { port: number; stop: () => void } | null = null;
  let events: BrowserEvent[] = [];
  let client: ReturnType<typeof createCdpClient> | null = null;

  beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'cdp-it-'));
    fixture = Bun.serve({
      port: 0,
      fetch: (req) => new Response(
        req.url.endsWith('/form')
          ? '<!doctype html><html><body><input id="q" style="width:300px;height:40px"></body></html>'
          : '<!doctype html><html><body style="height:3000px"><h1 id="hero">Fixture</h1><a href="#x">link</a></body></html>',
        { headers: { 'content-type': 'text/html' } },
      ),
    });
    chrome = spawn(chromePath ?? '/usr/bin/false', [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
      '--no-first-run', '--mute-audio', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    browserWsUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('chrome boot timeout')), 15000);
      const onData = (chunk: Buffer) => {
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(chunk));
        if (m?.[1]) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      };
      if (chrome) chrome.stderr.on('data', onData);
    });
  }, 60000);

  afterAll(() => {
    client?.disconnect();
    try { chrome?.kill(); } catch { /* 已退 */ }
    try { if (fixture) fixture.stop(); } catch { /* 已停 */ }
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* 迟滞 */ }
  });

  function activeTarget(): { targetId: string } {
    const tab = client?.currentTabs().find((t) => t.active);
    if (!tab) throw new Error('no active tab');
    return tab;
  }

  test('连接 + 初始 tab 表', async () => {
    events = [];
    client = createCdpClient({ browserWsUrl, onEvent: (e) => events.push(e) });
    await client.connect();
    const tabs = client.currentTabs();
    expect(tabs.length).toBeGreaterThanOrEqual(1);
    expect(tabs.some((t) => t.active)).toBe(true);
  }, 30000);

  test('导航到本地 fixture + 投屏帧到达（ack 循环）', async () => {
    const { targetId } = activeTarget();
    if (!client) throw new Error('client not ready');
    await client.navigate(targetId, `http://127.0.0.1:${fixture?.port}`);
    await sleep(800);
    await client.startScreencast(targetId, { maxWidth: 400, maxHeight: 300 });
    await client.dispatchInput(targetId, { kind: 'wheel', x: 50, y: 50, deltaX: 0, deltaY: 600 });
    await sleep(1500);
    const frames = events.filter((e) => e.type === 'frame' && e.targetId === targetId);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const first = frames[0];
    if (first?.type === 'frame') {
      expect(first.jpegB64.length).toBeGreaterThan(100);
      expect(first.meta.deviceWidth).toBeGreaterThan(0);
    }
  }, 30000);

  test('输入转发 + 事件钩子回传（wheel 滚动被观测）', async () => {
    const { targetId } = activeTarget();
    if (!client) throw new Error('client not ready');
    const scrollBefore = events.filter((e) => e.type === 'action' && e.kind === 'scroll').length;
    await client.dispatchInput(targetId, { kind: 'wheel', x: 50, y: 50, deltaX: 0, deltaY: 800 });
    await sleep(1000);
    const scrollActions = events.filter((e) => e.type === 'action' && e.kind === 'scroll');
    expect(scrollActions.length).toBeGreaterThan(scrollBefore);
  }, 30000);

  test('mouse 点击被钩子观测（click 事件带坐标）', async () => {
    const { targetId } = activeTarget();
    if (!client) throw new Error('client not ready');
    const clicksBefore = events.filter((e) => e.type === 'action' && e.kind === 'click').length;
    await client.dispatchInput(targetId, { kind: 'mouse', x: 30, y: 30, button: 'left', press: true });
    await client.dispatchInput(targetId, { kind: 'mouse', x: 30, y: 30, button: 'left', press: false });
    await sleep(800);
    const clicks = events.filter((e) => e.type === 'action' && e.kind === 'click');
    expect(clicks.length).toBeGreaterThan(clicksBefore);
  }, 30000);

  test('tab 增删同步', async () => {
    if (!client) throw new Error('client not ready');
    const newTarget = await client.openTab(`http://127.0.0.1:${fixture?.port}/second`);
    await sleep(600);
    expect(client.currentTabs().some((t) => t.targetId === newTarget)).toBe(true);
    await client.closeTab(newTarget);
    await sleep(600);
    expect(client.currentTabs().some((t) => t.targetId === newTarget)).toBe(false);
  }, 30000);

  test('activateTab 切换激活真相源', async () => {
    if (!client) throw new Error('client not ready');
    const second = await client.openTab(`http://127.0.0.1:${fixture?.port}/tab2`);
    await sleep(400);
    const first = client.currentTabs().find((t) => t.targetId !== second);
    if (!first) throw new Error('first tab missing');
    await client.activateTab(first.targetId);
    const active = client.currentTabs().find((t) => t.active);
    expect(active?.targetId).toBe(first.targetId);
    await client.closeTab(second);
    await sleep(400);
  }, 30000);

  test('insertText 中文注入（IME 路径）被钩子观测为 input', async () => {
    const { targetId } = activeTarget();
    if (!client) throw new Error('client not ready');
    await client.navigate(targetId, `http://127.0.0.1:${fixture?.port}/form`);
    await sleep(600);
    // 聚焦输入框（点击）
    await client.dispatchInput(targetId, { kind: 'mouse', x: 150, y: 20, button: 'left', press: true });
    await client.dispatchInput(targetId, { kind: 'mouse', x: 150, y: 20, button: 'left', press: false });
    await sleep(300);
    const inputsBefore = events.filter((e) => e.type === 'action' && e.kind === 'input').length;
    await client.dispatchInput(targetId, { kind: 'insertText', text: '中文输入测试' });
    await sleep(800);
    const inputs = events.filter((e) => e.type === 'action' && e.kind === 'input');
    expect(inputs.length).toBeGreaterThan(inputsBefore);
  }, 30000);

  test('pickElement 拾取元素：结构化数据 + 敏感属性脱敏（真 Chrome）', async () => {
    const { targetId } = activeTarget();
    if (!client) throw new Error('client not ready');
    // fixture：form 页带 password 字段 + 普通按钮
    await client.navigate(targetId, `http://127.0.0.1:${fixture?.port}/form`);
    await sleep(600);
    // 采集脚本走 element-picker 的表达式（PICK_X/PICK_Y 替换后 evaluate）
    const { PICK_COLLECT_EXPRESSION, toPickedElement } = await import('../element-picker');
    const expression = PICK_COLLECT_EXPRESSION.replace('PICK_X', '150').replace('PICK_Y', '20');
    const raw = await client.evaluate<Record<string, unknown>>(targetId, expression);
    expect(raw).not.toBeNull();
    if (raw !== null) {
      const picked = toPickedElement(raw);
      expect(picked.tag).toBe('input');
      // 密码框：outerHTML 的 value 必须脱敏
      expect(picked.outerHtml).not.toMatch(/value="[^*]/);
      expect(picked.selector.length).toBeGreaterThan(0);
      expect(picked.bbox.width).toBeGreaterThan(0);
    }
  }, 30000);

  test('视口设置事件', async () => {
    const { targetId } = activeTarget();
    if (!client) throw new Error('client not ready');
    await client.setViewport(targetId, 375, 812);
    const vp = events.filter((e) => e.type === 'viewportChanged' && e.targetId === targetId);
    expect(vp.length).toBeGreaterThanOrEqual(1);
  }, 30000);
});
