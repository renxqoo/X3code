import { beforeEach, describe, expect, it } from '@jest/globals';

import { createHistorySync, mergeSaved } from '../history-sync';
import type { ConversationSession } from '@/types/domain';

describe('history-sync', () => {
  let emitted: ConversationSession[][];

  beforeEach(() => {
    emitted = [];
  });

  const sync = () =>
    createHistorySync({
      onSessions: (sessions) => emitted.push(sessions),
    });

  it('seedBootstrap：live 会话列表 + 偏好折叠（置顶/归档）；按活跃时间排序', () => {
    const s = sync();
    s.seedBootstrap(
      [
        { threadId: 't1', title: 'A', cwd: '/a', state: 'live', sessionPath: '/s/a.jsonl', lastActivityAt: 100 },
        { threadId: 't2', title: 'B', cwd: '/b', state: 'parked', sessionPath: '/s/b.jsonl', lastActivityAt: 200 },
      ],
      [],
      { pinnedSessions: ['/s/a.jsonl'], archivedSessions: ['/s/b.jsonl'] },
    );
    const sessions = emitted[emitted.length - 1] ?? [];
    expect(sessions.map((x) => x.id)).toEqual(['t2', 't1']); // 200 > 100
    expect(sessions.find((x) => x.id === 't1')?.pinned).toBe(true);
    expect(sessions.find((x) => x.id === 't2')?.archived).toBe(true);
    // parked 是闲置回收后的静置（桌面端标「已归档」），不是待处理
    expect(sessions.find((x) => x.id === 't2')?.state).toBe('idle');
    // live 非流式 = idle（不显示运行中）
    expect(sessions.find((x) => x.id === 't1')?.state).toBe('idle');
  });

  it('updateSession 保持既有偏好与消息；removeSession 删行', () => {
    const s = sync();
    s.seedBootstrap([{ threadId: 't1', title: 'A', cwd: '/a', state: 'live', sessionPath: '/s/a.jsonl', lastActivityAt: 1 }], [], { pinnedSessions: ['/s/a.jsonl'], archivedSessions: [] });
    s.applyLocalChange('t1', { pinned: true });
    s.updateSession({ threadId: 't1', title: 'A2', state: 'live', lastActivityAt: 5 });
    let sessions = emitted[emitted.length - 1] ?? [];
    expect(sessions.find((x) => x.id === 't1')?.title).toBe('A2');
    expect(sessions.find((x) => x.id === 't1')?.pinned).toBe(true);
    s.removeSession('t1');
    sessions = emitted[emitted.length - 1] ?? [];
    expect(sessions.length).toBe(0);
  });

  it('mergeSaved：历史会话并入去重（live 优先）', () => {
    const live: ConversationSession[] = [{ id: 't1', title: 'live', preview: '', project: '', timeLabel: '', state: 'working', pinned: false, archived: false, unread: false, messages: [] }];
    const merged = mergeSaved(live, [{ sessionId: 't1', sessionPath: '/p1', title: 'dup' }, { sessionId: 't9', sessionPath: '/p9', title: 'old', lastActivityAt: 42 }]);
    expect(merged.map((x) => x.id).slice().sort((a, b) => a.localeCompare(b))).toEqual(['t1', 't9']);
    expect(merged.find((x) => x.id === 't9')?.state).toBe('idle');
  });
});

describe('审查修复回归（H3/H4/M9）', () => {
  const sink = () => {
    const emitted: ConversationSession[][] = [];
    return { emitted };
  };

  it('H3：残缺视图（sessionDied 只带 state）不覆盖 title/时间', () => {
    const { emitted } = sink();
    const s = createHistorySync({ onSessions: (sessions) => emitted.push(sessions) });
    s.seedBootstrap([{ threadId: 't1', title: '重要会话', cwd: '/p', state: 'live', sessionPath: '/s/a.jsonl', lastActivityAt: Date.now() - 60_000 }], [], {});
    s.updateSession({ threadId: 't1', state: 'parked' });
    const session = emitted[emitted.length - 1]?.[0];
    expect(session?.title).toBe('重要会话');
    expect(session?.timeLabel).toBe('1 分钟前');
    expect(session?.state).toBe('idle');
  });

  it('状态映射：live+streaming=working；live 空闲=idle；dead=paused（唯一待处理态）', () => {
    const { emitted } = sink();
    const s = createHistorySync({ onSessions: (sessions) => emitted.push(sessions) });
    s.seedBootstrap([
      { threadId: 'tS', state: 'live', streaming: true, sessionPath: '/s/1', lastActivityAt: 1 },
      { threadId: 'tI', state: 'live', streaming: false, sessionPath: '/s/2', lastActivityAt: 1 },
      { threadId: 'tD', state: 'dead', sessionPath: '/s/3', lastActivityAt: 1 },
      { threadId: 'tP', state: 'parked', sessionPath: '/s/4', lastActivityAt: 1 },
    ], [], {});
    const list = emitted[emitted.length - 1] ?? [];
    expect(list.find((x) => x.id === 'tS')?.state).toBe('working');
    expect(list.find((x) => x.id === 'tI')?.state).toBe('idle');
    expect(list.find((x) => x.id === 'tD')?.state).toBe('paused');
    expect(list.find((x) => x.id === 'tP')?.state).toBe('idle');
  });

  it('saved 并入（M10）：不在册会话可见且 live 优先去重', () => {
    const { emitted } = sink();
    const s = createHistorySync({ onSessions: (sessions) => emitted.push(sessions) });
    s.seedBootstrap(
      [{ threadId: 'tLive', title: '活跃', state: 'live', sessionPath: '/s/live', lastActivityAt: 2 }],
      [
        { sessionId: 'tLive', sessionPath: '/s/live', title: '重复', lastActivityAt: 1 },
        { sessionId: 'tOld', sessionPath: '/s/old', title: '历史', lastActivityAt: 1 },
      ],
      { archivedSessions: ['/s/old'] },
    );
    const list = emitted[emitted.length - 1] ?? [];
    expect(list.some((x) => x.id === 'tLive' && x.title === '活跃')).toBe(true);
    expect(list.find((x) => x.id === 'tOld')).toMatchObject({ title: '历史', archived: true, state: 'idle' });
  });
});

/**
 * 症状回归：抽屉里每一条历史会话都挂红色「需要处理」。
 * parked（闲置回收后的静置，桌面端标「已归档」）曾被映射成 paused → 红标；
 * mergeSaved 更把盘上历史直接写死 paused。真正需要处理的只有 dead（worker 异常退出）。
 */
describe('会话状态语义（症状：历史会话全部标「需要处理」）', () => {
  it('parked 与盘上历史都不标待处理', () => {
    const emitted: ConversationSession[][] = [];
    const s = createHistorySync({ onSessions: (sessions) => emitted.push(sessions) });
    s.seedBootstrap(
      [
        { threadId: 'tParked', state: 'parked', sessionPath: '/s/p', lastActivityAt: 1 },
        { threadId: 'tDead', state: 'dead', sessionPath: '/s/d', lastActivityAt: 1 },
      ],
      [{ sessionId: 'tSaved', sessionPath: '/s/saved', title: '历史', lastActivityAt: 1 }],
      {},
    );
    const list = emitted[emitted.length - 1] ?? [];
    const byId = (id: string): string | undefined => list.find((x) => x.id === id)?.state;
    expect(byId('tParked')).toBe('idle');
    expect(byId('tSaved')).toBe('idle');
    // 唯一需要用户处理的是 worker 异常退出
    expect(byId('tDead')).toBe('paused');
  });
});
