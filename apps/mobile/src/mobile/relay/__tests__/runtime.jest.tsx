import { beforeEach, describe, expect, it } from '@jest/globals';

import { initializeRelayRuntime, attachThread, hydrateThread, loadBootstrap } from '../runtime';
import { setRatchetKv } from '../credentials';
import * as conversationStoreModule from '@/store/conversation-store';
import * as historyStoreModule from '@/store/history-store';

function kvStub(): void {
  const map = new Map<string, string>();
  setRatchetKv({
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
  });
}

describe('relay runtime（T58 装配）', () => {
  beforeEach(() => {
    kvStub();
  });

  it('单例：两次初始化同实例；断连 disconnect 安全', () => {
    const a = initializeRelayRuntime();
    const b = initializeRelayRuntime();
    expect(a).toBe(b);
    expect(a.client).toBeTruthy();
    a.disconnect();
  });

  it('attachThread(null) 复位会话（不崩溃）', () => {
    attachThread(null);
    expect(true).toBe(true);
  });

  it('attachThread(id) 后非匹配线程事件不进消息流', () => {
    attachThread('t-active');
    const rt = initializeRelayRuntime();
    const client = rt.client as unknown as { dispatch(rawEvent: unknown): void };
    client.dispatch({ type: 'userMessage', threadId: 't-other', message: { id: 'u', text: 'x', origin: 'user' } });
    const { useConversationStore } = conversationStoreModule;
    expect(useConversationStore.getState().session.messages.some((m) => m.text === 'x')).toBe(false);
    attachThread(null);
  });

  it('sessionUpdated → 历史列表更新；sessionRemoved → 删行', () => {
    const { useHistoryStore } = historyStoreModule;
    const rt = initializeRelayRuntime();
    const client = rt.client as unknown as { dispatch(rawEvent: unknown): void };
    client.dispatch({ type: 'sessionUpdated', session: { threadId: 't-1', title: 'Relay 会话', cwd: '/p', state: 'live', streaming: false, model: null, thinkingLevel: null, sessionPath: '/s/1.jsonl', lastActivityAt: 1000, createdAt: 1000 } });
    expect(useHistoryStore.getState().sessions.some((s) => s.title === 'Relay 会话')).toBe(true);
    client.dispatch({ type: 'sessionRemoved', threadId: 't-1' });
    expect(useHistoryStore.getState().sessions.some((s) => s.id === 't-1')).toBe(false);
  });
});

describe('relay runtime 路由与装配分支', () => {
  beforeEach(() => {
    const map = new Map<string, string>();
    setRatchetKv({
      get: (key) => map.get(key) ?? null,
      set: (key, value) => {
        map.set(key, value);
      },
    });
  });

  it('sessionDied：活跃线程收敛一次（恰一次失败行）+ 历史列表 dead 标异常', () => {
    const rt = initializeRelayRuntime();
    const client = rt.client as unknown as { dispatch(rawEvent: unknown): void };
    attachThread('t-die');
    conversationStoreModule.useConversationStore.getState().openSession({ id: 't-die', title: 'D', preview: '', project: '', timeLabel: '', state: 'working', pinned: false, archived: false, unread: false, messages: [] });
    client.dispatch({ type: 'sessionUpdated', session: { threadId: 't-die', title: 'D', cwd: '/d', state: 'live', streaming: true, model: null, thinkingLevel: null, sessionPath: '/s/d.jsonl', lastActivityAt: 5, createdAt: 5 } });
    client.dispatch({ type: 'sessionDied', threadId: 't-die', reason: 'worker crash' });
    const messages = conversationStoreModule.useConversationStore.getState().session.messages;
    const failureRows = messages.filter((m) => m.kind === 'status' && m.text === 'session ended');
    expect(failureRows.length).toBe(1);
    expect(conversationStoreModule.useConversationStore.getState().session.messages.length).toBeGreaterThan(0);
    const { useHistoryStore } = historyStoreModule;
    expect(useHistoryStore.getState().sessions.find((s) => s.id === 't-die')?.state).toBe('paused');
    attachThread(null);
  });

  it('connectWithCredentials：无凭证时安全早退（不崩）', () => {
    const rt = initializeRelayRuntime();
    expect(() => rt.connectWithCredentials('whatever-token')).not.toThrow();
    rt.disconnect();
  });

  it('hydrateThread：断连（无连接）早退不清消息', async () => {
    attachThread('t-h');
    const { useConversationStore } = conversationStoreModule;
    useConversationStore.getState().appendMessages([{ id: 'keep', kind: 'user', text: 'keep', createdAt: '2026-01-01T00:00:00.000Z' }]);
    await hydrateThread('t-h');
    expect(useConversationStore.getState().session.messages.some((m) => m.id === 'keep')).toBe(true);
    attachThread(null);
  });

  it('dialogRequest/dialogSettled：权限卡置位与按 requestId 结算', () => {
    const rt = initializeRelayRuntime();
    const client = rt.client as unknown as { dispatch(rawEvent: unknown): void };
    client.dispatch({ type: 'dialogRequest', threadId: 't-x', requestId: 'r1', method: 'confirm', tool: 'bash', summary: '运行' });
    const { useConversationStore } = conversationStoreModule;
    expect(useConversationStore.getState().permissionQueue[0]?.id).toBe('r1');
    client.dispatch({ type: 'dialogSettled', requestId: 'r1' });
    expect(useConversationStore.getState().permissionQueue).toEqual([]);
  });
});

