/**
 * preview 跨仓契约的端到端护栏（症状：内容搜索永远零结果）。
 *
 * 这条用例存在的唯一理由：previous 版本里 preview 的测试直接喂
 * toConversationSession / updateSession，绕开了 mapThreadRows → withSavedMeta →
 * seedBootstrap 这条真实链路，于是 host 下发的 preview 在映射层被丢弃，12 条测试全绿
 * 而特性零效果。断言必须从 host 原始行起，穿过每一个映射层。
 */
import { describe, expect, it } from '@jest/globals';

import { mapThreadRows, mapSavedSessions } from '@/mobile/relay/response-map';
import { withSavedMeta } from '@/mobile/relay/with-saved-meta';
import { createHistorySync } from '@/mobile/state/history-sync';

/** hub thread/list 的原始行（x-harness host-commands 的形状）。 */
const hostLiveRow = (over: Record<string, unknown> = {}) => ({
  threadId: 't1', cwd: '/w', sessionPath: '/s/t1.jsonl', state: 'live',
  idleMs: 0, rssBytes: null, keepalive: false, isStreaming: false,
  preview: '正文里有 relay 这个词', ...over,
});

/** hub thread/list_saved 的原始行（x-harness saved-query 的形状）。 */
const hostSavedRow = (over: Record<string, unknown> = {}) => ({
  id: 't1', sessionPath: '/s/t1.jsonl', createdAt: 1, updatedAt: 2,
  title: '标题', cwd: '/w', messageCount: 3, lastSeq: 9,
  preview: '归档侧摘要', ...over,
});

describe('preview 跨仓链路（症状：12 条测试全绿但特性零效果）', () => {
  it('host thread/list 的 preview 穿过 mapThreadRows 到达会话行', () => {
    const rows = mapThreadRows([hostLiveRow()]);
    expect(rows[0]?.preview).toBe('正文里有 relay 这个词');
  });

  it('host 未带 preview 时不透传空键（字段缺席，不伪造空串）', () => {
    const rows = mapThreadRows([hostLiveRow({ preview: undefined })]);
    expect('preview' in (rows[0] ?? {})).toBe(false);
  });

  it('host thread/list_saved 的 preview 穿过 mapSavedSessions', () => {
    const rows = mapSavedSessions({ sessions: [hostSavedRow()] });
    expect(rows[0]?.['preview']).toBe('归档侧摘要');
  });

  it('live 行缺 preview 时由 saved 面补齐（内容摘要在归档面才是权威）', () => {
    const merged = withSavedMeta(mapThreadRows([hostLiveRow({ preview: undefined })]), mapSavedSessions({ sessions: [hostSavedRow()] }));
    expect(merged[0]?.['preview']).toBe('归档侧摘要');
  });

  it('live 行已有 preview 时不被 saved 面覆盖', () => {
    const merged = withSavedMeta(mapThreadRows([hostLiveRow()]), mapSavedSessions({ sessions: [hostSavedRow()] }));
    expect(merged[0]?.['preview']).toBe('正文里有 relay 这个词');
  });

  it('全链路：host 原始行 → 映射 → 归并 → seedBootstrap → 会话行', () => {
    const emitted: Array<{ id: string; preview: string }[]> = [];
    const sync = createHistorySync({ onSessions: (sessions) => { emitted.push(sessions as never); } });
    const saved = mapSavedSessions({ sessions: [hostSavedRow()] });
    sync.seedBootstrap(withSavedMeta(mapThreadRows([hostLiveRow({ preview: undefined })]), saved), saved, { pinnedSessions: [], archivedSessions: [] });
    expect(emitted[emitted.length - 1]?.[0]?.preview).toBe('归档侧摘要');
  });

  it('saved-only 会话（不在 thread/list）的 preview 同样落到会话行', () => {
    // 该分支 withSavedMeta 管不到（它只 live.map），preview 必须由 seedBootstrap 的
    // saved 分支自己带上——漏拷则「只在归档列表里的会话」内容搜索恒零命中
    const emitted: Array<{ id: string; preview: string }[]> = [];
    const sync = createHistorySync({ onSessions: (sessions) => { emitted.push(sessions as never); } });
    sync.seedBootstrap([], mapSavedSessions({ sessions: [hostSavedRow({ id: 'archived-only' })] }), {});
    const row = emitted[emitted.length - 1]?.find((item) => item.id === 'archived-only');
    expect(row?.preview).toBe('归档侧摘要');
  });

  it('全链路：live 侧的 preview 也能独立落到会话行', () => {
    const emitted: Array<{ id: string; preview: string }[]> = [];
    const sync = createHistorySync({ onSessions: (sessions) => { emitted.push(sessions as never); } });
    sync.seedBootstrap(mapThreadRows([hostLiveRow()]), [], { pinnedSessions: [], archivedSessions: [] });
    expect(emitted[emitted.length - 1]?.[0]?.preview).toBe('正文里有 relay 这个词');
  });
});