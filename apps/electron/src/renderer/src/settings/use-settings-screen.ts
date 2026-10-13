import * as React from 'react';

import type { AgentDefinition, IdleRecycleMinutes, PluginCandidateView, PluginProposalRow, PluginView, ProviderConfigView, ProviderModel, RelayConfig, SkillCandidateView, SkillView, ThinkingLevel } from '@x3code/contracts';
import type { HubSettingsView } from '@/live/store';
import type { PluginImportRequest, PluginImportSummary, SkillImportRequest, SkillImportSummary } from '@/live/live-controller-types';
import { AGENT_TOOL_IDS } from '@x3code/contracts';
import type { Theme } from '@/components/theme-context';
import { useTheme } from '@/components/use-theme';
import { useStore } from 'zustand';
import { store as liveStore, workspaceActions } from '@/live/workspace-runtime';
import { savedSessionEntries } from '@/settings/saved-views';
import { useRuntimePanel } from '@/hooks/use-runtime-panel';
import type { WorkspaceActions } from '@/live/workspace-actions';
import { changeLocaleSetting, getLocaleSetting, type LocaleSetting } from '@/strings';
import { FETCH_ON_ENTER_SECTIONS, SETTINGS_FIRST_SECTION, type SettingsSectionId } from './settings-sections';

type SavedSession = { sessionPath: string; title: string; cwd: string; modifiedAt: number; messageCount: number };

/**
 * 按开即读派发：分区目录/文件面无推送，每次进入都拉取；其余分区 no-op。
 * 分区 ↔ 动作映射在这里集中（导航层不认识 workspace 动作面）。
 */
export function dispatchSectionEnter(id: SettingsSectionId, actions: Pick<WorkspaceActions, 'refreshHubSettings' | 'refreshAgentDefinitions' | 'refreshSkills'>): void {
  if (!FETCH_ON_ENTER_SECTIONS.has(id)) return;
  if (id === 'permissions') actions.refreshHubSettings();
  else if (id === 'agents') actions.refreshAgentDefinitions();
  else actions.refreshSkills();
}

/** 已保存会话的项目目录（首现顺序去重；历史分区过滤数据源）。 */
export function savedProjectsOf(saved: readonly SavedSession[]): string[] {
  return [...new Set(saved.map((session) => session.cwd))];
}

/** 置顶键集合（sessionPath）：与侧栏置顶区共用 preferences.pinnedSessions 真相。 */
export function pinnedSetOf(pinnedSessions: readonly string[]): ReadonlySet<string> {
  return new Set(pinnedSessions);
}

import type { RuntimeContentProps } from '@/screens/runtime-content';

