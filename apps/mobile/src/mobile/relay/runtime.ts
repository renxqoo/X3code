/**
 * relay 装配根（T58 P2）：传输（relay transport）+ Client 适配 + 同步器组合。
 * 与 LAN 期 bridge-runtime 同职责，差异仅传输段——事件路由/水化/store 面全复用
 * （session-sync/history-sync/entriesToMessages 原样，见 MIGRATION 矩阵）。
 * 文件职责：装配 + 事件路由（拆出 useRelayStatus 到 hooks 面）。
 */
import * as React from 'react';

import type { ApiMethod, ApiOutcome, Client, UiEvent, Unsubscribe } from '@x3code/contracts';

import { createBridgeClient, type BridgeClient, type ClientTransportFace } from '../transport/client';
import { createRelayTransport, type RelayStatus, type RelayTransport } from './transport';
import { createRelayRatchetCodec } from './ratchet-codec';
import { dialWebSocket } from './ws-dial';
import { refreshDeviceToken } from './token-refresh';
import { createKvRatchetStore, preloadRelayCredentials, relayCredentialsStore, type RelayCredentials } from './credentials';
import { withSavedMeta } from './with-saved-meta';
import { createSessionSync } from '../state/session-sync';
import { setSessionSync } from '../state/session-align';
import { noteThreadPaths } from './thread-paths';
import { classifyRelayFailure } from './relay-reachability';
import { normalizeSessionRows } from './session-rows';
import { bindLocalHistorySink } from '../state/local-history-changes';
import {
  activeThreadIdOf, bindRuntimeSource, reconcileThread, sessionSyncRefOf, setSessionSyncRef,
} from './session-lifecycle';
import { createEventMapper, type EventMapper } from '@x3code/api/events/event-mapper';
import { createHistorySync } from '../state/history-sync';
import { useConversationStore } from '@/store/conversation-store';
import { useHistoryStore } from '@/store/history-store';
import { useComposerStore } from '@/store/composer-store';

export interface RelayRuntime {
  client: BridgeClient;
  transport: RelayTransport;
  status: RelayStatus;
  /** 设备凭证（配对后可用）。 */
  credentials: RelayCredentials | null;
  /** 配对完成后的正式连接（经凭证 + relay token）。 */
  connectWithCredentials(relayToken: string): Promise<void>;
  disconnect(): void;
}

let runtime: RelayRuntime | null = null;
const eventMapper: EventMapper = createEventMapper({ now: () => Date.now() });
let connectInFlight: Promise<void> | null = null;

/**
 * 装配期失败归一（token 续期抛 / ratchet 读抛 / SecureStore 抛 / socket 建抛）。
 *
 * 不吞掉的另一个理由：失败必须能落到可区分的面上。「连不上」与「凭证有问题」
 * 在用户处是两种完全不同的处置（等网络 vs 重新配对），归一成语义不明的值
 * 等于把诊断信息扔掉。
 */
function assemblyFailureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/token|credential|secret|key|auth/i.test(message)) return 'auth-rejected';
  return 'assembly-failed';
}

export function getRelayRuntime(): RelayRuntime | null {
  return runtime;
}

