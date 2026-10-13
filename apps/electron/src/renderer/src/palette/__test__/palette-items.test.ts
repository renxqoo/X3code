import { describe, expect, test } from 'bun:test';

import { actionItems, commandItems, fileItems, sessionItems, settingsItems } from '../palette-items';

const ACTION_LABELS = {
  newTask: '新建任务',
  openDiff: '打开 Diff 面板',
  openAgents: '打开子代理面板',
  openFinder: '在访达中打开',
  openTerminal: '在终端中打开',
  openEditor: '在编辑器中打开',
  copyPath: '复制项目路径',
  copySessionId: '复制会话 ID',
  closeSession: '关闭当前会话',
  openSettings: '打开设置',
  openUsage: '打开用量',
};

describe('actionItems', () => {
  test('全上下文：快捷键提示 + 会话/目录动作齐备', () => {
    const items = actionItems(ACTION_LABELS, { hasSession: true, hasCwd: true, modifier: '⌘' });
    expect(items.map((item) => item.id)).toEqual([
      'action:newTask',
      'action:openDiff',
      'action:openAgents',
      'action:openFinder',
      'action:openTerminal',
      'action:openEditor',
      'action:copyPath',
      'action:openSettings',
      'action:openUsage',
      'action:copySessionId',
      'action:closeSession',
    ]);
    expect(items[0]?.shortcut).toBe('⌘N');
  });

  test('无会话隐藏会话级动作；无 cwd 隐藏本机打开动作', () => {
    const bare = actionItems(ACTION_LABELS, { hasSession: false, hasCwd: false, modifier: '⌘' });
    const ids = bare.map((item) => item.id);
    expect(ids).not.toContain('action:closeSession');
    expect(ids).not.toContain('action:openFinder');
    expect(ids).toContain('action:newTask');
  });
});

describe('动态组构建', () => {
  test('会话组带项目名 detail；命令组斜杠前缀与描述；文件组路径直用', () => {
    expect(sessionItems([{ id: 't1', title: '重构', projectName: 'agent-app' }])).toEqual([
      { id: 'session:t1', label: '重构', detail: 'agent-app', group: 'sessions' },
    ]);
    expect(commandItems([{ name: 'compact', description: '压缩' }, { name: 'model', description: null }])).toEqual([
      { id: 'command:compact', label: '/compact', detail: '压缩', group: 'commands' },
      { id: 'command:model', label: '/model', group: 'commands' },
    ]);
    expect(fileItems(['src/a.ts'])).toEqual([{ id: 'file:src/a.ts', label: 'src/a.ts', group: 'files' }]);
  });

  test('设置组覆盖七分区（diagnostics 已由 runtime 分区取代），标题缺省回落分区 id', () => {
    const items = settingsItems({ general: '常规', history: '历史' });
    expect(items.map((item) => item.id)).toEqual([
      'settings:general',
      'settings:providers',
      'settings:permissions',
      'settings:agents',
      'settings:skills',
      'settings:history',
      'settings:runtime',
    ]);
    expect(items[0]?.label).toBe('常规');
    expect(items[1]?.label).toBe('providers');
  });
});
