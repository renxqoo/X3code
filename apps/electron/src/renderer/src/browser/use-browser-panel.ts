import * as React from 'react';

import type { BrowserEvent, BrowserFrameMeta } from '@x3code/contracts';

/**
 * 浏览器面板数据源（T61 M1）：browser/* invoke + x3code:browser-event 订阅的
 * 最小封装。帧不做历史缓存（双缓冲当前帧）；hostState 非 ready 时清空画布
 * （陈旧帧契约：restarting/failed 作废全部画面）。
 */

export type BrowserPanelState = {
  phase: string;
  cdpEndpoint: string | null;
  tabs: ReadonlyArray<{ targetId: string; url: string; title: string; active: boolean }>;
  frame: { targetId: string; streamEpoch: number; jpegB64: string; meta: BrowserFrameMeta } | null;
  actions: ReadonlyArray<BrowserActionEntry>;
};

/** 动作时间线条目（钧子回传统一人/Agent 两侧；环形缓冲 200 条）。 */
export type BrowserActionEntry = {
  id: number;
  at: number;
  targetId: string;
  kind: 'click' | 'input' | 'change' | 'keydown' | 'scroll';
  x?: number;
  y?: number;
  elementLabel?: string;
};

const ACTION_RING_LIMIT = 200;

let actionSeq = 0;

export const BROWSER_PANEL_EMPTY: BrowserPanelState = {
  phase: 'starting',
  cdpEndpoint: null,
  tabs: [],
  frame: null,
  actions: [],
};

export function reduceBrowserEvent(state: BrowserPanelState, event: BrowserEvent): BrowserPanelState {
  switch (event.type) {
    case 'hostState':
      // 陈旧帧契约：非 ready 相位清空画面与 tab（targetId 全作废）
      return {
        ...state,
        phase: event.phase,
        cdpEndpoint: event.cdpEndpoint ?? state.cdpEndpoint,
        frame: event.phase === 'ready' ? state.frame : null,
        tabs: event.phase === 'ready' ? state.tabs : [],
      };
    case 'frame': {
      // 世代号旧帧丢弃（同 target 停/复流竞态防护）
      const currentEpoch = state.frame?.targetId === event.targetId ? state.frame.streamEpoch : null;
      if (currentEpoch !== null && event.streamEpoch < currentEpoch) return state;
      return { ...state, frame: event };
    }
    case 'tabsChanged':
      return { ...state, tabs: event.tabs };
    case 'action': {
      const entry: BrowserActionEntry = {
        id: ++actionSeq,
        at: Date.now(),
        targetId: event.targetId,
        kind: event.kind,
        ...(event.x !== undefined ? { x: event.x } : {}),
        ...(event.y !== undefined ? { y: event.y } : {}),
        ...(event.elementLabel !== undefined ? { elementLabel: event.elementLabel } : {}),
      };
      const actions = [...state.actions, entry];
      return { ...state, actions: actions.length > ACTION_RING_LIMIT ? actions.slice(actions.length - ACTION_RING_LIMIT) : actions };
    }
    case 'viewportChanged':
      return state;
    default:
      return state;
  }
}

/** 画布渲染尺寸换算：画布 CSS 尺寸 → 页面 CSS 坐标（帧 meta 的 deviceWidth 为准）。 */
export function pageCoordinate(
  canvasX: number,
  canvasY: number,
  canvasWidth: number,
  frame: BrowserFrameMeta,
): { x: number; y: number } {
  const scale = frame.deviceWidth / Math.max(1, canvasWidth);
  return { x: Math.round(canvasX * scale), y: Math.round(canvasY * scale) };
}

/** preload 桥的 browser 面（渲染层经 window.x3code 访问；测试注入替身）。 */
export type BrowserBridge = {
  invoke(method: string, params: unknown): Promise<unknown>;
  subscribeBrowser(onEvent: (event: unknown) => void): () => void;
};

export function useBrowserPanel(bridge: BrowserBridge | null): BrowserPanelState {
  const [state, setState] = React.useState<BrowserPanelState>(BROWSER_PANEL_EMPTY);

  React.useEffect(() => {
    if (bridge === null) return;
    const unsubscribe = bridge.subscribeBrowser((raw) => {
      setState((prev) => reduceBrowserEvent(prev, raw as BrowserEvent));
    });
    void bridge.invoke('browser/bootstrap', {}).then(
      (outcome) => {
        if (typeof outcome === 'object' && outcome !== null && 'data' in outcome) {
          const data = (outcome as { data?: { phase?: string; cdpEndpoint?: string | null; tabs?: BrowserPanelState['tabs'] } }).data;
          if (data) {
            setState((prev) => ({
              ...prev,
              phase: data.phase ?? prev.phase,
              cdpEndpoint: data.cdpEndpoint ?? prev.cdpEndpoint,
              tabs: data.tabs ?? prev.tabs,
            }));
          }
        }
      },
      () => undefined,
    );
    return unsubscribe;
  }, [bridge]);

  // 面板可见期间对活跃 tab 开流；切 tab / 卸载停流
  const activeTargetId = state.tabs.find((tab) => tab.active)?.targetId ?? null;
  React.useEffect(() => {
    if (bridge === null || activeTargetId === null || state.phase !== 'ready') return;
    void bridge.invoke('browser/streamStart', { targetId: activeTargetId, maxWidth: 1286, maxHeight: 832 }).catch(() => undefined);
    return () => {
      void bridge.invoke('browser/streamStop', { targetId: activeTargetId }).catch(() => undefined);
    };
  }, [bridge, activeTargetId, state.phase]);

  return state;
}
