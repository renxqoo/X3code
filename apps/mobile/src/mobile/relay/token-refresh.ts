/**
 * 设备 token 换发：relay POST /api/device-token/refresh——
 * 设备长期钥签名挑战应答（无需持有未过期 token；签名即所有权证明）。
 * 15min TTL 到期后的可持续续期。返回换发结果（新 token + relay 节点 id，
 * 节点 id 随本次应答落盘，下次续期免一次探测往返）；失败返回 null（调用方回落旧 token）。
 */
import { signBytes } from '@x3code/relay-protocol';
import { relayHttpOrigin } from './discover';
import type { RelayCredentials } from './credentials';

export interface RefreshedToken {
  token: string;
  relayNodeId: string | null;
}

export async function refreshDeviceToken(credentials: RelayCredentials): Promise<RefreshedToken | null> {
  // URL 构造避免可变 API（RN URL polyfill pathname 只读——赋值抛 TypeError）
  const base = relayHttpOrigin(credentials.relayUrl).replace(/\/$/, '');
  const nonce = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  // nodeId 未知（relay 集群）——先用注册时缓存的；无缓存时经 /api/node-key 探测
  let nodeId = credentials.relayNodeId ?? '';
  if (nodeId.length === 0) {
    try {
      const res = await fetch(`${base}/api/node-key`);
      if (res.ok) {
        const data = (await res.json()) as { nodeId?: string };
        nodeId = typeof data.nodeId === 'string' ? data.nodeId : '';
      }
    } catch {
      return null;
    }
  }
  const transcript = `device-refresh|${credentials.deviceId}|${nodeId}|${nonce}`;
  const sig = signBytes(credentials.signingSecret, new TextEncoder().encode(transcript));
  try {
    const res = await fetch(`${base}/api/device-token/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: credentials.deviceId, nonce, sig }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { token?: string; nodeId?: string };
    if (typeof data.token !== 'string') return null;
    const fresh = typeof data.nodeId === 'string' && data.nodeId.length > 0 ? data.nodeId : nodeId;
    return { token: data.token, relayNodeId: fresh.length > 0 ? fresh : null };
  } catch {
    return null;
  }
}
