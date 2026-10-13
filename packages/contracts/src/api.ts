import { z } from 'zod';
import { GitApiSchemas } from './git-api';

import type { ApiError } from './hub-errors';
import { } from './git-views';
import { PermModeSchema } from './permissions';
import { RuntimeSnapshotViewSchema } from './runtime';
import { InflightViewSchema, PendingDialogViewSchema, SubagentSnapshotViewSchema } from './inflight-views';
import { DiffFileViewSchema, EditHunkViewSchema, SessionViewSchema, SubagentSpawnViewSchema, imagePayload } from './ui-events';
import { UsageSchema } from './usage';
import { IdleRecycleMinutesSchema, ProviderModelSchema, RelayConfigSchema } from './settings';
import { TodoSnapshotEventDataSchema } from './todo-views';
import { THINKING_LEVEL_ORDER } from './thinking-levels';
import {
  CommandViewSchema,
  ModelInfoViewSchema,
  SavedSessionViewSchema,
  SessionStatsViewSchema,
  ThinkingLevelViewSchema,
  ThreadStateViewSchema,
  TokenAnalyticsViewSchema,
} from './session-views';

/**
 * 渲染层 API 面：方法名用应用语义（渲染层不出现协议字面量）。
 * 主进程 api 服务按本表校验参数并翻译为 host-hub 命令；
 * 传输层统一应答 {ok:true,data} | {ok:false,error}（ApiOutcome）。
 */

// —— 视图形状（adapter 从协议响应收窄，渲染层唯一认识的形态）——

/** 历史条目（session/entries 的正规化结果，渲染层水化为对话流）。 */
export const HistoryItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    id: z.string(),
    text: z.string(),
    origin: z.enum(['user', 'system']),
    /** 用户消息携带的图片附件（data URL 渲染缩略图）。 */
    images: z.array(imagePayload),
    /** 条目时刻（ms）：轮次计时行与排序用。 */
    at: z.number(),
    /** 压缩摘要标记（CONTEXT-TOKEN-UNIFICATION §3.4 P5）：replace 型落账命中
     *  isCompactionSummary 谓词时携带——渲染层折叠呈现（单行标记 + 展开）。
     *  缺席 = 普通用户/系统消息（判别形状不变——可选字段不破坏 discriminated union）。 */
    meta: z.literal('compaction-summary').optional(),
    /** 被折叠的历史轮数（splice 计数——M1；meta 在场时有效） */
    foldedTurns: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal('assistant'),
    id: z.string(),
    /** 消息自身的时间戳（ms）= 事件流的消息身份（流式块归并 key）。
     *  与条目 id 不同源：它是「同一条消息」在转写/在途快照/增量流三处的共用 key。
     *  0 = 该条目缺消息时间戳（legacy 降级：块身份退回条目 id）。 */
    messageTs: z.number(),
    text: z.string(),
    thinking: z.string(),
    at: z.number(),
    toolCalls: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        argsPreview: z.string(),
        output: z.string(),
        isError: z.boolean(),
        /** 文件修改类工具的变更视图；null = 非文件修改。 */
        diff: z.array(DiffFileViewSchema).nullable(),
        /** agent 委派工具的子代理执行清单；其余工具不携带。 */
        subagents: z.array(SubagentSpawnViewSchema).optional(),
        /** edit 工具的补丁片段（精确文本替换的原文/新文对）；其余工具不携带。 */
        editHunks: z.array(EditHunkViewSchema).optional(),
      }),
    ),
    usage: UsageSchema.nullable(),
    /** 异常终态（done 增量 stopReason 收窄）；null = 正常结束（stop/toolUse）。 */
    stopReason: z.enum(['error', 'aborted', 'max-tokens']).nullable(),
    /** stopReason=error 时的上游原始错误信息；其余 null。 */
    errorMessage: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('bash'),
    id: z.string(),
    command: z.string(),
    output: z.string(),
    exitCode: z.number(),
    cancelled: z.boolean(),
    at: z.number(),
  }),
]);
export type HistoryItem = z.infer<typeof HistoryItemSchema>;

/**
 * agent 定义的管理面形态（hub 命令面读写 user 级 + project 级直写；
 * tools/model 为 null = 不写 frontmatter 字段 = hub 运行期继承语义：
 * 模型继承父对话，工具用默认集）。name 同时是文件名主干与身份键。
 */