export function initializeRelayRuntime(): RelayRuntime {
  if (runtime !== null) return runtime;

  // 传输（codec 由凭证种子；无凭证时占位——connectWithCredentials 重建）
  const placeholderCodec = {
    seal: async () => {
      await Promise.resolve();
      return null;
    },
    open: async () => {
      await Promise.resolve();
      return null;
    },
  };
  const transport = createRelayTransport({
    relayUrl: '',
    relayToken: '',
    deviceId: '',
    installationId: '',
    codec: placeholderCodec,
    socketFactory: () => {
      throw new Error('not configured');
    },
    callbacks: {
      onStatus(status, detail) {
        if (runtime === null) return;
        (runtime as RelayRuntime & { status: RelayStatus }).status = status;
        notifyStatusListeners();
        void detail;
      },
      onFrame(frame) {
        dispatchL2Frame(frame);
      },
      onRelayMessage() {
        // relay 控制行（no-route 等）——观测面（日志）
      },
    },
  });

  // client 经活引用取 transport（connectWithCredentials 换绑后 invoke 即刻生效——H1 修复）
  const liveTransport = { current: transport as unknown as ClientTransportFace };
  // 鉴权拒绝（token 过期）→ 签名挑战续期一次 → 重连（不在退避环里 401 打转）
  //
  // 症状：配对成功过，之后再也连不上，手动重连也没用。
  // 根因两处：① RN 的 WebSocket 在握手失败时不暴露响应头，relay 的 401(auth) 与
  // 503(overloaded) 在 onError 里同形，transport 只能报 'closed'——自动续期的判据
  // 从来不成立；② 续期失败时 authRetryArmed 不复位（只在成功分支），一次失败后
  // 自动重连永久关闭。两者叠加 = 掉线即永久。
  //
  // 修法：① 失败后探测 relay /healthz（免鉴权，relay 已在提供），据此把故障分成
  // 「网络不可达」与「凭证被拒」；② 无论续期成败都复位 armed。
  let authRetryArmed = true;
  const onStatusWrapper = (status: RelayStatus, detail: string): void => {
    if (status !== 'disconnected' || !authRetryArmed || runtime === null) return;
    // assembly-failed 是本模块自己的装配失败面（不来自 transport），一并纳入：
    // 不纳入则装配失败（如 ratchet store 读不出）永远不会被自动重试
    if (detail !== 'auth-rejected' && detail !== 'connect-exhausted' && detail !== 'closed' && detail !== 'assembly-failed') return;
    // armed 只防「同一轮退避里反复续期」，不是「一生只续一次」——所有出口都要复位。
    // 用 try/finally 而非在 then 尾部：凭据缺失、探测异常等早退路径同样必须解锁，
    // 否则一次「断开时恰好未配对」就永久关闭自动重连（这正是本缺陷的形态）。
    authRetryArmed = false;
    try {
      const credentials = relayCredentialsStore.load();
      // 未配对：无凭证可续期，解锁后由用户完成配对再走正常连接
      if (credentials === null) return;
      void classifyRelayFailure(credentials.relayUrl)
        .then((reachability) => {
          // relay 本身不可达时续期必然也失败，白白消耗一次挑战；等网络回来由退避环接管
          if (reachability !== 'reachable') return;
          return runtime?.connectWithCredentials(credentials.relayToken).catch(() => undefined);
        })
        .catch(() => undefined)
        // 成败都复位：armed 只防「同一轮退避里反复续期」，不是「一生只续一次」。
        // 旧实现只在成功分支复位，一次失败后自动重连永久关闭。
        .then(() => { authRetryArmed = true; });
    } finally {
      // 同步路径（凭据缺失）的解锁；异步路径已在上方 then 里复位，此处再置真幂等
      authRetryArmed = true;
    }
  };
  const client = createBridgeClient({
    transport: {
      sendCommand: (spec) => liveTransport.current.sendCommand(spec),
      waitResponse: (id, timeoutMs) => liveTransport.current.waitResponse(id, timeoutMs),
    },
  });
  const clientRef: BridgeClient | null = client;

  historySyncRef = createHistorySync({
    onSessions(sessions) {
      useHistoryStore.getState().replaceSessions(sessions);
    },
  });

  setSessionSyncRef(createSessionSync({
    onDialogRequest(request, settledId) {
      if (request === null) {
        if (settledId !== null && settledId !== undefined && settledId.length > 0) {
          useConversationStore.getState().settlePermission(settledId);
        } else {
          useConversationStore.getState().clearPermission();
        }
        return;
      }
      useConversationStore.getState().requestPermission({ id: request.requestId, title: request.title, command: request.command, approved: null });
    },
    onSessionEvent() {
      // 会话级事件已在订阅回调直调 routeEvent——此回灌通道废弃（双路由根治）
    },
  }));
  // 归并器登记给两处消费者：session-lifecycle（事件泵与水合）与 session-align
  // （本地行入流与起点对齐）。单一真相仍是 createSessionSync 的实例，两处只持引用面
  setSessionSync(sessionSyncRefOf());
  // 历史本地变更回流：store 只改投影会被下一条事件整体替换回滚，此处把意图写回真相层
  bindLocalHistorySink((threadId, change) => { historySyncOf()?.applyLocalChange(threadId, change); });
  // runtime 取用口登记给 session-lifecycle：打破 lifecycle→runtime 的反向引用
  // （runtime 已 import lifecycle，反向 import 成环在 web 形态下会让绑定未初始化）
  bindRuntimeSource({
    initialize: () => initializeRelayRuntime(),
    current: () => getRelayRuntime(),
  });


  /** L2 帧 → UiEvent（hub 事件名 camelCase 词表翻译——与桌面端同源 event-mapper）+ ui_request 面。 */
  function dispatchL2Frame(frame: { kind: string; body?: unknown }): void {
    const body = (frame.body ?? {}) as Record<string, unknown>;
    if (frame.kind === 'event') {
      const name = textOf(body['name']);
      // host 生命周期词表（event-mapper 外——M-6）：thread_died/thread_parked → sessionDied/sessionParked
      if (name === 'thread_died' || name === 'thread_parked') {
        clientRef?.dispatch({ type: name === 'thread_died' ? 'sessionDied' : 'sessionParked', threadId: textOf(body['threadId']) });
        return;
      }
      const mapped = eventMapper.mapEvent({ threadId: textOf(body['threadId']), name, payload: (body['payload'] ?? {}) as Record<string, unknown>, ...(textOf(body['agentName']).length > 0 ? { agentName: textOf(body['agentName']) } : {}) });
      for (const uiEvent of mapped) clientRef?.dispatch(uiEvent);
      return;
    }
    if (frame.kind === 'ui_request') {
      // 载荷平铺（M-8：tool/summary/reason 在 body.payload——卡片信息完整）
      const payload = (body['payload'] ?? {}) as Record<string, unknown>;
      clientRef?.dispatch({
        type: 'dialogRequest',
        requestId: textOf(body['requestId']),
        method: textOf(body['method']),
        threadId: textOf(body['threadId']),
        ...(typeof payload['tool'] === 'string' ? { tool: payload['tool'] } : {}),
        ...(typeof payload['summary'] === 'string' ? { summary: payload['summary'] } : {}),
        ...(typeof payload['reason'] === 'string' ? { reason: payload['reason'] } : {}),
      });
      return;
    }
    // rekey 帧（L-2）：本端一期不做强制 rekey 应答——静默忽略（gateway sweep 60s 重发为
    // 已知噪音；暴露窗由配对种子唯一性+设备撤销兜底，见 R2 申报）
    if (frame.kind === 'rekey') return;
    if (textOf(body['type']) === 'thread_died' || textOf(body['name']) === 'thread_died') {
      clientRef?.dispatch({ type: 'sessionDied', threadId: textOf(body['threadId']) ?? textOf(body['threadId']) });
      return;
    }
  }

  // 事件路由（模块级常量——热路径零分配）
  client.subscribe((event) => {
    const record = event as unknown as Record<string, unknown>;
    const type = textOf(record['type']);
    const threadId = typeof record['threadId'] === 'string' ? (record['threadId'] as string) : null;
    const recordThreadId = textOf(record['threadId']);
    if (type === 'dialogRequest' || type === 'dialogSettled') {
      // 权限卡只对当前活跃会话（或引导态）可见——后台会话请求不打扰当前视图（L1）
      if (recordThreadId.length === 0 || activeThreadIdOf() === null || recordThreadId === activeThreadIdOf()) {
        sessionSyncRefOf()?.handleEvent(record as Record<string, unknown>);
      }
      return;
    }
    // 会话生命周期事件只走 routeEvent（session-sync 的 onSessionEvent 回灌会造成二跳双路由）
    if (type === 'sessionUpdated' || type === 'sessionRemoved' || type === 'sessionDied' || type === 'sessionParked') {
      routeEvent(event);
      return;
    }
    const sync = threadId !== null && threadId === activeThreadIdOf() ? sessionSyncRefOf() : null;
    if (sync !== null) {
      sync.handleEvent(record as Record<string, unknown>);
      const snapshot = sync.snapshot();
      useConversationStore.getState().appendMessages(snapshot.messages);
      useComposerStore.getState().setGenerating(snapshot.streaming);
      if (type === 'turnSettled' && threadId !== null) void reconcileThread(threadId);
    }
  });

  runtime = {
    client,
    transport,
    status: 'disconnected',
    credentials: null,
    async connectWithCredentials(_relayToken) {
      const credentials = relayCredentialsStore.load();
      if (credentials === null) return;
      // 并发护栏：in-flight 互斥——await 窗口的二次调用等待前者，防乱序覆盖。
      // 必须按前者的成败收敛：旧实现 await 后无条件 return，第二个调用方拿到「已完成」
      // 却什么都没连上，而 authRetryArmed 的复位正建立在这个假成功之上。
      if (connectInFlight !== null) {
        await connectInFlight;
        return;
      }
      const run = (async () => {
        try {
          // 重建传输（真 codec + RN socket）
          // token 续期：凭证 token 15min TTL 到期后凭签名挑战换新（失败回落旧值）
      const refreshed = await refreshDeviceToken(credentials);
      const freshToken = refreshed?.token ?? credentials.relayToken;
      const freshNodeId = refreshed?.relayNodeId ?? credentials.relayNodeId;
      if (freshToken !== credentials.relayToken || freshNodeId !== credentials.relayNodeId) {
        void relayCredentialsStore.save({
          ...credentials,
          relayToken: freshToken,
          ...(freshNodeId !== undefined ? { relayNodeId: freshNodeId } : {}),
        });
      }
      const codec = await createRelayRatchetCodec({
        deviceId: credentials.deviceId,
        installationId: credentials.installationId,
        sharedSecretHex: credentials.sharedSecretHex,
        store: createKvRatchetStore(),
      });
      const real = createRelayTransport({
        relayUrl: credentials.relayUrl,
        relayToken: freshToken,
        deviceId: credentials.deviceId,
        installationId: credentials.installationId,
        codec,
        socketFactory: (url) => rnSocketFactoryWithToken(url, freshToken),
        callbacks: {
          onStatus(status, detail) {
            (runtime as RelayRuntime & { status: RelayStatus }).status = status;
            notifyStatusListeners();
            onStatusWrapper(status, detail);
          },
          onFrame(frame) {
            dispatchL2Frame(frame);
          },
          onRelayMessage() {
            // 观测面
          },
        },
      });
      // 换绑前先停旧 transport（H4：泄漏 + 双写）；活引用切换让 client.invoke 即刻走真连接（H1）
      const previous = (runtime as RelayRuntime & { transport: RelayTransport }).transport;
      if (previous !== real && previous.status() !== 'disconnected') previous.stop();
      liveTransport.current = real as unknown as ClientTransportFace;
      (runtime as RelayRuntime & { transport: RelayTransport }).transport = real;
      (runtime as RelayRuntime & { credentials: RelayCredentials | null }).credentials = credentials;
      real.connect();
        } catch (error) {
          // 互斥量先释放再触发自愈：onStatusWrapper 会同步调 connectWithCredentials，
          // 若此时 connectInFlight 仍是本次的 run，自愈重试会撞上自己的互斥量而
          // 静默空转（await 立即返回、不重连也不报错）——正是这里要修的「一次失败即永久」。
          connectInFlight = null;
          // 装配失败必须可见：吞掉它等于「配对成功却连不上」且零原因（用户只能反复点
          // 重连）。落到连接失败面，由 onStatusWrapper 走故障分类与自动续期。
          (runtime as RelayRuntime & { status: RelayStatus }).status = 'disconnected';
          notifyStatusListeners();
          onStatusWrapper('disconnected', assemblyFailureDetail(error));
        } finally {
          connectInFlight = null;
        }
      })();
      connectInFlight = run;
      await run;
    },
    disconnect() {
      transport.stop();
      runtime?.transport.stop();
    },
  } as RelayRuntime;
  return runtime;
}