export type SettingsScreenProps = {
  open: boolean;
  onClose: () => void;
  section: SettingsSectionId;
  onSelectSection: (id: SettingsSectionId) => void;
  /** 运行状态分区（T30）：轮询随分区激活启停。 */
  runtime: RuntimeContentProps;

  /** 导航红点：宿主非就绪或存在异常会话。 */
  runtimeAttention: boolean;
  general: {
    localeSetting: LocaleSetting;
    onLocaleSettingChange: (next: LocaleSetting) => void;
    theme: Theme;
    onThemeChange: (next: Theme) => void;
    trustedDefault: boolean;
    onSaveTrustedDefault: (trustedDefault: boolean) => Promise<boolean>;
    /** worker 闲置自动回收档位（3/5/10/15 分钟；写路径唯一是 setIdleRecycle）。 */
    idleRecycleMinutes: IdleRecycleMinutes;
    onIdleRecycleChange: (minutes: IdleRecycleMinutes) => void;
    onRestartOnboarding: () => void;
  };
  devices: {
    /** relay 配置（全局统一：settings.json 唯一真相）与保存出口。 */
    relay: RelayConfig;
    onRelaySave: (relay: RelayConfig) => Promise<boolean>;
  };
  providers: {
    list: readonly ProviderConfigView[];
    defaultModel: string | null;
    modelOptions: readonly string[];
    onUpsert: (input: { name: string; baseUrl: string; api: string; models: ProviderModel[]; apiKey?: string }) => Promise<string | null>;
    onRemove: (name: string) => Promise<string | null>;
    onSelectDefaultModel: (value: string | null) => void;
    onTest: (name: string, modelId?: string) => Promise<{ ok: true; latencyMs: number } | { ok: false; reason: string }>;
  };
  permissions: {
    hubSettings: HubSettingsView | null;
    onSaveDefaults: (patch: { permissionDefaultMode?: string | null; thinkingDefault?: ThinkingLevel | null }) => Promise<boolean>;
  };
  /** 子 agent 定义键位（作用域 + 项目 + name）；upsert 的 previous 与 remove 共用。 */
  agents: {
    definitions: readonly AgentDefinition[];
    /** 可指定为 project 作用域的项目目录（已保存会话 cwd 去重）。 */
    knownProjects: readonly string[];
    modelOptions: readonly string[];
    /** 可选工具 id 词表（contracts 单一真相的副本）。 */
    toolIds: readonly string[];
    onRefresh: () => void;
    onSave: (
      definition: AgentDefinition,
      previous: { name: string; scope: 'user' | 'project'; project: string | null } | null,
    ) => Promise<string | null>;
    onRemove: (key: { name: string; scope: 'user' | 'project'; project: string | null }) => Promise<string | null>;
  };
  skills: {
    list: readonly SkillView[];
    onToggle: (name: string, enabled: boolean) => Promise<boolean>;
    onRefresh: () => void;
    /** 候选扫描（导入对话框数据源；失败 null）。 */
    onScanCandidates: (sourcePath?: string) => Promise<readonly SkillCandidateView[] | null>;
    /** 批量导入（逐条隔离；返回汇总含逐条失败明细）。 */
    onImportSkills: (items: readonly SkillImportRequest[]) => Promise<SkillImportSummary>;
    /** 系统目录选择（导入对话框「选择文件夹…」）。 */
    onPickFolder: () => Promise<string | null>;
    /** 删除用户级技能（两步确认后调用）。 */
    onRemove: (name: string) => Promise<boolean>;
  };
  plugins: {
    list: readonly PluginView[];
    onToggle: (name: string, enabled: boolean) => Promise<boolean>;
    onRefresh: () => void;
    /** 候选扫描（导入对话框数据源；失败 null）。 */
    onScanCandidates: (sourcePath?: string) => Promise<readonly PluginCandidateView[] | null>;
    /** 批量导入（逐条隔离；返回汇总含逐条失败明细）。 */
    onImportPlugins: (items: readonly PluginImportRequest[]) => Promise<PluginImportSummary>;
    /** 系统目录选择（导入对话框「选择文件夹…」）。 */
    onPickFolder: () => Promise<string | null>;
    /** 移除 vendor 件（两步确认后调用）。 */
    onRemove: (name: string) => Promise<boolean>;
    /** agent 提案面板（登记态直读；进入分区与刷新时拉取）。 */
    onListProposals: () => Promise<readonly PluginProposalRow[] | null>;
    /** 确认提案（host 内存置位——文件伪造不可达）。 */
    onConfirmProposal: (proposalId: string) => Promise<boolean>;
    /** 拒绝提案。 */
    onRejectProposal: (proposalId: string) => Promise<boolean>;
  };
  history: {
    saved: readonly SavedSession[];
    pinned: ReadonlySet<string>;
    archived: ReadonlySet<string>;
    projects: readonly string[];
    onTogglePin: (sessionPath: string) => void;
    onReveal: (sessionPath: string) => void;
    onOpenSaved: (sessionPath: string) => void;
    onRefresh: () => void;
    onRestore: (sessionPath: string) => void;
    onOpenArchived: (sessionPath: string) => void;
  };
};

