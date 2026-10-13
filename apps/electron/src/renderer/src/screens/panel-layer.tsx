import * as React from 'react';
import { useStore } from 'zustand';

import { AgentPanel } from '@/agent-panel/agent-panel';
import { DiffPanel } from '@/diff-panel/diff-panel';
import { FilePane } from '@/panel/file-pane';
import { PanelDock } from '@/panel/panel-dock';
import { openFileTab, readFile } from '@/panel/panel-controller';
import { panelTabLabel } from '@/panel/panel-state';
import { summarizeAgents } from '@/thread/panel-summary';
import { useElapsedNow } from '@/thread/use-elapsed-now';
import { collectThreadDiff } from '@/diff-panel/collect-thread-diff';
import { copy } from '@/strings';
import { store as liveStore, workspaceActions } from '@/live/workspace-runtime';
import { threadModelOf } from '@/live/store';
import { uiStore } from '@/ui/ui-store';

/**
 * 面板层（T34 M2 区域化，0 props + memo）：多标签 Dock（活跃 pane 内容）。
 * 面板开合/标签在 ui store；Agents/Diff 内容按活跃线程自订阅 live store
 * （threadModelOf 引用缓存，无关线程事件不进订阅面）。
 * 文件 tab 的入口：命令面板 file: 条目与 Diff 列表点击（openFileTab）。
 */
function PanelLayer(): React.JSX.Element | null {
  const panel = useStore(uiStore, (s) => s.panel);
  const activeThread = useStore(liveStore, (s) => threadModelOf(s, s.activeThreadId ?? ''));

  const activePanelTab = panel.tabs.find((tab) => tab.id === panel.activeId) ?? null;
  /** 子代理计时随工作状态走表（与舞台运行计时各自门控，预算 ≤2 份） */
  const agentsWorking = summarizeAgents(activeThread.agents).busyCount;
  const agentsNow = useElapsedNow(agentsWorking > 0);
  const threadDiff = React.useMemo(() => collectThreadDiff(activeThread), [activeThread]);

  /** PanelDock 是 memo 边界：tab 视图数组 memo 化（panel.tabs 引用仅在面板操作时变化）。 */
  const dockTabs = React.useMemo(
    () => panel.tabs.map((tab) => ({ id: tab.id, label: panelTabLabel(tab, { diff: copy.panel.tabDiff, agents: copy.panel.tabAgents }) })),
    [panel.tabs],
  );

  return panel.tabs.length === 0 ? null : (
    <PanelDock
      tabs={dockTabs}
      activeId={panel.activeId}
      onSelect={(id) => uiStore.getState().focusPanelTabById(id)}
      onCloseTab={(id) => uiStore.getState().closePanelTabById(id)}
      onClose={() => uiStore.getState().closePanel()}
      closeAria={copy.panel.close}
      closeTabAria={copy.panel.closeTab}
    >
      {activePanelTab?.kind === 'agents' ? (
        <AgentPanel agents={activeThread.agents} now={agentsNow} onSteer={workspaceActions.steerSubagent} />
      ) : activePanelTab?.kind === 'diff' ? (
        <DiffPanel diff={threadDiff} onOpenFile={openFileTab} />
      ) : activePanelTab?.kind === 'file' && activePanelTab.cwd !== undefined && activePanelTab.path !== undefined ? (
        <FilePane cwd={activePanelTab.cwd} path={activePanelTab.path} readProjectFile={readFile} />
      ) : null}
    </PanelDock>
  );
}

const PanelLayerMemo = React.memo(PanelLayer);
export { PanelLayerMemo as PanelLayer };