/** 事件字段安全取串（object → ''）。 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  return '';
}

function routeEvent(event: UiEvent): void {
  if (runtime === null) return;
  const record = event as unknown as Record<string, unknown>;
  const type = textOf(record['type']);
  if (type === 'sessionUpdated') {
    historySyncOf()?.updateSession(record['session'] as Record<string, unknown>);
    return;
  }
  if (type === 'sessionRemoved') {
    const threadId = textOf(record['threadId']);
    historySyncOf()?.removeSession(threadId);
    eventMapper.dispose(threadId);
    return;
  }
  if (type === 'sessionDied' || type === 'sessionParked') {
    const threadId = textOf(record['threadId']);
    eventMapper.dispose(threadId); // L-3
    historySyncOf()?.updateSession({ threadId, state: 'dead' });
    if (threadId === activeThreadIdOf()) {
      sessionSyncRefOf()?.handleEvent({ type: 'turnSettled', threadId, ok: false, reason: 'session ended' });
      const snapshot = sessionSyncRefOf()?.snapshot();
      if (snapshot !== undefined) {
        useConversationStore.getState().appendMessages(snapshot.messages);
        useComposerStore.getState().setGenerating(false);
      }
    }
    return;
  }
}

let historySyncRef: ReturnType<typeof createHistorySync> | null = null;
function historySyncOf(): ReturnType<typeof createHistorySync> | null {
  return historySyncRef;
}

// ---- 状态订阅（React hook 面）----

const statusListeners = new Set<() => void>();

function notifyStatusListeners(): void {
  for (const listener of statusListeners) listener();
}

export function useRelayStatus(): { status: RelayStatus; runtime: RelayRuntime | null } {
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    statusListeners.add(force);
    return () => {
      statusListeners.delete(force);
    };
  }, [force]);
  const current = getRelayRuntime();
  return { status: current === null ? 'disconnected' : current.status, runtime: current };
}

/** 启动数据装载（ready 后：bootstrap → 历史 + 偏好；并发互斥）。 */
let bootstrapInFlight: Promise<void> | null = null;

