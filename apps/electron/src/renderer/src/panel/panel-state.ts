/**
 * 右侧面板多标签状态（纯函数，容器只接线）：
 * 单例 tab（diff/agents，id == kind）与参数化 tab（文件查看，id = cwd+path）共存；
 * 关闭活跃 tab 时焦点移到右邻，无右邻取左邻——与浏览器 tab 惯例一致。
 */

export type PanelKind = 'diff' | 'agents' | 'file';

export type PanelTab = {
  id: string;
  kind: PanelKind;
  /** file 专属：目标项目目录与相对路径（tab 身份 = 路径）。 */
  cwd?: string;
  path?: string;
};

export type PanelState = {
  tabs: readonly PanelTab[];
  activeId: string | null;
};

export const EMPTY_PANEL: PanelState = { tabs: [], activeId: null };

/** 单例 tab 的稳定 id（同 kind 只存一份）。 */
export function singletonTab(kind: 'diff' | 'agents'): PanelTab {
  return { id: kind, kind };
}

/** 文件 tab：同目录同路径去重（跨会话 cwd 不同即不同 tab）。 */
export function fileTab(cwd: string, path: string): PanelTab {
  return { id: `file:${cwd}:${path}`, kind: 'file', cwd, path };
}

export function openPanel(state: PanelState, tab: PanelTab): PanelState {
  const exists = state.tabs.some((entry) => entry.id === tab.id);
  return {
    tabs: exists ? state.tabs : [...state.tabs, tab],
    activeId: tab.id,
  };
}

export function closePanelTab(state: PanelState, id: string): PanelState {
  const index = state.tabs.findIndex((entry) => entry.id === id);
  if (index === -1) return state;
  const tabs = state.tabs.filter((entry) => entry.id !== id);
  // 焦点迁移：关活跃取右邻，无右邻取左邻；关非活跃不动焦点
  let activeId = state.activeId;
  if (state.activeId === id) {
    activeId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
  }
  return { tabs, activeId };
}

export function focusPanelTab(state: PanelState, id: string): PanelState {
  return state.tabs.some((entry) => entry.id === id) ? { ...state, activeId: id } : state;
}

/** 快捷键 toggle 语义：已开且是活跃 tab → 关闭；否则打开并聚焦。 */
export function togglePanel(state: PanelState, kind: 'diff' | 'agents'): PanelState {
  if (state.activeId === kind) return closePanelTab(state, kind);
  return openPanel(state, singletonTab(kind));
}

/** Esc / 面板级关闭：整组收起（多 tab 下一次 Esc 全收，与既有单槽语义一致）。 */
export function closeAllPanels(): PanelState {
  return EMPTY_PANEL;
}

export type PanelTabLabels = {
  diff: string;
  agents: string;
};

/** tab → 标签文案（文件 tab 用相对路径；视图菜单与标签行共用同一词表）。 */
export function panelTabLabel(tab: PanelTab, labels: PanelTabLabels): string {
  if (tab.kind === 'file') return tab.path ?? tab.id;
  return tab.kind === 'diff' ? labels.diff : labels.agents;
}

/** 会话级面板档案（模块单例持有；Map 形态支持会话消亡时的键回收）。 */
export type PanelArchive = Map<string, PanelState>;

/**
 * 切会话的面板存档/恢复裁决（纯函数，供单测钉住导航不清面板的交互）：
 * 同线程 = 只存档返回 null（调用方不 setState）；切线程 = 存档旧组态并返回
 * 新线程的恢复值（无存档时空态）。导航链不得在切换前清面板——那会把存档覆盖成空。
 * canArchive=false（旧线程已消亡——会话消亡修剪刚回收过死键）时跳过存档写入，
 * 防止切会话 effect 把死键回写复活。
 */
export function panelSwitchOutcome(
  archive: PanelArchive,
  currentThread: string,
  nextThread: string,
  currentPanel: PanelState,
  opts: { canArchive?: boolean } = {},
): PanelState | null {
  if (opts.canArchive !== false) archive.set(currentThread, currentPanel);
  if (currentThread === nextThread) return null;
  return archive.get(nextThread) ?? EMPTY_PANEL;
}
