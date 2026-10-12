import { beforeEach, describe, expect, it } from '@jest/globals';
import { testSession } from '@/test/session-fixture';
import { useAttachmentStore } from '@/store/attachment-store';
import { useComposerStore } from '@/store/composer-store';
import { useConversationStore } from '@/store/conversation-store';
import { useHistoryStore } from '@/store/history-store';
import { useNavigationStore } from '@/store/navigation-store';
import { useSettingsStore } from '@/store/settings-store';

const SESSIONS = [
  testSession('session-mobile', { messages: [{ id: 'm1', kind: 'user', text: '你好', createdAt: '10:00' }] }),
  testSession('session-b'),
  testSession('session-c'),
];

describe('mobile UI stores', () => {
  beforeEach(() => {
    useNavigationStore.setState({ drawerOpen: false, sheet: null });
    useComposerStore.setState({ draft: '', model: '', thinking: 'medium', permission: 'ask', generating: false });
    useHistoryStore.setState({ sessions: SESSIONS, query: '' });
    useAttachmentStore.setState({ items: [] });
    useSettingsStore.setState({ theme: 'system', defaultModel: 'walk/walk-model', defaultThinking: 'medium', defaultPermission: 'ask', notifications: true, haptics: true, compactHistory: false });
    useConversationStore.getState().startNewSession();
    useConversationStore.setState({ workspaceId: null });
  });

  it('keeps drawer and sheets mutually exclusive', () => {
    useNavigationStore.getState().setDrawerOpen(true);
    useNavigationStore.getState().openSheet('workspace');
    expect(useNavigationStore.getState()).toMatchObject({ drawerOpen: false, sheet: 'workspace' });
    useNavigationStore.getState().closeSheet();
    expect(useNavigationStore.getState().sheet).toBeNull();
  });

  it('selects model, thinking and permission', () => {
    useComposerStore.getState().selectModel('walk/walk-model');
    useComposerStore.getState().selectThinking('high');
    useComposerStore.getState().selectPermission('plan');
    expect(useComposerStore.getState()).toMatchObject({ model: 'walk/walk-model', thinking: 'high', permission: 'plan' });
  });

  it('rejects empty and duplicate submissions and bounds draft length', () => {
    useComposerStore.getState().setDraft('   ');
    expect(useComposerStore.getState().submitDraft()).toBe(false);
    useComposerStore.getState().setDraft('x'.repeat(12000));
    expect(useComposerStore.getState().draft).toHaveLength(10000);
    expect(useComposerStore.getState().submitDraft()).toBe(true);
    expect(useComposerStore.getState().draft).toBe('');
    expect(useComposerStore.getState().submitDraft()).toBe(false);
  });

  it('starts with no preselected model and toggles generation', () => {
    expect(useComposerStore.getState().model).toBe('');
    useComposerStore.getState().toggleGeneration();
    expect(useComposerStore.getState().generating).toBe(true);
    useComposerStore.getState().toggleGeneration();
    expect(useComposerStore.getState().generating).toBe(false);
  });

  it('renames, pins, archives and deletes a known session safely', () => {
    const id = 'session-mobile';
    useHistoryStore.getState().renameSession(id, '  新名称  ');
    expect(useHistoryStore.getState().sessions.find((item) => item.id === id)?.title).toBe('新名称');
    useHistoryStore.getState().renameSession(id, '   ');
    expect(useHistoryStore.getState().sessions.find((item) => item.id === id)?.title).toBe('新名称');
    useHistoryStore.getState().togglePinned(id);
    expect(useHistoryStore.getState().sessions.find((item) => item.id === id)?.pinned).toBe(true);
    useHistoryStore.getState().archiveSession(id);
    expect(useHistoryStore.getState().sessions.find((item) => item.id === id)?.archived).toBe(true);
    useHistoryStore.getState().deleteSession(id);
    expect(useHistoryStore.getState().sessions.some((item) => item.id === id)).toBe(false);
    useHistoryStore.getState().deleteSession('missing');
    expect(useHistoryStore.getState().sessions).toHaveLength(SESSIONS.length - 1);
  });

  it('manages attachment deduplication, failure and removal', () => {
    const attachment = { id: 'file-1', name: 'spec.pdf', size: 2000, kind: 'pdf' as const, status: 'ready' as const };
    useAttachmentStore.getState().addAttachment(attachment);
    useAttachmentStore.getState().addAttachment({ ...attachment, name: 'spec-v2.pdf' });
    expect(useAttachmentStore.getState().items).toHaveLength(1);
    useAttachmentStore.getState().markFailed('file-1');
    expect(useAttachmentStore.getState().items[0]?.status).toBe('failed');
    useAttachmentStore.getState().removeAttachment('file-1');
    expect(useAttachmentStore.getState().items).toHaveLength(0);
  });

  it('updates settings with a safe model fallback', () => {
    useSettingsStore.getState().setDefaultModel('   ');
    expect(useSettingsStore.getState().defaultModel).toBe('walk/walk-model');
    useSettingsStore.getState().setTheme('dark');
    useSettingsStore.getState().setDefaultThinking('high');
    useSettingsStore.getState().setDefaultPermission('auto');
    useSettingsStore.getState().toggleNotifications();
    useSettingsStore.getState().toggleHaptics();
    useSettingsStore.getState().toggleCompactHistory();
    expect(useSettingsStore.getState()).toMatchObject({ theme: 'dark', defaultThinking: 'high', defaultPermission: 'auto', notifications: false, haptics: false, compactHistory: true });
  });

  it('opens sessions, appends messages and resolves permissions once', () => {
    const session = SESSIONS[0];
    if (session === undefined) throw new Error('fixture missing');
    useConversationStore.getState().openSession(session);
    // 消息流只由归并器快照写入口（appendMessages）——无直写 append 面可测了
    useConversationStore.getState().appendMessages([...session.messages, { id: 'm', kind: 'user', text: '继续', createdAt: 'now' }]);
    expect(useConversationStore.getState().session.messages).toHaveLength(session.messages.length + 1);
    useConversationStore.getState().requestPermission({ id: 'p1', title: '运行测试', command: 'bun test', approved: null });
    expect(useConversationStore.getState().permissionQueue).toHaveLength(1);
    // 应答即出队（原子 action）：不允许留下「已标记但卡还在」的残卡
    useConversationStore.getState().answerPermission(true);
    expect(useConversationStore.getState().permissionQueue).toHaveLength(0);
  });

  it('权限队列：多请求并发时逐张应答，被顶掉的仍可应答（症状：第二个请求覆盖第一个）', () => {
    useConversationStore.getState().startNewSession();
    useConversationStore.getState().requestPermission({ id: 'p1', title: '第一条', command: 'bun test', approved: null });
    useConversationStore.getState().requestPermission({ id: 'p2', title: '第二条', command: 'bun build', approved: null });
    // 队首是第一张卡
    expect(useConversationStore.getState().permissionQueue[0]?.id).toBe('p1');
    useConversationStore.getState().answerPermission(true);
    // 第一张应答后出队，第二张顶上且仍可应答
    expect(useConversationStore.getState().permissionQueue[0]?.id).toBe('p2');
    useConversationStore.getState().answerPermission(false);
    expect(useConversationStore.getState().permissionQueue).toHaveLength(0);
  });

  it('权限队列：同一 requestId 重复弹卡不堆叠（事件重放不留残卡）', () => {
    useConversationStore.getState().startNewSession();
    useConversationStore.getState().requestPermission({ id: 'p1', title: '第一条', command: 'bun test', approved: null });
    useConversationStore.getState().requestPermission({ id: 'p1', title: '第一条', command: 'bun test', approved: null });
    expect(useConversationStore.getState().permissionQueue).toHaveLength(1);
  });

  it('权限队列：dialogSettled 按 requestId 摘卡，不误伤队首以外的', () => {
    useConversationStore.getState().startNewSession();
    useConversationStore.getState().requestPermission({ id: 'p1', title: '第一条', command: 'a', approved: null });
    useConversationStore.getState().requestPermission({ id: 'p2', title: '第二条', command: 'b', approved: null });
    useConversationStore.getState().settlePermission('p1');
    expect(useConversationStore.getState().permissionQueue.map((item) => item.id)).toEqual(['p2']);
  });

  it('权限队列：应答后卡片不可二次应答（出队即消失，不留 approved 残卡）', () => {
    useConversationStore.getState().startNewSession();
    useConversationStore.getState().requestPermission({ id: 'p1', title: '第一条', command: 'a', approved: null });
    useConversationStore.getState().answerPermission(true);
    // 再应答一次不应改变任何状态（无卡可答）
    useConversationStore.getState().answerPermission(false);
    expect(useConversationStore.getState().permissionQueue).toHaveLength(0);
  });

  it('chooses a workspace for new tasks', () => {
    useConversationStore.getState().chooseWorkspace('workspace-mobile', 'X3code Mobile');
    expect(useConversationStore.getState()).toMatchObject({ workspaceId: 'workspace-mobile' });
    expect(useConversationStore.getState().session.project).toBe('X3code Mobile');
  });
});