export type UseSettingsScreenInput = {
  open: boolean;
  onClose: () => void;
  /** 打开时进入的分区（命令面板跳转；缺省回首分区）。 */
  initialSection?: SettingsSectionId;
};

/**
 * 设置页装配 hook：从 live 工作区派生 SettingsScreen 全部 props（数据/动作/分区状态/
 * 语言/主题/重跑引导），workspace-main 只剩一行接线。语言切换经 changeLocaleSetting
 * 广播（app 根重挂载后本 hook 状态回到首分区，与既有行为一致）。
 */
export function useSettingsScreen({ open, onClose, initialSection }: UseSettingsScreenInput): SettingsScreenProps {
  const [section, setSection] = React.useState<SettingsSectionId>(initialSection ?? SETTINGS_FIRST_SECTION);
  const [localeSetting, setLocaleSettingState] = React.useState<LocaleSetting>(getLocaleSetting());
  const { theme, setTheme } = useTheme();
  const actions = workspaceActions;
  // 直订阅（T34 M3）：设置页全部为低频字段（sessions/stats 随 sessionUpdated 元数据
  // 快照变更，非消息流频度）；savedSessionEntries 派生不进 selector（每次返回新数组
  // 会让 getSnapshot 永不稳定——裸订阅 + useMemo 映射，同 use-new-task-screen 范式）
  const sessionById = useStore(liveStore, (s) => s.sessions);
  const statsById = useStore(liveStore, (s) => s.stats);
  const savedRaw = useStore(liveStore, (s) => s.saved);
  const saved = React.useMemo(() => savedSessionEntries(savedRaw), [savedRaw]);
  const providers = useStore(liveStore, (s) => s.providers);
  const models = useStore(liveStore, (s) => s.models);
  const preferences = useStore(liveStore, (s) => s.preferences);
  const hubSettings = useStore(liveStore, (s) => s.hubSettings);
  const agentDefinitions = useStore(liveStore, (s) => s.agentDefinitions);
  const skills = useStore(liveStore, (s) => s.skills);
  const plugins = useStore(liveStore, (s) => s.plugins);
  const modelOptions = React.useMemo(() => models.map((model) => `${model.provider}/${model.modelId}`), [models]);
  // 原始值 selector（布尔）：宿主相位或死会话存在性翻转才重渲，与 sessions 表引用解耦
  const runtimeAttention = useStore(
    liveStore,
    (s) => s.hostPhase !== 'ready' || Object.values(s.sessions).some((session) => session.state === 'dead'),
  );
  // 每次打开回到首分区（重进分区会重触发按开即读）
  const runtimePanel = useRuntimePanel(
    actions,
    {
      sessions: sessionById,
      statsById,
      queueCountOf: (threadId) => {
        const queue = liveStore.getState().threads[threadId]?.queue;
        return queue === undefined ? 0 : queue.steering.length + queue.followUp.length;
      },
    },
    open && section === 'runtime',
  );
  /** 分区进入只在开沿消费一次性 entry：entry 随后被调用方清除（prop 变 undefined），
   * 不得把已打开的设置页拽回首分区。 */
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (open && !wasOpen.current) setSection(initialSection ?? SETTINGS_FIRST_SECTION);
    wasOpen.current = open;
  }, [open, initialSection]);

  const onSelectSection = React.useCallback((id: SettingsSectionId) => {
    dispatchSectionEnter(id, actions);
    setSection(id);
  }, [actions]);

  const pinned = React.useMemo(() => pinnedSetOf(preferences.pinnedSessions), [preferences.pinnedSessions]);
  const projects = React.useMemo(() => savedProjectsOf(saved), [saved]);

  // 不做整体 memo：SettingsScreen 非 memo 边界，props 恒定性不参与渲染门控；
  // 手工维护依赖表曾漏数据面九类字段（providers/规则/目录/装配面板全部冻结陈旧）
  return {
    open,
    onClose,
    section,
    onSelectSection,
    general: {
      localeSetting,
      onLocaleSettingChange: (next) => {
        changeLocaleSetting(next);
        setLocaleSettingState(getLocaleSetting());
      },
      theme,
      onThemeChange: setTheme,
      trustedDefault: preferences.trustedDefault,
      onSaveTrustedDefault: (trustedDefault) => actions.saveGeneralPreferences({ trustedDefault }),
      idleRecycleMinutes: preferences.idleRecycleMinutes,
      onIdleRecycleChange: (minutes) => {
        void actions.setIdleRecycle(minutes);
      },
      onRestartOnboarding: () => {
        void actions.restartOnboarding().then((ok) => {
          if (ok) onClose();
        });
      },
    },
    devices: {
      relay: preferences.relay,
      onRelaySave: actions.saveRelay,
    },
    providers: {
      list: providers,
      defaultModel: preferences.defaultModel,
      modelOptions,
      onUpsert: actions.upsertProvider,
      onRemove: actions.removeProvider,
      onSelectDefaultModel: actions.setDefaultModel,
      onTest: actions.testProvider,
    },
    permissions: {
      hubSettings,
      onSaveDefaults: actions.saveHubDefaults,
    },
    agents: {
      definitions: agentDefinitions,
      knownProjects: projects,
      modelOptions,
      toolIds: [...AGENT_TOOL_IDS],
      onRefresh: actions.refreshAgentDefinitions,
      onSave: (definition, previous) => actions.upsertAgentDefinition(definition, previous),
      onRemove: (key) => actions.removeAgentDefinition(key),
    },
    skills: {
      list: skills,
      onToggle: actions.setSkillEnabled,
      onRefresh: actions.refreshSkills,
      onScanCandidates: actions.scanSkillCandidates,
      onImportSkills: actions.importSkills,
      onPickFolder: () => actions.pickDirectory(null),
      onRemove: actions.removeSkill,
    },
    plugins: {
      list: plugins,
      onToggle: actions.setPluginEnabled,
      onRefresh: actions.refreshPlugins,
      onScanCandidates: actions.scanPluginCandidates,
      onImportPlugins: actions.importPlugins,
      onPickFolder: () => actions.pickDirectory(null),
      onRemove: actions.removePlugin,
      onListProposals: actions.listPluginProposals,
      onConfirmProposal: actions.confirmPluginProposal,
      onRejectProposal: actions.rejectPluginProposal,
    },
    history: {
      saved: saved,
      pinned,
      archived: new Set(preferences.archivedSessions),
      projects,
      onTogglePin: actions.togglePinnedSession,
      onReveal: actions.revealSession,
      onOpenSaved: (sessionPath) => {
        void actions.openSavedSession(sessionPath);
        onClose();
      },
      onRefresh: actions.refreshSaved,
      onRestore: actions.unarchiveSession,
      onOpenArchived: (sessionPath) => {
        // 打开即恢复：归档语义 = 不在列表，resume 后应重新可见
        actions.unarchiveSession(sessionPath);
        void actions.openSavedSession(sessionPath);
        onClose();
      },
    },
    runtime: {
      snapshot: runtimePanel.snapshot,
      fetchFailed: runtimePanel.fetchFailed,
      rows: runtimePanel.rows,
      diagnosticLog: runtimePanel.diagnosticLog,
      actions,
      onLoadDiagnosticLog: runtimePanel.loadDiagnosticLog,
      onOpenSession: (threadId: string) => {
        // 行打开走既有 saved 恢复链（row.sessionPath）；关闭设置回到会话视图
        const row = runtimePanel.rows.find((item) => item.threadId === threadId);
        if (row?.sessionPath != null) void actions.openSavedSession(row.sessionPath);
        onClose();
      },
    },
    runtimeAttention,
  };
}
