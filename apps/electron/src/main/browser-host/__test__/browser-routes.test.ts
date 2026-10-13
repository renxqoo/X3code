import { describe, expect, test } from 'bun:test';

import { normalizeBrowserUrl } from '../browser-routes';

/** URL 归一化表驱动（T61 §4 URL 治理：scheme 白名单 + 智能补协议）。 */
describe('normalizeBrowserUrl', () => {
  test.each([
    ['https://example.com', 'https://example.com'],
    ['http://example.com', 'http://example.com'],
    // 无协议：公网补 https、本地/私网补 http
    ['example.com', 'https://example.com'],
    ['localhost:5173', 'http://localhost:5173'],
    ['localhost', 'http://localhost'],
    ['127.0.0.1:3000', 'http://127.0.0.1:3000'],
    ['192.168.1.10:8080', 'http://192.168.1.10:8080'],
    ['10.0.0.5', 'http://10.0.0.5'],
    ['172.16.0.1', 'http://172.16.0.1'],
    // 白名单内
    ['about:blank', 'about:blank'],
    ['data:text/html,hi', 'data:text/html,hi'],
    // 首尾空白剥除
    ['  https://example.com  ', 'https://example.com'],
    // 拒绝：file:// 与空
    ['file:///etc/passwd', null],
    ['javascript:alert(1)', null],
    ['', null],
    ['   ', null],
    // 172.17–172.31 是私网；172.99 不是
    ['172.99.0.1', 'https://172.99.0.1'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeBrowserUrl(input)).toBe(expected);
  });
});
