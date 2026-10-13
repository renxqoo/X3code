/**
 * 命令面板条目构建（纯函数）：动作/会话/命令/设置四组静态构建 + 文件组由
 * 搜索结果动态构建。id 词表封闭（消费方 workspace-main 按 id 派发）：
 * action:* / session:<threadId> / file:<path> / command:<name> / settings:<section>。
 */

export type PaletteGroupKind = 'actions' | 'sessions' | 'files' | 'commands' | 'settings';

export type PaletteItem = {
  id: string;
  label: string;
  group: PaletteGroupKind;
  /** 次级说明（会话的项目名/命令描述）。 */
  detail?: string;
  /** 右侧快捷键提示（如 ⌘N）。 */
  shortcut?: string;
};

export type PaletteActionLabels = {
  newTask: string;
  openDiff: string;
  openAgents: string;
  openFinder: string;
  openTerminal: string;
  openEditor: string;
  copyPath: string;
  copySessionId: string;
  closeSession: string;
  openSettings: string;
  openUsage: string;
};

export type PaletteActionContext = {
  /** 有活跃会话才出现会话级动作（复制 ID/关闭）。 */
  hasSession: boolean;
  /** 有工作目录才出现本机打开动作。 */
  hasCwd: boolean;
  /** 平台修饰键（⌘/Ctrl）用于快捷键提示。 */
  modifier: string;
};

export function actionItems(labels: PaletteActionLabels, context: PaletteActionContext): PaletteItem[] {
  return [
    { id: 'action:newTask', label: labels.newTask, group: 'actions', shortcut: `${context.modifier}N` },
    { id: 'action:openDiff', label: labels.openDiff, group: 'actions', shortcut: `${context.modifier}⇧D` },
    { id: 'action:openAgents', label: labels.openAgents, group: 'actions', shortcut: `${context.modifier}⇧A` },
    ...(context.hasCwd
      ? ([
          { id: 'action:openFinder', label: labels.openFinder, group: 'actions' },
          { id: 'action:openTerminal', label: labels.openTerminal, group: 'actions' },
          { id: 'action:openEditor', label: labels.openEditor, group: 'actions' },
          { id: 'action:copyPath', label: labels.copyPath, group: 'actions' },
        ] as PaletteItem[])
      : []),
    { id: 'action:openSettings', label: labels.openSettings, group: 'actions' },
    { id: 'action:openUsage', label: labels.openUsage, group: 'actions' },
    ...(context.hasSession
      ? ([
          { id: 'action:copySessionId', label: labels.copySessionId, group: 'actions' },
          { id: 'action:closeSession', label: labels.closeSession, group: 'actions' },
        ] as PaletteItem[])
      : []),
  ];
}

export function sessionItems(sessions: ReadonlyArray<{ id: string; title: string; projectName: string }>): PaletteItem[] {
  return sessions.map((session) => ({
    id: `session:${session.id}`,
    label: session.title,
    detail: session.projectName,
    group: 'sessions' as const,
  }));
}

export function fileItems(paths: readonly string[]): PaletteItem[] {
  return paths.map((path) => ({ id: `file:${path}`, label: path, group: 'files' as const }));
}

export function commandItems(commands: ReadonlyArray<{ name: string; description: string | null }>): PaletteItem[] {
  return commands.map((command) => ({
    id: `command:${command.name}`,
    label: `/${command.name}`,
    detail: command.description ?? undefined,
    group: 'commands' as const,
  }));
}

export function settingsItems(sectionTitles: Readonly<Record<string, string>>): PaletteItem[] {
  return ['general', 'providers', 'permissions', 'agents', 'skills', 'history', 'runtime'].map((section) => ({
    id: `settings:${section}`,
    label: sectionTitles[section] ?? section,
    group: 'settings' as const,
  }));
}
