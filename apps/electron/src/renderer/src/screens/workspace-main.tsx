import * as React from 'react';
import { useStore } from 'zustand';

import { ComposerRegion } from '@/composer/composer-region';
import { navigation } from '@/screens/workspace-navigation';
import { TitleBarLeft } from '@/layout/title-bar-left';
import { WindowCaptionButtons } from '@/layout/window-caption-buttons';
import { isWindowsPlatform } from '@/lib/platform';
import { useObservedHeight } from '@/hooks/use-observed-height';
import { useCmdHotkeys } from '@/hooks/cmd-hotkeys';
import { NoticeStrip } from '@/notices/notice-strip';
import { store as liveStore, workspaceActions } from '@/live/workspace-runtime';
import { SettingsScreen } from '@/settings/settings-screen';
import { Sidebar } from '@/sidebar/sidebar';
import { useUsagePanel } from '@/hooks/use-usage-panel';
import { useSettingsScreen } from '@/settings/use-settings-screen';
import { StopConfirmBar } from '@/thread/stop-confirm-bar';
import { UsageScreen } from '@/screens/usage-screen';
import { useEscDismiss } from '@/screens/use-esc-dismiss';
import { hotkeyGating } from '@/screens/hotkey-gating';
import { ThreadBanner } from '@/thread/thread-banner';
import { PanelLayer } from '@/screens/panel-layer';
import { CommandPanel } from '@/palette/command-panel';
import { useCommandPanel } from '@/screens/use-command-panel';
import { ThreadStage } from '@/screens/thread-stage';
import { PulsePanel } from '@/pulse-panel/pulse-panel';
import { NewTaskPage } from '@/screens/new-task-page';
import { ImageViewerHost } from '@/image-viewer/image-viewer-host';
import { uiStore } from '@/ui/ui-store';

import { copy } from '@/strings';

/** ui store 动作引用恒定（zustand 动作创建即稳定），模块级取出，渲染期零重建。 */
const {
  openSettings,
  openSettingsAt,
  closeSettings,
  toggleSidebarCollapsed,
  toggleCommandPanel,
  setConfirmStop,
} = uiStore.getState();

/** 输入浮层高度通道（T34 U3）：测量回调模块级恒定引用写 ui store（+24 偏移在动作内），
 * 高度变化只重渲舞台订阅处。观测以回调 ref 形态挂在浮层容器上——新建任务页
 * 往返重挂容器即重挂观测，高度永不冻结。 */
const publishComposerInset = (height: number): void => {
  uiStore.getState().setComposerInset(height);
};

