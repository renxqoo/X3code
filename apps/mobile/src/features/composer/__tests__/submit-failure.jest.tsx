/**
 * 症状：手机端发消息失败只显示「未知错误」，且 PC 侧闲置 park 过的会话
 * 直接发不出去（宿主表无活线程时 prompt 无投递目标）。这两条都在发送
 * 管线上：失败原因可读 + 投递前唤活。
 */
import { act, render } from '@testing-library/react-native';
import { beforeEach, describe, expect, it } from '@jest/globals';
import * as React from 'react';

import { useComposerSubmit } from '../use-composer-submit';
import { useComposerStore } from '@/store/composer-store';
import { useConversationStore } from '@/store/conversation-store';
import { useAttachmentStore } from '@/store/attachment-store';
import { useHistoryStore } from '@/store/history-store';
import { testSession } from '@/test/session-fixture';
import { initializeRelayRuntime, loadBootstrap, resyncSessionStore } from '@/mobile/relay/runtime';

interface InvokeLog {
  command: string;
  args: Record<string, unknown>;
}

/** 内存 host：脚本化应答（attachThread 已在 runtime 层注册 sessionPath 索引）。 */
function stubHost(reply: (method: string, args: Record<string, unknown>) => { ok: boolean; data?: unknown; error?: { message?: string } }): InvokeLog[] {
  const log: InvokeLog[] = [];
  const runtime = initializeRelayRuntime();
  const mutable = runtime as unknown as { client: unknown; status: string };
  mutable.client = {
    capabilities: { fileDialog: false, systemNotification: true },
    invoke: (method: string, params: unknown) => {
      const args = (params ?? {}) as Record<string, unknown>;
      log.push({ command: method, args });
      return Promise.resolve(reply(method, args));
    },
    subscribe: () => () => undefined,
  };
  mutable.status = 'ready';
  return log;
}

/** 挂载即提交一次（钩子返回值在真实界面由发送按钮驱动）。 */
function Composer({ submit }: { submit: boolean }): null {
  const send = useComposerSubmit();
  React.useEffect(() => {
    if (submit) send();
  }, [send, submit]);
  return null;
}

/** 渲染并跑完发送管线的 await 链（提交是同步返回、内部异步推进）。 */
async function submitOnce(): Promise<void> {
  await act(async () => {
    await render(<Composer submit />);
    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
  });
}

describe('发送管线（症状：发不出去 + 只显示未知错误）', () => {
  beforeEach(() => {
    useComposerStore.setState({ draft: '', generating: false });
    useAttachmentStore.setState({ items: [] });
    useConversationStore.getState().startNewSession();
    // 事件归并器是模块单例：上个用例的本地行还在里面，不对齐会被下个快照带进本用例
    resyncSessionStore();
    // 新建会话只认电脑端候选内的目录（cwd 守卫）：给一条在册工作空间
    useHistoryStore.setState({ sessions: [testSession('ws-session', { project: '/work/agent-app' })], query: '' });
    useConversationStore.getState().chooseWorkspace('/work/agent-app', 'agent-app', '/work/agent-app');
  });

  it('失败原因可读：scope-denied 展示中文原因而非未知错误', async () => {
    stubHost(() => ({ ok: false, error: { message: 'scope-denied' } }));
    useComposerStore.getState().setDraft('继续');
    await submitOnce();
    const failure = useConversationStore.getState().session.messages.find((message) => message.kind === 'status');
    expect(failure?.text).toContain('设备权限不足');
    expect(failure?.text).not.toContain('未知错误');
  });

  it('投递前唤活：已有会话先 resume 再 prompt（PC 侧 park 过的会话）', async () => {
    // 真实时序：bootstrap 时在册（记下 sessionPath）→ 桌面端收编移出表 → 手机端发消息
    const table: Array<{ threadId: string; sessionPath: string | null; state: string }> = [
      { threadId: 't-parked', sessionPath: '/s/p.jsonl', state: 'parked' },
    ];
    const log = stubHost((method) => {
      if (method === 'session/liveThreads') {
        return {
          ok: true,
          data: { sessions: table.map((row) => ({ threadId: row.threadId, cwd: '/w', state: row.state, streaming: false, sessionPath: row.sessionPath })) },
        };
      }
      if (method === 'session/entries') return { ok: false, error: { message: 'no_reason' } };
      if (method === 'session/resume') return { ok: true, data: { threadId: 't-live' } };
      return { ok: true, data: null };
    });
    await act(async () => {
      await loadBootstrap(initializeRelayRuntime().client);
    });
    table.splice(0, table.length);
    useConversationStore.getState().openSession({ ...useConversationStore.getState().session, id: 't-parked' });
    useComposerStore.getState().setDraft('继续');
    await submitOnce();
    const order = log.map((entry) => entry.command);
    expect(order).toContain('session/resume');
    expect(order.indexOf('session/resume')).toBeLessThan(order.lastIndexOf('session/prompt'));
    expect(log.find((entry) => entry.command === 'session/prompt')?.args['threadId']).toBe('t-live');
  });

  it('新建会话：start 失败时给出可读原因', async () => {
    stubHost(() => ({ ok: false, error: { message: 'host_unavailable' } }));
    useComposerStore.getState().setDraft('继续');
    await submitOnce();
    const failure = useConversationStore.getState().session.messages.find((message) => message.kind === 'status');
    expect(failure?.text).toContain('桌面端不可用');
  });

  it('未选工作空间时拒绝新建（症状：把「未选择工作空间」当目录发给 hub 建出错线程）', async () => {
    const log = stubHost(() => ({ ok: true, data: null }));
    useConversationStore.getState().chooseWorkspace('未选择工作空间', '未选择工作空间');
    useComposerStore.getState().setDraft('继续');
    await submitOnce();
    expect(log.map((entry) => entry.command)).not.toContain('session/start');
    const failure = useConversationStore.getState().session.messages.find((message) => message.kind === 'status');
    expect(failure?.text).toContain('先选择电脑端已有的工作空间');
  });

  it('选中的目录不在电脑端候选内时拒绝新建（症状：凭空目录被 hub 写入信任注册表）', async () => {
    const log = stubHost(() => ({ ok: true, data: null }));
    useConversationStore.getState().chooseWorkspace('/work/never-used', 'never-used', '/work/never-used');
    useComposerStore.getState().setDraft('继续');
    await submitOnce();
    expect(log.map((entry) => entry.command)).not.toContain('session/start');
  });

  it('候选内的工作空间带上真路径建会话', async () => {
    const log = stubHost(() => ({ ok: true, data: { threadId: 't-new' } }));
    useComposerStore.getState().setDraft('继续');
    await submitOnce();
    const start = log.find((entry) => entry.command === 'session/start');
    expect(start?.args['cwd']).toBe('/work/agent-app');
  });
});