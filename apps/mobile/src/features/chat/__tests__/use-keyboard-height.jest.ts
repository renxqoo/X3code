/**
 * 症状回归（对话输入框被遮）：对话输入区用 position:absolute + 写死 bottom 钉在屏底，
 * KeyboardAvoidingView 的 padding 只推流式内容、不动绝对定位元素，键盘升起后输入区
 * 仍在键盘之下。根因是 dock 的 bottom 必须是键盘实测高度，而非常量安全区。
 */
import { act, renderHook } from '@testing-library/react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Keyboard } from 'react-native';

import { useKeyboardHeight } from '@/features/chat/use-keyboard-height';

type Listener = (event: unknown) => void;

const emitted = new Map<string, Listener[]>();
const removed: string[] = [];

function installKeyboardMock(): void {
  emitted.clear();
  removed.length = 0;
  const addListener = jest.fn((event: string, handler: Listener) => {
    const list = emitted.get(event) ?? [];
    list.push(handler);
    emitted.set(event, list);
    return { remove: () => { removed.push(event); } };
  });
  (Keyboard as unknown as { addListener: typeof addListener }).addListener = addListener as never;
}

// 键盘事件是外部推送的状态更新：不包 act 则 React 不提交，renderHook 的 result
// 读到的是更新前的值（且在全量跑时序下更不稳）。.then 收尾保持 no-floating-promises 通过。
function emit(event: string, payload: unknown): Promise<void> {
  const applied = act(() => {
    for (const handler of emitted.get(event) ?? []) handler(payload);
  });
  return Promise.resolve(applied).then(() => undefined);
}

describe('useKeyboardHeight（症状：对话输入框被键盘遮盖）', () => {
  beforeEach(() => { installKeyboardMock(); });
  afterEach(() => { jest.restoreAllMocks(); });

  it('初始为 0——键盘未升起时 dock 贴安全区', async () => {
    const view = await renderHook(() => useKeyboardHeight());
    expect(view.result.current).toBe(0);
  });

  it('键盘升起取实测高度（不写死——各输入法高度不同）', async () => {
    const view = await renderHook(() => useKeyboardHeight());
await emit('keyboardWillShow', { endCoordinates: { height: 336 } });
    expect(view.result.current).toBe(336);
  });

  it('键盘收起归零——dock 回到安全区贴屏底', async () => {
    const view = await renderHook(() => useKeyboardHeight());
await emit('keyboardWillShow', { endCoordinates: { height: 336 } });
await emit('keyboardWillHide', {});
    expect(view.result.current).toBe(0);
  });

  it('事件缺 endCoordinates 时收敛到 0——不让 dock 悬在半空', async () => {
    const view = await renderHook(() => useKeyboardHeight());
await emit('keyboardWillShow', {});
    expect(view.result.current).toBe(0);
  });

  it('仅用 startCoordinates 的旧事件形态也取得到高度', async () => {
    const view = await renderHook(() => useKeyboardHeight());
await emit('keyboardWillShow', { startCoordinates: { height: 291 } });
    expect(view.result.current).toBe(291);
  });

  it('卸载时摘除监听——不在已卸载组件上派发（泄漏面）', async () => {
    const view = await renderHook(() => useKeyboardHeight());
    // effect cleanup 在卸载后异步刷新——断言前冲一个微任务，否则读到的是清理前的空监听
    await Promise.resolve(view.unmount()).catch(() => undefined);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    // 两条监听（show/hide）均被摘除：残留会在卸载后继续 setState（泄漏 + 幽灵更新）
    expect(new Set(removed)).toEqual(new Set(['keyboardWillShow', 'keyboardWillHide']));
  });
});