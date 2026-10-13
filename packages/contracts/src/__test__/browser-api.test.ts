import { describe, expect, test } from 'bun:test';

import {
  BROWSER_EVENT_TYPES,
  BROWSER_URL_SCHEMES,
  BROWSER_VIEWPORT_PRESETS,
  BrowserApiSchemas,
  BrowserEventSchema,
  BrowserInputEventSchema,
} from '../browser-api';

/** 事件帧样本（每词一项：判别联合可解析性的最小代表）。 */
const eventSamples = {
  frame: {
    type: 'frame',
    targetId: 't1',
    streamEpoch: 0,
    jpegB64: 'aGVsbG8=',
    meta: { deviceWidth: 1286, deviceHeight: 832, pageScaleFactor: 1 },
  },
  tabsChanged: {
    type: 'tabsChanged',
    tabs: [{ targetId: 't1', url: 'https://example.com', title: 'Example', active: true }],
  },
  action: { type: 'action', targetId: 't1', kind: 'click', x: 10, y: 20, elementLabel: 'button#submit' },
  navState: { type: 'navState', targetId: 't1', url: 'https://example.com', canBack: false, canForward: false, loading: false },
  viewportChanged: { type: 'viewportChanged', targetId: 't1', width: 375, height: 812 },
  hostState: { type: 'hostState', phase: 'ready', cdpEndpoint: 'http://127.0.0.1:1234' },
  confirmNotice: { type: 'confirmNotice', sid: 'sess-1', cid: 'sc-1', reason: 'origin not in whitelist' },
} as const;

describe('browser 事件词表封闭性', () => {
  test('词表与样本键一致（双向）', () => {
    expect([...BROWSER_EVENT_TYPES].sort()).toEqual(Object.keys(eventSamples).sort());
  });

  test('每个词项样本可解析', () => {
    for (const sample of Object.values(eventSamples)) {
      expect(BrowserEventSchema.safeParse(sample).success).toBe(true);
    }
  });

  test('未知事件词拒绝', () => {
    expect(BrowserEventSchema.safeParse({ type: 'nonsense' }).success).toBe(false);
  });
});

describe('browser invoke schema 输入域', () => {
  test('bootstrap 空参数可解析；多余字段拒绝', () => {
    expect(BrowserApiSchemas['browser/bootstrap'].params.safeParse({}).success).toBe(true);
    expect(BrowserApiSchemas['browser/bootstrap'].params.safeParse({ extra: 1 }).success).toBe(false);
  });

  test('navigate：空/超长 URL 拒绝', () => {
    const schema = BrowserApiSchemas['browser/navigate'].params;
    expect(schema.safeParse({ targetId: 't', url: 'https://a.com' }).success).toBe(true);
    expect(schema.safeParse({ targetId: 't', url: '' }).success).toBe(false);
    expect(schema.safeParse({ targetId: 't', url: 'x'.repeat(8193) }).success).toBe(false);
    expect(schema.safeParse({ targetId: '', url: 'https://a.com' }).success).toBe(false);
  });

  test('viewportSet：非正/超界尺寸拒绝', () => {
    const schema = BrowserApiSchemas['browser/viewportSet'].params;
    expect(schema.safeParse({ targetId: 't', width: 375, height: 812 }).success).toBe(true);
    expect(schema.safeParse({ targetId: 't', width: 0, height: 812 }).success).toBe(false);
    expect(schema.safeParse({ targetId: 't', width: -5, height: 812 }).success).toBe(false);
    expect(schema.safeParse({ targetId: 't', width: 9999, height: 812 }).success).toBe(false);
    expect(schema.safeParse({ targetId: 't', width: 375.5, height: 812 }).success).toBe(false);
  });

  test('input 判别联合：四类各自可解析、缺字段拒绝', () => {
    expect(BrowserInputEventSchema.safeParse({ kind: 'mouse', x: 1, y: 2, button: 'left', press: true }).success).toBe(true);
    expect(BrowserInputEventSchema.safeParse({ kind: 'wheel', x: 1, y: 2, deltaX: 0, deltaY: 120 }).success).toBe(true);
    expect(BrowserInputEventSchema.safeParse({ kind: 'key', key: 'Enter', down: true }).success).toBe(true);
    expect(BrowserInputEventSchema.safeParse({ kind: 'insertText', text: '你好' }).success).toBe(true);
    // mouse 缺 button
    expect(BrowserInputEventSchema.safeParse({ kind: 'mouse', x: 1, y: 2, press: true }).success).toBe(false);
    // insertText 空文本
    expect(BrowserInputEventSchema.safeParse({ kind: 'insertText', text: '' }).success).toBe(false);
    // 负坐标（页面 CSS 坐标域非负）
    expect(BrowserInputEventSchema.safeParse({ kind: 'mouse', x: -1, y: 2, button: 'left', press: true }).success).toBe(false);
    // 未知 kind
    expect(BrowserInputEventSchema.safeParse({ kind: 'pinch', x: 1, y: 2 }).success).toBe(false);
  });
});

describe('browser 常量', () => {
  test('scheme 白名单不含 file:', () => {
    expect(BROWSER_URL_SCHEMES).not.toContain('file:');
  });

  test('视口预设三档且尺寸合法', () => {
    expect(BROWSER_VIEWPORT_PRESETS).toHaveLength(3);
    for (const preset of BROWSER_VIEWPORT_PRESETS) {
      expect(preset.width).toBeGreaterThan(0);
      expect(preset.height).toBeGreaterThan(0);
    }
  });
});
