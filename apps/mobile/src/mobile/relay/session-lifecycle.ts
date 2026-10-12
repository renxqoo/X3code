/**
 * 会话生命周期（打开 / 挂载 / 水化 / 唤活）——从 runtime 拆出的一个动词。
 *
 * 拆出理由：这些动作共享 activeThreadId 与 sessionSyncRef 两处私有状态，却和
 * relay 装配、事件路由、bootstrap 挤在同一文件里（一文件五件事）。挂载次序是协议
 * 事实，暴露面反而应该收窄——现在三个打开入口共用 openSessionAndAttach，漏挂线程
 * 这个缺陷无法再复发。
 */

import { useConversationStore } from '@/store/conversation-store';
import { useAttachmentStore } from '@/store/attachment-store';
import { useComposerStore } from '@/store/composer-store';
import { noteThreadPath, noteThreadPaths, threadPathOf } from './thread-paths';
import type { createSessionSync } from '../state/session-sync';
import { rebaselineSession } from '../state/session-align';
import { initializeRelayRuntime, getRelayRuntime } from './runtime';
import type { ChatMessage, ConversationSession } from '@/types/domain';

let activeThreadId: string | null = null;

/** 事件字段安全取串（object → ''）。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 打开会话的唯一正确入口：切 store + 挂线程 + 水化，一处收口。
 *
 * 症状：搜索页/归档页点会话后，发送消息没有回复。
 * 根因：那两处只调 store 的 openSession，不挂线程——activeThreadId 滞留在上一个
 * 会话，事件过滤（threadId === activeThreadId）把旧会话的事件写进刚打开的新会话，
 * 回复进了别的会话。history-drawer 三步齐全所以正常，两个入口时好时坏。
 *
 * 收口而不是让每个调用点自己记着三步：挂载次序是协议事实（先切 store 再挂线程
 * 再水化），漏一步就静默错，不该由人工纪律兜。本函数在 runtime 侧——store 引 runtime
 * 会成环（runtime 已引 store），故编排方是 runtime 而不是 store。
 */
export async function openSessionAndAttach(session: ConversationSession): Promise<void> {
  attachThread(session.id);
  useConversationStore.getState().openSession(session);
  // 脱离宿主表的归档会话：桌面端未在册，手机端无路径可唤活——不发起注定失败的水化
  if (session.detached === true) return;
  await hydrateThread(session.id);
}

/**
 * 挂线程（所有换宿主路径的必经点）。
 *
 * 「换宿主即换暂存域」下沉到这里而非调用侧：绕过 openSessionAndAttach 的换宿主路径
 * 有三处（抽屉「新对话」裸调 startNewSession、session-sheet 删除后 attachThread(null)、
 * 唤活换 id 时裸调 openSession），只在 openSessionAndAttach 里清会漏掉其中两条——
 * 用户在「新对话」里选的附件会串到下一个会话。
 */
export function attachThread(threadId: string | null): void {
  // 守卫读 attach 域自身的上一值（activeThreadId），不读 store 的 activeSessionId：
  // 后者会被调用方提前 openSession 改写，那样两边恒相等、守卫永不成立。
  // 判定锚在本模块内，任何调用顺序都正确。
  if (activeThreadId !== threadId) {
    useComposerStore.getState().clearDraft();
    useAttachmentStore.getState().bindToSession(threadId);
  }
  activeThreadId = threadId;
  void initializeRelayRuntime();
  if (threadId === null) {
    sessionSyncRef?.reset();
    useConversationStore.getState().startNewSession();
    // 归并器回到新会话的空起点——否则上个会话的本地行会被下个快照带进新会话
    rebaselineSession();
  }
}

let sessionSyncRef: ReturnType<typeof createSessionSync> | null = null;

/** 归并器登记（runtime 建好归并器时调用；本模块是持有者，runtime 只读引用面）。 */
export function setSessionSyncRef(instance: ReturnType<typeof createSessionSync>): void {
  sessionSyncRef = instance;
}

/**
 * 历史水化（session/entries；staleGuard：await 期间切会话弃用迟到载荷）。
 * 会话在 PC 侧闲置 park 后，worker 已收编——get_entries 只在 host 直接读档面可用，
 * 事件流则按 thread 订阅投递；水化失败时先尝试 resume 唤活再读一次。
 */
