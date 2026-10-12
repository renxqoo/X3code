/**
 * 症状：真机（Expo Go / dev build）输入正确 6 位码报「未找到配对码」。
 * 根因：候选主机只有 window.location.hostname（原生无 window.location）与 127.0.0.1
 * （手机自身）——探测请求根本到不了桌面端。dev 形态必须补 Metro 宿主
 * （Constants.expoConfig.hostUri / expoGoConfig.debuggerHost——真机即 Mac LAN IP）。
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Constants from 'expo-constants';

import { relayCredentialsStore } from '../credentials';
import { devHosts, discoverGateway, manualRelayOrigin, relayHttpOrigin, DISCOVER_PORT } from '../discover';

function installFetch(respond: (url: string) => { ok: boolean; json: () => Promise<unknown> } | null): jest.Mock {
  const mock = jest.fn((input: string | URL | Request) => {
    const reply = respond(input instanceof Request ? input.url : String(input));
    if (reply === null) return Promise.reject(new Error('network unreachable'));
    return Promise.resolve(reply as unknown as Response);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

const gatewayHit = (): { ok: boolean; json: () => Promise<unknown> } => ({
  ok: true,
  json: () => Promise.resolve({ relayUrl: 'ws://lan-host:8787', installationId: 'i1', gatewayKeyFingerprint: 'g1', pairingId: 'p1', pairingTicket: 't1' }),
});

describe('dev 形态候选主机（症状：真机 6 位码必失败）', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    (Constants as { expoConfig: unknown }).expoConfig = null;
    (Constants as { expoGoConfig: unknown }).expoGoConfig = null;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('Expo Go 真机：expoGoConfig.debuggerHost（host:port）成为候选——探测可达桌面 LAN IP', async () => {
    (Constants as { expoGoConfig: unknown }).expoGoConfig = { debuggerHost: '192.168.31.98:8081' };
    expect(devHosts()).toEqual(['192.168.31.98']);
    const mock = installFetch((url) => (url.includes('192.168.31.98') ? gatewayHit() : null));
    const hit = await discoverGateway('123456');
    expect(hit?.pairingId).toBe('p1');
    expect(mock.mock.calls.some(([input]) => String(input).includes(`http://192.168.31.98:${DISCOVER_PORT}/api/discover?code=123456`))).toBe(true);
  });

  it('dev build：expoConfig.hostUri 成为候选（无 debuggerHost 形态）', async () => {
    (Constants as { expoConfig: unknown }).expoConfig = { hostUri: '10.0.0.5:8081' };
    expect(devHosts()).toEqual(['10.0.0.5']);
    installFetch((url) => (url.includes('10.0.0.5') ? gatewayHit() : null));
    const hit = await discoverGateway('654321');
    expect(hit?.installationId).toBe('i1');
  });

  it('hostUri 与 debuggerHost 重复时去重；空串/带路径的畸形值被丢弃', () => {
    (Constants as { expoConfig: unknown }).expoConfig = { hostUri: '192.168.1.10:8081' };
    (Constants as { expoGoConfig: unknown }).expoGoConfig = { debuggerHost: '192.168.1.10:8081' };
    expect(devHosts()).toEqual(['192.168.1.10']);
    (Constants as { expoConfig: unknown }).expoConfig = { hostUri: '  ' };
    (Constants as { expoGoConfig: unknown }).expoGoConfig = { debuggerHost: 'http://x/y' };
    expect(devHosts()).toEqual([]);
  });

  it('打包形态（无 dev 宿主）：全部候选失联时诚实返回 null——报「未找到配对码」', async () => {
    installFetch(() => null);
    await expect(discoverGateway('999999')).resolves.toBeNull();
  });
});

/**
 * 症状：外部 relay 形态（PC 配 wss 公网中继）下 4G 输正确 6 位码报「未找到配对码」。
 * 根因：候选只有 LAN/Metro 宿主，手机不知道公网 relay 在哪。已配对过的手机
 * 凭据里有 PC 下发的 relayUrl——它就是发现候选（零配置，非手输）。
 */
describe('配对学到的 relay 地址成为发现候选（症状：外部 relay 下 6 位码必失败）', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    (Constants as { expoConfig: unknown }).expoConfig = null;
    (Constants as { expoGoConfig: unknown }).expoGoConfig = null;
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await relayCredentialsStore.clear();
    jest.restoreAllMocks();
  });

  it('已配对手机（凭据带外部 relayUrl）在无任何 LAN 候选时也能命中——探测打到 relay origin（端口保留）', async () => {
    await relayCredentialsStore.save({
      deviceId: 'd1',
      signingSecret: 's',
      signingPub: 'p',
      sharedSecretHex: 'x',
      installationId: 'i1',
      relayUrl: 'wss://120.26.219.32:80',
      relayToken: 't',
    });
    const mock = installFetch((url) => (url.includes('120.26.219.32:80/api/discover') ? gatewayHit() : null));
    const hit = await discoverGateway('246813');
    expect(hit?.pairingId).toBe('p1');
    expect(mock.mock.calls.some(([input]) => String(input).includes('https://120.26.219.32:80/api/discover?code=246813'))).toBe(true);
  });

  it('未配对（无凭据）不产生 relay 候选——不探到页面 origin，LAN 候选照旧', async () => {
    const mock = installFetch((url) => (url.includes('127.0.0.1') ? gatewayHit() : null));
    const hit = await discoverGateway('135790');
    expect(hit?.pairingId).toBe('p1');
    expect(mock.mock.calls.every(([input]) => !String(input).includes('undefined'))).toBe(true);
  });

  it('凭据 relayUrl 畸形（非 ws 形态）不进候选不抛——其余候选照常探测', async () => {
    await relayCredentialsStore.save({
      deviceId: 'd1', signingSecret: 's', signingPub: 'p', sharedSecretHex: 'x',
      installationId: 'i1', relayUrl: 'not a url', relayToken: 't',
    });
    installFetch((url) => (url.includes('127.0.0.1') ? gatewayHit() : null));
    await expect(discoverGateway('112233')).resolves.not.toBeNull();
  });
});

