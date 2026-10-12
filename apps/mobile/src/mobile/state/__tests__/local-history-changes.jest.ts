/**
 * 症状回归（本地操作被回滚）：用户置顶/归档/改名/删除后，桌面上任何一条
 * sessionUpdated 到达即把操作抹掉，删除的会话还会复活。
 *
 * 根因：history-sync 的 Map 是历史真相，history-store 只是它的投影拷贝；
 * 本地动作只改拷贝，下一次 emit() 的整体替换把拷贝换回旧值。
 */
import { describe, expect, it } from '@jest/globals';

import { createHistorySync } from '@/mobile/state/history-sync';
import { bindLocalHistorySink, recordLocalHistoryChange } from '@/mobile/state/local-history-changes';

const raw = (threadId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  threadId, title: `会话 ${threadId}`, cwd: '/w', state: 'idle', streaming: false,
  sessionPath: `/s/${threadId}.jsonl`, lastActivityAt: 1_700_000_000_000, createdAt: 1_700_000_000_000,
  ...extra,
});

function harness() {
  const emitted: Array<Record<string, unknown>> = [];
  const sync = createHistorySync({ onSessions: (sessions) => { emitted.push(sessions as never); } });
  // 每条用例重绑 sink 到本用例的 sync：模块级 sink 跨用例共享，不重绑会串到上一条的真相层
  bindLocalHistorySink((id, change) => { sync.applyLocalChange(id, change); });
  const last = (): Row[] => (emitted[emitted.length - 1] ?? []) as Row[];
  return { sync, emitted, last };
}

type Row = { id: string; pinned: boolean; archived: boolean; title: string };

describe('历史本地变更回流（症状：置顶/归档/改名被下一条事件回滚）', () => {
  it('置顶后到达 sessionUpdated，置顶仍在（不回滚）', () => {
    const { sync, last } = harness();
    sync.updateSession(raw('t1'));
    recordLocalHistoryChange('t1', { pinned: true });
    sync.updateSession(raw('t1', { title: '桌端改名了' }));
    expect(last().find((s) => s.id === 't1')?.pinned).toBe(true);
    // 桌端的事实照常更新——回流只保本地意图，不挡远端变更
    expect(last().find((s) => s.id === 't1')?.title).toBe('桌端改名了');
  });

  it('归档后到达 sessionUpdated，归档仍在', () => {
    const { sync, last } = harness();
    sync.updateSession(raw('t1'));
    recordLocalHistoryChange('t1', { archived: true });
    sync.updateSession(raw('t1', { state: 'live', streaming: true }));
    expect(last().find((s) => s.id === 't1')?.archived).toBe(true);
  });

  it('删除后到达 sessionUpdated，已删会话不复活', () => {
    const { sync, last } = harness();
    sync.updateSession(raw('t1'));
    sync.updateSession(raw('t2'));
    recordLocalHistoryChange('t1', null);
    sync.updateSession(raw('t1'));
    expect(last().map((s) => s.id)).toEqual(['t2']);
  });

  it('改名后到达 sessionUpdated，新标题不被抹掉', () => {
    const { sync, last } = harness();
    sync.updateSession(raw('t1'));
    recordLocalHistoryChange('t1', { title: '我的新标题' });
    sync.updateSession(raw('t1', { title: '桌端的名字', state: 'live' }));
    expect(last().find((s) => s.id === 't1')?.title).toBe('我的新标题');
  });

  it('连续多次本地操作合并为最后一次意图（不被前一次覆盖）', () => {
    const { sync, last } = harness();
    sync.updateSession(raw('t1'));
    recordLocalHistoryChange('t1', { pinned: true });
    recordLocalHistoryChange('t1', { archived: true });
    sync.updateSession(raw('t1'));
    const row = last().find((s) => s.id === 't1');
    expect(row?.pinned).toBe(true);
    expect(row?.archived).toBe(true);
  });

  it('删除是终态：随后的置顶操作也带不回被删会话', () => {
    const { sync, last } = harness();
    sync.updateSession(raw('t1'));
    recordLocalHistoryChange('t1', null);
    recordLocalHistoryChange('t1', { pinned: true });
    sync.updateSession(raw('t1'));
    // 墓碑优先于后续意图：删除是用户显式动作，误触的后续置顶不该复活它
    expect(last().map((s) => s.id)).toEqual([]);
  });

  it('会话晚于本地操作到达时也带上意图（bootstrap 晚于用户点击）', () => {
    const { sync, last } = harness();
    recordLocalHistoryChange('late-1', { pinned: true });
    expect(last()).toEqual([]);
    sync.updateSession(raw('late-1'));
    expect(last().find((s) => s.id === 'late-1')?.pinned).toBe(true);
  });
});