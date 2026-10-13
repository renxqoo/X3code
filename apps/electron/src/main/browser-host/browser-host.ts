import { execSync } from 'node:child_process';

import type { BrowserEvent, BrowserHostPhase } from '@x3code/contracts';

import { createBwBridge, defaultBwHome } from './bw-bridge';
import { createCdpClient } from './cdp-client';
import { createChromeSupervisor, type SupervisorState } from './chrome-supervisor';

/**
 * browser-host 装配根（T61 §2）：supervisor + cdp-client 组合、懒启动（首个
 * browser/* invoke 才 spawn Chrome）、事件出口（装配层接 x3code:browser-event
 * IPC 推送）、env 注入面（X3CODE_BROWSER_CDP / BW_HOME 值的唯一真相）。
 */

export type BrowserHostDeps = {
  /** userData 目录（browser-host.json 与 browser-profile 的宿主）。 */
  userDataDir: string;
  /** Chrome 二进制发现（D7 序：设置覆盖 > BUN_CHROME_PATH > 标准探测；null = 引导态）。 */
  chromePath: string | null;
  /** 事件出口（IPC 推送）。 */
  onEvent: (event: BrowserEvent) => void;
  /** 诊断日志。 */
  log?: (message: string) => void;
  /** 心跳参数（测试注入；缺省 2s × 3）。 */
  heartbeatMs?: number;
  heartbeatFailLimit?: number;
  /** bw 可执行路径（确认门桥接；null/缺席 = 不桥接，通知链降级）。 */
  bwPath?: string | null;
};

/** 当前 CDP 端点（env 注入与 attach 复制条共用；Chrome 未启动时为已定格端口）。 */
export function browserCdpEndpoint(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function createBrowserHost(deps: BrowserHostDeps) {
  let supervisor: ReturnType<typeof createChromeSupervisor> | null = null;
  let client: ReturnType<typeof createCdpClient> | null = null;
  let phase: BrowserHostPhase = 'starting';
  let port = 0;
  let started = false;
  let starting: Promise<void> | null = null;
  let confirmPollTimer: ReturnType<typeof setInterval> | null = null;
  const notifiedCids = new Set<string>();
  const bwBridge = deps.bwPath !== undefined && deps.bwPath !== null
    ? createBwBridge({ bwPath: deps.bwPath, bwHome: defaultBwHome(deps.userDataDir) })
    : null;

  /** 确认门通知链：pending 文件枚举 → confirmNotice 事件（每 cid 恰一次；
   *  bw 侧 120s 超时自清，面板同样 120s 后不再显示）。 */
  function startConfirmPolling(): void {
    if (bwBridge === null || confirmPollTimer !== null) return;
    confirmPollTimer = setInterval(() => {
      for (const pending of bwBridge.listPendingConfirms()) {
        if (notifiedCids.has(pending.cid)) continue;
        notifiedCids.add(pending.cid);
        deps.onEvent({ type: 'confirmNotice', sid: pending.sid, cid: pending.cid, reason: pending.reason });
      }
      if (notifiedCids.size > 200) {
        for (const key of [...notifiedCids].slice(0, notifiedCids.size - 200)) notifiedCids.delete(key);
      }
    }, 2000);
    confirmPollTimer.unref();
  }

  function pushHostState(next: BrowserHostPhase, detail?: string): void {
    phase = next;
    deps.onEvent({ type: 'hostState', phase: next, ...(detail !== undefined ? { detail } : {}) });
  }

  /** 懒启动：首个 browser/* 调用触发；幂等（并发调用合并到同一次启动）。 */
  async function ensureStarted(): Promise<void> {
    if (started && client !== null) return;
    if (starting !== null) return starting;
    starting = (async () => {
      supervisor = createChromeSupervisor({
        userDataDir: deps.userDataDir,
        chromePath: deps.chromePath,
        ...(deps.heartbeatMs !== undefined ? { heartbeatMs: deps.heartbeatMs } : {}),
        ...(deps.heartbeatFailLimit !== undefined ? { heartbeatFailLimit: deps.heartbeatFailLimit } : {}),
        pingCdp: async () => {
          if (client === null) return false;
          try {
            await client.connect();
            return true;
          } catch {
            return false;
          }
        },
        probeHttp: async (targetPort) => {
          try {
            const response = await fetch(`http://127.0.0.1:${targetPort}/json/version`, { signal: AbortSignal.timeout(2000) });
            return response.ok;
          } catch {
            return false;
          }
        },
        readCmdline: (pid) => {
          try {
            return execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8', timeout: 2000 }).trim();
          } catch {
            return null;
          }
        },
        onPhase: (state: SupervisorState) => {
          if (state.phase === 'ready') {
            port = state.port;
            void attachClient();
          } else if (state.phase === 'restarting') {
            client?.disconnect();
            client = null;
            pushHostState('restarting');
          } else if (state.phase === 'chromeMissing' || state.phase === 'failed') {
            port = state.port;
            pushHostState(state.phase);
          }
        },
        log: deps.log,
      });
      pushHostState('starting');
      await supervisor.start();
      started = true;
      startConfirmPolling();
    })();
    try {
      await starting;
    } finally {
      starting = null;
    }
    if (phase === 'chromeMissing' || phase === 'failed') {
      throw new Error(phase);
    }
  }

  async function attachClient(): Promise<void> {
    if (client !== null || supervisor === null || port === 0) return;
    const host = browserCdpEndpoint(port);
    try {
      const version = (await (await fetch(`${host}/json/version`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()))) as { webSocketDebuggerUrl?: string };
      if (version.webSocketDebuggerUrl === undefined) throw new Error('no browser ws');
      client = createCdpClient({ browserWsUrl: version.webSocketDebuggerUrl, onEvent: deps.onEvent, log: deps.log });
      await client.connect();
      deps.onEvent({ type: 'hostState', phase: 'ready', cdpEndpoint: browserCdpEndpoint(port) });
    } catch (error) {
      deps.log?.(`browser client attach failed: ${String(error)}`);
      // supervisor 心跳兜底：等下一轮 restarting
    }
  }

  function currentClient(): ReturnType<typeof createCdpClient> | null {
    return client;
  }

  function currentPhase(): BrowserHostPhase {
    return phase;
  }

  function currentPort(): number {
    return port;
  }

  /** 应用退出停机（will-quit 接线）。 */
  function stop(): void {
    if (confirmPollTimer !== null) {
      clearInterval(confirmPollTimer);
      confirmPollTimer = null;
    }
    client?.disconnect();
    client = null;
    supervisor?.stop();
    supervisor = null;
    started = false;
  }

  /** 调试数据面（browser/debugQuery 路由）：tab → bw 会话（URL 对齐）→ CLI。 */
  async function debugForTarget(targetId: string, source: string): Promise<unknown> {
    if (bwBridge === null) return null;
    const tab = client?.currentTabs().find((t) => t.targetId === targetId);
    if (tab === undefined) return null;
    const sessions = await bwBridge.listSessions();
    const matched = bwBridge.matchSessionByTab(sessions, tab.url);
    if (matched === null) return null;
    return bwBridge.debugQuery(matched.sessionId, source as 'console' | 'errors' | 'requests' | 'perf');
  }

  /** 确认门代跑（browser/confirm 路由）。 */
  async function confirmGate(sid: string, cid: string, approve: boolean): Promise<boolean> {
    if (bwBridge === null) return false;
    const ok = await bwBridge.confirm(sid, cid, approve);
    if (ok) notifiedCids.delete(cid);
    return ok;
  }

  return { ensureStarted, currentClient, currentPhase, currentPort, stop, confirmGate, debugForTarget };
}
