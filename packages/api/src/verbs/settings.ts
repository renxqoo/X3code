

import type { ApiError, ApiMethod, ApiOutcome, ApiParams, PreferencesView, ProviderConfig, ProviderConfigView } from '@x3code/contracts';
import { isApiFormat, permVocabOf, resolveStoredPermMode, type PermissionModeData } from '@x3code/contracts';
import { appError } from '../errors';
import type { PermissionCommands } from '../commands/permissions';
import type { SettingsCommands } from '../commands/settings';

import { envVarNameForProvider } from './env-name';
import { errorLogToken } from './error-log-token';
import { createProviderProbe } from './provider-probe';

/**
 * 设置与目录路由组（api-routes 的本地配置子集）：providers/hub 设置/偏好写。
 * 技能域已拆至 verbs/skills.ts（T42 §4：一域一文件；清单/启停/候选/导入）；
 * 视图构建器（providersView/preferencesView）随路由一并产出。
 */

type Handler<M extends ApiMethod> = (params: ApiParams<M>) => Promise<ApiOutcome<M>>;

/** 设置存储端口（verbs 消费面：providers CRUD + 偏好读写——provider 行用 contracts 真形；
 *  写路径返回判别联合：磁盘不可读时拒绝写（settings_unreadable），不静默丢数据） */
interface SettingsStorePort {
  listProviders(): ProviderConfig[];
  upsertProvider(input: ProviderConfig & { apiKey?: string }): { ok: true; data: ProviderConfig[] } | { ok: false; reason: 'settings_unreadable' };
  removeProvider(name: string): { ok: true; data: ProviderConfig[] } | { ok: false; reason: 'settings_unreadable' };
  get(): PreferencesView;
  patch(patch: Record<string, unknown>): { ok: true; data: unknown } | { ok: false; reason: 'settings_unreadable' };
}
interface KeyStorePort { getKey(name: string): string | null; }

export type SettingsRoutesDeps = {
  settings: SettingsStorePort;
  keyStore: KeyStorePort;
  /** provider 配置结构变更（无 key 变更）：hub models/reload 热更新,存量会话存活。 */
  reloadModels: () => Promise<void>;
  /** key 变更后重启 host（$X3CODE_KEY_* 经 spawn env 注入,进程存活期不可变）。 */
  restartHost: () => Promise<void>;
  /** relay 配置变更后重启网关（gateway.json 只在启动期读入）。 */
  restartGateway: () => Promise<void>;
  /** hub settings 域 accessor（惰性：路由构造早于 runtime.start；host 未启动时各路由显式降级）。 */
  settingsCommands: () => SettingsCommands;
  /** permissions 域 accessor（hubSettings 词表读口：无 threadId 的权限双域全局档）。 */
  permissionCommands: () => PermissionCommands;
  /** 拒绝/失败落诊断日志（保存失败零日志曾致排障无据可查）。 */
  onReject?: (message: string) => void;
};

