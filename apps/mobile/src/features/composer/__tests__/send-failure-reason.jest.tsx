/**
 * 症状：手机端发送失败只显示「发送失败：transient」——reason 位被 ApiError 的
 * kind（transient/permanent 分级）顶掉了，真因（unknown_thread / scope-denied /
 * model_unavailable…）全程不可见，用户无从判断该重试、该开电脑还是该换模型。
 *
 * 投递前唤活会先问宿主表（reviveThread），故各用例都要一并应答 session/liveThreads。
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { initializeRelayRuntime, resyncSessionStore } from '@/mobile/relay/runtime';
import { renderHook } from '@testing-library/react-native';
import { useComposerSubmit } from '@/features/composer/use-composer-submit';
import { useComposerStore } from '@/store/composer-store';
import { useConversationStore } from '@/store/conversation-store';

const invoke = jest.fn();

const LIVE_T1 = { ok: true, data: { sessions: [{ threadId: 't1', state: 'live', streaming: false, sessionPath: '/s/t1.jsonl' }] } };

/** 连接就绪的 bridge，invoke 由用例指定应答。 */
function readyBridge(): void {
  const runtime = initializeRelayRuntime();
  runtime.status = 'ready';
  (runtime.client as unknown as { invoke: unknown }).invoke = invoke;
}

/** 会话在宿主表里是活的（投递目标现成），但 prompt 被宿主拒绝，原因由用例给。 */
function answerPromptFailure(message: string): void {
  invoke.mockImplementation((method: string) => Promise.resolve(method === 'session/liveThreads' ? LIVE_T1 : { ok: false, error: { kind: 'transient', message } }));
}

async function send(text: string): Promise<void> {
  // 草稿必须在挂载前入 store：hook 返回值捕获的是渲染那一刻的 draft
  useComposerStore.getState().setDraft(text);
  const view = await renderHook(() => useComposerSubmit());
  view.result.current();
  // 发送是悬空 async（内部先 await reviveThread 再 invoke），冲干净微任务链再断言
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function failTexts(): string[] {
  return useConversationStore.getState().session.messages.filter((message) => message.kind === 'status').map((message) => message.text);
}

describe('发送失败原因可见性（症状：只显示 transient）', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((method: string) => Promise.resolve(method === 'session/liveThreads' ? LIVE_T1 : { ok: false, error: { kind: 'transient', message: 'unknown_thread' } }));
    useComposerStore.setState({ draft: '', generating: false });
    useConversationStore.setState({ permissionRequest: null, activeSessionId: 't1', session: { ...useConversationStore.getState().session, id: 't1', messages: [], detached: false } });
    readyBridge();
    // 归并器是模块单例：上条用例的本地行还在里面，不对齐会被下个快照带进本用例
    resyncSessionStore();
  });

  it('prompt 失败：显示 host 错误码对应文案，不显示 kind', async () => {
    answerPromptFailure('unknown_thread');
    await send('你好');
    expect(failTexts()).toEqual(['发送失败：会话已在桌面端关闭']);
    expect(failTexts().join()).not.toContain('transient');
  });

  it('权限不足与模型不可用各自给出可行动文案', async () => {
    answerPromptFailure('scope-denied');
    await send('a');
    expect(failTexts().at(-1)).toContain('设备权限不足');

    answerPromptFailure('model_unavailable');
    await send('b');
    expect(failTexts().at(-1)).toContain('模型不可用');
  });

  it('host 没给原因：显式提示缺因，而不是回落成 kind', async () => {
    answerPromptFailure('no_reason');
    await send('你好');
    expect(failTexts()).toEqual(['发送失败：桌面端未返回失败原因，请重试']);
  });

  it('唤活拿不到归档路径：报「无法恢复」而不是把 unknown_thread 说成会话被关', async () => {
    // 症状回归：会话已移出宿主表、设备也没有它的归档路径时，继续 prompt 只会拿到
    // unknown_thread，用户会误以为会话在电脑端被删了，实际是设备侧没有恢复入口。
    // 用一个本文件内从未记过路径的 id（路径索引是模块级单例，别让前序用例污染它）。
    useConversationStore.setState({ activeSessionId: 't-gone', session: { ...useConversationStore.getState().session, id: 't-gone', messages: [] } });
    invoke.mockImplementation((method: string) => Promise.resolve(method === 'session/liveThreads' ? { ok: true, data: { sessions: [] } } : { ok: false, error: { kind: 'transient', message: 'unknown_thread' } }));
    await send('你好');
    expect(invoke.mock.calls.map((call) => call[0])).not.toContain('session/prompt');
    expect(failTexts().at(-1)).toContain('无法恢复这条会话');
    expect(failTexts().at(-1)).not.toContain('会话已在桌面端关闭');
  });

  it('会话已在桌面端重开过：设备没记路径也能直接投递（先问宿主表，不靠本地路径索引）', async () => {
    // 症状回归：设备面的路径索引是启动时快照，桌面端之后重开过的会话本地没路径，
    // 旧实现直接判 no_session_path 拒绝发送——宿主明明有活线程。
    invoke.mockImplementation((method: string) => Promise.resolve(method === 'session/liveThreads' ? LIVE_T1 : { ok: true, data: null }));
    await send('你好');
    expect(invoke.mock.calls.map((call) => call[0])).toContain('session/prompt');
    expect(failTexts()).toEqual([]);
  });
});
