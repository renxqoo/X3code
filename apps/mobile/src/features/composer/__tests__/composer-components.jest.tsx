import { act, fireEvent, render } from '@testing-library/react-native';
import { beforeEach, describe, expect, it } from '@jest/globals';
import * as React from 'react';
import { ChatHeader } from '@/features/chat/chat-header';
import { ComposerPanel } from '@/features/composer/composer-panel';
import { TaskConfigSheet } from '@/features/composer/task-config-sheet';
import { useAttachmentStore } from '@/store/attachment-store';
import { useComposerStore } from '@/store/composer-store';
import { useConversationStore } from '@/store/conversation-store';
import { useNavigationStore } from '@/store/navigation-store';
import { TestWrapper } from '@/test/test-wrapper';
import { initializeRelayRuntime, resyncSessionStore } from '@/mobile/relay/runtime';

const invoke = jest.fn();

/** 显式未连接：runtime 是单例，上一个用例留下的 ready 状态必须由用例自己归位。 */
function bridgeOffline(): void {
  const runtime = initializeRelayRuntime();
  runtime.status = 'disconnected';
  invoke.mockReset();
  invoke.mockImplementation(() => Promise.resolve({ ok: false }));
}

/**
 * 连接就绪的 bridge：模型目录只能来自它（未连接时面板不给占位模型）。
 *
 * liveThreads 答一个活线程（t1）：发送路径先问宿主表找投递目标（reviveThread），
 * 表内没有就按「拿不到归档路径」拒绝并报「无法恢复这条会话」——面板类用例测的是
 * 发送交互，不该顺带落进无路径的拒绝分支。
 */
function readyBridge(modelList: Array<{ provider: string; modelId: string; reasoning?: boolean }>): void {
  const runtime = initializeRelayRuntime();
  runtime.status = 'ready';
  (runtime.client as unknown as { invoke: unknown }).invoke = invoke;
  invoke.mockReset();
  invoke.mockImplementation((method: string) => {
    if (method === 'model/list') return Promise.resolve({ ok: true, data: modelList });
    if (method === 'session/liveThreads') return Promise.resolve({ ok: true, data: { sessions: [{ threadId: 't1', state: 'live', streaming: false, sessionPath: '/s/t1.jsonl' }] } });
    return Promise.resolve({ ok: true, data: { sessions: [] } });
  });
}