export function loadBootstrap(client: Client): Promise<void> {
  if (bootstrapInFlight !== null) return bootstrapInFlight;
  bootstrapInFlight = (async () => {
    try {
      // host 无聚合命令（R2 H-4④）：thread/list + thread/list_saved 并行拼装（偏好经 settings/get）
      const results = (await Promise.all([
        client.invoke('session/liveThreads', { includePreview: true }),
        client.invoke('session/listSaved', {}),
      ])) as unknown as Array<{ ok: boolean; data?: unknown }>;
      const threadsOut = results[0];
      const savedOut = results[1];
      const sessionsData = (threadsOut?.data ?? {}) as { sessions?: unknown };
      const live = normalizeSessionRows(sessionsData.sessions);
      // live/saved 同一套形状归一（host 的包装不一致：有的包一层、有的不包）。
      // saved 侧曾只认裸数组，包装形态下整体落空——而 cwd 守卫的候选正来自这两侧合并，
      // 列表空 = 手机端永远发不出第一条消息。
      const saved = normalizeSessionRows(savedOut?.ok === true ? savedOut.data : null);
      // 归档行也记路径：不在宿主表的会话靠它唤活（thread/resume 按路径投递）
      noteThreadPaths(live);
      noteThreadPaths(saved);
      // 置顶/归档：设备本地视图偏好。PC 的偏好集在桌面端主进程 settings.json，
      // 网关命令面无对应 host 命令——设备侧发起远程写恒为 unknown-command，故不上送。
      historySyncRef?.seedBootstrap(withSavedMeta(live, saved), saved, { pinnedSessions: [], archivedSessions: [] });
    } finally {
      bootstrapInFlight = null;
    }
  })();
  return bootstrapInFlight;
}

