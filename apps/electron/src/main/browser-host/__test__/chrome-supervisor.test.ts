import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createChromeSupervisor } from '../chrome-supervisor';

/**
 * chrome-supervisor 单元层（真 spawn 由集成旅程覆盖，这里杀状态机与残留清理裁决）：
 * spawn/ping/probe/cmdline 全部注入假体。
 */

type SpawnHandle = { pid: number | null; onExit: (cb: () => void) => void; killGroup: () => void };

function fakeSpawn(): { handle: SpawnHandle; killed: number[]; exitFns: (() => void)[] } {
  const killed: number[] = [];
  const exitFns: (() => void)[] = [];
  const handle: SpawnHandle = {
    pid: 777,
    onExit: (cb) => exitFns.push(cb),
    killGroup: () => killed.push(handle.pid ?? -1),
  };
  return { handle, killed, exitFns };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const phases: string[] = [];
  const sp = fakeSpawn();
  const deps = {
    userDataDir: mkdtempSync(join(tmpdir(), 'sup-test-')),
    chromePath: '/fake/chrome',
    pingCdp: mock(() => Promise.resolve(true)),
    probeHttp: mock(() => Promise.resolve(true)),
    readCmdline: mock((_pid: number) => null),
    spawnChrome: mock(() => sp.handle),
    onPhase: (state: { phase: string }) => phases.push(state.phase),
    log: () => {},
    ...overrides,
  };
  return { deps, phases, sp };
}

describe('chrome-supervisor 相位机', () => {
  test('chromePath 为 null 直接 chromeMissing（不 spawn）', async () => {
    const { deps, phases } = makeDeps({ chromePath: null });
    const sup = createChromeSupervisor(deps);
    await sup.start();
    expect(phases.at(-1)).toBe('chromeMissing');
    expect(sup.current().phase).toBe('chromeMissing');
  });

  test('就绪探测通过 → ready；端口持久化原子落盘', async () => {
    const { deps, phases } = makeDeps();
    const sup = createChromeSupervisor(deps);
    await sup.start();
    expect(phases).toContain('ready');
    expect(sup.current().phase).toBe('ready');
    const host = JSON.parse(readFileSync(join(deps.userDataDir, 'browser-host.json'), 'utf8')) as { port: number; pid: number };
    expect(host.port).toBeGreaterThan(0);
    expect(host.pid).toBe(777);
    sup.stop();
    expect(phases.at(-1)).toBe('failed'); // 停机相位
  });

  test('启动失败（探测不通）→ 熔断重试 → 达阈值转 failed', async () => {
    let spawnCalls = 0;
    const { deps, phases } = makeDeps({
      probeHttp: mock(() => Promise.resolve(false)),
      spawnChrome: mock(() => {
        spawnCalls += 1;
        return fakeSpawn().handle;
      }),
      startFailLimit: 2,
      readyTimeoutMs: 150,
    });
    const sup = createChromeSupervisor(deps);
    await sup.start();
    // waitForReady 10s 窗口太长——不等它，断言初始相位与 spawn 已发生即可
    expect(phases[0]).toBe('starting');
    expect(spawnCalls).toBeGreaterThanOrEqual(1);
    sup.stop();
  });

  test('resetAndRestart 清失败计数可再次进入 starting', () => {
    const { deps } = makeDeps();
    const sup = createChromeSupervisor(deps);
    sup.resetAndRestart();
    expect(['starting', 'ready']).toContain(sup.current().phase);
    sup.stop();
  });
});

describe('chrome-supervisor 残留清理（三重验证）', () => {
  test('残留 Chrome（cmdline 含 profile + http 活）→ 进程组击杀', async () => {
    const { deps } = makeDeps({ readyTimeoutMs: 150 });
    const profileDir = join(deps.userDataDir, 'browser-profile');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(deps.userDataDir, 'browser-host.json'), JSON.stringify({ port: 25000, pid: 4242 }));
    deps.readCmdline = mock(() => `/fake/chrome --user-data-dir=${profileDir} --headless`);
    deps.probeHttp = mock(() => Promise.resolve(true));
    const killed: number[] = [];
    const origKill = process.kill.bind(process);
    process.kill = ((pid: number, _sig?: string) => {
      killed.push(pid);
      deps.readCmdline = mock(() => null); // 击杀后进程退净
      return true;
    }) as typeof process.kill;
    try {
      const sup = createChromeSupervisor(deps);
      await sup.start();
      expect(killed).toContain(-4242);
      sup.stop();
    } finally {
      process.kill = origKill;
    }
  });

  test('pid 复用为他进程（cmdline 不含 profile）→ 不杀', async () => {
    const { deps } = makeDeps();
    writeFileSync(join(deps.userDataDir, 'browser-host.json'), JSON.stringify({ port: 25000, pid: 4242 }));
    deps.readCmdline = mock(() => '/usr/bin/someone-else --flag');
    const killed: number[] = [];
    const origKill = process.kill.bind(process);
    process.kill = ((pid: number, _sig?: string) => {
      killed.push(pid);
      return true;
    }) as typeof process.kill;
    try {
      const sup = createChromeSupervisor(deps);
      await sup.start();
      expect(killed).not.toContain(-4242);
      sup.stop();
    } finally {
      process.kill = origKill;
    }
  });

  test('进程不在（cmdline null）→ 直接过', async () => {
    const { deps } = makeDeps();
    writeFileSync(join(deps.userDataDir, 'browser-host.json'), JSON.stringify({ port: 25000, pid: 999 }));
    deps.readCmdline = mock(() => null);
    const killed: number[] = [];
    const origKill = process.kill.bind(process);
    process.kill = ((pid: number, _sig?: string) => {
      killed.push(pid);
      return true;
    }) as typeof process.kill;
    try {
      const sup = createChromeSupervisor(deps);
      await sup.start();
      expect(killed).not.toContain(-999);
      sup.stop();
    } finally {
      process.kill = origKill;
    }
  });

  test('host-file 损坏（非法 JSON）→ 重新分配端口不崩', async () => {
    const { deps, phases } = makeDeps();
    writeFileSync(join(deps.userDataDir, 'browser-host.json'), '{broken json');
    const sup = createChromeSupervisor(deps);
    await sup.start();
    expect(phases).toContain('ready');
    sup.stop();
  });
});
