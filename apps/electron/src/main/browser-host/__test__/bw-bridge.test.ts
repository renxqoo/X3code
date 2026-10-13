import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBwBridge, defaultBwHome } from '../bw-bridge';

/** bw-bridge：pending 确认文件系统枚举 + 会话匹配（CLI 代跑由 e2e 旅程覆盖）。 */

function pendingFixture(root: string, sid: string, entries: ReadonlyArray<{ cid: string; reason: string; originHost?: string }>): void {
  const dir = join(root, '.bw', 'session', sid, 'pending');
  mkdirSync(dir, { recursive: true });
  for (const entry of entries) {
    writeFileSync(join(dir, `${entry.cid}.json`), JSON.stringify({ ...entry, createdAt: 1791891786771, action: { kind: 'navigate' } }));
  }
}

describe('bw-bridge listPendingConfirms', () => {
  test('枚举多会话 pending（cid/reason/originHost）', () => {
    const root = mkdtempSync(join(tmpdir(), 'bw-bridge-'));
    try {
      pendingFixture(root, 'sess-a', [{ cid: 'sc-1', reason: 'origin not in whitelist', originHost: 'iana.org' }]);
      pendingFixture(root, 'sess-b', [
        { cid: 'sc-2', reason: 'sensitive action: pay', originHost: 'shop.com' },
        { cid: 'sc-3', reason: 'upload outside allowed dirs' },
      ]);
      const bridge = createBwBridge({ bwPath: '/nonexistent/bw', bwHome: root });
      const pending = bridge.listPendingConfirms();
      expect(pending).toHaveLength(3);
      expect(pending.some((p) => p.sid === 'sess-a' && p.cid === 'sc-1' && p.originHost === 'iana.org')).toBe(true);
      expect(pending.filter((p) => p.sid === 'sess-b')).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('BW_HOME 不存在 → 空数组', () => {
    const bridge = createBwBridge({ bwPath: '/x', bwHome: join(tmpdir(), 'no-such-bw-home-' + Date.now()) });
    expect(bridge.listPendingConfirms()).toEqual([]);
  });

  test('损坏 JSON 与缺 cid 跳过（敌意输入降级）', () => {
    const root = mkdtempSync(join(tmpdir(), 'bw-bridge-'));
    try {
      const dir = join(root, '.bw', 'session', 'sess-x', 'pending');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'broken.json'), '{not json');
      writeFileSync(join(dir, 'nocid.json'), JSON.stringify({ reason: 'x' }));
      writeFileSync(join(dir, 'good.json'), JSON.stringify({ cid: 'sc-ok', reason: 'fine' }));
      const bridge = createBwBridge({ bwPath: '/x', bwHome: root });
      const pending = bridge.listPendingConfirms();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.cid).toBe('sc-ok');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('bw-bridge matchSessionByTab', () => {
  test('同 host+path 匹配（query 忽略）', () => {
    const bridge = createBwBridge({ bwPath: '/x', bwHome: '/tmp/x' });
    const sessions = [{ sessionId: 's1', url: 'https://a.com/p?x=1', alive: true }];
    expect(bridge.matchSessionByTab(sessions, 'https://a.com/p?y=2')?.sessionId).toBe('s1');
    expect(bridge.matchSessionByTab(sessions, 'https://other.com/p')).toBeNull();
  });
});

describe('defaultBwHome', () => {
  test('userData 下 browser-bw-home', () => {
    expect(defaultBwHome('/ud')).toBe('/ud/browser-bw-home');
  });
});
