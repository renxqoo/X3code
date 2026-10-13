import { createStore } from 'zustand/vanilla';

import { EMPTY_RELAY_CONFIG } from '@x3code/contracts';
import type {
  AgentDefinition,
  PendingDialogView,
  SubagentSnapshotView,
  CommandView,
  SessionStatsView,
  TokenAnalyticsView,
  SkillView,
  ApiData,
  ModelInfoView,
  PluginView,
  PreferencesView,
  ProviderConfigView,
  SavedSessionView,
  SessionView,
  UiEvent,
} from '@x3code/contracts';
import type { SubagentModel, ThreadModel } from '@/thread/thread-model';
import type { ThreadItem } from '@/thread/thread-model';

import { foldDeath, foldStopIntent, foldThreadEvent } from './fold-events';

const MAX_LIVE_CHARS = 4 * 1024 * 1024;
import { capSeenIds } from './live-thread-state';
import { insertBeforeLiveTurn } from './turn-ops';
import { foldHydrate } from './fold-hydrate';
import { initialThreadState, type HydrateAction, type LiveThreadState } from './live-thread-state';

/**
 * 渲染层全局 store（zustand vanilla + 组件经 useStore 选择器订阅）。
 * store 只做状态容器与折叠派发；副作用（invoke/对账拉取）在 controller。
 */

/** 挂起的 confirm 对话框（host-hub 仅实现 confirm：tool/summary/reason 三字段平铺）。 */
export type PendingDialog = {
  requestId: string;
  threadId: string;
  method: string;
  tool?: string;
  summary?: string;
  reason?: string;
  /** 子代理中继的对话框身份。 */
  agentName?: string;
};

/** hub 用户级缺省（app/hubSettings；null 字段 = 未设置按 hub 缺省；permissionModes = host 词表——选项面）。 */
export type HubSettingsView = ApiData<'app/hubSettings'>;

/** 活跃会话权限模式读口视图（permission/mode；modes = host 词表——选项面）。 */
export type SessionPermissionModeView = ApiData<'permission/mode'>;

/** 活跃会话思考档读口视图（session/thinkingLevels）。 */
export type ThinkingLevelStateView = {
  level: string;
  source: 'session' | 'project' | 'user' | 'off';
};

export interface LiveStoreState {
  hostPhase: 'starting' | 'ready' | 'restarting' | 'failed' | null;
  bootstrapLoaded: boolean;
  bootstrapError: string | null;
  sessions: Readonly<Record<string, SessionView>>;
  saved: readonly SavedSessionView[];
  models: readonly ModelInfoView[];
  providers: readonly ProviderConfigView[];
  /** 应用偏好（默认模型 / 引导完成标志）。 */
  preferences: PreferencesView;
  /** hub 用户级缺省（null = 未加载；新任务页控件与设置页共用）。 */
  hubSettings: HubSettingsView | null;
  /** 活跃会话权限模式（null = 未加载/无会话）。 */
  sessionPermissionMode: SessionPermissionModeView | null;
  /** 子 agent 定义管理面（文件真相；进 Agents 分区时拉取）。 */
  agentDefinitions: readonly AgentDefinition[];
  /** 用户级技能目录（进技能分区时拉取；启停真相在 hub settings）。 */
  skills: readonly SkillView[];
  plugins: readonly PluginView[];
  /** 活跃会话的斜杠命令目录（`/` 补全数据源；拉取 effect 写入，切会话同步清空）。 */
  commands: readonly CommandView[];
  /** 活跃会话思考档读口（{level,source}；null = 未加载）。 */
  thinkingLevel: ThinkingLevelStateView | null;
  threads: Readonly<Record<string, LiveThreadState>>;
  /** 挂起对话框队列（入队序即呈现序；数组本身即真相，无伴生索引）。 */
  dialogs: readonly PendingDialog[];
  activeThreadId: string | null;
  stats: Readonly<Record<string, SessionStatsView>>;
  /** 占用构成的两个静态分量（系统提示词/工具；会话内近似不变，激活时拉一次）。
   *  messages 不在此——它是「占用 − 两估」的残差，由展示层从实报占用实时派生。 */
  analytics: Readonly<Record<string, TokenAnalyticsView>>;
  /** 通知条（bash 携图拒绝/失败类接线层提示的瞬时呈现）。 */
  notices: readonly { id: string; text: string }[];
}

