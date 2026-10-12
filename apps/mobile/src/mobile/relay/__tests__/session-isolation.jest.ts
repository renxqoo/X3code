/**
 * 状态隔离的端到端护栏（对抗审查补）。
 *
 * 两类症状：
 * 1) 本地删除的会话在重连后复活，且此后被永久冻结——每一�� sessionUpdated 都被墓碑丢弃
 * 2) 绕过 openSessionAndAttach 的换宿主路径不清暂存域，附件/草稿串到下一个会话
 */
import { describe, expect, it } from '@jest/globals';

import { createHistorySync } from '@/mobile/state/history-sync';
import { bindLocalHistorySink } from '@/mobile/state/local-history-changes';
import { useAttachmentStore } from '@/store/attachment-store';
import { useComposerStore } from '@/store/composer-store';
import { useConversationStore } from '@/store/conversation-store';
import { attachThread, openSessionAndAttach } from '@/mobile/relay/session-lifecycle';

const raw = (threadId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  threadId, title: `会话 ${threadId}`, cwd: '/w', state: 'idle', streaming: false,
  sessionPath: `/s/${threadId}.jsonl`, lastActivityAt: 1_700_000_000_000, createdAt: 1_700_000_000_000,
  ...extra,
});

const last = (emitted: Array<Record<string, unknown>[]>): Record<string, unknown>[] =>
  (emitted[emitted.length - 1] ?? []) as Record<string, unknown>[];

describe('本地删除的会话不会被永久冻结（症状：重连后复活且收不到桌端更新）', () => {
  it('bootstrap 后会话可继续接收 sessionUpdated（墓碑随权威快照清空）', () => {
    const emitted: Array<Record<string, unknown>[]> = [];
    const sync = createHistorySync({ onSessions: (sessions) => { emitted.push(sessions as never); } });
    // 走真实链路：本地删除经登记回流到真相层（直接调 applyLocalChange 会绕过登记语义）
    bindLocalHistorySink((id, change) => { sync.applyLocalChange(id, change); });
    sync.updateSession(raw('t1') as never);
    sync.applyLocalChange('t1', null);
    // 重连：bootstrap 是权威快照，桌端仍列着这条（设备侧删除走 retire，非真删）
    sync.seedBootstrap([raw('t1', { title: '桌端的真名' })] as never, [], {});
    expect(last(emitted).map((row) => row['id'])).toEqual(['t1']);
    // 关键：此后的桌端更新必须能落到会话行上（不复活即冻结）
    sync.updateSession(raw('t1', { title: '改名了', state: 'dead' }) as never);
    const row = last(emitted).find((item) => item['id'] === 't1');
    expect(row?.['title']).toBe('改名了');
    // dead 是唯一映射到 paused 的态（stateOf 的既定语义：live 非流式=idle、dead=paused）
    expect(row?.['state']).toBe('paused');
  });

  it('bootstrap 未列出的会话不进列表（墓碑之外仍以快照为准）', () => {
    const emitted: Array<Record<string, unknown>[]> = [];
    const sync = createHistorySync({ onSessions: (sessions) => { emitted.push(sessions as never); } });
    sync.updateSession(raw('t1') as never);
    sync.seedBootstrap([], [], {});
    expect(last(emitted)).toEqual([]);
  });
});

describe('换宿主清暂存域（症状：附件/草稿串到下一个会话）', () => {
  it('attachThread 换到新线程时清草稿与附件（不依赖调用侧记着清）', () => {
    useComposerStore.setState({ draft: 'A 的草稿' });
    useAttachmentStore.getState().addAttachment({ id: 'a1', kind: 'image', uri: 'file://a', status: 'ready' } as never);
    useConversationStore.getState().openSession({ id: 'A', messages: [] } as never);

    attachThread('B');
    expect(useComposerStore.getState().draft).toBe('');
    expect(useAttachmentStore.getState().items).toHaveLength(0);
    attachThread(null);
  });

  it('同一线程重复挂载不清（渲染期反复调用不得吃掉草稿）', () => {
    // 先经真实入口建立宿主锚点，再测重复挂载幂等（守卫读 attach 域自身记忆，
    // 不依赖 openSession 与 attachThread 的调用先后）
    attachThread('A');
    useComposerStore.setState({ draft: '同一个会话的草稿' });
    useConversationStore.getState().openSession({ id: 'A', messages: [] } as never);
    attachThread('A');
    attachThread('A');
    expect(useComposerStore.getState().draft).toBe('同一个会话的草稿');
    attachThread(null);
  });

  it('openSessionAndAttach 换会话同样清暂存域', async () => {
    useComposerStore.setState({ draft: '上一会话草稿' });
    useAttachmentStore.getState().addAttachment({ id: 'a2', kind: 'image', uri: 'file://b', status: 'ready' } as never);
    useConversationStore.getState().openSession({ id: 'A', messages: [] } as never);

    await openSessionAndAttach({ id: 'C', title: 'C', messages: [] } as never);
    expect(useComposerStore.getState().draft).toBe('');
    expect(useAttachmentStore.getState().items).toHaveLength(0);
    attachThread(null);
  });
});