describe('composer components', () => {
  beforeEach(() => {
    bridgeOffline();
    useComposerStore.setState({ draft: '', model: '', thinking: 'medium', permission: 'ask', generating: false });
    useAttachmentStore.setState({ items: [] });
    useConversationStore.getState().startNewSession();
    // 事件归并器是模块单例：上个用例的本地行还在里面。不对齐的话，下个快照会把它们
    // 带进本用例的会话（直接 store.setState 绕过 runtime，不触发 attachThread 的对齐）
    resyncSessionStore();
    useNavigationStore.setState({ drawerOpen: false, sheet: null });
  });

  it('edits a draft with attachments from the compact input', async () => {
    useAttachmentStore.getState().addAttachment({ id: 'sent-file', name: '设计.pdf', size: 2000, kind: 'pdf', status: 'ready' });
    const view = await render(<ComposerPanel />);
    expect(view.getByPlaceholderText('尽管问，带图也行')).toBeTruthy();
    await fireEvent.changeText(view.getByLabelText('消息输入框'), '检查 Android 构建');
    await fireEvent.press(view.getByLabelText('发送消息'));
    expect(useComposerStore.getState().draft).toBe('检查 Android 构建');
  });

  it('未连接时发送不上屏也不假装在生成（症状：本地回显让没送出的消息看起来已送达）', async () => {
    const view = await render(<ComposerPanel />);
    await fireEvent.changeText(view.getByLabelText('消息输入框'), '检查 Android 构建');
    await fireEvent.press(view.getByLabelText('发送消息'));
    expect(useComposerStore.getState().generating).toBe(false);
    expect(useConversationStore.getState().session.messages.some((message) => message.kind === 'user')).toBe(false);
    expect(useConversationStore.getState().session.messages[0]?.text).toBe('未连接电脑端，消息没有发送。');
  });

  it('连接态发送：草稿出栈、用户消息上屏', async () => {
    readyBridge([]);
    useConversationStore.setState({ activeSessionId: 't1', session: { ...useConversationStore.getState().session, id: 't1', messages: [] } });
    const view = await render(<ComposerPanel />);
    await fireEvent.changeText(view.getByLabelText('消息输入框'), '检查 Android 构建');
    await fireEvent.press(view.getByLabelText('发送消息'));
    expect(useComposerStore.getState().draft).toBe('');
    expect(useConversationStore.getState().session.messages[0]?.text).toBe('检查 Android 构建');
  });

  it('keeps only attachment and send controls in the input area', async () => {
    const view = await render(<ComposerPanel />);
    expect(view.getByLabelText('添加附件')).toBeTruthy();
    expect(view.getByLabelText('发送消息')).toBeTruthy();
    expect(view.queryByLabelText('上下文已使用 24%')).toBeNull();
    expect(view.queryByLabelText('模型与思考')).toBeNull();
    expect(view.queryByLabelText('任务配置')).toBeNull();
    expect(view.queryByLabelText('权限模式：每次询问')).toBeNull();
  });

  it('expands on focus and returns to the compact capsule on blur', async () => {
    const view = await render(<ComposerPanel />);
    expect(view.getByTestId('compact-composer')).toBeTruthy();
    expect(view.queryByTestId('focused-composer')).toBeNull();
    await fireEvent(view.getByLabelText('消息输入框'), 'focus');
    expect(view.queryByTestId('compact-composer')).toBeNull();
    expect(view.getByTestId('focused-composer')).toBeTruthy();
    expect(view.getByTestId('focused-composer').props.style).toMatchObject({ minHeight: 132 });
    await fireEvent(view.getByLabelText('消息输入框'), 'blur');
    expect(view.getByTestId('compact-composer')).toBeTruthy();
    expect(view.queryByTestId('focused-composer')).toBeNull();
  });

  it('opens attachments and removes a selected file', async () => {
    useAttachmentStore.getState().addAttachment({ id: '1', name: 'a.pdf', size: 100, kind: 'pdf', status: 'ready' });
    const view = await render(<ComposerPanel />);
    await fireEvent.press(view.getByLabelText('添加附件'));
    expect(useNavigationStore.getState().sheet).toBe('attachments');
    await fireEvent.press(view.getByLabelText('移除 a.pdf'));
    expect(useAttachmentStore.getState().items).toHaveLength(0);
  });

  it('configures model, thinking and permission from the computer model catalog', async () => {
    readyBridge([
      { provider: 'walk', modelId: 'walk-model', reasoning: true },
      { provider: 'walk', modelId: 'walk-fast' },
    ]);
    const view = await render(<TestWrapper><><ChatHeader /><TaskConfigSheet /></></TestWrapper>);
    await fireEvent.press(view.getByLabelText('任务配置'));
    await act(() => Promise.resolve());
    await view.rerender(<TestWrapper><><ChatHeader /><TaskConfigSheet /></></TestWrapper>);
    await fireEvent.press(view.getByText('walk-fast'));
    await fireEvent.press(view.getByText('高'));
    await fireEvent.press(view.getByText('仅规划'));
    expect(useComposerStore.getState()).toMatchObject({ model: 'walk/walk-fast', thinking: 'high', permission: 'plan' });
    // 上下文百分比没有真值来源——面板不再给固定数字
    expect(view.queryByText(/上下文 ·/)).toBeNull();
  });

  it('未连接时不摆占位模型（症状：未配对时列出一整排假模型）', async () => {
    bridgeOffline();
    const view = await render(<TestWrapper><><ChatHeader /><TaskConfigSheet /></></TestWrapper>);
    await fireEvent.press(view.getByLabelText('任务配置'));
    expect(view.getByText('模型目录来自电脑端——连接后在此选择（设备与连接页配对）。')).toBeTruthy();
    expect(view.queryByText('GPT-5.2 Codex')).toBeNull();
    expect(view.queryByText('Claude Sonnet 5')).toBeNull();
    expect(view.getByText('配置应用于当前对话；默认配置可在个人设置中调整。')).toBeTruthy();
  });

  it('removes and sends attachments', async () => {
    readyBridge([]);
    useConversationStore.setState({ activeSessionId: 't1', session: { ...useConversationStore.getState().session, id: 't1', messages: [] } });
    useAttachmentStore.getState().addAttachment({ id: '1', name: 'a.pdf', size: 100, kind: 'pdf', status: 'ready' });
    useComposerStore.getState().setDraft('内容');
    const view = await render(<ComposerPanel />);
    await fireEvent.press(view.getByLabelText('移除 a.pdf'));
    await act(() => Promise.resolve(useAttachmentStore.getState().addAttachment({ id: '2', name: 'b.pdf', size: 100, kind: 'pdf', status: 'ready' })));
    await view.rerender(<TestWrapper><ComposerPanel /></TestWrapper>);
    await fireEvent.press(view.getByLabelText('发送消息'));
    expect(useAttachmentStore.getState().items).toHaveLength(0);
    expect(useConversationStore.getState().session.messages[0]?.attachments?.[0]?.name).toBe('b.pdf');
  });

  it('stops generation', async () => {
    useComposerStore.setState({ generating: true });
    const view = await render(<ComposerPanel />);
    await fireEvent.press(view.getByLabelText('停止生成'));
    expect(useComposerStore.getState().generating).toBe(false);
  });
});

describe('TaskConfigSheet 连接模式（写档同步链）', () => {
  it('配置项切换在非连接态不崩（syncRemote 早退）', async () => {
    bridgeOffline();
    useNavigationStore.getState().openSheet('task-config');
    const view = await render(
      <TestWrapper>
        <TaskConfigSheet />
      </TestWrapper>,
    );
    await fireEvent.press(view.getByText('高'));
    await fireEvent.press(view.getByText('仅规划'));
    expect(useComposerStore.getState()).toMatchObject({ thinking: 'high', permission: 'plan' });
    expect(invoke.mock.calls.some(([method]) => method === 'session/setThinking')).toBe(false);
  });
});