export interface LiveStoreActions {
  applyEvent(event: UiEvent, now: number): void;
  hydrate(threadId: string, action: HydrateAction): void;
  /** 子代理快照合入（T35 M2b 收敛读口）：按 agentName 合并（快照为权威态），
   * 本地缺的补建、本地有而快照无的保留。 */
  hydrateSubagents(threadId: string, snapshot: readonly SubagentSnapshotView[], now: number): void;
  /** 待答弹窗合入（T35 M2b 收敛读口）：按 requestId 合并（快照权威），**只增不删**——
   * 快照读取与应用之间存在在途窗口，凭快照删除会复活刚结算的弹窗；删除只走 dialogSettled。 */
  hydrateDialogs(snapshot: readonly PendingDialogView[]): void;
  /** fork 换轨后旧线程运行面终态化（streaming/queue 镜像不再有事件驱动收敛）。 */
  parkThread(threadId: string): void;
  stopIntent(threadId: string): void;
  bootstrap(data: ApiData<'app/bootstrap'>): void;
  bootstrapFailed(reason: string): void;
  setActiveThread(threadId: string | null): void;
  updateStats(threadId: string, stats: SessionStatsView): void;
  updateAnalytics(threadId: string, analytics: TokenAnalyticsView): void;
  /** 直执行 bash 开始/结束（流式尾部经 bashOutput 事件折叠）。 */
  bashStarted(threadId: string): void;
  bashSettled(threadId: string): void;
  /** 乐观回显：本地气泡即时上屏（文本/图片已知，WAL seq 未知）。宿主回执带回该落账
   *  的 WAL seq——`reconcileEcho` 把本气泡换到 `msg-seq-<seq>` 同一身份域。 */
  echoPendingMessage(threadId: string, localId: string, text: string, images?: ReadonlyArray<{ data: string; mimeType: string }>): void;
  /** 回执对账：把在途回显气泡换成落账身份（`msg-seq-<seq>`）——随后到达的事件帧/条目
   *  对账与它同键，seenIds/条目 id 直接去重（否则同文本两条并存）。转写已先到时
   *  只除名（不重复插入）。 */
  reconcileEcho(threadId: string, localId: string, seq: number): void;
  /** 投递失败回滚：移除 pending 气泡（草稿回填由调用方负责）。 */
  dropPendingMessage(threadId: string, localId: string): void;
  /** 通知条追加（保留最近 5 条；controller/actions 共用的单一入口）。 */
  pushNotice(text: string): void;
  dismissNotice(id: string): void;
  reset(): void;
}

export type LiveStore = ReturnType<typeof createLiveStore>;

/** 会话存活判定（异步读回包落地前的复检谓词，单一真相）：活跃或已登记。
 *  事件流先于登记到达是协议常态（hub 同管道先发事件帧后发 response——直发下
 *  事件恒先于 invoke 结果），故本谓词只用于「读口回包」侧的写回复检（bash 收尾
 *  探测/converge/轮首 inflight 读），不用于事件折叠入口（那里必须宽容预登记）。 */
export const isLiveSession = (state: LiveStoreState, threadId: string): boolean =>
  threadId === state.activeThreadId || threadId in state.sessions;

