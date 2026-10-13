import { describe, expect, test } from 'bun:test';

import { BROWSER_PANEL_EMPTY, reduceBrowserEvent } from '../use-browser-panel';

/** 事件 reducer（T61 M3）：动作环形缓冲上限、hostState 陈旧帧契约、世代号。 */

const frame = (epoch: number) => ({
  type: 'frame' as const,
  targetId: 't1',
  streamEpoch: epoch,
  jpegB64: 'aGVsbG8=',
  meta: { deviceWidth: 1286, deviceHeight: 832, pageScaleFactor: 1 },
});

const action = (id: number) => ({
  type: 'action' as const,
  targetId: 't1',
  kind: 'click' as const,
  x: id,
  y: id,
});

describe('reduceBrowserEvent 动作环形缓冲', () => {
  test('超过 200 条裁剪最旧', () => {
    let state = BROWSER_PANEL_EMPTY;
    for (let i = 0; i < 230; i++) state = reduceBrowserEvent(state, action(i));
    expect(state.actions).toHaveLength(200);
    expect(state.actions[0]?.x).toBe(30); // 前 30 条被裁
    expect(state.actions.at(-1)?.x).toBe(229);
  });

  test('动作条目带 id 单调与 targetId', () => {
    const state = reduceBrowserEvent(BROWSER_PANEL_EMPTY, action(1));
    expect(state.actions).toHaveLength(1);
    expect(state.actions[0]?.targetId).toBe('t1');
    expect(state.actions[0]?.id).toBeGreaterThan(0);
  });
});

describe('hostState 陈旧帧契约', () => {
  test('restarting/failed 清空画面与 tab', () => {
    let state = reduceBrowserEvent(BROWSER_PANEL_EMPTY, frame(0));
    state = reduceBrowserEvent(state, { type: 'tabsChanged', tabs: [{ targetId: 't1', url: 'https://a.com', title: 'A', active: true }] });
    expect(state.frame).not.toBeNull();
    expect(state.tabs).toHaveLength(1);
    state = reduceBrowserEvent(state, { type: 'hostState', phase: 'restarting' });
    expect(state.frame).toBeNull();
    expect(state.tabs).toHaveLength(0);
  });

  test('ready 保留既有画面', () => {
    let state = reduceBrowserEvent(BROWSER_PANEL_EMPTY, frame(0));
    state = reduceBrowserEvent(state, { type: 'hostState', phase: 'ready' });
    expect(state.frame).not.toBeNull();
  });
});

describe('帧世代号', () => {
  test('旧世代帧丢弃', () => {
    let state = reduceBrowserEvent(BROWSER_PANEL_EMPTY, frame(3));
    state = reduceBrowserEvent(state, frame(2));
    expect(state.frame?.streamEpoch).toBe(3);
  });

  test('新世代帧接受', () => {
    let state = reduceBrowserEvent(BROWSER_PANEL_EMPTY, frame(2));
    state = reduceBrowserEvent(state, frame(3));
    expect(state.frame?.streamEpoch).toBe(3);
  });

  test('target 切换后首帧直接接受（跨 target 不比世代）', () => {
    let state = reduceBrowserEvent(BROWSER_PANEL_EMPTY, frame(5));
    state = reduceBrowserEvent(state, { ...frame(1), targetId: 't2' });
    expect(state.frame?.targetId).toBe('t2');
  });
});
