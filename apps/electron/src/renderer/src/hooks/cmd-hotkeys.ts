import * as React from 'react';

export type CmdHotkeyAction = 'newThread' | 'search' | 'toggleDiff' | 'toggleAgents';

/** ⌘N/⌘K/⌘⇧D/⌘⇧A 命中判定：macOS ⌘、其余平台 Ctrl；Alt 组合不劫持（留给系统）。 */
export function resolveCmdHotkey(mod: { meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }, key: string): CmdHotkeyAction | null {
  if (!(mod.meta || mod.ctrl) || mod.alt) return null;
  const lower = key.toLowerCase();
  // shift 组合单独分派（面板开关）；⌘D/⌘A 裸组合不劫持（编辑器/系统语义）
  if (mod.shift) {
    if (lower === 'd') return 'toggleDiff';
    if (lower === 'a') return 'toggleAgents';
    return null;
  }
  if (lower === 'n') return 'newThread';
  if (lower === 'k') return 'search';
  return null;
}

type CmdHotkeysHandlers = {
  /** ⌘N/Ctrl+N：新建任务。 */
  onNewThread: () => void;
  /** ⌘K/Ctrl+K：切换命令面板（面板开着再按关闭）。 */
  onSearch: () => void;
  /** ⌘⇧D/Ctrl+Shift+D：切换 Diff 面板。 */
  onToggleDiff: () => void;
  /** ⌘⇧A/Ctrl+Shift+A：切换子代理面板。 */
  onToggleAgents: () => void;
};

/**
 * 窗口级 ⌘N/⌘K/⌘⇧D/⌘⇧A 快捷键（带修饰键组合在输入框聚焦时同样生效，平台惯例）。
 * enabled=false（任一模态覆盖/对话框开着）时非面板热键不劫持：模态层优先于
 * 全局热键，否则 ⌘N 会把焦点从对话框抢走。panelHotkeyEnabled 独立门控 ⌘K——
 * 它必须走这条分支而非 enabled：面板开着时 hotkeysEnabled 必为 false（面板开着
 * 时其余热键停用），留在 enabled 分支会让 ⌘K 关不掉自己的面板。
 * 回调需引用稳定（本 hook 不做最新值中转）。
 */
export function useCmdHotkeys(handlers: CmdHotkeysHandlers, enabled: boolean, panelHotkeyEnabled: boolean): void {
  const { onNewThread, onSearch, onToggleDiff, onToggleAgents } = handlers;
  React.useEffect(() => {
    if (!enabled && !panelHotkeyEnabled) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      const action = resolveCmdHotkey({ meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey }, event.key);
      if (action === null) return;
      if (action === 'search') {
        if (!panelHotkeyEnabled) return;
        event.preventDefault();
        onSearch();
        return;
      }
      if (!enabled) return;
      event.preventDefault();
      if (action === 'newThread') onNewThread();
      else if (action === 'toggleDiff') onToggleDiff();
      else if (action === 'toggleAgents') onToggleAgents();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onNewThread, onSearch, onToggleDiff, onToggleAgents, enabled, panelHotkeyEnabled]);
}