export function createLiveStore() {
  const store = createStore<LiveStoreState & LiveStoreActions>()((set) => {
    const threadOf = (state: LiveStoreState, threadId: string): LiveThreadState => state.threads[threadId] ?? initialThreadState;

    return {
      ...initialStoreState(),
      applyEvent(event, now) {
        set((state) => {
          switch (event.type) {
            case 'host': {
              if (event.phase !== 'restarting' && event.phase !== 'failed') return { hostPhase: event.phase };
              // 宿主进程死亡（挂死重启/启动失败）：全部线程的运行面随进程消亡且不会再有任何事件，
              // 就地终态防 streaming/queue 镜像滞留（滞留会把空闲会话的新消息投进永不消费的队列）；
              // 挂起对话框同随进程消亡（ui_response 永无回执，滞留只等 5 分钟兜底超时）。
              // hydrated/hydrateFailed 一并失效：对账回落后（同 threadId）旧数据可能
              // 落后于盘上会话，被再次激活时须重拉全量；旧失败标志属旧世代，不得残留
              // 误呈「历史加载失败」空态
              const threads: Record<string, LiveThreadState> = {};
              for (const [threadId, thread] of Object.entries(state.threads)) {
                threads[threadId] = { ...foldDeath(thread, now), crashed: true, hydrated: false, hydrateFailed: false };
              }
              return { hostPhase: event.phase, threads, dialogs: [] };
            }
            case 'sessionUpdated':
              return { sessions: { ...state.sessions, [event.session.threadId]: event.session } };
            case 'sessionRemoved': {
              const doomed = state.sessions[event.threadId];
              if (doomed === undefined) return state;
              const sessions = omitKey(state.sessions, event.threadId);
              const threads = omitKey(state.threads, event.threadId);
              const stats = omitKey(state.stats, event.threadId);
              const analytics = omitKey(state.analytics, event.threadId);
              // 线程已移除，挂起对话框永无应答对象：随行收走（与 sessionDied/host 同口径）
              const dialogs = state.dialogs.filter((dialog) => dialog.threadId !== event.threadId);
              let activeThreadId = state.activeThreadId;
              if (activeThreadId === event.threadId) {
                // 换 id 整行替换（resume/fork）时优先回落到同会话文件的新 id，避免闪跳到无关会话
                const successor =
                  doomed.sessionPath !== null
                    ? Object.values(sessions).find((session) => session.sessionPath === doomed.sessionPath)
                    : undefined;
                activeThreadId = successor?.threadId ?? firstSessionId(sessions);
              }
              return { sessions, threads, stats, analytics, dialogs, ...activeThreadFlip(state, activeThreadId) };
            }
            case 'sessionDied': {
              const thread = threadOf(state, event.threadId);
              // 该 worker 的挂起对话框随进程消亡：立即收起，不等 5 分钟兜底超时
              const dialogs = state.dialogs.filter((dialog) => dialog.threadId !== event.threadId);
              return { threads: { ...state.threads, [event.threadId]: foldThreadEvent(thread, event, now) }, dialogs };
            }
            case 'sessionParked': {
              const thread = threadOf(state, event.threadId);
              const session = state.sessions[event.threadId];
              const dialogs = state.dialogs.filter((dialog) => dialog.threadId !== event.threadId);
              return {
                // 会话视图经 sessionUpdated(parked) 折叠；此处兜底幂等置 parked（事件乱序安全）
                sessions: session === undefined || session.state === 'parked' ? state.sessions : { ...state.sessions, [event.threadId]: { ...session, state: 'parked', streaming: false } },
                threads: { ...state.threads, [event.threadId]: foldThreadEvent(thread, event, now) },
                dialogs,
              };
            }
            case 'dialogRequest': {
              // host-hub 仅实现 confirm：全部入队（无 notify/setStatus 分支——通知条
              // 只服务接线层提示，见 pushNotice）
              const dialogs = [...state.dialogs.filter((dialog) => dialog.requestId !== event.requestId), toPendingDialog(event)];
              return { dialogs };
            }
            case 'dialogSettled': {
              if (!state.dialogs.some((dialog) => dialog.requestId === event.requestId)) return state;
              return { dialogs: state.dialogs.filter((dialog) => dialog.requestId !== event.requestId) };
            }
            default: {
              const threadId = (event as { threadId?: string }).threadId;
              if (typeof threadId !== 'string' || threadId.length === 0) return state;
              return { threads: { ...state.threads, [threadId]: foldThreadEvent(threadOf(state, threadId), event, now) } };
            }
          }
        });
      },
      hydrateSubagents(threadId, snapshot, now) {
        if (snapshot.length === 0) return;
        set((state) => {
          const agents = [...(state.threads[threadId]?.agents ?? [])];
          for (const entry of snapshot) {
            const index = agents.findIndex((agent) => agent.agentId === entry.agentId);
            const base: SubagentModel =
              index === -1
                ? { id: entry.agentId, agentId: entry.agentId, name: entry.agentType, agentType: entry.agentType, task: entry.work ?? '', model: '', effort: '', tokens: null, toolCount: 0, status: entry.status, startedAt: now, endedAt: null, summary: '', pendingAsk: null, tools: [] }
                : (agents[index] as SubagentModel);
            const merged: SubagentModel = {
              ...base,
              agentId: entry.agentId.length > 0 ? entry.agentId : base.agentId,
              // 快照缺 agentType/work 时不抹掉本地已知值（复活旧档案 work 可能缺席）
              agentType: entry.agentType.length > 0 ? entry.agentType : base.agentType,
              task: (entry.work ?? '').length > 0 ? (entry.work as string) : base.task,
              status: entry.status,
              endedAt: entry.status === 'stopped' ? base.endedAt ?? now : null,
            };
            if (index === -1) agents.push(merged);
            else agents[index] = merged;
          }
          return { threads: { ...state.threads, [threadId]: { ...threadOf(state, threadId), agents } } };
        });
      },
      hydrateDialogs(snapshot) {
        if (snapshot.length === 0) return;
        set((state) => {
          let dialogs = state.dialogs;
          for (const entry of snapshot) {
            const mapped = toPendingDialogFromView(entry);
            dialogs = [...dialogs.filter((dialog) => dialog.requestId !== mapped.requestId), mapped];
          }
          return { dialogs };
        });
      },
      hydrate(threadId, action) {
        set((state) => {
          // 幽灵守卫：会话已移除（重开/停止后迟到的对账定时器）不再在 threads 表复活条目
          if (threadId !== state.activeThreadId && !(threadId in state.sessions)) return state;
          return { threads: { ...state.threads, [threadId]: foldHydrate(threadOf(state, threadId), action) } };
        });
      },
      parkThread(threadId) {
        set((state) => {
          const thread = state.threads[threadId];
          if (thread === undefined) return state;
          // fork 换轨：旧 id 不再有任何事件，运行面就地终态防 streaming/queue 镜像滞留；
          // parked 标志让轮结算侦测（排队冲刷）把这次翻转排除在「自然结算」外
          return { threads: { ...state.threads, [threadId]: { ...foldDeath(thread, Date.now()), parked: true } } };
        });
      },
      stopIntent(threadId) {
        set((state) => ({ threads: { ...state.threads, [threadId]: foldStopIntent(threadOf(state, threadId)) } }));
      },
      bootstrap(data) {

        set((state) => {
          // 滞后快照合并语义：快照补缺、不清在途（事件流可能先于 bootstrap 建立更新的会话/字段）
          const sessions: Record<string, SessionView> = { ...state.sessions };
          for (const session of data.sessions) {
            sessions[session.threadId] = sessions[session.threadId] ?? session;
          }
          const threads: Record<string, LiveThreadState> = {};
          for (const threadId of Object.keys(sessions)) {
            threads[threadId] = state.threads[threadId] ?? initialThreadState;
          }
          const activeThreadId =
            state.activeThreadId !== null && state.activeThreadId in sessions ? state.activeThreadId : firstSessionId(sessions);
          return {
            // 活跃线程翻转（bootstrap 回落）同样清会话级视图，与 setActiveThread 同语义
            ...activeThreadFlip(state, activeThreadId),
            bootstrapLoaded: true,
            bootstrapError: null,
            sessions,
            saved: data.saved,
            models: data.models,
            providers: data.providers,
            // 偏好整体替换：bootstrap 只在启动时发生一次，晚于它写入的偏好不会被回滚；
            // 若未来引入重连 re-bootstrap，需改为字段级合并（滞后快照可能覆盖本地新写值）
            preferences: data.preferences,
            // 宿主相位滞后合并：缓冲事件先到（如 host failed）不被启动快照回滚
            hostPhase: state.hostPhase ?? data.hostPhase,
            threads,
            activeThreadId,
          };
        });
      },
      bootstrapFailed(reason) {
        set({ bootstrapLoaded: true, bootstrapError: reason });
      },
      setActiveThread(threadId) {
        // 同值重设不失效（effect 以 activeThreadId 为 deps，不会重拉）；翻转语义见 activeThreadFlip
        set((state) => activeThreadFlip(state, threadId));
      },
      updateAnalytics(threadId, analytics) {
        set((state) => ({ analytics: { ...state.analytics, [threadId]: analytics } }));
      },
      updateStats(threadId, stats) {
        set((state) => ({ stats: { ...state.stats, [threadId]: stats } }));
      },
      bashStarted(threadId) {
        set((state) => ({ threads: { ...state.threads, [threadId]: { ...threadOf(state, threadId), bashRunning: true, bashTail: '' } } }));
      },
      bashSettled(threadId) {
        set((state) => ({ threads: { ...state.threads, [threadId]: { ...threadOf(state, threadId), bashRunning: false, bashTail: '' } } }));
      },
      echoPendingMessage(threadId, localId, text, images) {
        set((state) => {
          const thread = threadOf(state, threadId);
          if (thread.seenIds.has(localId)) return {};
          const message: ThreadItem = { kind: 'message', message: { id: `msg-${localId}`, role: 'user', text: text.slice(0, MAX_LIVE_CHARS), images: images ?? [] } };
          return {
            threads: {
              ...state.threads,
              [threadId]: {
                ...thread,
                seenIds: capSeenIds(new Set([...thread.seenIds, localId])),
                items: insertBeforeLiveTurn(thread.items, message, thread.liveTurnId),
              },
            },
          };
        });
      },
      reconcileEcho(threadId, localId, seq) {
        set((state) => {
          const thread = threadOf(state, threadId);
          const nextId = `msg-seq-${seq}`;
          // 转写已先到（同 seq 的权威气泡已并入，id 即 msg-seq-<seq>）：本气泡只除名，
          // 身份归属转写侧（否则 rename 会撞出同 id 的两条）
          if (thread.items.some((item) => item.kind === 'message' && item.message.id === nextId)) {
            const items = thread.items.filter((item) => !(item.kind === 'message' && item.message.id === `msg-${localId}`));
            return { threads: { ...state.threads, [threadId]: { ...thread, items } } };
          }
          let found = false;
          const items = thread.items.map((item) => {
            if (item.kind === 'message' && item.message.id === `msg-${localId}`) {
              found = true;
              return { kind: 'message' as const, message: { ...item.message, id: nextId } };
            }
            return item;
          });
          if (!found) return {};
          return {
            threads: {
              ...state.threads,
              [threadId]: { ...thread, items, seenIds: capSeenIds(new Set([...thread.seenIds, nextId])) },
            },
          };
        });
      },
      dropPendingMessage(threadId, localId) {
        set((state) => {
          const thread = threadOf(state, threadId);
          const items = thread.items.filter((item) => !(item.kind === 'message' && item.message.id === `msg-${localId}`));
          if (items.length === thread.items.length) return {};
          return { threads: { ...state.threads, [threadId]: { ...thread, items } } };
        });
      },
      pushNotice(text) {
        set((state) => ({ notices: [...state.notices.filter((notice) => notice.text !== text).slice(-4), { id: `notice-${(noticeSeq += 1)}`, text }] }));
      },
      dismissNotice(id) {
        set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) }));
      },
      reset() {
        set(initialStoreState());
      },
    };
  });
  return store;
}

