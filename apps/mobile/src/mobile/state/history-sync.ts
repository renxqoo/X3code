/**
 * 历史同步（T57 §5）：bootstrap/listSaved 拉取 + sessionUpdated/Removed 事件维护 →
 * ConversationSession[]（history-store 消费模型）。
 *
 * 键语义（对抗审查 H4 修复）：preferences.pinnedSessions/archivedSessions 的键是
 * **sessionPath**（PC 端真相——sidebar/build-pinned-list 同源），非 cwd。
 * 部分更新（对抗审查 H3 修复）：残缺视图（sessionDied 等）不覆盖既有 title/cwd/
 * lastActivityAt——逐字段缺席保留。
 * 状态映射：live+streaming=working、live/parked=dead 之外的常态=idle、dead=paused
 * （paused 只表示 worker 异常退出待处理；parked 是闲置回收后的静置，桌面端标「已归档」）。
 */
import type { ConversationSession } from '@/types/domain';

export interface HistorySyncCallbacks {
  onSessions(sessions: ConversationSession[]): void;
}

interface SessionLike {
  threadId?: string;
  cwd?: string;
  title?: string;
  /** 正文摘要（hub thread/list 从归档折叠）——内容搜索与列表预览的锚点。 */
  preview?: string;
  state?: string;
  streaming?: boolean;
  model?: string | null;
  sessionPath?: string | null;
  lastActivityAt?: number;
}

interface SavedLike {
  sessionPath?: string;
  sessionId?: string;
  title?: string;
  cwd?: string;
  lastActivityAt?: number;
  /** 正文摘要（hub listSaved 从事件折叠）——内容搜索与列表预览的锚点。 */
  preview?: string;
}

const stateOf = (raw: SessionLike): ConversationSession['state'] => {
  if (raw.state === 'live') return raw.streaming === true ? 'working' : 'idle';
  // dead = worker 异常退出（桌面端标「异常」）——唯一需要用户处理的状态；
  // parked = 闲置回收/重启后的正常静置（桌面端标「已归档」），使用时会懒恢复，
  // 把它标成待处理会让每一条历史会话都挂红标。
  if (raw.state === 'dead') return 'paused';
  return 'idle';
};

const timeLabelOf = (lastActivityAt: number): string => {
  if (lastActivityAt <= 0) return '';
  const diff = Date.now() - lastActivityAt;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
};

export function toConversationSession(raw: SessionLike, pinned: boolean, archived: boolean): ConversationSession {
  const session: ConversationSession = {
    id: raw.threadId ?? '',
    title: raw.title ?? '未命名对话',
    preview: raw.preview ?? '',
    project: raw.cwd ?? '',
    timeLabel: timeLabelOf(raw.lastActivityAt ?? 0),
    state: stateOf(raw),
    pinned,
    archived,
    unread: false,
    messages: [],
  };
  if (raw.lastActivityAt !== undefined) {
    session.startedAtMs = raw.lastActivityAt;
    session.endedAtMs = raw.lastActivityAt;
  }
  return session;
}

