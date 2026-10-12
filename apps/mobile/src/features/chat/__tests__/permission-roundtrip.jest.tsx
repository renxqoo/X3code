/**
 * 权限确认往返（症状：授权卡点了没反应，或应答没真正发到 host）。
 *
 * 应答走 L2 ui_response 帧而非 host 命令——这条路径此前只断言「点了会清卡」，
 * ui_response 是否按 requestId/threadId/method 正确发出无人验证（bridge 未就绪时
 * 静默跳过，测试照样绿）。
 */
import { act, fireEvent, render } from '@testing-library/react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as React from 'react';

import { PermissionCard } from '@/features/chat/permission-card';
import { initializeRelayRuntime } from '@/mobile/relay/runtime';
import { useConversationStore } from '@/store/conversation-store';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));

/** 把 relay runtime 的状态与发送面换成受控替身（runtime 是模块级单例）。 */
function stubBridge(status: 'disconnected' | 'connected') {
  const runtime = initializeRelayRuntime();
  runtime.status = status;
  const sendFrame = jest.fn(() => Promise.resolve(true));
  (runtime.transport as unknown as { sendFrame: unknown }).sendFrame = sendFrame;
  return sendFrame;
}

describe('权限确认往返（ui_request → 授权卡 → ui_response）', () => {
  beforeEach(() => {
    useConversationStore.setState({ activeSessionId: 't1' });
  });

  it('允许一次：按 requestId 发 ui_response 且 payload 为 confirmed:true，随后清卡', async () => {
    const sendFrame = stubBridge('connected');
    const view = await render(<PermissionCard />);
    await act(() =>
      Promise.resolve(
        useConversationStore.getState().requestPermission({ id: 'req-7', title: '运行测试', command: 'bun test', approved: null }),
      ),
    );
    await view.rerender(<PermissionCard />);

    await fireEvent.press(view.getByText('允许一次'));

    expect(sendFrame).toHaveBeenCalledTimes(1);
    expect(sendFrame).toHaveBeenCalledWith({
      kind: 'ui_response',
      streamId: 'ui:req-7',
      seq: 1,
      body: { requestId: 'req-7', threadId: 't1', method: 'confirm', payload: { confirmed: true } },
    });
    expect(useConversationStore.getState().permissionQueue).toEqual([]);
  });

  it('拒绝：payload 为 confirmed:false', async () => {
    const sendFrame = stubBridge('connected');
    const view = await render(<PermissionCard />);
    await act(() =>
      Promise.resolve(
        useConversationStore.getState().requestPermission({ id: 'req-8', title: '删除文件', command: 'rm -rf build', approved: null }),
      ),
    );
    await view.rerender(<PermissionCard />);

    await fireEvent.press(view.getByText('拒绝'));

    expect(sendFrame).toHaveBeenCalledTimes(1);
    expect(sendFrame).toHaveBeenCalledWith({
      kind: 'ui_response',
      streamId: 'ui:req-8',
      seq: 1,
      body: { requestId: 'req-8', threadId: 't1', method: 'confirm', payload: { confirmed: false } },
    });
    expect(useConversationStore.getState().permissionQueue).toEqual([]);
  });

  it('bridge 未就绪时不发帧（静默跳过而非误发空 requestId）', async () => {
    const sendFrame = stubBridge('disconnected');
    const view = await render(<PermissionCard />);
    await act(() =>
      Promise.resolve(
        useConversationStore.getState().requestPermission({ id: 'req-9', title: '删除文件', command: 'rm', approved: null }),
      ),
    );
    await view.rerender(<PermissionCard />);

    await fireEvent.press(view.getByText('允许一次'));

    expect(sendFrame).not.toHaveBeenCalled();
    expect(useConversationStore.getState().permissionQueue).toEqual([]);
  });
});