export function createSettingsRoutes(deps: SettingsRoutesDeps) {
  const failLogged = (error: ApiError): Promise<{ ok: false; error: ApiError }> => {
    deps.onReject?.(`provider_route_rejected:${errorLogToken(error)}`);
    return Promise.resolve({ ok: false, error });
  };
  const fail = failLogged;

  const providersView = (): ProviderConfigView[] =>
    deps.settings.listProviders().map((provider) => ({
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: provider.api,
      models: provider.models.map((model) => ({ ...model })),
      hasKey: deps.keyStore.getKey(provider.name) !== null,
    }));

  const preferencesView = () => {
    const settings = deps.settings.get();
    return {
      defaultModel: settings.defaultModel,
      onboarded: settings.onboarded,
      projectModels: { ...settings.projectModels },
      pinnedSessions: [...settings.pinnedSessions],
      trustedDefault: settings.trustedDefault,
      hiddenProjects: [...settings.hiddenProjects],
      archivedSessions: [...settings.archivedSessions],
      idleRecycleMinutes: settings.idleRecycleMinutes,
      relay: { ...settings.relay },
    };
  };

  // 连接探活（HTTP 直发不经 hub；渠道与 key 取本路由组的 settings/keyStore 端口，key 不进日志）
  const probe = createProviderProbe({
    getProvider: (name) => deps.settings.listProviders().find((provider) => provider.name === name),
    getKey: (name) => deps.keyStore.getKey(name),
  }).probe;

  const routes: {
    'provider/upsert': Handler<'provider/upsert'>;
    'provider/remove': Handler<'provider/remove'>;
    'provider/test': Handler<'provider/test'>;
    'app/hubSettings': Handler<'app/hubSettings'>;
    'app/setHubSettings': Handler<'app/setHubSettings'>;
    'app/setPreference': Handler<'app/setPreference'>;
  } = {
    'provider/upsert': async (params) => {
      // env 变量名碰撞防护：不同名字 sanitize 后同名会导致 key 互串（a-b 与 a_b 同映射 X3CODE_KEY_A_B）
      const envName = envVarNameForProvider(params.name);
      const collides = deps.settings
        .listProviders()
        .some((provider) => provider.name !== params.name && envVarNameForProvider(provider.name) === envName);
      if (collides) return failLogged(appError('provider_name_conflict'));
      // api 词表校验（providers.json protocol 同源：词表外语形写盘会被目录剔除降级）
      if (!isApiFormat(params.api)) return failLogged(appError('provider_api_unsupported'));
      // baseUrl 形状校验（无 scheme 的档案被目录整档剔除且零告警——写前显式拒绝）
      if (!params.baseUrl.startsWith('http://') && !params.baseUrl.startsWith('https://')) {
        return failLogged(appError('provider_baseurl_invalid'));
      }
      // baseUrl 变更强制重录 key：换端点 = 换服务方，「省略 apiKey = 保留存量」的 UX
      // 只对不换端点的改动成立——否则存量 key 会被后续 provider/test 无声发往新主机
      const existing = deps.settings.listProviders().find((provider) => provider.name === params.name);
      if (existing !== undefined && existing.baseUrl !== params.baseUrl && params.apiKey === undefined) {
        return failLogged(appError('provider_baseurl_changed'));
      }
      // 同名内置预设 = 用户覆盖（x-harness 整档覆盖语义 + 消歧 custom 优先）：用户
      // 配置胜出、删渠道即恢复内置——不再拒名（T39 实施轮用户裁决：app 无「预设挡人」面）
      const upserted = deps.settings.upsertProvider({
        name: params.name,
        baseUrl: params.baseUrl,
        api: params.api,
        models: params.models.map((model) => ({ ...model })),
        apiKey: params.apiKey,
      });
      if (!upserted.ok) return failLogged(appError('settings_unavailable'));
      if (params.apiKey !== undefined) await deps.restartHost();
      else await deps.reloadModels();
      return { ok: true as const, data: providersView() };
    },
    'provider/remove': async (params) => {
      const removed = deps.settings.removeProvider(params.name);
      if (!removed.ok) return failLogged(appError('settings_unavailable'));
      await deps.reloadModels();
      return { ok: true as const, data: providersView() };
    },
    'provider/test': async (params) => {
      const outcome = await probe(params.name, params.modelId);
      return outcome.ok
        ? { ok: true as const, data: { latencyMs: outcome.latencyMs } }
        : fail(outcome.error);
    },
    'app/hubSettings': async () => {
      // 词表读口 = 无 threadId permission/get_mode（host 权限双域全局档）——与 settings/get
      // 并发取；词表读失败回落内置缺省（设置读不因词表整体失败），无缓存即无失效问题
      const [result, vocabResult] = await Promise.all([deps.settingsCommands().get({}), deps.permissionCommands().getMode({})]);
      if (!result.ok) return fail(result.error);
      const values = (result.data as { values?: Record<string, unknown> }).values ?? {};
      const mode = values['permission.defaultMode'];
      const thinking = values['thinking.default'];
      const vocab = permVocabOf(vocabResult.ok ? (vocabResult.data as PermissionModeData | undefined)?.modes : undefined);
      return {
        ok: true as const,
        data: {
          // 读侧归一：旧档映射 → 词表内透传 → 词表外视为未设置（归一展示不丢语义）
          permissionDefaultMode: typeof mode === 'string' ? resolveStoredPermMode(mode, vocab) : null,
          thinkingDefault:
            thinking === 'off' || thinking === 'low' || thinking === 'medium' || thinking === 'high' || thinking === 'max'
              ? thinking
              : null,
          permissionModes: vocab,
        },
      };
    },
    'app/setHubSettings': async (params) => {
      // null = 不写该键（「未设置」在 hub 侧无协议表达——settings/set 无删除语义）
      if (params.permissionDefaultMode !== undefined && params.permissionDefaultMode !== null) {
        const result = await deps.settingsCommands().set({
          key: 'permission.defaultMode',
          value: params.permissionDefaultMode,
        });
        if (!result.ok) return fail(result.error);
      }
      if (params.thinkingDefault !== undefined && params.thinkingDefault !== null) {
        const result = await deps.settingsCommands().set({
          key: 'thinking.default',
          value: params.thinkingDefault,
        });
        if (!result.ok) return fail(result.error);
      }
      return { ok: true as const, data: null };
    },
    'app/setPreference': async (params) => {
      const patch: Parameters<SettingsStorePort['patch']>[0] = {};
      if (params.defaultModel !== undefined) patch.defaultModel = params.defaultModel;
      if (params.onboarded !== undefined) patch.onboarded = params.onboarded;
      if (params.projectModels !== undefined) patch.projectModels = { ...params.projectModels };
      if (params.pinnedSessions !== undefined) patch.pinnedSessions = [...params.pinnedSessions];
      if (params.trustedDefault !== undefined) patch.trustedDefault = params.trustedDefault;
      if (params.hiddenProjects !== undefined) patch.hiddenProjects = [...params.hiddenProjects];
      if (params.archivedSessions !== undefined) patch.archivedSessions = [...params.archivedSessions];
      // relay 变更须重启网关：gateway.json 只在网关启动期读入，不重启即拿旧 relay 形态配对
      const relay = params.relay;
      const relayChanged = relay !== undefined && (relay.relayUrl !== deps.settings.get().relay.relayUrl || relay.relayKeyFingerprint !== deps.settings.get().relay.relayKeyFingerprint);
      if (relay !== undefined) patch.relay = { ...relay };
      const outcome = deps.settings.patch(patch);
      if (!outcome.ok) return failLogged(appError('settings_unavailable'));
      if (relayChanged) await deps.restartGateway();
      return { ok: true as const, data: preferencesView() };
    },
  };

  return {
    providersView,
    preferencesView,
    routes,
  };
}

