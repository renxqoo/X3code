import type {
  AgentDefinition,
  ApiOutcome,
  CommandView,
  ImagePayload,
  PluginCandidateView,
  PluginProposalRow,
  PreferencesView,
  ProviderModel,
  RelayConfig,
  SkillCandidateView,
  SkillView,
} from '@x3code/contracts';

import type { RuntimeController } from './runtime-controller';
import type { HubSettingsView, SessionPermissionModeView, ThinkingLevelStateView } from './store';

/**
 * 控制器对外契约（从 live-controller.ts 拆出，一文件一事）：
 * 渲染层唯一的数据/动作入口面——组件只依赖它，不感知 IPC 与协议。
 */

/** 新会话入参（渲染层动作面形状）：权限模式与思考档经 session/start 直达（hub 原生支持）。 */
export type CreateSessionInput = {
  cwd: string
  trusted?: boolean
  /** 裸模型 id（hub 三级消歧；app 级 "provider/modelId" 记忆由调用方拆解）。 */
  model?: { provider: string; modelId: string }
  thinkingLevel?: string
  permissionMode?: string
}

/** 会话创建结果：成功带新 threadId（调用方据此把首条消息/草稿寻址到新会话）。 */
/** 技能导入请求（目标名缺省 = 候选建议名；overwrite = 显式覆盖同名）。 */
export type SkillImportRequest = { sourcePath: string; name?: string; overwrite: boolean };

/** 批量导入汇总（逐条隔离的失败明细 + 批末重开失败数）。 */
export type SkillImportSummary = {
  imported: number;
  failed: ReadonlyArray<{ name: string; reason: string }>;
  reopenFailures: number;
};

/** 插件导入请求（名 = manifest 声明名不可改；overwrite = 显式覆盖同名）。 */
export type PluginImportRequest = { sourcePath: string; overwrite: boolean };

/** 批量插件导入汇总（逐条隔离失败明细 + 热装/降级重开失败数）。 */
export type PluginImportSummary = SkillImportSummary;

export type CreateSessionOutcome = { ok: true; threadId: string } | { ok: false; reason: string };

/** 单条队列操作结果（hub 错误码 → 消费方文案分派的类别）：
 *  ok = 受理；consumed = 条目已不在队（已入轮/已清空）；window = 无可注入的运行中轮；failed = 其余失败。 */
export type QueueOpOutcome = 'ok' | 'consumed' | 'window' | 'failed';

