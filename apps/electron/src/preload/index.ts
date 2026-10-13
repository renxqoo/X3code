import { contextBridge, ipcRenderer } from 'electron';

import type { WindowState } from '../renderer/src/lib/window-state';

const bridge = {
  invoke(method: string, params: unknown): Promise<unknown> {
    return ipcRenderer.invoke('x3code:invoke', { method, params });
  },
  subscribe(onEvent: (e: unknown) => void): () => void {
    const listener = (_e: unknown, ev: unknown): void => onEvent(ev);
    ipcRenderer.on('x3code:event', listener);
    return () => ipcRenderer.removeListener('x3code:event', listener);
  },
  window: {
    minimize(): Promise<void> {
      return ipcRenderer.invoke('x3code:window-minimize');
    },
    toggleMaximize(): Promise<void> {
      return ipcRenderer.invoke('x3code:window-toggle-maximize');
    },
    close(): Promise<void> {
      return ipcRenderer.invoke('x3code:window-close');
    },
    openExternal(url: string): Promise<void> {
      return ipcRenderer.invoke('x3code:window-open-external', url);
    },
    getState(): Promise<WindowState> {
      return ipcRenderer.invoke('x3code:window-get-state');
    },
  },
  /** remote-access 网关面（桌面 = gateway owner）：状态 / owner 命令（配对与设备管理）。 */
  gateway: {
    status(): Promise<unknown> {
      return ipcRenderer.invoke('x3code:gateway-status');
    },
    command(payload: { command: string; args?: Record<string, unknown> }): Promise<unknown> {
      return ipcRenderer.invoke('x3code:gateway-command', payload);
    },
  },
};

contextBridge.exposeInMainWorld('x3code', bridge);

export type X3codeBridge = typeof bridge;
