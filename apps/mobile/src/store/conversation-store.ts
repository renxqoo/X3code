import { create } from 'zustand';
import type { ChatMessage, ConversationSession } from '@/types/domain';

export type PermissionDecision = { id: string; title: string; command: string; approved: boolean | null };

type ConversationState = {
  activeSessionId: string | null;
  session: ConversationSession;
  workspaceId: string | null;
  /** 工作区路径（host thread/start 的 cwd 真值——显示名仅 UI；R3 M4） */
  workspacePath: string | null;
  /**
   * 待答权限卡队列（同时可有多张：多个会话并发弹窗时后一条覆盖前一条，
   * 被覆盖那张永远无法应答、只能在宿主侧挂到超时）。视图取队首。
   */
  permissionQueue: PermissionDecision[];
  startNewSession: () => void;
  openSession: (session: ConversationSession) => void;
  /**
   * bridge 会话流整体替换（事件归并器驱动——唯一消息流写入口）。
   *
   * 设备侧本地行（发送失败/未连接/缺工作区）不再直写本 store：一律经
   * runtime.appendLocalRow 进归并器后由它快照下发。之前两路并存（本地 append 与
   * 本替换共用同一槽）会让本地行被下一个事件快照冲掉，表现为“提示闪一下就没了”。
   */
  appendMessages: (messages: readonly ChatMessage[]) => void;
  chooseWorkspace: (id: string, name: string, path?: string) => void;
  requestPermission: (request: PermissionDecision) => void;
  /** 一次应答的完整语义：标记队首并出队（原子）。
   *  拆成 resolve+clear 两步时，异步帧恰好在两步之间抛错会留下「approved 已设、
   *  卡片未出」的卡——按钮此时已消失，用户对这轮再也做不了第二次应答。 */
  answerPermission: (approved: boolean) => void;
  clearPermission: () => void;
  /** 按 requestId 结算（dialogSettled 对账——只清对应卡）。 */
  settlePermission: (requestId: string) => void;
};

function blankSession(): ConversationSession {
  return { id: 'new-session', title: '新对话', preview: '', project: '未选择工作空间', timeLabel: '刚刚', state: 'idle', pinned: false, archived: false, unread: false, messages: [] };
}

export const useConversationStore = create<ConversationState>((set) => ({
  activeSessionId: null, session: blankSession(), workspaceId: null, workspacePath: null, permissionQueue: [],
  startNewSession: () => set({ activeSessionId: null, session: blankSession(), permissionQueue: [] }),
  openSession: (session) => set({ activeSessionId: session.id, session, permissionQueue: [] }),
  appendMessages: (messages) => set((state) => ({ session: { ...state.session, messages, preview: messages.length > 0 ? (messages[messages.length - 1]?.text ?? '').slice(0, 80) : state.session.preview } })),
  chooseWorkspace: (workspaceId, name, path) => set((state) => ({ workspaceId, workspacePath: path ?? null, session: { ...state.session, project: name } })),
  requestPermission: (permissionRequest) => set((state) => ({
    permissionQueue: state.permissionQueue.some((item) => item.id === permissionRequest.id)
      ? state.permissionQueue
      : [...state.permissionQueue, permissionRequest],
  })),
  answerPermission: (approved) => set((state) => {
    if (state.permissionQueue[0] === undefined) return state;
    void approved;
    return { permissionQueue: state.permissionQueue.slice(1) };
  }),
  clearPermission: () => set((state) => ({ permissionQueue: state.permissionQueue.slice(1) })),
  settlePermission: (requestId) => set((state) => ({ permissionQueue: state.permissionQueue.filter((item) => item.id !== requestId) })),
}));
