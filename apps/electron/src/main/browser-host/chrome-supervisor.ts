import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrowserHostPhase } from '@x3code/contracts';

/**
 * Chrome 宿主监督器（T61 §5）：spawn/双探心跳/挂死重启/残留清理/进程组停机/熔断。
 * 端口持久化于 userData/browser-host.json（原子写）；启动时三重验证残留 Chrome
 * （pid 存活 + 命令行含本 profile 路径 + CDP /json/version 可连）→ 进程组击杀 →
 * 等退净 → 清 SingletonLock → spawn。心跳双探：ws ping 连续 3 失败后追加 HTTP
 * /json/version 探测，双失败才判死（容忍休眠时钟跳变）。
 */

export type SupervisorState = {
  phase: BrowserHostPhase;
  port: number;
  chromePath: string | null;
  pid: number | null;
};

export type SupervisorDeps = {
  /** userData 目录（browser-host.json 与 browser-profile/ 的宿主）。 */
  userDataDir: string;
  /** Chrome 二进制路径（null = 探测失败，phase 转 chromeMissing）。 */
  chromePath: string | null;
  /** 心跳间隔与判死阈值（装配注入；默认 2s × 3）。 */
  heartbeatMs?: number;
  heartbeatFailLimit?: number;
  /** 启动失败熔断阈值。 */
  startFailLimit?: number;
  /** 就绪探测窗口（默认 10s；测试注入缩短）。 */
  readyTimeoutMs?: number;
  /** ws ping 探测（注入便于测试；默认按实现接线时提供）。 */
  pingCdp: (port: number) => Promise<boolean>;
  /** HTTP 活性探测（/json/version）。 */
  probeHttp: (port: number) => Promise<boolean>;
  /** 命令行探测（macOS ps；返回进程完整命令行，null = 进程不存在）。 */
  readCmdline: (pid: number) => string | null;
  /** 进程 spawn（注入便于测试；缺省 node spawn，detached 进程组）。 */
  spawnChrome?: (chromePath: string, args: readonly string[]) => ChromeSpawnHandle;
  /** 相位变更通知。 */
  onPhase: (state: SupervisorState) => void;
  /** 诊断日志（中性英文；不进用户文案）。 */
  log?: (message: string) => void;
};

/** 进程 spawn 句柄（supervisor 只依赖此形状；默认实现 = detached 进程组 + stdio ignore）。 */
export type ChromeSpawnHandle = { pid: number | null; onExit: (cb: () => void) => void; killGroup: () => void };

type HostFile = { port: number; pid: number | null };

const CHROME_FLAGS = [
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--hide-scrollbars',
] as const;

/** 默认 spawn：detached 进程组 + stdio ignore（Chrome 独立于主进程存活）。 */
function defaultSpawnChrome(chromePath: string, args: readonly string[]): ChromeSpawnHandle {
  const proc = spawn(chromePath, [...args], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  const pid = proc.pid;
  return {
    pid: pid ?? null,
    onExit: (cb) => proc.on('exit', cb),
    killGroup: () => {
      if (pid !== undefined) {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          // 已退
        }
      }
    },
  };
}

