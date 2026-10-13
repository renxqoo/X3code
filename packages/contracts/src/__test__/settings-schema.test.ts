import { describe, expect, test } from 'bun:test';

import { SettingsSchema } from '../index';

/** Settings/PreferencesView 契约：round-trip、缺省、拒绝表（从 contracts.test 拆出）。 */

describe('Settings zod：round-trip 与拒绝表', () => {
  test('空输入落到默认值', () => {
    const s = SettingsSchema.parse({});
    expect(s.providers).toEqual([]);
    expect(s.trustedDefault).toBe(false);
    expect(s.hubDev).toEqual({ bunPath: null, hubEntry: null, gatewayEntry: null });
    expect(s.defaultModel).toBeNull();
    expect(s.onboarded).toBe(false);
    expect(s.relay).toEqual({ remoteEnabled: true, relayUrl: '', relayKeyFingerprint: '' });
    expect(s.browserAutoOpenPanel).toBe(true);
    expect(s.browserExternalLinkTarget).toBe('builtin');
    expect(s.browserLocalLinkTarget).toBe('builtin');
  });

  test('全量字段 round-trip', () => {
    const input = {
      hubDev: { bunPath: '/usr/local/bin/bun', hubEntry: '/Users/x/my-agent/packages/host-hub/src/host/cli.ts', gatewayEntry: null },
      providers: [{ name: 'glm', baseUrl: 'https://api.example.com', api: 'openai', models: [{ id: 'glm-5.3', reasoning: true, vision: true }]}],
      trustedDefault: true,
      defaultModel: 'glm/glm-5.3',
      onboarded: true,
      projectModels: { '/w': 'glm/glm-5.3' },
      pinnedSessions: ['/a.jsonl'],
      hiddenProjects: ['/w/gone'],
      idleRecycleMinutes: 15,
      archivedSessions: ['/b.jsonl'],
      relay: { remoteEnabled: false, relayUrl: 'wss://relay.example.com', relayKeyFingerprint: 'fp-1' },
      browserAutoOpenPanel: false,
      browserExternalLinkTarget: 'system',
      browserLocalLinkTarget: 'builtin',
    };
    expect(SettingsSchema.parse(input)).toEqual(input);
  });

  test.each([
    ['未知键', { extra: 1 } as Record<string, unknown>],
    ['provider 空 models', { providers: [{ name: 'p', baseUrl: 'u', api: 'openai', models: [] }] }],
    ['provider 缺 baseUrl', { providers: [{ name: 'p', api: 'openai', models: ['m'] }] }],
  ])('拒绝：%s', (_name, bad) => {
    expect(() => SettingsSchema.parse(bad)).toThrow();
  });
});