export async function hydrateThread(threadId: string): Promise<void> {
  const rt = getRelayRuntime();
  if (rt === null) return;
  const outcome = (await rt.client.invoke('session/entries', { threadId })) as { ok: boolean; data?: { items?: unknown[] } };
  if (activeThreadId !== threadId) return;
  if (outcome.ok) {
    applyHydrated(threadId, outcome.data?.items);
    return;
  }
  const revived = await reviveThread(threadId);
  if (!revived.ok || activeThreadId !== threadId) return;
  const retry = (await rt.client.invoke('session/entries', { threadId: revived.threadId })) as { ok: boolean; data?: { items?: unknown[] } };
  if (!retry.ok) return;
  switchActiveThread(revived.threadId);
  applyHydrated(revived.threadId, retry.data?.items);
}

function applyHydrated(threadId: string, rawItems: unknown): void {
  const sync = sessionSyncRef;
  if (sync === null) return;
  // data.items 经 mapResponseData 已是 ChatMessage[]（WAL→HistoryItem 折叠在 response-map）
  sync.seed(Array.isArray(rawItems) ? (rawItems as ChatMessage[]) : []);
  useConversationStore.getState().appendMessages(sync.snapshot().messages);
  void threadId;
}

/**
 * parked/dead 会话唤活，语义与 PC 端 resolveTarget 同款。
 *
 * 顺序要紧：**先问宿主表，再看本地路径**。设备面的路径索引是启动时快照，
 * 桌面端之后重开过的会话（另一台设备/桌面自己唤的）本地可能没记到路径，
 * 但它在宿主表里就是活的、原 id 即投递目标。没有路径就放弃会把「宿主明明
 * 有活线程」误判成不可用——这正是手机端对 PC 侧会话发不出消息的成因。
 * 路径只作兜底：表内没有才按 sessionPath resume（可能换发新 threadId）。
 */
export async function reviveThread(threadId: string): Promise<{ ok: true; threadId: string } | { ok: false; reason: string }> {
  const rt = getRelayRuntime();
  if (rt === null) return { ok: false, reason: 'runtime_missing' };
  const sessionPath = threadPathOf(threadId);
  const rows = await liveThreadRows();
  // ① 原 id 仍在表：它就是投递目标（同时补记路径，供后续按路径收养）
  const byId = rows.find((row) => textOf(row['threadId']) === threadId);
  if (byId !== undefined) {
    const path = rowSessionPath(byId);
    if (path !== null) noteThreadPaths([byId]);
    return { ok: true, threadId };
  }
  if (sessionPath === null || sessionPath.length === 0) return { ok: false, reason: 'no_session_path' };
  // ② 同路径被桌面端换发过新 id：收养既有表项，不重复 resume
  const holder = rows.find((row) => rowSessionPath(row) === sessionPath);
  if (holder !== undefined) {
    const id = textOf(holder['threadId']);
    if (id.length > 0) {
      noteThreadPaths([holder]);
      return { ok: true, threadId: id };
    }
  }
  // ③ 表内没有：按路径 resume（可能换发新 threadId）
  const outcome = (await rt.client.invoke('session/resume', { sessionPath })) as {
    ok: boolean;
    data?: { threadId?: string };
    error?: { message?: string };
  };
  if (outcome.ok && typeof outcome.data?.threadId === 'string') {
    noteThreadPath(outcome.data.threadId, sessionPath);
    return { ok: true, threadId: outcome.data.threadId };
  }
  return { ok: false, reason: outcome.error?.message ?? 'resume_failed' };
}

/** thread/list 原始行（失败按空表降级——调用方据此走 resume 兜底）。 */
async function liveThreadRows(): Promise<Array<Record<string, unknown>>> {
  const rt = getRelayRuntime();
  if (rt === null) return [];
  const outcome = (await rt.client.invoke('session/liveThreads', {})) as { ok: boolean; data?: { sessions?: unknown } };
  if (!outcome.ok || !Array.isArray(outcome.data?.sessions)) return [];
  return outcome.data.sessions.filter((raw): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null);
}

function rowSessionPath(row: Record<string, unknown>): string | null {
  const path = row['sessionPath'];
  return typeof path === 'string' && path.length > 0 ? path : null;
}

function switchActiveThread(threadId: string): void {
  activeThreadId = threadId;
  const session = useConversationStore.getState().session;
  if (session.id !== threadId) useConversationStore.getState().openSession({ ...session, id: threadId });
}

export async function reconcileThread(threadId: string): Promise<void> {
  await hydrateThread(threadId);
}



/** 活跃线程 id（事件路由的过滤锚点）。 */
export function activeThreadIdOf(): string | null {
  return activeThreadId;
}

/** 归并器引用（runtime 建好后登记，事件泵直接用）。 */
export function sessionSyncRefOf(): ReturnType<typeof createSessionSync> | null {
  return sessionSyncRef;
}