describe('症状「手机端打开 PC 侧会话发不出消息」：parked 唤活链', () => {
  /** 内存 host：thread/list 表项 + entries/prompt 应答脚本。 */
  function hostStub(spec: {
    table: Array<{ threadId: string; sessionPath: string | null; state: string }>;
    entriesOf: (threadId: string) => Array<Record<string, unknown>>;
    resumeTo?: string | null;
    /** listSaved 的应答（默认空列表——多数装置只关心 live 面）。 */
    savedOf?: () => Promise<{ ok: boolean; data?: unknown; error?: { kind: string; message: string } }>;
    /** live 面是否失败（默认成功）。 */
    liveFails?: boolean;
  }) {
    const savedOf = spec.savedOf ?? (() => Promise.resolve({ ok: true, data: [] as unknown[] }));
    const commands: Array<{ command: string; args: Record<string, unknown> }> = [];
    const resumed = new Set<string>();
    const client = {
      capabilities: { fileDialog: false, systemNotification: true },
      invoke: (method: string, params: unknown) => {
        const args = (params ?? {}) as Record<string, unknown>;
        commands.push({ command: method, args });
        const ok = (data: unknown) => Promise.resolve({ ok: true, data });
        const fail = (message: string) => Promise.resolve({ ok: false, error: { kind: 'transient', message } });
        if (method === 'session/liveThreads') {
          if (spec.liveFails === true) return fail('live_unavailable');
          return ok({ sessions: spec.table.map((row) => ({ threadId: row.threadId, cwd: '/w', state: row.state, streaming: false, sessionPath: row.sessionPath })) });
        }
        if (method === 'session/listSaved') {
          return savedOf();
        }
        if (method === 'session/entries') {
          const threadId = args['threadId'] as string;
          // resume 换发的 id 即在册（真实宿主行为：resume 后 worker 起来，新 id 可读写）
          if (resumed.has(threadId) || spec.table.some((row) => row.threadId === threadId)) return ok({ items: spec.entriesOf(threadId) });
          return fail('no_reason');
        }
        if (method === 'session/resume') {
          if (spec.resumeTo === null || spec.resumeTo === undefined) return fail('no_reason');
          resumed.add(spec.resumeTo);
          return ok({ threadId: spec.resumeTo });
        }
        return ok(null);
      },
      subscribe: () => () => undefined,
    } as never;
    return { client, commands, table: spec.table };
  }

  /** hydrateThread/reviveThread 走 runtime 内部 client —— 用 transport 桩换绑。 */
  async function withHost<T>(host: ReturnType<typeof hostStub>, run: () => Promise<T>): Promise<T> {
    const rt = initializeRelayRuntime();
    const live = rt.client as unknown as { transport: { sendCommand: unknown } };
    void live;
    const swap = rt as unknown as { client: unknown };
    const original = swap.client;
    swap.client = host.client;
    try {
      return await run();
    } finally {
      swap.client = original;
    }
  }

  /**
   * 症状回归：手机端工作空间候选恒空 → cwd 守卫永不满足 → 发消息恒被拒
   * （「先选择电脑端已有的工作空间」），而电脑端明明有上千个会话。
   *
   * 根因：loadBootstrap 以 live 面成败作为整体早退条件，live 一失败就连坐丢弃 saved 面
   * ——而绝大多数会话（已归档落盘的）只在 saved 侧。任一侧失败都不能废掉另一侧。
   */
  it('live 面失败不连坐 saved 侧（症状：工作空间候选恒空）', async () => {
    const savedRow = { id: 's-1', sessionPath: '/s/s-1.jsonl', cwd: '/work/proj', title: '归档会话', messageCount: 2 };
    const host = hostStub({
      table: [],
      entriesOf: () => [],
      // live 面失败（如服务端旧版不识别 includePreview 而报错）
      liveFails: true,
      savedOf: () => Promise.resolve({ ok: true, data: { sessions: [savedRow] } }),
    });
    await withHost(host, async () => {
      await loadBootstrap(host.client);
    });
    const sessions = historyStoreModule.useHistoryStore.getState().sessions;
    expect(sessions.some((row) => row.project === '/work/proj')).toBe(true);
  });

  it('live 与 saved 都失败时降级为空列表（不抛、不留半份数据）', async () => {
    const host = hostStub({
      table: [],
      entriesOf: () => [],
      savedOf: () => Promise.resolve({ ok: false, error: { kind: 'transient', message: 'nope' } }),
    });
    await withHost(host, async () => {
      await loadBootstrap(host.client);
    });
    expect(historyStoreModule.useHistoryStore.getState().sessions).toEqual([]);
  });

  it('saved 侧两种包装都识别（裸数组与 {sessions:[...]}）', async () => {
    for (const data of [[{ id: 's-1', sessionPath: '/s/s.jsonl', cwd: '/w/bare' }], { sessions: [{ id: 's-2', sessionPath: '/s/w.jsonl', cwd: '/w/wrapped' }] }]) {
      const host = hostStub({ table: [], entriesOf: () => [], savedOf: () => Promise.resolve({ ok: true, data }) });
      await withHost(host, async () => { await loadBootstrap(host.client); });
      const projects = historyStoreModule.useHistoryStore.getState().sessions.map((row) => row.project);
      expect(projects.some((p) => p === '/w/bare' || p === '/w/wrapped')).toBe(true);
    }
  });

  it('表内有占位（parked）→ 沿用原 threadId，不发 resume', async () => {
    const host = hostStub({ table: [{ threadId: 't-parked', sessionPath: '/s/p.jsonl', state: 'parked' }], entriesOf: () => [{ id: 'u-1', kind: 'user', text: '历史', createdAt: '2026-01-01T00:00:00.000Z' }] });
    await withHost(host, async () => {
      await loadBootstrap(host.client);
      attachThread('t-parked');
      await hydrateThread('t-parked');
    });
    expect(host.commands.some((entry) => entry.command === 'session/resume')).toBe(false);
    expect(conversationStoreModule.useConversationStore.getState().session.messages.some((m) => m.text === '历史')).toBe(true);
    attachThread(null);
  });

  it('桌面端已按同一路径换发新 id → 收养既有表项，不重复 resume', async () => {
    // 真实时序：bootstrap 时在册 → 桌面端 resume 后换了 threadId（同会话文件）→ 手机端水化
    const host = hostStub({
      table: [{ threadId: 't-gone', sessionPath: '/s/gone.jsonl', state: 'live' }],
      entriesOf: (threadId) => [{ id: `u-${threadId}`, kind: 'user', text: `历史-${threadId}`, createdAt: '2026-01-01T00:00:00.000Z' }],
      resumeTo: 't-new',
    });
    await withHost(host, async () => {
      await loadBootstrap(host.client);
      host.table.splice(0, host.table.length, { threadId: 't-new', sessionPath: '/s/gone.jsonl', state: 'live' });
      attachThread('t-gone');
      await hydrateThread('t-gone');
    });
    expect(host.commands.some((entry) => entry.command === 'session/resume')).toBe(false);
    const messages = conversationStoreModule.useConversationStore.getState().session.messages;
    expect(messages.some((m) => m.text === '历史-t-new')).toBe(true);
    attachThread(null);
  });

  it('表内无同路径表项 → 按已知 sessionPath resume，换发的新 threadId 承接历史', async () => {
    const host = hostStub({
      table: [{ threadId: 't-gone', sessionPath: '/s/gone.jsonl', state: 'live' }],
      entriesOf: (threadId) => [{ id: `u-${threadId}`, kind: 'user', text: `历史-${threadId}`, createdAt: '2026-01-01T00:00:00.000Z' }],
      resumeTo: 't-new',
    });
    await withHost(host, async () => {
      await loadBootstrap(host.client);
      host.table.splice(0, host.table.length);
      attachThread('t-gone');
      await hydrateThread('t-gone');
    });
    expect(host.commands.some((entry) => entry.command === 'session/resume')).toBe(true);
    const messages = conversationStoreModule.useConversationStore.getState().session.messages;
    expect(messages.some((m) => m.text === '历史-t-new')).toBe(true);
    attachThread(null);
  });

  it('唤不活（无表项且 resume 失败）→ 不清空既有消息，不静默换轨', async () => {
    const host = hostStub({ table: [{ threadId: 't-lost', sessionPath: '/s/l.jsonl', state: 'live' }], entriesOf: () => [], resumeTo: null });
    await withHost(host, async () => {
      await loadBootstrap(host.client);
      host.table.splice(0, host.table.length);
      attachThread('t-lost');
      conversationStoreModule.useConversationStore.getState().appendMessages([{ id: 'keep', kind: 'user', text: 'keep', createdAt: '2026-01-01T00:00:00.000Z' }]);
      await hydrateThread('t-lost');
    });
    expect(conversationStoreModule.useConversationStore.getState().session.messages.some((m) => m.id === 'keep')).toBe(true);
    expect(host.commands.filter((entry) => entry.command === 'session/entries')).toHaveLength(1);
    attachThread(null);
  });
});