export const AgentDefinitionSchema = z
  .object({
    /** kebab-case（^^[a-z0-9][a-z0-9-]*$$；保留名 fork/main 拒绝）。 */
    name: z.string().min(1),
    /** 一句话职责（单行，≤500 字符）。 */
    description: z.string(),
    systemPrompt: z.string(),
    tools: z.array(z.string()).nullable(),
    model: z.string().nullable(),
    scope: z.enum(['user', 'project']),
    /** scope=project 时的项目绝对路径（写入门禁：必须是本应用已知项目）。 */
    project: z.string().nullable(),
  })
  .strict();
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/** 技能视图（skills/list 与 skills/setEnabled 共用形态；hub skills 域）。 */
export const SkillViewSchema = z
  .object({
    name: z.string(),
    enabled: z.boolean(),
    /** builtin = hub 随包内置；user = <agentDir>/skills（app 数据区）；project = <项目>/.my-agent/skills。 */
    source: z.enum(['builtin', 'user', 'project']),
  })
  .strict();
export type SkillView = z.infer<typeof SkillViewSchema>;

/**
 * 技能候选视图（skills/candidates；导入对话框数据源）。
 * state 三态取自 hub skills/inspect；problem = 中性诊断码（hub SkillProblem 闭集，
 * rename 补 'name_mismatch'）——文案在 strings 按码查表，判定语义不进 app。
 */
export const SkillCandidateViewSchema = z
  .object({
    /** 建议目标名 = 源声明名（缺省）/ 源目录名（无法读 frontmatter 时）。 */
    name: z.string(),
    description: z.string(),
    /** 源技能目录绝对路径（SKILL.md 的父目录）。 */
    sourcePath: z.string(),
    /** 来源根标签：agents|pi|claude = 内置源根；picked = 用户手动选择目录。 */
    origin: z.enum(['agents', 'pi', 'claude', 'picked']),
    /** ready = 可直接导入；rename = name≠源目录名（导入时自动校正）；blocked = 装载器必拒。 */
    state: z.enum(['ready', 'rename', 'blocked']),
    /** blocked/rename 的诊断码（SkillProblemCode ∪ 'name_mismatch'）；ready 恒 null。 */
    problem: z.string().nullable(),
  })
  .strict();
export type SkillCandidateView = z.infer<typeof SkillCandidateViewSchema>;

export const ProviderConfigViewSchema = z.object({
  name: z.string(),
  baseUrl: z.string(),
  api: z.string(),
  models: z.array(ProviderModelSchema),
  /** key 永不回传，只回传有无。 */
  hasKey: z.boolean(),
});
export type ProviderConfigView = z.infer<typeof ProviderConfigViewSchema>;

/** 应用偏好（settings.json 的渲染层视图子集）。 */
export const PreferencesViewSchema = z.object({
  defaultModel: z.string().nullable(),
  onboarded: z.boolean(),
  projectModels: z.record(z.string(), z.string()),
  pinnedSessions: z.array(z.string()),
  trustedDefault: z.boolean(),
  hiddenProjects: z.array(z.string()),
  /** worker 闲置自动回收档位（分钟）。 */
  idleRecycleMinutes: IdleRecycleMinutesSchema,
  archivedSessions: z.array(z.string()),
  /** relay 接入配置（全局统一：settings.json 唯一真相，gateway.json 由其派生）。 */
  relay: RelayConfigSchema,
});
export type PreferencesView = z.infer<typeof PreferencesViewSchema>;

export const BootstrapViewSchema = z.object({
  sessions: z.array(SessionViewSchema),
  saved: z.array(SavedSessionViewSchema),
  models: z.array(ModelInfoViewSchema),
  providers: z.array(ProviderConfigViewSchema),
  preferences: PreferencesViewSchema,
  /** 启动时 host 相位快照；null = host 从未构建（路径未解析/装配失败），模型与会话能力不可用。 */
  hostPhase: z.enum(['starting', 'ready', 'restarting', 'failed']).nullable(),
});
export type BootstrapView = z.infer<typeof BootstrapViewSchema>;

// —— 运行状态面（T29：监控页快照与其组成视图）——


export { HostInfoViewSchema, WorkerRowViewSchema, ResourceSampleViewSchema, RuntimeEventViewSchema, RuntimeSnapshotViewSchema } from './runtime';
export type { HostInfoView, WorkerRowView, ResourceSampleView, RuntimeEventView, RuntimeSnapshotView } from './runtime';

// —— 方法 schema（单一真相）：服务端参数校验，渲染层类型从此推导 ——

