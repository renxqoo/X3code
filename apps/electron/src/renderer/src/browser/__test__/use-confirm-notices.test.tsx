import { describe, expect, test } from 'bun:test';
import * as React from 'react';

import { render } from '@/testing/render';

import { useConfirmNotices } from '../use-confirm-notices';

/** 确认门通知状态：每 cid 恰一次、120s 自动收起、非目标事件忽略。 */

function probeBridge(events: unknown[]) {
  return {
    subscribeBrowser(onEvent: (e: unknown) => void): () => void {
      // 立即回放种子事件
      for (const e of events) onEvent(e);
      return () => undefined;
    },
  };
}

function Probe({ bridge }: { bridge: ReturnType<typeof probeBridge> | null }) {
  const notices = useConfirmNotices(bridge);
  return <div data-testid="notices">{notices.map((n) => `${n.cid}:${n.reason}`).join(',')}</div>;
}

describe('useConfirmNotices', () => {
  test('confirmNotice 事件进清单；其他事件忽略', () => {
    const h = render(<Probe bridge={probeBridge([
      { type: 'confirmNotice', sid: 's1', cid: 'sc-1', reason: 'origin not in whitelist' },
      { type: 'tabsChanged', tabs: [] },
      { type: 'hostState', phase: 'ready' },
    ])} />);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(h.container.textContent).toContain('sc-1');
        expect(h.container.textContent).toContain('origin not in whitelist');
        resolve();
      }, 150);
    });
  });

  test('bridge null → 空清单', () => {
    const h = render(<Probe bridge={null} />);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(h.container.textContent).toBe('');
        resolve();
      }, 100);
    });
  });

  test('缺 sid/cid 的畸形事件忽略', () => {
    const h = render(<Probe bridge={probeBridge([
      { type: 'confirmNotice', cid: 'sc-x' },
      { type: 'confirmNotice' },
    ])} />);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(h.container.textContent).toBe('');
        resolve();
      }, 100);
    });
  });
});
