import { realpathSync } from 'node:fs';
import { basename as baseName, dirname as dirnamePath, isAbsolute, join as joinPaths, resolve, resolve as resolvePath, sep as pathSep } from 'node:path';

import {
  appError,
  createGitBranches,
  createGitGraph,
  createGitStatus,
  createHubApi,
  savedSessions,
  type GitBranches,
  type GitGraph,
  type GitStatus,
  type HubApi,
} from '@x3code/api';
import { createFileRead, type FileRead } from './file-read';
import { searchProjectFiles } from './file-search';
import { runGit } from './git-exec';
import { createOpenLocation, type OpenLocation } from './open-location';
import { writeModelsConfig } from './models-config';
import { createLocalRoutes } from '@x3code/api';
import { createSettingsRoutes } from '@x3code/api';
import { createSkillRoutes, failClosedSkillSources, type SkillSourcePort } from '@x3code/api';
import { createPluginRoutes, failClosedPluginSources, type PluginSourcePort } from '@x3code/api';
import { promptRoutes } from '@x3code/api';
import type { AgentDefinitionsStore } from './agent-definitions-store';
import type { ApiError } from '@x3code/contracts';
import { errorLogToken } from '@x3code/api';
import { ApiSchemas, type ApiMethod, type ApiOutcome, type ApiParams, type ModelInfoView } from '@x3code/contracts';

import type { PaiRuntime } from './x3code-runtime';
import type { RuntimeMonitor } from '@x3code/infra';
import { runtimeRoutes } from '@x3code/api';
import { threadOpsRoutes } from '@x3code/api';
import { appRoutes, bashRouteHandler, sessionRoutes } from '@x3code/api';
import { resumeRoutes } from '@x3code/api';
import type { createFileSettings } from './file-settings';
import type { ProviderKeyStore } from './file-settings';

/**
 * 渲染层 invoke 路由：zod 校验 → hub 域方法（runtime.hub 单实例门面）→ 响应收窄为视图。
 * 全部错误以 {ok:false,error:ApiError}（kind 判别联合）；协议字面量只在本文件族与 @x3code/api（views/events）出现。
 */

type FileSettings = ReturnType<typeof createFileSettings>;

/** host 未构建窗口（start 前/装配失败）的降级门面：request 恒拒——经 transport catch
 *  统一折叠 transient/host_unavailable（渲染层据此进降级 UI，与旧命令面同口径）。 */

/**
 * 模型清单的渠道真相域过滤：app 的唯一模型/凭据面是设置里的渠道
 * （env 清洗 + $X3CODE_KEY_* 注入），hub 内置目录的模型不经渠道配置不可用，
 * 不进选择面。
 */
export function channelScopedModels(
  models: readonly ModelInfoView[],
  channelNames: ReadonlySet<string>,
): ModelInfoView[] {
  return models.filter((model) => channelNames.has(model.provider));
}

export interface ApiRouteDeps {
  runtime: PaiRuntime;
  settings: FileSettings;
  keyStore: ProviderKeyStore;
  /** 审计日志（权限应答等安全敏感动作）。 */
  audit: (message: string) => void;
  /** 子 agent 定义文件面（user 目录 + 已知项目 .my-agent/agents 的 CRUD）。 */
  agentDefinitions: AgentDefinitionsStore;
  /** agentDir 根（会话根解析）。 */
  agentDir: string;
  /** 在系统文件管理器中显示文件（装配层注入 Electron shell；缺省 no-op 保可测性）。 */
  revealPath: (path: string) => void;
  /** 系统目录选择对话框（装配层注入 Electron dialog；缺省返回「不可用」）。 */
  pickDirectory: (defaultPath: string | null) => Promise<string | null>;
  /** 技能源面（装配层注入 skill-import 实现：批准根白名单 + 候选发现）。
   *  缺省 fail-closed（门恒拒、扫描恒空）——未接线不放大能力面，可测性同 revealPath 范式。 */
  skillImporter?: SkillSourcePort;
  /** 插件源面（装配层注入 plugin-import 实现；缺省 fail-closed 同 skillImporter 范式）。 */
  pluginImporter?: PluginSourcePort;
  /** 热装目标（活跃 thread id 集合的惰性快照；导入后即时生效编排）。 */
  pluginHotInstallTargets?: () => readonly string[];
  /** 本地 git 分支能力（装配层可注入执行器替身；缺省走真实 git）。 */
  git?: GitBranches;
  /** 本地 git 图谱读口（同上，可注入替身）。 */
  graph?: GitGraph;
  /** 工作区变更速览读口（同上，可注入替身）。 */
  gitStatus?: GitStatus;
  /** 运行状态监控器（T29 app/runtime 快照源）。 */
  monitor: RuntimeMonitor;
  /** relay 配置变更后重启网关（gateway.json 只在网关启动期读入——不重启即拿旧形态配对）。 */
  restartGateway: () => Promise<void>;
  /** 档位 hub 同步失败落档钩子（监督日志 → 监控时间线）。 */
  onPolicySyncFailed?: (minutes: number, reason: string) => void;
  /** 路由拒绝/失败落诊断日志（api-routes 装配层接主进程 log；设置域本地
   *  fail 面的可观测口。hub 命令拒绝由 transport onCall 统一落
   *  hub_call_rejected:<type>:<token>——同一事实一套接口）。 */
  onRouteRejected?: (message: string) => void;
  /** 诊断包落盘（装配层注入：真实 fs + reveal；测试注入替身）。 */
  exportDiagnosticsBundle: () => string;
  /** 系统工具打开能力（访达/终端/编辑器；缺省走真实 execFile 探测）。 */
  openLocation?: OpenLocation;
  /** 项目文件只读面（代码查看器数据源；缺省走真实 fs）。 */
  fileRead?: FileRead;
  /** 额外放行的工作目录（本次运行中经系统选择器选过的目录）。 */
  extraCwds?: () => readonly string[];
}