/**
 * 症状：外部 relay 首次配对（真机打包形态、无凭据）输正确 6 位码必报「未找到配对码」。
 * 根因：候选源只有凭据/页面/Metro/loopback——首配时凭据为空、原生无 window、非 dev
 * 形态无 Metro 宿主、loopback 是手机自身，四者无一命中公网 relay。而 relay 地址只能
 * 经配对写进凭据，配对又需先知 relay 地址——鸡生蛋死锁。手输 relay 地址是唯一出口。
 */
describe('手输 relay 地址成为发现候选（症状：外部 relay 首配必失败）', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    (Constants as { expoConfig: unknown }).expoConfig = null;
    (Constants as { expoGoConfig: unknown }).expoGoConfig = null;
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await relayCredentialsStore.clear();
    jest.restoreAllMocks();
  });

  it('无任何自动候选时，手输 relay 地址成为唯一命中源——首配不再死锁', async () => {
    await relayCredentialsStore.clear();
    const mock = installFetch((url) => (url.includes('120.26.219.32:80/api/discover') ? gatewayHit() : null));
    const hit = await discoverGateway('654321', 'wss://120.26.219.32:80');
    expect(hit?.pairingId).toBe('p1');
    expect(mock.mock.calls.some(([input]) => String(input).includes('https://120.26.219.32:80/api/discover?code=654321'))).toBe(true);
  });

  it('手输址归一为 http(s) origin：ws/wss 皆探 https 面且端口保留', () => {
    expect(manualRelayOrigin('  wss://120.26.219.32:80 ')).toBe('https://120.26.219.32:80');
    expect(manualRelayOrigin('ws://192.168.1.9:8787')).toBe('http://192.168.1.9:8787');
  });

  it('手输址畸形/空串不进候选不抛——自动候选照常探测', async () => {
    expect(manualRelayOrigin('')).toBeNull();
    expect(manualRelayOrigin('   ')).toBeNull();
    expect(manualRelayOrigin('not a url')).toBeNull();
    const mock = installFetch((url) => (url.includes('127.0.0.1') ? gatewayHit() : null));
    await expect(discoverGateway('112233', 'not a url')).resolves.not.toBeNull();
    expect(mock.mock.calls.every(([input]) => !String(input).includes('undefined'))).toBe(true);
  });

  it('手输地址与凭据地址同源时去重——同 origin 只探一次', async () => {
    await relayCredentialsStore.save({
      deviceId: 'd1', signingSecret: 's', signingPub: 'p', sharedSecretHex: 'x',
      installationId: 'i1', relayUrl: 'wss://relay.test:80', relayToken: 't',
    });
    const mock = installFetch(() => gatewayHit());
    await discoverGateway('314159', 'wss://relay.test:80');
    const probes = mock.mock.calls.filter(([input]) => String(input).includes('relay.test:80/api/discover'));
    expect(probes.length).toBe(1);
    expect(String(probes[0]?.[0])).toBe('https://relay.test:80/api/discover?code=314159');
  });
});

/**
 * 症状：wss relay（https 公网中继）的手输码配对与 token 续期静默全失。
 * 根因：ws→http 归一用 /^ws/ 前缀截断，wss 变成 httpss——非法 scheme，fetch 拒载。
 * 既有用例的 mock 只匹配 host+path、不校验 scheme，故一直假绿。
 */
describe('ws/wss → http(s) 归一（症状：wss relay 静默失效）', () => {
  it('wss 归一为 https（不得产出 httpss 非法 scheme）', () => {
    expect(relayHttpOrigin('wss://120.26.219.32:80')).toBe('https://120.26.219.32:80');
    expect(relayHttpOrigin('ws://192.168.1.9:8787')).toBe('http://192.168.1.9:8787');
    expect(relayHttpOrigin('https://relay.test')).toBe('https://relay.test');
  });

  it('wss 候选探到 https 面——真实 fetch 构造出的 URL 合法可解析', () => {
    const url = new URL(`${manualRelayOrigin('wss://relay.test:443') ?? ''}/api/discover?code=123456`);
    expect(url.protocol).toBe('https:');
    expect(url.href).toBe('https://relay.test/api/discover?code=123456');
  });

  it('手输 wss 地址时探测 URL 逐字为 https（抓前缀截断回归）', async () => {
    const originalFetch = globalThis.fetch;
    (Constants as { expoConfig: unknown }).expoConfig = null;
    (Constants as { expoGoConfig: unknown }).expoGoConfig = null;
    try {
      const mock = installFetch((url) => (url.includes('httpss://') ? null : gatewayHit()));
      await discoverGateway('123456', 'wss://120.26.219.32:80');
      expect(mock.mock.calls.every(([input]) => !String(input).includes('httpss://'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      await relayCredentialsStore.clear();
    }
  });
});
