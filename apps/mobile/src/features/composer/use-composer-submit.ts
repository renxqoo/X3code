import { useComposerStore } from '@/store/composer-store';
import { useConversationStore } from '@/store/conversation-store';
import { useAttachmentStore } from '@/store/attachment-store';
import { appendLocalRow, attachThread, getBridge, reviveThread } from '@/mobile/relay/runtime';
import { localRowId } from '@/mobile/state/session-sync';
import { useKnownWorkspaces } from '@/features/workspace/use-known-workspaces';
import { copy, copyReason } from '@/strings/zh';
import type { ChatMessage } from '@/types/domain';

/**
 * 发送路径：走 hub——无活跃线程时 session/start（新建），随后 session/prompt（同线程续聊）。
 * 应答为受理；流式渲染由事件泵驱动（session-sync 的 userMessage 事件做权威回显）。
 * 未连接电脑端时不投递也不回显：草稿留在输入框，状态行说明未送达——假回显会让
 * 没送出去的消息看起来已经送出。
 */
export function useComposerSubmit(): () => void {
  const draft = useComposerStore((state) => state.draft);
  const submitDraft = useComposerStore((state) => state.submitDraft);
  const items = useAttachmentStore((state) => state.items);
  const clearAttachments = useAttachmentStore((state) => state.clearAttachments);
  const workspaces = useKnownWorkspaces();
  /** 本地行的 id 按失败原因归一：同因重试不堆叠行，重试成功也不残留旧提示。 */
  const note = (key: string, text: string): void => {
    appendLocalRow({ id: localRowId(key), kind: 'status', text, createdAt: new Date().toISOString(), status: 'failed', summary: copy.notDelivered });
  };
  const submit = () => {
    const text = draft.trim();
    if (text.length === 0) return;
    const bridge = getBridge();
    if (bridge?.status !== 'ready') {
      note('send-not-connected', copy.sendNotConnected);
      return;
    }
    if (!submitDraft()) return;
    const attachments = items.map((item) => ({ ...item }));
    const store = useConversationStore.getState();
    const threadId = store.activeSessionId;
    // cwd 只认路径真值：显示名（project）不是目录，送出去会让 hub 在错误 cwd 建线程。
    const workspacePath = store.workspacePath;
    const known = workspacePath !== null ? workspaces.find((workspace) => workspace.path === workspacePath) : undefined;
    // 新建线程的工作空间必须来自电脑端候选：hub 不校验 cwd，凭空造出的目录
    // 等于替电脑端授权了一个从未确认的工作区（且 hub 会照单写入信任注册表）。
    const startCwd = threadId === null ? known?.path : undefined;
    if (threadId === null && startCwd === undefined) {
      note('workspace-required', copy.workspaceRequired);
      return;
    }
    const failNote = (reason: string): void => {
      // 发送失败可见化：经本地行入流——直改 store 会被下一个事件快照冲掉。
      // id 带时间戳：连续两次失败（换原因重试）得两行，不被前一次的 id 去重掉
      note(`send-failed-${Date.now()}`, copy.sendFailed(reason));
      useComposerStore.getState().setGenerating(false);
    };
    /**
     * 失败原因取 error.message（host 错误码），不是 error.kind——
     * kind 只是 transient/permanent 分级，把它当原因会让所有失败都显示「transient」。
     * 用户已切走时不报错：消息留在原会话，错误行不该出现在无关的当前视图里。
     */
    const reportFailure = (target: string | null, reason: string): void => {
      if (target !== null && useConversationStore.getState().activeSessionId !== target) {
        useComposerStore.getState().setGenerating(false);
        return;
      }
      failNote(reason);
    };
    /**
     * 投递前唤活：先问宿主表（reviveThread 内部已做），表内没有才按 sessionPath 恢复。
     * 唤活因「拿不到归档路径」失败时直接报这个原因——继续 prompt 只会拿到
     * unknown_thread，把「设备没路径」说成「会话被关了」，误导用户去电脑端找。
     */
    const promptLive = async (target: string): Promise<{ ok: boolean; switched?: true; error?: { message?: string } }> => {
      const revived = await reviveThread(target);
      if (!revived.ok && revived.reason === 'no_session_path') return { ok: false, error: { message: 'no_session_path' } };
      const threadForSend = revived.ok ? revived.threadId : target;
      if (revived.ok && revived.threadId !== target) {
        if (useConversationStore.getState().activeSessionId !== null && useConversationStore.getState().activeSessionId !== target) return { ok: false, switched: true };
        useConversationStore.getState().openSession({ ...useConversationStore.getState().session, id: revived.threadId });
        attachThread(revived.threadId);
      }
      return (await bridge.client.invoke('session/prompt', { threadId: threadForSend, message: text })) as { ok: boolean; error?: { message?: string } };
    };
    void (async () => {
      if (threadId === null) {
        // startCwd 非空是上面的守卫所保证；受信态转述电脑端对该目录的既有授权，
        // 不新增授权面——候选之外的路径已被拒绝。
        if (startCwd === undefined) return;
        const outcome = (await bridge.client.invoke('session/start', { cwd: startCwd, trusted: true })) as { ok: boolean; data?: { threadId?: string }; error?: { message?: string } };
        if (!outcome.ok || typeof outcome.data?.threadId !== 'string') {
          failNote(outcome.ok ? copy.sessionCreateFailed : copyReason(outcome.error?.message));
          return;
        }
        const newThreadId = outcome.data.threadId;
        if (useConversationStore.getState().activeSessionId !== null && useConversationStore.getState().activeSessionId !== newThreadId) return; // 用户已切换
        useConversationStore.getState().openSession({ ...store.session, id: newThreadId });
        attachThread(newThreadId);
        const prompted = await promptLive(newThreadId);
        if (!prompted.ok && prompted.switched !== true) reportFailure(newThreadId, copyReason(prompted.error?.message));
        return;
      }
      const prompted = await promptLive(threadId);
      if (!prompted.ok && prompted.switched !== true) reportFailure(threadId, copyReason(prompted.error?.message));
    })();
    // 乐观回显（带时间戳 id：同一会话可多次发送同一句话，固定 id 会互相去重掉）
    appendLocalRow({ id: localRowId(`user-${Date.now()}`), kind: 'user', text, createdAt: new Date().toISOString(), ...(attachments.length > 0 ? { attachments } : {}) } as ChatMessage);
    clearAttachments();
  };
  return submit;
}
