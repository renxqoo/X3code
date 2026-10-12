import { create } from 'zustand';
import type { Attachment } from '@/types/domain';

type AttachmentState = {
  items: readonly Attachment[];
  /** 所属会话（null = 未打开任何会话）。附件是单次投递的暂存物：
   *  切会话不清会把 A 的附件贴到 B 的消息上（用户看不到自己带的是什么）。 */
  sessionId: string | null;
  /** 挂到会话上（打开/新建时调用；换会话即换宿主，附件随之清空）。 */
  bindToSession: (sessionId: string | null) => void;
  addAttachment: (attachment: Attachment) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  markFailed: (id: string) => void;
};

export const useAttachmentStore = create<AttachmentState>((set) => ({
  items: [],
  sessionId: null,
  bindToSession: (sessionId) => set((state) => (
    // 同一会话重复绑定不清（渲染期可能反复调用）；换宿主才清
    state.sessionId === sessionId ? state : { sessionId, items: [] }
  )),
  addAttachment: (attachment) => set((state) => ({
    items: [...state.items.filter((item) => item.id !== attachment.id), attachment],
  })),
  removeAttachment: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
  clearAttachments: () => set({ items: [] }),
  markFailed: (id) => set((state) => ({ items: state.items.map((item) => item.id === id ? { ...item, status: 'failed' } : item) })),
}));
