import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * bw CLI 桥（T61 §2 S5 确认门，UX 层非安全边界）：pending 确认直接读文件系统
 * （BW_HOME/.bw/session/<sid>/pending/<cid>.json——bw 落盘真相），confirm 代跑走
 * CLI（会话文件锁由 bw 自己管）。会话目录与 Agent worker 共享同一 BW_HOME。
 */

export type PendingConfirm = {
  sid: string;
  cid: string;
  reason: string;
  originHost?: string;
  createdAt: number;
};

export type BwSessionRow = {
  sessionId: string;
  url: string;
  alive: boolean;
};

export type BwBridgeDeps = {
  /** bw 可执行文件路径（装配注入：PATH 解析或 bunx）。 */
  bwPath: string;
  /** BW_HOME（与 spawn-env 注入 worker 的同一目录）。 */
  bwHome: string;
  /** 运行超时（默认 8s）。 */
  timeoutMs?: number;
};

export function createBwBridge(deps: BwBridgeDeps) {
  const env = () => ({ ...process.env, BW_HOME: deps.bwHome });

  function run(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(deps.bwPath, args, { env: env(), timeout: deps.timeoutMs ?? 8000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ ok: error === null, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }

  /** 枚举会话（bw s list）。失败返回空数组（降级：无通知）。 */
  async function listSessions(): Promise<BwSessionRow[]> {
    const result = await run(['s', 'list']);
    if (!result.ok) return [];
    try {
      const parsed = JSON.parse(result.stdout) as { sessions?: BwSessionRow[] };
      return Array.isArray(parsed.sessions) ? parsed.sessions : [];
    } catch {
      return [];
    }
  }

  /** 代跑确认（bw s confirm <sid> <cid> --yes/--no）。 */
  async function confirm(sid: string, cid: string, approve: boolean): Promise<boolean> {
    const result = await run(['s', 'confirm', sid, cid, approve ? '--yes' : '--no']);
    return result.ok;
  }

  /** BW_HOME 就绪探测（目录存在 = 会话文件可落）。 */
  function homeReady(): boolean {
    return existsSync(deps.bwHome);
  }

  /** 会话 URL ↔ tab URL 对齐（同源同路径视为同 tab 的粗匹配）。 */
  function matchSessionByTab(sessions: readonly BwSessionRow[], tabUrl: string): BwSessionRow | null {
    return sessions.find((s) => normalizeUrlKey(s.url) === normalizeUrlKey(tabUrl)) ?? null;
  }

  /** 枚举 pending 确认（文件系统真相；bw 120s 超时自动清除）。 */
  function listPendingConfirms(): PendingConfirm[] {
    const sessionsRoot = join(deps.bwHome, '.bw', 'session');
    if (!existsSync(sessionsRoot)) return [];
    const out: PendingConfirm[] = [];
    for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pendingDir = join(sessionsRoot, entry.name, 'pending');
      if (!existsSync(pendingDir)) continue;
      for (const file of readdirSync(pendingDir)) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = JSON.parse(readFileSync(join(pendingDir, file), 'utf8')) as Record<string, unknown>;
          const cid = typeof raw['cid'] === 'string' ? raw['cid'] : '';
          const reason = typeof raw['reason'] === 'string' ? raw['reason'] : '';
          if (cid.length === 0) continue;
          out.push({
            sid: entry.name,
            cid,
            reason,
            ...(typeof raw['originHost'] === 'string' ? { originHost: raw['originHost'] } : {}),
            createdAt: typeof raw['createdAt'] === 'number' ? raw['createdAt'] : 0,
          });
        } catch {
          // 损坏/敌意 JSON：跳过（垃圾输入降级）
        }
      }
    }
    return out;
  }

  /** 调试数据面（bw s console/errors/requests/perf）：按会话拉取。失败返回 null（降级空 drawer）。 */
  async function debugQuery(sid: string, source: 'console' | 'errors' | 'requests' | 'perf'): Promise<unknown> {
    const result = await run(['s', source, sid]);
    if (!result.ok) return null;
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      return null;
    }
  }

  return { listSessions, confirm, homeReady, matchSessionByTab, listPendingConfirms, debugQuery };
}

function normalizeUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/** BW_HOME 默认路径（userData/browser-bw-home；与 spawn-env 注入保持同一常量）。 */
export function defaultBwHome(userDataDir: string): string {
  return join(userDataDir, 'browser-bw-home');
}