/** 模型缓存 key = 折叠态引用：不可变更新保证「引用不变 ⇒ 内容不变」，
 * 后台线程/无关字段的 set 不再让活跃线程模型换引用（消息流 memo 的命中前提）。 */
const threadModelCache = new WeakMap<LiveThreadState, ThreadModel>();

export function threadModelOf(state: LiveStoreState, threadId: string): ThreadModel {
  const thread = state.threads[threadId] ?? initialThreadState;
  const cached = threadModelCache.get(thread);
  if (cached?.sessionId === threadId) return cached;
  const model: ThreadModel = { sessionId: threadId, items: thread.items, agents: thread.agents };
  threadModelCache.set(thread, model);
  return model;
}

/** 通知条 id 单调序列（避免同毫秒碰撞；dismiss 按 id 定位）。 */
let noticeSeq = 0;

function toPendingDialog(event: DialogViewSource): PendingDialog {
  return {
    requestId: event.requestId,
    threadId: event.threadId,
    method: event.method,
    tool: event.tool,
    summary: event.summary,
    reason: event.reason,
    agentName: event.agentName,
  };
}

type DialogViewSource = Extract<UiEvent, { type: 'dialogRequest' }>;

/** 待答弹窗视图 → store 形状（与 dialogRequest 事件同一套字段收窄；confirm 平铺载荷）。 */
function toPendingDialogFromView(entry: PendingDialogView): PendingDialog {
  const payload = entry.payload;
  const str = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
  return {
    requestId: entry.requestId,
    threadId: entry.threadId,
    method: entry.method,
    tool: str(payload['tool']),
    summary: str(payload['summary']),
    reason: str(payload['reason']),
    agentName: str(payload['agentName']),
  };
}

