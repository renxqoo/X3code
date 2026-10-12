import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as React from 'react';

import { QrScanModal as mockQrScanModal } from '@/test/qr-scan-modal-stub';

/**
 * 症状回归（配对简化）：手机输完 6 位码后，比对码只经桌面 owner 自动确认——
 * 手机端不得再展示那 6 位数字（旧流程要人眼比对，留着是误导）。
 */

jest.mock('@/mobile/relay/runtime', () => {
  const state = { connects: 0 };
  return {
    __state: state,
    initializeRelayRuntime: () => ({ connectWithCredentials: () => { state.connects += 1; return Promise.resolve(); } }),
    useRelayStatus: () => ({ status: 'disconnected', runtime: null }),
  };
});

jest.mock('@/mobile/relay/credentials', () => ({
  relayCredentialsStore: {
    load: () => null,
    save: () => Promise.resolve(true),
    clear: () => Promise.resolve(),
  },
}));

jest.mock('@/mobile/relay/discover', () => ({
  discoverGateway: () => Promise.resolve({
    relayUrl: 'ws://127.0.0.1:8787',
    installationId: 'i-1',
    gatewayKeyFingerprint: 'fp-1',
    pairingId: 'p-1',
    pairingTicket: 'ticket-1',
  }),
}));

jest.mock('@/mobile/relay/ws-dial', () => ({
  dialWebSocket: () => {
    const socket = { onopen: null, onerror: null, onclose: null, onmessage: null, send: () => undefined, close: () => undefined } as unknown as Record<string, (() => void) | null>;
    setTimeout(() => socket['onopen']?.(), 0);
    return socket;
  },
}));

jest.mock('@/mobile/relay/qr-scan-modal', () => ({
  // 替身装在独立模块（非工厂内联）：工厂不允许引用 React，而取它的 require 触犯
  // no-require-imports——同 relay-crypto-stub 的做法。
  QrScanModal: (props: { visible: boolean; onPayload: (payload: string) => void }) => mockQrScanModal(props),
}));

// 注册结果状态活在工厂内部（jest.mock 工厂不得引用外层变量）
jest.mock('@/mobile/relay/pairing', () => {
  const state = { registered: { ok: true, reason: 'timeout' } as { ok: boolean; reason: string }, specs: [] as unknown[] };
  return {
    __state: state,
    generateDeviceIdentity: () => ({ deviceId: 'd-1', signingSecret: 's', signingPub: 'p' }),
    createPairingSession: (spec: unknown) => {
      state.specs.push(spec);
      return {
      registeredDeviceId: 'd-1',
      relayToken: 'token-1',
      relayNodeId: null,
      onStep: (listener: (step: { phase: string; sas?: string }) => void) => {
        listener({ phase: 'sas-shown', sas: '392653' });
        return () => undefined;
      },
      startManual: () => Promise.resolve(),
      submitDeviceKeys: () => Promise.resolve(),
      waitRegistered: () => Promise.resolve(state.registered.ok ? { ok: true, sharedSecret: 'seed' } : { ok: false, reason: state.registered.reason }),
      close: () => undefined,
      };
    },
  };
});

import * as pairingModule from '@/mobile/relay/pairing';
import * as runtimeModule from '@/mobile/relay/runtime';
import { TestWrapper } from '@/test/test-wrapper';

import DevicesRoute from '../devices';

const pairingState = (pairingModule as unknown as { __state: { registered: { ok: boolean; reason: string }; specs: unknown[] } }).__state;
const runtimeState = (runtimeModule as unknown as { __state: { connects: number } }).__state;

