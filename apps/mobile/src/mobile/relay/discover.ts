/**
 * 6 位配对码网关发现：探测候选源的 relay /api/discover?code=xxxxxx。
 * 候选源（任一命中即返回）：用户手输的 relay 地址（外部 relay 首次配对的唯一入口——
 * 见 manualRelayOrigin）、配对学到的 relay 地址（外部 relay 形态——PC 配置经
 * 配对下发，手机零配置）、dev 形态的 Metro 宿主（真机即 Mac LAN IP）、web 预览宿主、
 * loopback。命中即返回 {relayUrl, installationId, gatewayKeyFingerprint, pairingId}。
 */
import { Platform } from 'react-native';
import Constants from 'expo-constants';

import { relayCredentialsStore } from './credentials';

export interface DiscoveredGateway {
  relayUrl: string;
  installationId: string;
  gatewayKeyFingerprint: string;
  pairingId: string;
  pairingTicket: string;
}

export const DISCOVER_PORT = 8787;

/** relay 基址的 ws/wss → http/https 归一（单一真相：探测面与 token 续期面共用同一事实）。
 *  逐字对应而非 /^ws/ 前缀截断——后者把 wss 变成 httpss（非法 scheme，fetch 拒载，
 *  wss relay 的发现与续期会静默全失）。 */
export function relayHttpOrigin(relayUrl: string): string {
  return relayUrl.replace(/^wss/, 'https').replace(/^ws/, 'http');
}

/** 同上并剥掉尾斜杠（拼绝对 URL 时避免双斜杠）。单一真相仍在本文件的 relayHttpOrigin。 */
export function relayHttpBase(relayUrl: string): string {
  return relayHttpOrigin(relayUrl).replace(/\/$/, '');
}

/** 候选 relay 地址 → http(s) origin（原端口保留）。非候选形态（空/畸形）返回 null
 *  ——空串会探到当前页面 origin，污染候选。ws 探明文面，wss 探 TLS 面。 */
function originOf(relayUrl: string): string | null {
  if (relayUrl.length === 0) return null;
  try {
    const origin = new URL(relayHttpOrigin(relayUrl)).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** 用户手输的 relay 地址候选（外部 relay 首次配对的唯一入口）。
 *  首配时凭据为空，无从得知公网 relay 在哪——手输码路径必须让用户显式给出，
 *  否则四个自动候选（凭据/页面/Metro/loopback）无一命中公网 relay，配对必失败。 */
export function manualRelayOrigin(raw: string): string | null {
  return originOf(raw.trim());
}

/** 外部 relay 候选 origin（配对学到的 relayUrl——非秘密，已随配对落盘）。 */
function pairedRelayOrigin(): string | null {
  return originOf(relayCredentialsStore.load()?.relayUrl ?? '');
}

/** host 形态（hostUri/debuggerHost 可能带端口后缀）：仅 IPv4/主机名，剥掉端口与路径。 */
function hostOf(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.includes('/')) return null;
  const bare = trimmed.split(':')[0] ?? '';
  if (bare.length === 0) return null;
  return bare;
}

/** dev 形态宿主（真机走 Metro 加载——Metro 所在机即桌面端所在机）。 */
export function devHosts(): string[] {
  if (Platform.OS === 'web') return [];
  const out: string[] = [];
  const expoConfigHost = Constants.expoConfig?.hostUri;
  if (typeof expoConfigHost === 'string') {
    const host = hostOf(expoConfigHost);
    if (host !== null) out.push(host);
  }
  const debuggerHost = Constants.expoGoConfig?.debuggerHost;
  if (typeof debuggerHost === 'string') {
    const host = hostOf(debuggerHost);
    if (host !== null) out.push(host);
  }
  return [...new Set(out)];
}

function candidates(manualOrigin: string | null): string[] {
  const out: string[] = [];
  if (manualOrigin !== null) out.push(manualOrigin);
  const pairedOrigin = pairedRelayOrigin();
  if (pairedOrigin !== null) out.push(pairedOrigin);
  if (typeof window === 'object' && window !== null && typeof window.location === 'object' && window.location !== null) {
    const host = window.location.hostname;
    if (typeof host === 'string' && host.length > 0) out.push(host);
  }
  out.push(...devHosts());
  out.push('127.0.0.1');
  return [...new Set(out)];
}

async function probe(origin: string, code: string, timeoutMs: number): Promise<DiscoveredGateway | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${origin}/api/discover?code=${encodeURIComponent(code)}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<DiscoveredGateway>;
    if (
      typeof data.relayUrl === 'string' && data.relayUrl.length > 0 &&
      typeof data.installationId === 'string' && data.installationId.length > 0 &&
      typeof data.gatewayKeyFingerprint === 'string' && data.gatewayKeyFingerprint.length > 0 &&
      typeof data.pairingId === 'string' && data.pairingId.length > 0
    ) {
      return { relayUrl: data.relayUrl, installationId: data.installationId, gatewayKeyFingerprint: data.gatewayKeyFingerprint, pairingId: data.pairingId, pairingTicket: typeof data.pairingTicket === 'string' ? data.pairingTicket : '' };
    }
    return null;
  } catch {
    return null;
  }
}

/** 按码发现网关（并发探测全部候选，任一命中即返回）。
 *  候选 origin 形态二分：外部 relay 候选已是完整 origin（带协议端口，外部 relay
 *  不占 8787）；其余是裸 host，拼 DISCOVER_PORT。
 *  manualRelayUrl 走 manualRelayOrigin 归一（ws/wss → http(s) 并筛除畸形）——
 *  原始串直入会绕掉归一，探出 wss:// 这类 fetch 拒载的 URL 且无提示地全候选失联。 */
export async function discoverGateway(code: string, manualRelayUrl?: string): Promise<DiscoveredGateway | null> {
  const digits = code.replace(/[^0-9]/g, '');
  if (digits.length !== 6) return null;
  const hosts = candidates(manualRelayUrl === undefined ? null : manualRelayOrigin(manualRelayUrl));
  const probes = hosts.map((host) => probe(host.includes('://') ? host : `http://${host}:${DISCOVER_PORT}`, digits, 2_500));
  return (await Promise.all(probes)).find((hit) => hit !== null) ?? null;
}