function omitKey<T>(source: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [name, value] of Object.entries(source)) {
    if (name !== key) out[name] = value;
  }
  return out;
}

/**
 * 活跃线程翻转时的会话级视图失效补丁：sessionPermissionMode/commands/thinkingLevel
 * 是活跃会话的视图，翻转即同步清空（防旧会话的规则/补全目录在操作栏残留一帧；新值由
 * 切会话 effect 重拉）。全部翻转路径（setActiveThread / sessionRemoved 继任者
 * 回落 / bootstrap 回落）必须经此，禁止直写 activeThreadId 不带补丁。
 */
function activeThreadFlip(state: LiveStoreState, threadId: string | null) {
  return state.activeThreadId === threadId
    ? {}
    : { activeThreadId: threadId, sessionPermissionMode: null, commands: [] as const, thinkingLevel: null };
}

function firstSessionId(sessions: Readonly<Record<string, SessionView>>): string | null {
  const ids = Object.keys(sessions);
  return ids.length > 0 ? (ids[0] ?? null) : null;
}

function initialStoreState(): LiveStoreState {
  return {
    hostPhase: null,
    bootstrapLoaded: false,
    bootstrapError: null,
    sessions: {},
    saved: [],
    models: [],
    providers: [],
    agentDefinitions: [],
    skills: [],
    plugins: [],
    commands: [],
    thinkingLevel: null,
    preferences: { defaultModel: null, onboarded: false, projectModels: {}, pinnedSessions: [], trustedDefault: false, hiddenProjects: [], idleRecycleMinutes: 5, archivedSessions: [], relay: { ...EMPTY_RELAY_CONFIG } },
    hubSettings: null,
    sessionPermissionMode: null,
    threads: {},
    dialogs: [],
    activeThreadId: null,
    stats: {},
  analytics: {},
    notices: [],
  };
}