function WorkspaceMain(): React.JSX.Element {
  const sidebarCollapsed = useStore(uiStore, (s) => s.sidebarCollapsed);
  /** 项目文件面板（T18）：开合门控读（target null = 关闭，侧栏内容区照旧） */
  const projectFilesState = useStore(uiStore, (s) => s.projectFiles);
  /** 侧栏宽度：拖拽真相在 ui store（resize 装配在 Sidebar 壳内），标题栏避让消费 */
  const sidebarWidth = useStore(uiStore, (s) => s.sidebarWidth);
  /** 命令面板跳设置分区：进入分区经一次性 entry（关闭即清，普通打开不受影响）。 */
  const settingsOpen = useStore(uiStore, (s) => s.settingsOpen);
  const settingsEntry = useStore(uiStore, (s) => s.settingsEntry);
  /** 停止确认条开合（H2：不可恢复的停止先确认；Esc 链同源，真相在 ui store） */
  const confirmStop = useStore(uiStore, (s) => s.confirmStop);
  /** 新建任务页开合/预填目录/重挂载代次/页内浮层——生命周期全在 ui store（T34 M3） */
  const newTaskOpen = useStore(uiStore, (s) => s.newTaskOpen);
  const newTaskCwd = useStore(uiStore, (s) => s.newTaskCwd);
  const newTaskKey = useStore(uiStore, (s) => s.newTaskKey);
  const newTaskDialogOpen = useStore(uiStore, (s) => s.newTaskDialogOpen);
  const openNewTask = React.useCallback(() => uiStore.getState().openNewTask('', liveStore.getState().activeThreadId), [liveStore]);
  const observeComposerLayer = useObservedHeight<HTMLDivElement>(publishComposerInset);
  /** Usage 总览页（I2；侧栏 footer 入口）——开合在 ui store，条目 UsageScreen 自取 */
  const usagePanel = useUsagePanel();
  const notices = useStore(liveStore, (s) => s.notices);

  const usageOpen = usagePanel.usageOpen;
  const closeUsage = usagePanel.closeUsage;
  /** 界面语言与全部设置页数据/动作经 use-settings-screen 装配（语言广播后 app 根重挂载） */
  const settings = useSettingsScreen({ open: settingsOpen, onClose: closeSettings, initialSection: settingsEntry ?? undefined });
  /** 设置分区一次性 entry：开沿消费即清——不随 ui store 跨语言重挂载存活（基线：重挂载停首分区）。 */
  const wasSettingsOpen = React.useRef(false);
  React.useEffect(() => {
    if (settingsOpen && !wasSettingsOpen.current) uiStore.setState({ settingsEntry: null });
    wasSettingsOpen.current = settingsOpen;
  }, [settingsOpen]);

  /** 命令面板（⌘K）装配：开关/条目/派发（整页覆盖期间不唤起）。 */
  const commandPanel = useCommandPanel({
    openNewTask,
    openSettings,
    openSettingsAt,
    openUsage: usagePanel.openUsage,
    navigateSession: navigation.onSelectSession,
  });
  const { open: commandPanelOpen, setOpen: setCommandPanelOpen, defaultItemValue: commandPanelDefaultValue, onSelect: onCommandPanelSelect } = commandPanel;
  /** 面板 props 引用恒定：CommandPanel 是 memo 边界；items 已随组件
   * 自订阅；@ 搜索按调用时活跃 cwd 读 store 真相——工作区根对 live store 零订阅。 */
  const commandPanelFileSearch = React.useCallback((query: string) => {
    const state = liveStore.getState();
    const threadId = state.activeThreadId;
    const cwd = threadId === null ? '' : (state.sessions[threadId]?.cwd ?? '');
    return workspaceActions.searchFilesIn(cwd, query);
  }, []);
  const commandPanelLabels = React.useMemo(
    () => ({ aria: copy.palette.aria, placeholder: copy.palette.placeholder, empty: copy.palette.empty, groups: copy.palette.groups }),
    [],
  );

  /** ⌘N/⌘K/⌘⇧D/⌘⇧A 门控矩阵单一真相在 hotkey-gating 纯函数（表驱动用例钉住）。 */
  const { hotkeysEnabled, panelHotkeyEnabled } = hotkeyGating({
    commandPanelOpen,
    newTaskOpen,
    usageOpen,
    settingsOpen,
    projectFilesOpen: projectFilesState.target !== null,
  });
  useCmdHotkeys(
    {
      onNewThread: openNewTask,
      onSearch: toggleCommandPanel,
      onToggleDiff: () => uiStore.getState().toggleDiffPane(),
      onToggleAgents: () => uiStore.getState().toggleAgentsPane(),
    },
    hotkeysEnabled,
    panelHotkeyEnabled,
  );

  useEscDismiss({
    /** 新建任务页本地浮层自行消费 Esc（hub confirm 内联条非模态，不参与 Esc 链） */
    localDialogOpen: newTaskDialogOpen,
    commandPanelOpen,
    panelOpen: useStore(uiStore, (s) => s.panel.activeId !== null),
    onPanelClose: () => uiStore.getState().closePanel(),
    abortBash: workspaceActions.abortBash,
    stopActiveTurn: workspaceActions.stopActiveTurn,
  });

  return (
    <div className="relative flex h-screen min-h-0 overflow-hidden bg-background text-foreground">
      <Sidebar />
      <div className="relative flex min-w-0 flex-1 flex-col">
        {!newTaskOpen ? (
          <>
            <ThreadStage />
            <PulsePanel />
            <div ref={observeComposerLayer} className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-[40px] pb-[18px]">
          {confirmStop ? (
            <StopConfirmBar
              onConfirm={() => {
                setConfirmStop(false);
                workspaceActions.stopActiveTurn();
              }}
              onCancel={() => setConfirmStop(false)}
            />
          ) : null}
          <ThreadBanner />
          <ComposerRegion />
            </div>
          </>
        ) : (
          <NewTaskPage key={newTaskKey} enterCwd={newTaskCwd} />
        )}
      </div>
      {usageOpen ? <UsageScreen onClose={closeUsage} /> : null}
      <CommandPanel
        open={commandPanelOpen}
        onOpenChange={setCommandPanelOpen}
        searchFiles={commandPanelFileSearch}
        labels={commandPanelLabels}
        defaultItemValue={commandPanelDefaultValue}
        onSelect={onCommandPanelSelect}
      />
      <PanelLayer />
      <TitleBarLeft
        titleName={copy.appTitle}
        toggleLabel={sidebarCollapsed ? copy.sidebar.expandSidebarHint : copy.sidebar.collapseSidebarHint}
        collapsed={sidebarCollapsed}
        sidebarWidth={sidebarWidth}
        onToggle={toggleSidebarCollapsed}
      />
      {isWindowsPlatform ? <WindowCaptionButtons /> : null}
      <SettingsScreen
        {...settings}
        history={{
          ...settings.history,
          // 打开历史会话 = 导航到会话：与侧栏行走同一出口（退出新建任务页 + 关设置页）
          onOpenSaved: navigation.onOpenSavedSession,
        }}
      />
      <NoticeStrip notices={notices} onDismiss={workspaceActions.dismissNotice} suppressed={commandPanelOpen} />
      <ImageViewerHost />
    </div>
  );
}

export { WorkspaceMain };