describe('devices route（症状回归：配对比对码不再要求人比对）', () => {
  beforeEach(() => {
    pairingState.registered = { ok: true, reason: 'timeout' };
    runtimeState.connects = 0;
    pairingState.specs.length = 0;
    (globalThis as { __scanPayload?: string }).__scanPayload = undefined;
  });

  it('输码配对走完后不渲染网关比对码', async () => {
    const view = await render(<TestWrapper><DevicesRoute /></TestWrapper>);
    await fireEvent.changeText(view.getByPlaceholderText('输入桌面端显示的 6 位配对码'), '246813');
    await fireEvent.press(view.getByText('输入 6 位码配对'));
    // 配对确实走完（凭证落库 → 正式连接），否则「没渲染比对码」只是因为流程没启动
    await waitFor(() => {
      expect(runtimeState.connects).toBe(1);
    });
    expect(view.queryByText('392653')).toBeNull();
    expect(view.queryByText('比对桌面端数字')).toBeNull();
    await view.unmount();
  });

  it('配对未完成的原因照旧上屏（错误面不被简化流程吞掉）', async () => {
    pairingState.registered = { ok: false, reason: 'owner_confirm_missing' };
    const view = await render(<TestWrapper><DevicesRoute /></TestWrapper>);
    await fireEvent.changeText(view.getByPlaceholderText('输入桌面端显示的 6 位配对码'), '246813');
    await fireEvent.press(view.getByText('输入 6 位码配对'));
    await waitFor(() => {
      expect(view.queryByText(/配对未完成/)).not.toBeNull();
    });
    await view.unmount();
  });
});

/**
 * 症状：扫码配对后无限转圈到超时。根因是 QR 载荷的临时公钥字段名是
 * gwEphemeralPub（网关侧事实），扫码入口读的是 gatewayEphemeralPub → 取到
 * undefined → createPairingSession 不进入 QR 分支 → 不发 request 帧 →
 * 网关永远等不到设备，手机端 waitRegistered 挂到超时。
 */
describe('扫码配对（症状：扫码后一直 loading 到超时）', () => {
  const qrPayload = (extra: Record<string, unknown>): string => JSON.stringify({
    v: 1, relayUrl: 'wss://120.26.219.32:80', relayKeyFingerprint: 'rk-1',
    gatewayKeyFingerprint: 'gwf-1', installationId: 'inst-1', pairingId: 'pr_1',
    gwEphemeralPub: 'eph-pub-1', pairingTicket: 'tk-1', ...extra,
  });

  beforeEach(() => {
    pairingState.registered = { ok: true, reason: 'timeout' };
    runtimeState.connects = 0;
    pairingState.specs.length = 0;
  });

  it('QR 载荷的 gwEphemeralPub 映射为会话的 gatewayEphemeralPub——QR 分支得以发起 request', async () => {
    const view = await render(<TestWrapper><DevicesRoute /></TestWrapper>);
    (globalThis as { __scanPayload?: string }).__scanPayload = qrPayload({});
    await fireEvent.press(view.getByText('扫码配对'));
    await waitFor(() => {
      expect(pairingState.specs.length).toBe(1);
    });
    expect((pairingState.specs[0] as { gatewayEphemeralPub?: string }).gatewayEphemeralPub).toBe('eph-pub-1');
    await view.unmount();
  });

  it('扫码走到正式连接——不再挂在 loading', async () => {
    const view = await render(<TestWrapper><DevicesRoute /></TestWrapper>);
    (globalThis as { __scanPayload?: string }).__scanPayload = qrPayload({});
    await fireEvent.press(view.getByText('扫码配对'));
    await waitFor(() => {
      expect(runtimeState.connects).toBe(1);
    });
    await view.unmount();
  });

  it('载荷缺临时公钥时报错而非静默等待——不给用户一个必然超时的转圈', async () => {
    const view = await render(<TestWrapper><DevicesRoute /></TestWrapper>);
    (globalThis as { __scanPayload?: string }).__scanPayload = qrPayload({ gwEphemeralPub: undefined });
    await fireEvent.press(view.getByText('扫码配对'));
    await waitFor(() => {
      expect(view.queryByText(/二维码内容缺少/)).not.toBeNull();
    });
    expect(runtimeState.connects).toBe(0);
    await view.unmount();
  });

  it('载荷缺 ticket 时报凭据缺失——不撞 /pairing 握手 401', async () => {
    const view = await render(<TestWrapper><DevicesRoute /></TestWrapper>);
    (globalThis as { __scanPayload?: string }).__scanPayload = qrPayload({ pairingTicket: '' });
    await fireEvent.press(view.getByText('扫码配对'));
    await waitFor(() => {
      expect(view.queryByText(/未下发配对凭据/)).not.toBeNull();
    });
    expect(pairingState.specs.length).toBe(0);
    await view.unmount();
  });
});