export function createHistorySync(callbacks: HistorySyncCallbacks) {
  const sessions = new Map<string, ConversationSession>();
  const removed = new Set<string>();
  // 本地改过的标题：桌端随后推送同名会话时不得覆盖（用户刚改的名字不该被抹掉）
  const localTitles = new Map<string, string>();
  // 尚未在真相层出现的会话的本地意图：会话晚到（bootstrap 晚于用户操作）时补上
  const deferred: Map<string, { pinned?: boolean; archived?: boolean; title?: string }> = new Map();
  /** sessionPath → threadId（偏好键反查：pinned/archived 键域是 sessionPath）。 */
  const pathIndex = new Map<string, string>();

  const emit = (): void => {
    callbacks.onSessions([...sessions.values()].sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0)));
  };

  const applyPreference = (raw: SessionLike, pinnedPaths: ReadonlySet<string>, archivedPaths: ReadonlySet<string>): { pinned: boolean; archived: boolean } => {
    const path = raw.sessionPath ?? null;
    const pinned = path !== null && pinnedPaths.has(path);
    const archived = path !== null && archivedPaths.has(path);
    return { pinned, archived };
  };

  return {
    /** app/bootstrap.sessions + saved + preferences（置顶/归档按 sessionPath 折叠）。 */
    seedBootstrap(list: SessionLike[], saved: SavedLike[], preferences: { pinnedSessions?: string[]; archivedSessions?: string[] }): void {
      sessions.clear();
      pathIndex.clear();
      // bootstrap 是权威快照：墓碑必须随之清空。
      // 只清 sessions 不清 removed 会让「本地删除」在重连后复活且此后被静默冻结——
      // 会话行回来了，但它的每一条 sessionUpdated 都被墓碑丢弃，标题/状态永远停在旧值。
      removed.clear();
      deferred.clear();
      // localTitles 同样只服务于「会话尚未出现时的本地改名」，权威快照已含这些会话；
      // 不清理会让表随进程时长无界增长
      localTitles.clear();
      const pinnedPaths = new Set(preferences.pinnedSessions ?? []);
      const archivedPaths = new Set(preferences.archivedSessions ?? []);
      for (const raw of list) {
        const id = raw.threadId ?? '';
        if (id.length === 0) continue;
        if (typeof raw.sessionPath === 'string') pathIndex.set(raw.sessionPath, id);
        const { pinned, archived } = applyPreference(raw, pinnedPaths, archivedPaths);
        sessions.set(id, toConversationSession(raw, pinned, archived));
      }
      // saved（已落盘不在册会话）并入去重（live 优先）。不在册但带 sessionPath 的
      // 会话可按路径唤活（thread/resume），故仍可用；只有连路径都没有（归档不可读）
      // 才标 detached——UI 显式告知，不假装可用。
      const liveIds = new Set([...sessions.keys()].values());
      for (const item of saved) {
        const sid = item.sessionId ?? '';
        if (sid.length === 0 || liveIds.has(sid)) continue;
        const archived = item.sessionPath !== undefined && archivedPaths.has(item.sessionPath);
        const row: SessionLike = { threadId: sid, state: 'parked' };
        if (item.sessionPath !== undefined) row.sessionPath = item.sessionPath;
        if (item.title !== undefined) row.title = item.title;
        if (item.cwd !== undefined) row.cwd = item.cwd;
        if (item.lastActivityAt !== undefined) row.lastActivityAt = item.lastActivityAt;
        // saved 侧的 preview 必须带上：只在归档列表里的会话（不在 thread/live）
        // 内容搜索全靠这条路径，漏拷则该类会话恒零命中
        if (item.preview !== undefined) row.preview = item.preview;
        const derived = toConversationSession(row, false, archived);
        derived.detached = item.sessionPath === undefined;
        sessions.set(sid, derived);
      }
      emit();
    },
    /** 会话更新（sessionUpdated 事件；部分视图字段缺席时保留既有值）。 */
    updateSession(raw: SessionLike): void {
      const id = raw.threadId ?? '';
      if (id.length === 0) return;
      // 墓碑：本地删除的会话不从桌面端事件复活（否则删除后下一条 sessionUpdated 就回来）
      if (removed.has(id)) return;
      const existing = sessions.get(id);
      if (existing === undefined) {
        const created = toConversationSession(raw, false, false);
        const localTitle = localTitles.get(id);
        if (localTitle !== undefined) created.title = localTitle;
        // 会话晚到：补上此前登记的本地意图（bootstrap 晚于用户操作的情形）
        const late = deferred.get(id);
        if (late !== undefined) {
          if (late.pinned !== undefined) created.pinned = late.pinned;
          if (late.archived !== undefined) created.archived = late.archived;
          deferred.delete(id);
        }
        sessions.set(id, created);
        emit();
        return;
      }
      // 逐字段合并：残缺视图（sessionDied 只有 state）不清 title/cwd/时间
      const merged: ConversationSession = {
        ...existing,
        ...(raw.title !== undefined && !localTitles.has(id) ? { title: raw.title } : {}),
        ...(raw.preview !== undefined ? { preview: raw.preview } : {}),
        ...(raw.cwd !== undefined ? { project: raw.cwd } : {}),
        state: stateOf({ ...(raw.state !== undefined ? { state: raw.state } : {}), ...(raw.streaming !== undefined || raw.state === 'live' ? { streaming: raw.streaming ?? false } : {}) }),
      };
      if (raw.lastActivityAt !== undefined) {
        merged.startedAtMs = raw.lastActivityAt;
        merged.endedAtMs = raw.lastActivityAt;
        merged.timeLabel = timeLabelOf(raw.lastActivityAt);
      }
      const late = deferred.get(id);
      if (late !== undefined) {
        if (late.pinned !== undefined) merged.pinned = late.pinned;
        if (late.archived !== undefined) merged.archived = late.archived;
        deferred.delete(id);
      }
      sessions.set(id, merged);
      emit();
    },
    /** 会话移除（sessionRemoved 事件 / session/stop remove）。 */
    removeSession(threadId: string): void {
      sessions.delete(threadId);
      removed.add(threadId);
      emit();
    },
    /** 打开会话时带消息（conversation-store 装载）。 */
    messagesOf(threadId: string): ConversationSession | undefined {
      return sessions.get(threadId);
    },
    /**
     * 本地操作回流（置顶/归档/改名/删除）。
     *
     * 症状：用户置顶/归档/改名后，下一条 sessionUpdated 到达即回滚，删除的会话还会复活。
     * 根因：history-sync 的 Map 是历史真相，store 只是它的投影拷贝；本地动作只改拷贝，
     * 下一次 emit() 的整体替换把拷贝换回旧值。本方法把本地变更先写回 Map 再 emit，
     * 拷贝与真相不再分叉。
     *
     * change 传 null 表示移除（删除会话）。
     */
    applyLocalChange(threadId: string, change: { pinned?: boolean; archived?: boolean; title?: string } | null): void {
      if (change === null) {
        sessions.delete(threadId);
        // 墓碑：本地删的会话若稍后又从桌面端到达，不得复活
        removed.add(threadId);
        emit();
        return;
      }
      // 墓碑不因后续意图清除：删除是显式用户动作，误触的置顶/改名不该复活会话
      const existing = sessions.get(threadId);
      if (existing === undefined) {
        deferred.set(threadId, { ...deferred.get(threadId), ...change });
        return;
      }
      sessions.set(threadId, {
        ...existing,
        ...(change.pinned !== undefined ? { pinned: change.pinned } : {}),
        ...(change.archived !== undefined ? { archived: change.archived } : {}),
        ...(change.title !== undefined ? { title: change.title.slice(0, 80) } : {}),
      });
      if (change.title !== undefined) localTitles.set(threadId, change.title.slice(0, 80));
      emit();
    },
    snapshot(): ConversationSession[] {
      return [...sessions.values()];
    },
  };
}

/** saved 会话（listSaved）并入（去重 by threadId —— live 优先）。盘上历史没有 worker 态，静置即 idle。 */
export function mergeSaved(current: ConversationSession[], saved: SavedLike[]): ConversationSession[] {
  const live = new Set(current.map((session) => session.id));
  const extra: ConversationSession[] = [];
  for (const raw of saved) {
    const derived: ConversationSession = {
      id: raw.sessionId ?? raw.sessionPath ?? '',
      title: raw.title ?? '历史会话',
      preview: raw.preview ?? '',
      project: raw.cwd ?? '',
      timeLabel: timeLabelOf(raw.lastActivityAt ?? 0),
      state: 'idle',
      pinned: false,
      archived: false,
      unread: false,
      messages: [],
    };
    if (derived.id.length > 0 && !live.has(derived.id)) extra.push(derived);
  }
  return [...current, ...extra];
}
