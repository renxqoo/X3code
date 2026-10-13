import * as React from 'react';
import { useStore } from 'zustand';

import { insertIntoDraft } from '@/composer/composer-controller';
import { uiStore } from '@/ui/ui-store';
import type { SettingsSectionId } from '@/settings/settings-sections';
import { openFileTab } from '@/panel/panel-controller';
import { actionItems, commandItems, sessionItems, settingsItems, type PaletteItem } from '@/palette/palette-items';
import { sessionCardsOf } from '@/sidebar/session-cards';
import { store as liveStore, workspaceActions } from '@/live/workspace-runtime';
import { copy } from '@/strings';
import { MODIFIER_KEY_LABEL } from '@/lib/platform';

/**
 * 命令面板（⌘K）装配面：条目与派发自订阅 store + 单例。
 * 开关是本地低频态；静态条目（动作/会话/命令/设置）在条目侧 hook（items 归
 * CommandPanel 组件内消费，不进工作区订阅面）。id 词表封闭（palette-items）；
 * 文件组由 CommandPanel 按输入词动态搜索。
 */

export function useCommandItems(active: boolean): readonly PaletteItem[] {
  const activeThreadId = useStore(liveStore, (s) => s.activeThreadId) ?? '';
  const activeCwd = useStore(liveStore, (s) => (s.activeThreadId === null ? '' : s.sessions[s.activeThreadId]?.cwd ?? ''));
  const sessionViews = useStore(liveStore, (s) => s.sessions);
  const commands = useStore(liveStore, (s) => s.commands);
  void active; // 订阅常驻（open 门控在渲染层早退），条目引用稳定不驱动外层
  return React.useMemo<readonly PaletteItem[]>(() => {
    const hasSession = activeThreadId.length > 0;
    return [
      ...actionItems(copy.palette.actions, { hasSession, hasCwd: activeCwd.length > 0, modifier: MODIFIER_KEY_LABEL }),
      ...sessionItems(sessionCardsOf(sessionViews)),
      ...commandItems(commands),
      ...settingsItems({
        general: copy.settings.generalTitle,
        providers: copy.settings.providersTitle,
        permissions: copy.settings.permissionsTitle,
        agents: copy.settings.agentsTitle,
        skills: copy.settings.skillsTitle,
        history: copy.settings.historyTitle,
        runtime: copy.settings.runtimeTitle,
      }),
    ];
  }, [activeThreadId, activeCwd, sessionViews, commands]);
}

type UseCommandPanelArgs = {
  openNewTask: () => void
  openSettings: () => void
  openSettingsAt: (section: SettingsSectionId) => void
  openUsage: () => void
  /** 会话跳转出口（退出新建任务页/设置页等覆盖层的同一导航链）。 */
  navigateSession: (threadId: string) => void
}

type CommandPanelApi = {
  open: boolean
  /** 受控开合出口（⌘K toggle、侧栏入口行、遮罩/Esc 关闭共用）。 */
  setOpen: (open: boolean) => void
  /** 打开面板时的默认高亮项 id（当前会话的 `session:<threadId>`；无会话时 null）。 */
  defaultItemValue: string | null
  onSelect: (id: string) => void
}

export function useCommandPanel(args: UseCommandPanelArgs): CommandPanelApi {
  const { openNewTask, openSettings, openSettingsAt, openUsage, navigateSession } = args;
  const activeThreadId = useStore(liveStore, (s) => s.activeThreadId) ?? '';
  const activeCwd = useStore(liveStore, (s) => (s.activeThreadId === null ? '' : s.sessions[s.activeThreadId]?.cwd ?? ''));
  const open = useStore(uiStore, (s) => s.commandPanelOpen);

  /** 受控开合：Dialog 的 onOpenChange 只给布尔，统一折算到 open/close 两个动作。 */
  const setOpen = React.useCallback((next: boolean) => {
    const state = uiStore.getState();
    if (next === state.commandPanelOpen) return;
    if (next) state.openCommandPanel();
    else state.closeCommandPanel();
  }, []);

  const onSelect = React.useCallback(
    (id: string) => {
      if (id === 'action:newTask') openNewTask();
      else if (id === 'action:openDiff') uiStore.getState().openDiffPane();
      else if (id === 'action:openAgents') uiStore.getState().openAgentsPane();
      else if (id === 'action:openFinder') void workspaceActions.openInSystem(activeCwd, 'finder');
      else if (id === 'action:openTerminal') void workspaceActions.openInSystem(activeCwd, 'terminal');
      else if (id === 'action:openEditor') void workspaceActions.openInSystem(activeCwd, 'editor');
      else if (id === 'action:copyPath') void workspaceActions.copyText(activeCwd);
      else if (id === 'action:copySessionId') void workspaceActions.copyText(activeThreadId);
      else if (id === 'action:closeSession') workspaceActions.closeSession(activeThreadId);
      else if (id === 'action:openSettings') openSettings();
      else if (id === 'action:openUsage') openUsage();
      else if (id.startsWith('session:')) navigateSession(id.slice('session:'.length));
      else if (id.startsWith('file:')) openFileTab(id.slice('file:'.length));
      else if (id.startsWith('command:')) {
        // 斜杠命令填入 composer（词法/执行语义统一留在输入框侧；通道=controller 追加+聚焦）
        insertIntoDraft(`/${id.slice('command:'.length)} `);
      } else if (id.startsWith('settings:')) openSettingsAt(id.slice('settings:'.length) as SettingsSectionId);
    },
    [activeThreadId, activeCwd, openNewTask, openSettings, openUsage, navigateSession, openSettingsAt],
  );

  return { open, setOpen, defaultItemValue: activeThreadId.length > 0 ? `session:${activeThreadId}` : null, onSelect };
}