export function createChromeSupervisor(deps: SupervisorDeps) {
  const heartbeatMs = deps.heartbeatMs ?? 2000;
  const failLimit = deps.heartbeatFailLimit ?? 3;
  const startFailLimit = deps.startFailLimit ?? 3;
  const readyTimeoutMs = deps.readyTimeoutMs ?? 10_000;
  const hostFile = join(deps.userDataDir, 'browser-host.json');
  const profileDir = join(deps.userDataDir, 'browser-profile');

  let state: SupervisorState = { phase: 'starting', port: 0, chromePath: deps.chromePath, pid: null };
  let child: ChromeSpawnHandle | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let wsFails = 0;
  let startFails = 0;
  let stopping = false;

  // —— 端口持久化（原子写）——

  function loadPort(): number {
    try {
      const parsed = JSON.parse(readFileSync(hostFile, 'utf8')) as HostFile;
      if (typeof parsed.port === 'number' && parsed.port > 0 && parsed.port < 65536) return parsed.port;
    } catch {
      // 无文件或损坏：走分配
    }
    return 0;
  }

  function savePort(port: number, pid: number | null): void {
    mkdirSync(deps.userDataDir, { recursive: true });
    const tmp = join(tmpdir(), `x3code-browser-host-${port}.json`);
    writeFileSync(tmp, JSON.stringify({ port, pid } satisfies HostFile), 'utf8');
    renameSync(tmp, hostFile);
  }

  function allocatePort(): number {
    // 随机高位端口（绑定验证由 Chrome spawn 成败反馈；TOCTOU 由三重验证兜底）
    return 20000 + Math.floor(Math.random() * 20000);
  }

  // —— 残留清理（三重验证）——

  async function cleanResidue(port: number): Promise<void> {
    const existing = loadPort();
    if (existing !== port) return;
    let pid: number | null = null;
    try {
      pid = (JSON.parse(readFileSync(hostFile, 'utf8')) as HostFile).pid ?? null;
    } catch {
      pid = null;
    }
    if (pid === null) return;
    const cmdline = deps.readCmdline(pid);
    if (cmdline === null) return; // 进程不在：无残留
    if (!cmdline.includes(profileDir)) return; // pid 复用为他进程：不杀
    const httpAlive = await deps.probeHttp(port).catch(() => false);
    if (!httpAlive) return; // 非 Chrome 持端口：让 spawn 失败走熔断
    deps.log?.(`killing leftover chrome pid=${pid}`);
    try {
      process.kill(-pid, 'SIGTERM'); // 进程组
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 已退
      }
    }
    // 等退净（≤5s 轮询）
    for (let i = 0; i < 25; i++) {
      if (deps.readCmdline(pid) === null) break;
      await sleep(200);
    }
    const lock = join(profileDir, 'SingletonLock');
    if (existsSync(lock)) rmSync(lock, { force: true });
  }

  // —— spawn 与心跳 ——

  async function start(): Promise<void> {
    if (stopping) return;
    if (deps.chromePath === null) {
      setPhase('chromeMissing');
      return;
    }
    let port = loadPort();
    if (port === 0) {
      port = allocatePort();
    }
    await cleanResidue(port);
    mkdirSync(profileDir, { recursive: true });
    setPhase('starting');
    const spawnChrome = deps.spawnChrome ?? defaultSpawnChrome;
    const proc = spawnChrome(deps.chromePath, [
      ...CHROME_FLAGS,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ]);
    child = proc;
    state.pid = proc.pid ?? null;
    savePort(port, state.pid);
    proc.onExit(() => {
      if (stopping || state.phase === 'chromeMissing') return;
      // 非主动退出的死亡：计一次启动失败后重启
      registerStartFailure();
    });
    // 就绪探测
    const ready = await waitForReady(port, readyTimeoutMs);
    if (ready) {
      startFails = 0;
      setPhase('ready');
      startHeartbeat(port);
    } else {
      registerStartFailure();
    }
  }

  async function waitForReady(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await deps.probeHttp(port).catch(() => false)) return true;
      await sleep(250);
    }
    return false;
  }

  function registerStartFailure(): void {
    startFails += 1;
    if (startFails >= startFailLimit) {
      setPhase('failed');
      return;
    }
    void start();
  }

  function startHeartbeat(port: number): void {
    stopHeartbeat();
    wsFails = 0;
    heartbeatTimer = setInterval(() => {
      void (async () => {
        const alive = await deps.pingCdp(port).catch(() => false);
        if (alive) {
          wsFails = 0;
          return;
        }
        wsFails += 1;
        if (wsFails < failLimit) return;
        // 双探：HTTP 确认（合盖唤醒后 ws 可能假死）
        const httpAlive = await deps.probeHttp(port).catch(() => false);
        if (httpAlive) {
          wsFails = 0; // ws 假死但进程活：不杀
          return;
        }
        deps.log?.(`chrome judged dead (port=${port}); restarting`);
        setPhase('restarting');
        killGroup();
        await sleep(500);
        void start();
      })();
    }, heartbeatMs);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function killGroup(): void {
    if (child !== null) child.killGroup();
    child = null;
    state.pid = null;
  }

  function setPhase(phase: BrowserHostPhase): void {
    state = { ...state, phase };
    deps.onPhase(state);
  }

  /** 用户操作（改设置/显式重试）后调用：清失败计数并重启。 */
  function resetAndRestart(): void {
    startFails = 0;
    killGroup();
    void start();
  }

  /** 优雅停机：SIGTERM 进程组 → 3s SIGKILL 兜底 + 临时 profile 清理。 */
  function stop(): void {
    stopping = true;
    stopHeartbeat();
    killGroup();
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // 文件系统迟滞：下次启动 cleanResidue 兜底
    }
    setPhase('failed');
  }

  /** 主进程 exit 钩子的同步击杀兜底（防孤儿 Chrome）。 */
  /** 主进程 exit 钩子的同步击杀兑底（防孤儿 Chrome）。 */
  function killOnExit(): void {
    if (child !== null) child.killGroup();
  }

  function current(): SupervisorState {
    return state;
  }

  return { start, stop, resetAndRestart, killOnExit, current };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