type Outcome<M extends ApiMethod> = Promise<ApiOutcome<M>>;

export function createApiRoutes(deps: ApiRouteDeps) {
  const { runtime } = deps;

  const fail = (error: ApiError): { ok: false; error: ApiError } => ({ ok: false, error });

  /** 会话文件白名单：resolve 后必须位于 sessionsRoot 之下（真实路径优先；缺失段
   *  逐级上溯到存在的祖先做 realpath 归一——删除后的会话目录幂等重删不得因归一
   *  失败被误拒，逃逸路径 realpath 后仍在 root 外）。 */
  const insideSessionsRoot = (sessionPath: string): boolean => {
    let root = runtime.sessionsRoot;
    try {
      root = realpathSync(root);
    } catch {
      // 目录不存在时 resolve 语义兜底
    }
    let target = resolvePath(sessionPath);
    try {
      target = realpathSync(target);
    } catch {
      // 目标不在：逐级上溯最近的存在的祖先（macOS /tmp→/private/tmp 符号链接归一），
      // 剩余相对段拼回——任意深度的已删路径都能归一到真实前缀域
      let dir = dirnamePath(target);
      const tail: string[] = [baseName(target)];
      for (let depth = 0; depth < 8; depth += 1) {
        try {
          const real = realpathSync(dir);
          target = tail.length > 0 ? joinPaths(real, ...tail) : real;
          break;
        } catch {
          tail.unshift(baseName(dir));
          const parent = dirnamePath(dir);
          if (parent === dir) break; // 到根仍不存在：保持 resolve 形态（多半已在白名单外）
          dir = parent;
        }
      }
    }
    return target === root || target.startsWith(`${root}${pathSep}`);
  };

  /** 惰性 hub 取用：路由构造早于 runtime.start（工厂期不触 getter）；host 未构建
   *  窗口走降级门面（域方法恒回 transient/host_unavailable）。 */
  /** pre-start/装配失败窗口的降级门面：域方法恒回 transient/host_unavailable，
   *  拒绝经 onCall 与真 hub 同观测策略落日志（症状可观测性不因窗口而丢）。 */
  const unavailableHub: HubApi = createHubApi({
    request: () => Promise.reject(new Error('host_unavailable')),
    onCall: (command, result) => {
      if (result.ok) return;
      const threadId = (command as { threadId?: string }).threadId;
      deps.onRouteRejected?.(`hub_call_rejected:${command.type}:${threadId ?? '-'}:${errorLogToken(result.error)}`);
    },
  });

  const hub = (): HubApi => {
    try {
      return runtime.hub;
    } catch {
      return unavailableHub;
    }
  };

  /** 按会话文件路径找注册表行（resume 缺省 trusted 的补全源）。 */
  const findRegistryRowByPath = (sessionPath: string) => runtime.registry.list().find((row) => row.sessionPath === sessionPath) ?? null;

  /** 已知工作目录集合：活跃会话 + 注册表（list_saved 按目录过滤，需逐目录聚合）。 */
  const knownCwds = (): string[] => {
    const cwds = new Set<string>(runtime.sessions().map((session) => session.cwd));
    for (const row of runtime.registry.list()) {
      if (row.cwd.length > 0) cwds.add(row.cwd);
    }
    return [...cwds];
  };

  /**
   * 目录门禁：只允许本应用已知项目目录（活跃会话 + 注册表 + 本次系统选择器选过的目录），
   * 缩小文件枚举与工作树写入面（已知目录集合本身由 session/start 决定，见 T23 挂账），
   * 不是对任意路径的硬边界；符号链接按 realpath 归一。
   */
  const isKnownCwd = (cwd: string): boolean => {
    const root = resolvePath(cwd);
    let rootReal = root;
    try {
      rootReal = realpathSync(root);
    } catch {
      // 目录不存在：保留 resolve 形态（调用侧按空结果/报错降级）
    }
    return [...knownCwds(), ...(deps.extraCwds?.() ?? [])].some((known) => {
      try {
        const base = realpathSync(known);
        return base === rootReal || rootReal.startsWith(`${base}${pathSep}`);
      } catch {
        return resolvePath(known) === root;
      }
    });
  };

  // 路径能力注入（api 包无 node 域）：gitDir 相对串 resolve 归一
  const git = deps.git ?? createGitBranches(runGit, { isAbsolute, resolve });
  const graph = deps.graph ?? createGitGraph(runGit);
  const gitStatus = deps.gitStatus ?? createGitStatus(runGit);
  const openLocation = deps.openLocation ?? createOpenLocation();
  const fileRead = deps.fileRead ?? createFileRead();

  const savedAcrossCwds = async (cwd?: string): Promise<ReturnType<typeof savedSessions>> => {
    const targets = cwd !== undefined ? [cwd] : knownCwds();
    const merged = new Map<string, ReturnType<typeof savedSessions>[number]>();
    for (const target of targets) {
      const result = await hub().thread.listSaved({ cwd: target });
      if (!result.ok) continue;
      for (const session of savedSessions(result.data, runtime.sessionsRoot)) merged.set(session.sessionPath, session);
    }
    return [...merged.values()].sort((a, b) => b.modifiedAt - a.modifiedAt);
  };

  /**
   * provider 配置结构变更（无 key 变更）→ 落盘 providers.json + hub models/reload 热更新：
   * host 重读目录、广播 catalog/reload 给存量 worker——会话存活,不重启。
   * host 未启动：providers.json 已落盘,下次 spawn 生效。
   */
  const reloadModelsForProviders = async (): Promise<void> => {
    writeModelsConfig(deps.agentDir, deps.settings.listProviders(), deps.keyStore);
    try {
      const result = await runtime.hub.models.reloadModels();
      if (!result.ok) deps.audit(`models_reload_rejected:${errorLogToken(result.error)}`);
    } catch {
      deps.audit('models_reload_failed:host_unavailable');
    }
  };

  /**
   * key 变更 → 重启 host 恢复链路：key 经 spawn env 注入（$X3CODE_KEY_*）——
   * 进程存活期 env 不可变,必须重 spawn 才生效。
   * host 未启动则配置已落盘，下次启动时生效。
   */
  const restartHostForProviders = async (): Promise<void> => {
    try {
      await runtime.host.restart('providers_changed');
    } catch {
      // host 未构建/未启动：落盘即完成，待下次启动时生效
    }
  };

  const localRoutes = createLocalRoutes({
    isKnownCwd,
    audit: deps.audit,
    fileSearch: { search: searchProjectFiles },
    git,
    graph,
    gitStatus,
    openLocation,
    fileRead,
  });
  const settings = createSettingsRoutes({
    settings: deps.settings,
    keyStore: deps.keyStore,
    reloadModels: reloadModelsForProviders,
    restartHost: restartHostForProviders,
    restartGateway: deps.restartGateway,
    settingsCommands: () => hub().settings,
    permissionCommands: () => hub().permissions,
    ...(deps.onRouteRejected !== undefined ? { onReject: deps.onRouteRejected } : {}),
  });
  const { providersView, preferencesView } = settings;
  // 技能域（清单/启停/候选/导入；H 路线落盘经 hub skills/install|inspect）
  const skills = createSkillRoutes({
    settingsCommands: () => hub().settings,
    sources: deps.skillImporter ?? failClosedSkillSources,
    ...(deps.onRouteRejected !== undefined ? { onReject: deps.onRouteRejected } : {}),
  });
  const { skillsList, routes: skillRoutes } = skills;
  const { routes: pluginRoutes } = createPluginRoutes({
    settingsCommands: () => hub().settings,
    sources: deps.pluginImporter ?? failClosedPluginSources,
    ...(deps.pluginHotInstallTargets !== undefined ? { hotInstallTargets: deps.pluginHotInstallTargets } : {}),
    ...(deps.onRouteRejected !== undefined ? { onReject: deps.onRouteRejected } : {}),
  });

  type RouteTable = { [M in ApiMethod]?: (params: ApiParams<M>) => Outcome<M> };

  /** 渠道真相域过滤（纯函数见模块级 channelScopedModels）：model/list 与 bootstrap 同口径。 */
  const channelModels = (models: readonly ModelInfoView[]): ModelInfoView[] =>
    channelScopedModels(models, new Set(deps.settings.listProviders().map((provider) => provider.name)));

  /** start/resume 后补齐模型与思考档信息（失败不打断主流程）。 */
  const fillSessionMeta = (threadId: string): void => {
    void routes['session/state']?.({ threadId }).catch(() => undefined);
  };

  const routes: RouteTable = {
    ...localRoutes,
    ...settings.routes,
    ...skillRoutes,
    ...pluginRoutes,
    ...threadOpsRoutes({
      agentCommands: () => hub().agents,
      threadCommands: () => hub().thread,
      fail,
      runtime,
      rootDeps: { audit: deps.audit, agentDefinitions: deps.agentDefinitions, knownCwds, insideSessionsRoot },
    }),
    // app 域（bootstrap/restartHost/dialog/command/agent 定义管理面）独立模块
    ...appRoutes({
      hub,
      modelCommands: () => hub().models,
      sessionCommands: () => hub().session,
      agentCommands: () => hub().agents,
      fail,
      runtime,
      audit: deps.audit,
      pickDirectory: deps.pickDirectory,
      agentDefinitions: deps.agentDefinitions,
      knownCwds,
      savedAcrossCwds,
      channelModels,
      providersView,
      preferencesView,
      skillsList,
    }),
    // 会话域（生命周期/读面/写面/模型目录/权限模式）独立模块
    ...sessionRoutes({
      sessionCommands: () => hub().session,
      threadCommands: () => hub().thread,
      modelCommands: () => hub().models,
      permissionCommands: () => hub().permissions,
      fail,
      runtime,
      audit: deps.audit,
      savedAcrossCwds,
      channelModels,
      insideSessionsRoot,
      revealPath: deps.revealPath,
      fillSessionMeta,
    }),
    // 发送管线（`! ` 路由/空舞台守卫/懒唤醒/unknown_thread 自愈）独立模块；
    // resume 通路经表晚绑定（resume 组挂载在本表字面量之后，调用期解引用）
    ...promptRoutes({
      sessionCommands: () => hub().session,
      fail,
      runtime,
      bashRoute: bashRouteHandler({ sessionCommands: () => hub().session, fail, audit: deps.audit }),
      resumeRoute: () => routes['session/resume'],
    }),
    ...runtimeRoutes({
      runtime,
      monitor: deps.monitor,
      settings: deps.settings,
      settingsCommands: () => hub().settings,
      threadCommands: () => hub().thread,
      sessionCommands: () => hub().session,
      fail,
      onPolicySyncFailed: deps.onPolicySyncFailed,
      exportDiagnosticsBundle: deps.exportDiagnosticsBundle,
    }),
  };  const resume = resumeRoutes({
    threadCommands: () => hub().thread,
    fail,
    runtime,
    audit: deps.audit,
    insideSessionsRoot,
    findRegistryRowByPath,
    fillSessionMeta,
  });
  // 挂载在表字面量之后：resume 组依赖 fillSessionMeta，而它引用本表（调用期解引用，安全）
  Object.assign(routes, resume);


  return {
    async invoke(method: string, params: unknown): Promise<unknown> {
      // 自有属性判定：原型链键（toString/__proto__）不得命中 schema（误报 invalid_params）
      if (!Object.prototype.hasOwnProperty.call(ApiSchemas, method)) return fail(appError('unknown_method', method));
      const schema = ApiSchemas[method as ApiMethod];
      if (schema === undefined) return fail(appError('unknown_method', method));
      let parsed: unknown;
      try {
        parsed = schema.params.parse(params);
      } catch {
        return fail(appError('invalid_params'));
      }
      let outcome: unknown;
      try {
        const handler = routes[method as ApiMethod];
        if (handler === undefined) return fail(appError('unknown_method', method));
        outcome = await handler(parsed as never);
      } catch {
        // 路由实现内未捕获的异常（磁盘错/装配面）统一收窄，不沿 IPC reject 到渲染层
        outcome = fail(appError('internal_error'));
      }
      return outcome;
    },

    providersView,
  };
}
