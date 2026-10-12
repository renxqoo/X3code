/**
 * relay 故障分类（连接失败后的第一步判断）。
 *
 * 症状：配对成功过，之后再也连不上，手动重连也无效——用户只看到「未连接」。
 * 根因：RN 的 WebSocket 在握手失败时**不暴露响应头**（WebSocket API 无此能力），
 * relay 侧其实已经把 401(auth)/503(overloaded) 区分得很清楚
 * （x-harness hub-relay main.ts 的 upgrade 面），但这些信息在客户端 onError
 * 第一跳就被抹平，两类故障同形，只能报 'closed'。
 *
 * 分类办法：/healthz 是免鉴权的存活面（relay 已提供），拿它当探针——
 * 探得到 = relay 活着，故障在本机侧（凭证被拒/过期，自动续期可能救回）；
 * 探不到 = relay 不可达（离线/地址错/防火墙），续期无意义，等网络回来。
 *
 * 不改 x-harness：服务端语义已完备，缺的是客户端这一次探测。
 */

import { relayHttpBase } from './discover';

export type RelayReachability = 'reachable' | 'unreachable';

const PROBE_TIMEOUT_MS = 3_000;

/**
 * 探测 relay 存活。**永不抛**：分类失败本身不能引入新的失败路径，
 * 拿不到结论时按「不可达」处理——保守侧是不会误导用户去反复重试。
 */
export async function classifyRelayFailure(relayUrl: string): Promise<RelayReachability> {
  const base = relayHttpBase(relayUrl);
  if (!/^https?:\/\/[^/]+$/.test(base)) return 'unreachable';
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/healthz`, { method: 'GET', signal: controller.signal });
    // 任何 HTTP 应答都说明 relay 的 HTTP 面在监听（鉴权面另说）
    return response.status < 500 ? 'reachable' : 'unreachable';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}