const empty = z.object({}).strict();
const threadOnly = z.object({ threadId: z.string().min(1) }).strict();

import { PluginMethodsSchema } from './plugin-views';

export const ApiSchemas = {
  ...GitApiSchemas,
  ...PluginMethodsSchema,
  'app/bootstrap': {
    params: empty,
    result: BootstrapViewSchema,
  },
  'session/start': {
    params: z
      .object({
        cwd: z.string().min(1),
        /** 裸模型 id（hub 三级消歧）；app 级 "provider/modelId" 记忆由主进程拆解。 */
        modelId: z.string().optional(),
        trusted: z.boolean().optional(),
        permissionMode: PermModeSchema.optional(),
        thinkingLevel: z.enum(THINKING_LEVEL_ORDER).optional(),
      })
      .strict(),
    result: SessionViewSchema,
  },
  'session/resume': {
    params: z.object({ sessionPath: z.string().min(1), trusted: z.boolean().optional(), permissionMode: PermModeSchema.optional(), thinkingLevel: z.enum(THINKING_LEVEL_ORDER).optional() }).strict(),
    result: SessionViewSchema,
  },
  'session/register': {
    // parked 会话纳管：冷启动表外会话读命令的前置；幂等、零 worker
    params: z.object({ sessionPath: z.string().min(1) }).strict(),
    result: SessionViewSchema,
  },
  'session/queueDrop': {
    params: z.object({ threadId: z.string().min(1), entryId: z.string().min(1).max(128) }).strict(),
    result: z.null(),
  },
  'session/queueSendNow': {
    params: z.object({ threadId: z.string().min(1), entryId: z.string().min(1).max(128) }).strict(),
    result: z.null(),
  },
  'session/stop': {
    // remove：true = 用户关闭（注册表删行）；false = 内部重开链中间步骤（保行，title/trusted 是 resume 补全源）
    params: z.object({ threadId: z.string().min(1), remove: z.boolean() }).strict(),
    result: z.null(),
  },
  'session/liveThreads': {
    params: empty,
    // relay 形态：host thread/list 行（threadId/cwd/state/streaming/sessionPath）——
    // x-harness host 词表（手机端 history-sync 直接消费）
    result: z.array(z.object({ threadId: z.string(), cwd: z.string(), state: z.string(), streaming: z.boolean(), sessionPath: z.string().nullable() })),
  },
  'session/listSaved': {
    params: z.object({ cwd: z.string().optional() }).strict(),
    result: z.array(SavedSessionViewSchema),
  },
  'session/prompt': {
    // 纯图消息合法（message 与 images 至少其一非空）：fork 重试带图消息无文本形态。
    // 应答 = 受理；终态经 turnSettled 事件（settled{sendId,ok}）。
    params: z
      .object({
        threadId: z.string().min(1),
        message: z.string(),
        streamingBehavior: z.enum(['steer', 'followUp']).optional(),
        images: z.array(imagePayload).optional(),
      })
      .strict()
      .refine((params) => params.message.length > 0 || (params.images?.length ?? 0) > 0, {
        message: 'message_or_images_required',
      }),
    // 普通消息 = null（受理）；/compact 词形直发 compact 命令时 = 压缩三元组（响应即终态）
    result: z
      .object({ summary: z.string(), replacedCount: z.number().int(), summaryTokens: z.number().int() })
      .nullable(),
  },
  'session/abort': {
    params: threadOnly,
    result: z.null(),
  },
  'session/entries': {
    // 游标 = WAL seq（整数；与 get_inflight.turnStartSeq 同域）；null = 尚无条目。
    params: z.object({ threadId: z.string().min(1), since: z.number().int().nonnegative().optional() }).strict(),
    result: z.object({
      items: z.array(HistoryItemSchema),
      /** 已消费到的最后条目 seq（下一次 since 游标）；null = 尚无条目。 */
      cursor: z.number().int().nullable(),
      /** 本窗口内最后一条 todo/snapshot（窗口内无快照 = null——不清既有快照）。 */
      todo: TodoSnapshotEventDataSchema.nullable(),
    }),
  },
  'session/state': {
    params: threadOnly,
    result: ThreadStateViewSchema,
  },
  'session/inflight': {
    params: threadOnly,
    result: InflightViewSchema,
  },
  'session/subagents': {
    params: threadOnly,
    result: z.object({ subagents: z.array(SubagentSnapshotViewSchema) }),
  },
  'session/pendingDialogs': {
    params: threadOnly,
    result: z.object({ dialogs: z.array(PendingDialogViewSchema) }),
  },
  'session/stats': {
    params: threadOnly,
    result: SessionStatsViewSchema,
  },
  'session/tokenAnalytics': {
    params: threadOnly,
    result: TokenAnalyticsViewSchema,
  },
  'session/setName': {
    params: z.object({ threadId: z.string().min(1), name: z.string().min(1) }).strict(),
    result: z.null(),
  },
  'session/setModel': {
    // 下一 turn 生效（hub append model-change 事件）——UI 指示容忍错位窗口。
    params: z.object({ threadId: z.string().min(1), provider: z.string().min(1), modelId: z.string().min(1) }).strict(),
    result: z.null(),
  },
  'session/setThinking': {
    params: z.object({ threadId: z.string().min(1), level: z.enum(THINKING_LEVEL_ORDER) }).strict(),
    result: z.null(),
  },
  'session/thinkingLevels': {
    params: threadOnly,
    result: ThinkingLevelViewSchema,
  },
  'model/list': {
    params: empty,
    result: z.array(ModelInfoViewSchema),
  },
  'dialog/respond': {
    params: z
      .object({
        requestId: z.string().min(1),
        payload: z.record(z.string(), z.unknown()),
      })
      .strict(),
    result: z.null(),
  },
  'subagent/steer': {
    params: z
      .object({ threadId: z.string().min(1), agentId: z.string().min(1), message: z.string().min(1) })
      .strict(),
    result: z.null(),
  },
  'command/list': {
    params: z.object({ threadId: z.string().min(1) }).strict(),
    result: z.array(CommandViewSchema),
  },
  /** 预会话命令目录（新建任务页无 threadId 可寻址）：用户级启用技能以 skill: 条目
   * 预构；plugin/builtin 源依赖会话态，建会话后以 command/list 为准。 */
  'command/preview': {
    params: empty,
    result: z.array(CommandViewSchema),
  },
  'agent/definitions': { /** agent 定义管理枚举（user = hub agents/list；project = 各已知项目 .my-agent/agents；含 systemPrompt 原文）。 */
    params: empty,
    result: z.array(AgentDefinitionSchema),
  },
  'agent/upsert': { /** agent 定义新建/编辑（previous 给定时含改名与作用域移动；身份键 = name+scope+project）。 */
    params: z
      .object({
        definition: AgentDefinitionSchema,
        previous: z.object({ name: z.string().min(1), scope: z.enum(['user', 'project']), project: z.string().nullable() }).nullable(),
      })
      .strict(),
    result: z.null(),
  },
  'agent/remove': { /** agent 定义删除（user = agents/remove 命令；project = 删项目内文件；运行中的子代理不受影响）。 */
    params: z.object({ name: z.string().min(1), scope: z.enum(['user', 'project']), project: z.string().nullable() }).strict(),
    result: z.null(),
  },
  'file/search': { /** 项目文件搜索（@ 引用数据源；cwd 必须是本应用已知会话目录）。 */
    params: z.object({ cwd: z.string().min(1), query: z.string() }).strict(),
    result: z.array(z.string()),
  },
  /**
   * 读取项目文件文本（代码查看器/Markdown 预览数据源）：只读、相对路径、
   * 点前缀段拒绝（与 file/search 枚举面一致，越界 cwd 同为 cwd_forbidden）；
   * size 为磁盘真实字节数，超过读取上限时截断并 truncated=true。
   */
  'file/read': {
    params: z.object({ cwd: z.string().min(1), path: z.string().min(1) }).strict(),
    result: z
      .object({
        content: z.string(),
        truncated: z.boolean(),
        size: z.number().int().nonnegative(),
      })
      .strict(),
  },
  'shell/open': { /** 在系统工具中打开已知项目目录（访达/文件管理器、终端、编辑器）；动作落审计。 */
    params: z.object({ cwd: z.string().min(1), target: z.enum(['finder', 'terminal', 'editor']) }).strict(),
    result: z.null(),
  },
  /** 从历史条目分叉（seq = WAL 行号；position before|at，默认 before）→ 新会话视图。
   *  流式中 hub 拒绝（thread is streaming）——调用方先 abort。 */
  'session/fork': {
    params: z.object({ threadId: z.string().min(1), seq: z.number().int().positive(), position: z.enum(['before', 'at']).optional() }).strict(),
    result: SessionViewSchema,
  },
  'session/reveal': { /** 在系统文件管理器中显示会话文件（路径白名单同 resume）。 */
    params: z.object({ sessionPath: z.string().min(1) }).strict(),
    result: z.null(),
  },
  /** 系统目录选择对话框（单选，可新建）；null = 用户取消。 */
  'dialog/pickDirectory': {
    params: z.object({ defaultPath: z.string().min(1).optional() }).strict(),
    result: z.string().nullable(),
  },
  'skills/list': { /** 用户级技能目录（含启用态；启停真相 = hub-settings.json skills.disabled，经 skills/set_enabled）。 */
    params: empty,
    result: z.array(SkillViewSchema),
  },
  /** 技能启用/禁用（写 hub skills.disabled 名单；结果为写后的完整清单）。 */
  'skills/setEnabled': {
    params: z.object({ name: z.string().min(1), enabled: z.boolean() }).strict(),
    result: z.array(SkillViewSchema),
  },
  'skills/candidates': { /** 技能候选扫描（导入对话框数据源）：无 sourcePath = 扫固定源根；有 = 扫该目录（须在批准根之下）。 */
    params: z.object({ sourcePath: z.string().min(1).optional() }).strict(),
    result: z.object({ candidates: z.array(SkillCandidateViewSchema) }).strict(),
  },
  'skills/import': { /** 导入单个技能（经 hub skills/install；name = 目标名，副本 frontmatter name 行同步改写；结果为写后完整清单）。 */
    params: z
      .object({
        sourcePath: z.string().min(1),
        /** 目标目录名；缺省 = 源 SKILL.md 的 frontmatter name（装载器要求二者一致）。 */
        name: z.string().min(1).optional(),
        /** 同名已存在时是否覆盖（缺省 false = 拒）。 */
        overwrite: z.boolean().default(false),
      })
      .strict(),
    result: z
      .object({
        skills: z.array(SkillViewSchema),
        imported: z.object({ name: z.string(), path: z.string() }).strict(),
      })
      .strict(),
  },
  'skills/remove': { /** 删除用户级技能（hub skills/remove；删整技能目录——含捆绑文件）。 */
    params: z.object({ name: z.string().min(1) }).strict(),
    result: z.array(SkillViewSchema),
  },
  /** 清空排队消息（协议仅全清，无单条操作）。 */
  'session/clearQueue': {
    params: threadOnly,
    result: z.null(),
  },
  'session/bash': { /** 直执行 shell（结果在 response；流式经 bashOutput 事件；>64KiB 截断置 truncated）。 */
    params: z.object({ threadId: z.string().min(1), command: z.string().min(1) }).strict(),
    result: z.object({ output: z.string(), exitCode: z.number().int(), cancelled: z.boolean(), truncated: z.boolean(), fullOutputPath: z.string().nullable() }).strict(),
  },
  'session/abortBash': {
    params: threadOnly,
    result: z.null(),
  },
  'permission/mode': { /** 会话权限模式读（permission/get_mode；source = 生效层级；modes = host 词表——UI 选项渲染源）。 */
    params: threadOnly,
    result: z.object({ mode: z.string(), source: z.enum(['session', 'project', 'user', 'default']), modes: z.array(z.string()) }).strict(),
  },
  /** 会话权限模式写（permission/set_mode；下一工具裁决生效）。 */
  'permission/setMode': {
    params: z.object({ threadId: z.string().min(1), mode: PermModeSchema }).strict(),
    result: z.null(),
  },
  /** hub 用户级设置读（settings/get；null = 未设置，按 hub 缺省；permissionModes = host 词表——设置页选项面）。 */
  'app/hubSettings': {
    params: empty,
    result: z
      .object({
        permissionDefaultMode: PermModeSchema.nullable(),
        thinkingDefault: z.enum(THINKING_LEVEL_ORDER).nullable(),
        permissionModes: z.array(z.string()),
      })
      .strict(),
  },
  /** hub 用户级设置写（settings/set；省略字段不写）。 */
  'app/setHubSettings': {
    params: z
      .object({
        permissionDefaultMode: PermModeSchema.nullable().optional(),
        thinkingDefault: z.enum(THINKING_LEVEL_ORDER).nullable().optional(),
      })
      .strict(),
    result: z.null(),
  },
  'provider/upsert': {
    params: z
      .object({
        name: z.string().min(1),
        baseUrl: z.string().min(1),
        api: z.string().min(1),
        models: z.array(ProviderModelSchema).min(1),
        /** 省略 = 保留既有 key。 */
        apiKey: z.string().optional(),
      })
      .strict(),
    result: z.array(ProviderConfigViewSchema),
  },
  'provider/remove': {
    params: z.object({ name: z.string().min(1) }).strict(),
    result: z.array(ProviderConfigViewSchema),
  },
  'provider/test': { /** 连接探活：主进程直发指定模型的最小完成请求（缺省 = 渠道第一个模型），不经 hub、不落状态。 */
    params: z.object({ name: z.string().min(1), modelId: z.string().min(1).optional() }).strict(),
    result: z.object({ latencyMs: z.number().int().nonnegative() }).strict(),
  },
  'app/runtime': { /** 运行状态快照（T29 监控页 2s 轮询；host 未构建时安全降级 hostInfo=null）。 */
    params: empty,
    result: RuntimeSnapshotViewSchema,
  },
  /** 宿主 stderr 尾部（64KB 环；按需拉取不进 2s 快照）。 */
  'app/diagnosticLog': {
    params: empty,
    result: z.object({ stderrTail: z.string() }).strict(),
  },
  /** 闲置回收档位（唯一写路径：settings 持久 + set_idle_retire_ms 运行期生效）。 */
  'app/setIdleRecycle': {
    params: z.object({ minutes: IdleRecycleMinutesSchema }).strict(),
    result: z.object({ minutes: IdleRecycleMinutesSchema }).strict(),
  },
  /** 诊断包导出（userData/diagnostics/<ts>/ 目录 + Finder 定位）。 */
  'app/exportDiagnostics': {
    params: empty,
    result: z.object({ directory: z.string() }).strict(),
  },
  'session/retire': { /** 手动回收空闲 worker（thread/retire；会话保留转 parked）。 */
    params: threadOnly,
    result: z.null(),
  },
  'session/delete': { /** 会话删除（thread/delete：trash 原子 rename + 血缘级联；幂等；活族先拒）。 */
    params: z.object({ sessionPath: z.string().min(1) }).strict(),
    result: z.object({ removed: z.array(z.string()) }),
  },
  /** 强制回收（clear_queue + abort + thread/retire 逐条容错；对失控生成一步到位）。 */
  'session/forceRetire': {
    params: threadOnly,
    result: z.null(),
  },
  /** 常驻开关（registry 持久真相 + hub 表项置位；parked 未纳管先 register）。 */
  'session/setKeepalive': {
    params: z.object({ threadId: z.string().min(1), keepalive: z.boolean() }).strict(),
    result: z.null(),
  },
  /** 手动重启 host（走既有 restart 链路；审计落账）。 */
  'app/restartHost': {
    params: empty,
    result: z.null(),
  },
  /** 应用偏好部分写（至少一个字段；结果为写后的完整偏好视图）。 */
  'app/setPreference': {
    params: z
      .object({
        defaultModel: z.string().nullable().optional(),
        onboarded: z.boolean().optional(),
        projectModels: z.record(z.string(), z.string()).optional(),
        pinnedSessions: z.array(z.string()).optional(),
        trustedDefault: z.boolean().optional(),
        hiddenProjects: z.array(z.string()).optional(),
        archivedSessions: z.array(z.string()).optional(),
        /** relay 接入配置（全局统一；改写后网关需重启重载）。 */
        relay: RelayConfigSchema.optional(),
      })
      .strict()
      .refine(
        (value) =>
          value.defaultModel !== undefined ||
          value.onboarded !== undefined ||
          value.projectModels !== undefined ||
          value.pinnedSessions !== undefined ||
          value.trustedDefault !== undefined ||
          value.hiddenProjects !== undefined ||
          value.archivedSessions !== undefined ||
          value.relay !== undefined,
        { message: 'empty_preference' },
      ),
    result: PreferencesViewSchema,
  },
} as const;

export type ApiMethod = keyof typeof ApiSchemas;
export const API_METHODS = Object.keys(ApiSchemas) as readonly ApiMethod[];

/** 渲染层调用参数/结果类型推导入口。 */
export type ApiParams<M extends ApiMethod> = z.infer<(typeof ApiSchemas)[M]['params']>;
export type ApiData<M extends ApiMethod> = z.infer<(typeof ApiSchemas)[M]['result']>;

/** 传输层统一应答形态（preload 返回值；失败为 ApiError 判别联合）。 */
export type ApiOutcome<M extends ApiMethod> = { ok: true; data: ApiData<M> } | { ok: false; error: ApiError };
