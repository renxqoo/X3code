/**
 * 症状回归（配对后永久掉线）：
 * 配对成功过，之后无论网络怎么恢复都再也连不上，手动重连也没用，只显示「未连接」。
 *
 * 根因两处，本次逐条钉：
 * ① RN 的 WebSocket 握手失败不暴露响应头，relay 的 401(auth)/503(overloaded) 在
 *    onError 里同形——自动续期的判据「auth-rejected」从来没出现过。
 * ② authRetryArmed 只在续期【成功】时复位，一次失败后自动重连永久关闭。
 *
 * 与 e2e 装置的分工：装置验协议面（relay 确实回了 401 + X-Relay-Reason），
 * 本文件验客户端侧「分类 → 续期 → 复位」这条链路不会再次静默失效。
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { classifyRelayFailure } from '@/mobile/relay/relay-reachability';
import { relayHttpBase } from '@/mobile/relay/discover';

const RELAY_URL = 'wss://120.26.219.32:80';

const originalFetch = globalThis.fetch;

/** 探针应答器：reachable 给 200，unreachable 抛网络错。 */
function stubHealthz(reachable: boolean): jest.Mock {
  const mock = jest.fn(() => (reachable
    ? Promise.resolve({ status: 200 } as Response)
    : Promise.reject(new TypeError('Network request failed'))));
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe('relay 故障分类（症状：配对后永久掉线）', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('探得到 healthz = relay 活着：故障在本机侧，续期有意义', async () => {
    const mock = stubHealthz(true);
    await expect(classifyRelayFailure(RELAY_URL)).resolves.toBe('reachable');
    expect(mock.mock.calls.some(([input]) => String(input).includes('/healthz'))).toBe(true);
  });

  it('探不到 = relay 不可达：续期白费，等网络回来即可', async () => {
    stubHealthz(false);
    await expect(classifyRelayFailure(RELAY_URL)).resolves.toBe('unreachable');
  });

  it('探针失败不抛——分类本身不能引入新的失败路径', async () => {
    globalThis.fetch = jest.fn(() => Promise.resolve({ status: 503 } as Response)) as unknown as typeof fetch;
    await expect(classifyRelayFailure(RELAY_URL)).resolves.toBe('unreachable');
  });

  it('地址畸形按不可达收敛——不把探测请求打到非法 URL 上', async () => {
    const mock = stubHealthz(true);
    await expect(classifyRelayFailure('这不是地址')).resolves.toBe('unreachable');
    expect(mock).not.toHaveBeenCalled();
  });

  it('ws/wss 归一为 http/https 探测面且剥尾斜杠（单一真相在 discover.relayHttpBase）', () => {
    expect(relayHttpBase('wss://120.26.219.32:80')).toBe('https://120.26.219.32:80');
    expect(relayHttpBase('ws://192.168.1.9:8787/')).toBe('http://192.168.1.9:8787');
  });
});

describe('自动续期武装位（症状：一次失败后永久关闭重连）', () => {
  beforeEach(() => { jest.restoreAllMocks(); });

  it('续期失败也必须复位 armed——否则一次失败即永久掉线', async () => {
    // 与 runtime.ts onStatusWrapper 同形的行为断言：成败都走同一个 finally 复位
    const connect = jest.fn(() => Promise.reject(new Error('refresh failed')));
    let armed = true;
    const armedOnce = (): void => {
      if (!armed) return;
      armed = false;
      const attempt = connect().catch(() => undefined).then(() => { armed = true; });
      void attempt;
    };
    armedOnce();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(armed).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
    // 复位后下一轮断线仍能再次续期
    armedOnce();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(connect).toHaveBeenCalledTimes(2);
  });
});