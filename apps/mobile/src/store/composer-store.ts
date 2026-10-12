import { create } from 'zustand';
import type { PermissionMode, ThinkingLevel } from '@/types/domain';

type ComposerState = {
  draft: string;
  model: string;
  thinking: ThinkingLevel;
  permission: PermissionMode;
  generating: boolean;
  setDraft: (draft: string) => void;
  /** 清空草稿（换会话时用——草稿是单次投递物，跨会话留存会误发）。 */
  clearDraft: () => void;
  selectModel: (model: string) => void;
  selectThinking: (thinking: ThinkingLevel) => void;
  selectPermission: (permission: PermissionMode) => void;
  submitDraft: () => boolean;
  toggleGeneration: () => void;
  setGenerating: (generating: boolean) => void;
};

export const useComposerStore = create<ComposerState>((set, get) => ({
  draft: '', model: '', thinking: 'medium', permission: 'edit-confirm', generating: false,
  setDraft: (draft) => set({ draft: draft.slice(0, 10000) }),
  clearDraft: () => set({ draft: '' }),
  selectModel: (model) => set({ model }),
  selectThinking: (thinking) => set({ thinking }),
  selectPermission: (permission) => set({ permission }),
  submitDraft: () => {
    // 守卫认 generating（发送即置位、轮结算才回落）——旧字段 sending 从无处置 true，
    // 守卫恒不成立，连点两次会向同一线程投两个 prompt，事件流无法区分归属。
    const { draft, generating } = get();
    if (draft.trim().length === 0 || generating) return false;
    set({ generating: true, draft: '' });
    return true;
  },
  toggleGeneration: () => set((state) => ({ generating: !state.generating })),
  setGenerating: (generating) => set({ generating }),
}));