export interface LiveController {
  readonly start: () => Promise<void>;
  readonly dispose: () => void;
  /** 发送：成功返回 null，失败返回原因（调用方转用户可见提示）。mode 显式指定生成中投递方式。 */
  readonly submitDraft: (
    threadId: string,
    message: string,
    images?: readonly ImagePayload[],
    mode?: 'auto' | 'steer' | 'followUp',
  ) => Promise<string | null>;
  /** 会话选择：一律直接激活（parked 只读浏览，历史经 host 直读水化——T27 读不唤醒）。 */
  readonly selectSession: (threadId: string) => void;
  readonly stopActiveTurn: (threadId: string) => Promise<void>;
  queueDrop: (threadId: string, entryId: string) => Promise<QueueOpOutcome>;
  queueSendNow: (threadId: string, entryId: string) => Promise<QueueOpOutcome>;
  readonly createSession: (input: CreateSessionInput) => Promise<CreateSessionOutcome>;
  readonly openSavedSession: (sessionPath: string, trusted?: boolean) => Promise<boolean>;
  /** 会话信任切换 = stop(await) → 同文件 resume(trusted) → 激活新 threadId；stop 失败即中止不动原会话。 */
  readonly reloadSessionTrusted: (threadId: string, trusted: boolean) => Promise<boolean>;
  readonly closeSession: (threadId: string) => Promise<void>;
  readonly renameSession: (threadId: string, name: string) => Promise<boolean>;
  readonly respondDialog: (requestId: string, payload: Record<string, unknown>) => Promise<void>;
  readonly cancelDialog: (requestId: string) => Promise<void>;
  readonly selectModel: (threadId: string, provider: string, modelId: string) => Promise<void>;
  readonly selectThinking: (threadId: string, level: string) => Promise<void>;
  readonly refreshSaved: () => Promise<void>;
  /** 模型目录刷新（provider 保存触发 host 重启后向导/设置页手动补拉）。 */
  readonly refreshModels: () => Promise<void>;
  /** hub 用户级缺省读取（app/hubSettings；新任务页权限控件与设置页共用）；失败返回 null。 */
  readonly readHubSettings: () => Promise<HubSettingsView | null>;
  /** hub 用户级缺省写入（app/setHubSettings，部分字段）；成功返回 null，失败返回原因。 */
  readonly writeHubSettings: (patch: { permissionDefaultMode?: string | null; thinkingDefault?: string | null }) => Promise<string | null>;
  /** 活跃会话权限模式读取（permission/mode）；失败返回 null。 */
  readonly readSessionPermissionMode: (threadId: string) => Promise<SessionPermissionModeView | null>;
  /** 会话权限模式写入（permission/setMode，下一工具裁决生效）；成功返回 null。 */
  readonly setSessionPermissionMode: (threadId: string, mode: string) => Promise<string | null>;
  /** 活跃会话思考档读取（session/thinkingLevels）；失败返回 null。 */
  readonly readThinkingLevel: (threadId: string) => Promise<ThinkingLevelStateView | null>;
  /** 向运行中子代理注入 steer（agentId 寻址；非 running 一律失败，原因透传）。 */
  readonly steerSubagent: (threadId: string, agentId: string, message: string) => Promise<string | null>;
  readonly restartHost: () => void;
  /** 运行状态方法族（T29：快照/回收/档位/诊断包——runtime-controller.ts）。 */
  readonly runtime: RuntimeController;
  /** 子 agent 定义管理面刷新（hub/文件面快照；失败静默保持旧值）。 */
  readonly refreshAgentDefinitions: () => Promise<void>;
  /** 子 agent 定义新建/编辑/改名/移动（previous 非空时含改名与作用域移动）；成功返回 null。 */
  readonly upsertAgentDefinition: (definition: AgentDefinition, previous: { name: string; scope: 'user' | 'project'; project: string | null } | null) => Promise<string | null>;
  /** 子 agent 定义删除（身份键 = name+scope+project）；成功返回 null。 */
  readonly removeAgentDefinition: (key: { name: string; scope: 'user' | 'project'; project: string | null }) => Promise<string | null>;
  /** 用户级技能目录刷新（含启用态）。 */
  readonly refreshSkills: () => Promise<void>;
  /** 预会话命令目录（新建任务页 `/` 补全数据源；失败空目录降级）。 */
  readonly fetchCommandPreview: () => Promise<CommandView[]>;
  /** 技能启停：写 hub skills 名单；返回写后清单（失败 null + 原因）。 */
  readonly setSkillEnabled: (name: string, enabled: boolean) => Promise<{ ok: true; data: SkillView[] } | { ok: false; reason: string }>;
  /** 技能开关完整编排：写 + 串行重开全部 live 会话（链式排队，交错不叠加）；失败返回重开失败数。 */
  readonly applySkillToggle: (name: string, enabled: boolean) => Promise<{ ok: true; reopenFailures: number } | { ok: false; reason: string }>;
  /** 技能候选扫描（导入对话框数据源；sourcePath 缺省 = 三个内置源根；判定 = hub skills/inspect）。 */
  readonly scanSkillCandidates: (sourcePath?: string) => Promise<{ ok: true; candidates: SkillCandidateView[] } | { ok: false; reason: string }>;
  /** 批量技能导入（T42 D5/D6）：串行逐条（失败逐条隔离）→ 清 skills.disabled 名单 →
   *  写后清单回读 → **批末单次重开**全部 live 会话；挂在与 applySkillToggle 同一条串行链。 */
  readonly importSkills: (items: readonly SkillImportRequest[]) => Promise<SkillImportSummary>;
  /** 删除用户级技能（hub 删整技能目录——含捆绑文件）；成功后单次重开生效。 */
  readonly removeSkill: (name: string) => Promise<{ ok: true; reopenFailures: number } | { ok: false; reason: string }>;
  /** 插件启停完整编排：写 hub 名单 + 活跃会话热装/热卸（失败降级重开）。 */
  readonly applyPluginToggle: (name: string, enabled: boolean) => Promise<{ ok: true; hotFailures: number } | { ok: false; reason: string }>;
  /** 插件候选扫描（导入对话框数据源；判定 = hub plugins/inspect）。 */
  readonly scanPluginCandidates: (sourcePath?: string) => Promise<{ ok: true; candidates: PluginCandidateView[] } | { ok: false; reason: string }>;
  /** 批量插件导入：串行逐条（失败逐条隔离）→ 写后回读 → 逐会话热装（失败降级重开）。 */
  readonly importPlugins: (items: readonly PluginImportRequest[]) => Promise<PluginImportSummary>;
  /** 插件目录刷新（设置页插件分区进入时）。 */
  readonly refreshPlugins: () => Promise<void>;
  /** 移除 vendor 件（热卸活跃会话 + 删 vendor 目录与 registry 条目）。 */
  readonly removePlugin: (name: string) => Promise<{ ok: true; hotFailures: number } | { ok: false; reason: string }>;
  /** agent 提案面板（登记态直读）。 */
  readonly listPluginProposals: () => Promise<{ ok: true; proposals: PluginProposalRow[] } | { ok: false; reason: string }>;
  /** 确认提案（host 内存置位）。 */
  readonly confirmPluginProposal: (proposalId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 拒绝提案。 */
  readonly rejectPluginProposal: (proposalId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 同文件重开会话（不指定 trusted，保持既有信任态）：技能/资源开关生效通路。 */
  readonly reopenSession: (threadId: string) => Promise<boolean>;
  /** 项目文件搜索（@ 引用；cwd 门禁在主进程，失败返回 null）。 */
  readonly searchFiles: (cwd: string, query: string) => Promise<string[] | null>;
  /** 本地 git 分支列表（新任务页分支选择；非仓库为空形态，失败为 {ok:false}）。 */
  readonly listGitBranches: (cwd: string) => Promise<ApiOutcome<'git/branches'>>;
  readonly listGitGraph: (cwd: string) => Promise<ApiOutcome<'git/graph'>>;
  /** 工作区变更速览（速览面板 Git 区数据源）。 */
  readonly listGitStatus: (cwd: string) => Promise<ApiOutcome<'git/status'>>;
  /** 切换/创建并检出分支（成功返回 {ok:true}；失败原因透传，由调用方转文案）。 */
  readonly checkoutGitBranch: (cwd: string, branch: string, create: boolean) => Promise<ApiOutcome<'git/checkout'>>;
  readonly upsertProvider: (input: { name: string; baseUrl: string; api: string; models: ProviderModel[]; apiKey?: string }) => Promise<string | null>;
  readonly removeProvider: (name: string) => Promise<string | null>;
  /** 应用偏好部分写（返回写后视图；失败返回 null，原因走通知条）。 */
  readonly updatePreferences: (patch: { defaultModel?: string | null; onboarded?: boolean; projectModels?: Record<string, string>; pinnedSessions?: string[]; trustedDefault?: boolean; hiddenProjects?: string[]; archivedSessions?: string[]; relay?: RelayConfig; hubDev?: { bunPath: string | null; hubEntry: string | null } }) => Promise<PreferencesView | null>;
  /** provider 连接探活（主进程直发；结果原样透传给调用方做内联展示）。 */
  readonly testProvider: (name: string, modelId: string | undefined) => Promise<{ ok: true; latencyMs: number } | { ok: false; reason: string }>;
  /** 直执行 bash（`!` 前缀）：成功返回 null；权威条目经对账进入对话流。 */
  readonly runBash: (threadId: string, command: string) => Promise<string | null>;
  readonly abortBash: (threadId: string) => Promise<void>;
  /** 在系统文件管理器中显示会话文件（主进程白名单校验）。 */
  readonly revealSession: (sessionPath: string) => Promise<void>;
  /** 从历史条目分叉（seq = WAL 行号，position=before）→ 旧线程镜像终态 + 激活新会话；失败带原因。 */
  readonly forkSession: (threadId: string, seq: number) => Promise<{ ok: true; threadId: string } | { ok: false; reason: string }>;
  /** 轮次边界/线程切换/Usage 页：累计统计 + 上下文分析合并拉取（analytics 失败保持
   *  last-known——与 stats 同构；从未成功拉到时芯片才回落累计口径）。 */
  readonly refreshUsage: (threadId: string) => Promise<void>;
  /** 只读水化链（纳管→直读→model 补齐；force 供重试入口越过 hydrated 守卫）。 */
  readonly ensureHydrated: (threadId: string, options?: { force?: boolean }) => Promise<void>;
}