/** 预载凭证后若有即自动连接（App 根部 BridgeGate 调用）。 */
export async function bootstrapRelayRuntime(): Promise<void> {
  await preloadRelayCredentials();
  const credentials = relayCredentialsStore.load();
  void initializeRelayRuntime();
  if (credentials === null) return;
  // relay token：配对产物（gateway enroll token 换发——一期由 pairing 写入凭证同存）
  void runtime?.connectWithCredentials(credentials.relayToken);
}

/** RN socket 工厂（token 走 Authorization 头——R2 M10：URL query 进 LB/反代
 *  access log 的泄露面消除；relay main.ts 已优先收头）。web 无第三参——退 query（残余面见申报）。 */
function rnSocketFactoryWithToken(url: string, token: string) {
  const ws = dialWebSocket(url, token);
  return {
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
    onOpen: (cb: () => void) => {
      ws.onopen = cb;
    },
    onMessage: (cb: (data: string) => void) => {
      ws.onmessage = (event: unknown) => cb(String((event as { data: unknown }).data));
    },
    onClose: (cb: () => void) => {
      ws.onclose = cb;
    },
    onError: (cb: () => void) => {
      ws.onerror = cb;
    },
  };
}

export type { Unsubscribe, ApiMethod, ApiOutcome };

// ---- LAN 兼容别名（UI 调用面零改动——MIGRATION D8：全部 UI 屏经抽象消费）----

// 会话消息面的写入口与起点对齐在 session-align 定义——此处转出，调用方 import 不分裂
export { appendLocalRow, rebaselineSession as resyncSessionStore } from '../state/session-align';
export { attachThread, hydrateThread, openSessionAndAttach, reviveThread } from './session-lifecycle';

export const initializeBridge = initializeRelayRuntime;
export const getBridge = getRelayRuntime;
export { useRelayStatus as useBridgeStatus };
