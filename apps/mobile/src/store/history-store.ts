import { create } from 'zustand';
import type { ConversationSession } from '@/types/domain';
import { recordLocalHistoryChange } from '@/mobile/state/local-history-changes';

type HistoryState = {
  sessions: readonly ConversationSession[];
  query: string;
  setQuery: (query: string) => void;
  selectSession: (id: string) => void;
  togglePinned: (id: string) => void;
  archiveSession: (id: string) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  /** bridge 数据源装载（真实会话列表整体替换）。 */
  replaceSessions: (sessions: readonly ConversationSession[]) => void;
};

const updateSession = (sessions: readonly ConversationSession[], id: string, update: (session: ConversationSession) => ConversationSession): ConversationSession[] =>
  sessions.map((session) => session.id === id ? update(session) : session);

export const useHistoryStore = create<HistoryState>((set) => ({
  sessions: [], query: '',
  setQuery: (query) => set({ query: query.slice(0, 120) }),
  selectSession: (id) => set((state) => ({ sessions: state.sessions.map((session) => session.id === id ? { ...session, unread: false } : session) })),
  togglePinned: (id) => {
    const session = useHistoryStore.getState().sessions.find((item) => item.id === id);
    if (session === undefined) return;
    // 登记回流：只改 store 会被下一条事件整体替换回滚（真相在 history-sync 的 Map）
    recordLocalHistoryChange(id, { pinned: !session.pinned });
    set((state) => ({ sessions: updateSession(state.sessions, id, (item) => ({ ...item, pinned: !item.pinned })) }));
  },
  archiveSession: (id) => {
    const session = useHistoryStore.getState().sessions.find((item) => item.id === id);
    if (session === undefined) return;
    recordLocalHistoryChange(id, { archived: !session.archived });
    set((state) => ({ sessions: updateSession(state.sessions, id, (item) => ({ ...item, archived: !item.archived })) }));
  },
  deleteSession: (id) => {
    recordLocalHistoryChange(id, null);
    set((state) => ({ sessions: state.sessions.filter((session) => session.id !== id) }));
  },
  renameSession: (id, title) => {
    const next = title.trim().slice(0, 80);
    if (next.length === 0) return;
    recordLocalHistoryChange(id, { title: next });
    set((state) => ({ sessions: updateSession(state.sessions, id, (session) => ({ ...session, title: next })) }));
  },
  replaceSessions: (sessions) => set({ sessions }),
}));
