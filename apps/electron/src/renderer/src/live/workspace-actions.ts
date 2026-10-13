import type { AgentDefinition, ApiOutcome, CommandView, IdleRecycleMinutes, ImagePayload, PluginCandidateView, PluginProposalRow, ProviderModel, RelayConfig, RuntimeSnapshotView, SkillCandidateView } from '@x3code/contracts';
import { thinkingLevelOfLabel } from '@x3code/contracts';

import { writeClipboard } from '@/lib/write-clipboard';
import { copyOfError } from '@/lib/error-text';
import { copy } from '@/strings';
import { entrySeqOf } from './entry-seq';
import { resourceActions } from './resource-actions';
import type { PluginImportRequest, PluginImportSummary, SkillImportRequest, SkillImportSummary } from './live-controller-types';
import { parseModelKey, pickSessionModel } from './pick-session-model';
import { notifySubmitFailure } from './submit-notify';
import { apiClient, controller, store } from './workspace-runtime';
import { uiStore } from '@/ui/ui-store';
import { statsTargetsOf } from './stats-targets';
import { pendingEchoes } from './pending-echoes';

/** 投递结算（成功/失败/异常统一入口）：失败撤 pending 气泡并把文本回填草稿
 *  （重发不变措辞）；成功发回底跟随信号。 */
function settleSubmit(threadId: string, localId: string, message: string, reason: string | null): void {
  notifySubmitFailure(reason);
  if (reason === null) {
    // 发送成功 = 用户主动看最新：回底一次性信号（threadId 寻址，舞台消费即贴底跟随）
    uiStore.getState().requestFollowLatest(threadId);
    return;
  }
  // 失败：按 localId 精确出队回滚（不与后续提交的回显混淆；即使彼时队列里已有新条目）。
  // 回显不在队：气泡若还在场（认领异常序）直接除名并回填草稿；已不在场 = 被认领
  // 收敛（权威气泡承载文本），不得回填（否则「已发出的消息又出现在输入框»）。
  const queue = pendingEchoes.get(threadId);
  const index = queue === undefined ? -1 : queue.findIndex((entry) => entry.localId === localId);
  if (queue === undefined || index === -1) {
    const stillPending = (store.getState().threads[threadId]?.items ?? []).some(
      (item) => item.kind === 'message' && item.message.id === `msg-${localId}`,
    );
    if (stillPending) store.getState().dropPendingMessage(threadId, localId);
    if (!stillPending) uiStore.getState().setDraft(threadId, message);
    return;
  }
  const [entry] = queue.splice(index, 1);
  if (queue.length === 0) pendingEchoes.delete(threadId);
  if (entry === undefined) return;
  store.getState().dropPendingMessage(threadId, entry.localId);
  uiStore.getState().setDraft(threadId, message);
}

/**
 * 稳定动作面：引用恒定（不随渲染重建），全部动作在调用时读 store 真相，
 * 消灭闭包旧值与「actions 换引用击穿子组件 memo / effect 重挂」两类问题。
 * 唯一外来依赖是 hook 注入的 setState setter（引用本身恒定）。
 */

export type WorkspaceActions = {
  readonly submitDraft: (message: string, images?: readonly ImagePayload[], mode?: 'auto' | 'steer' | 'followUp') => string | null;
  readonly stopActiveTurn: () => void;
  /** 移除排队消息（threadId + entryId 寻址 hub inbox 条目；threadId 由卡片渲染处
   *  闭包捕获，不用点击时刻的活跃会话——防渲染后切会话的错投窗口）。 */
  readonly removeQueuedMessage: (threadId: string, entryId: string) => void;
  /** 编辑排队消息：移除条目并把文本回填输入框草稿（可改后重发）。失败不回填。 */
  readonly editQueuedMessage: (threadId: string, entryId: string) => void;
  /** 排队消息立即改向当前轮（仅生成中可行动；空闲条目留在队列）。 */
  readonly sendQueuedMessageNow: (threadId: string, entryId: string) => void;
  readonly selectSession: (threadId: string) => void;
  readonly createSession: (input: {
    cwd: string
    trusted?: boolean
    /** `provider/modelId`；缺省按项目记忆 → 全局默认 → 当前会话 → 首个可用重算 */
    model?: string
    thinkingLevel?: string
    permissionMode?: string
  }) => Promise<boolean>;
  /** 新建任务页提交：建会话 → 投首条消息；sendFailed 时调用方把文本回填到新会话草稿槽。 */
  readonly startTask: (input: {
    cwd: string
    trusted: boolean
    /** `provider/modelId` */
    model: string
    /** null = 不干预（hub 按 settings 缺省） */
    permissionMode: string | null
    /** 思考档（协议档位值；null = 跟随缺省） */
    thinkingLevel: string | null
    text: string
    images?: readonly ImagePayload[]
  }) => Promise<{ ok: true; threadId: string; sendFailed: boolean } | { ok: false }>;
  /** 新任务页初始模型键（项目记忆 → 全局默认 → 当前会话 → 首个可用；无模型返回 ''）。 */
  readonly defaultModelFor: (cwd: string) => string;
  readonly openSavedSession: (sessionPath: string) => Promise<boolean>;
  readonly closeSession: (threadId: string) => void;
  readonly selectModel: (value: string) => void;
  readonly selectEffort: (value: string) => void;
  readonly respondDialog: (requestId: string, payload: Record<string, unknown>) => void;
  readonly cancelDialog: (requestId: string) => void;
  readonly dismissNotice: (id: string) => void;
  readonly refreshSaved: () => void;
  readonly refreshModels: () => void;
  readonly setDefaultModel: (value: string | null) => void;
  readonly completeOnboarding: () => void;
  /** 重跑新手引导：onboarded 置回 false（偏好推回后工作区切回引导屏）。 */
  readonly restartOnboarding: () => Promise<boolean>;
  /** hub 用户级缺省读取（新任务页权限控件/思考档缺省数据源）。 */
  readonly refreshHubSettings: () => void;
  /** hub 用户级缺省写入（设置页权限分区）；失败 notice。 */
  readonly saveHubDefaults: (patch: { permissionDefaultMode?: string | null; thinkingDefault?: string | null }) => Promise<boolean>;
  /** 活跃会话权限模式读取（permission/mode）。 */
  readonly refreshSessionPermissionMode: () => void;
  /** 操作栏会话权限模式切换（permission/setMode，下一工具裁决生效）；失败 notice。 */
  readonly setSessionPermissionMode: (mode: string) => Promise<boolean>;
  readonly refreshAgentDefinitions: () => void;
  /** 子 agent 定义保存（新建/编辑/改名/移动统一）；失败 reason 交表单内联呈现。 */
  readonly upsertAgentDefinition: (definition: AgentDefinition, previous: { name: string; scope: 'user' | 'project'; project: string | null } | null) => Promise<string | null>;
  /** 子 agent 定义删除；失败 reason 交表单内联呈现。 */
  readonly removeAgentDefinition: (key: { name: string; scope: 'user' | 'project'; project: string | null }) => Promise<string | null>;
  /** 技能目录刷新（设置页技能分区进入时）。 */
  readonly refreshSkills: () => void;
  /** 预会话命令目录（新建任务页打开时拉取；失败空目录降级）。 */
  readonly fetchCommandPreview: () => Promise<CommandView[]>;
  /** 技能启停：落盘后重开全部活跃会话使新设置生效（失败 notice）。 */
  readonly setSkillEnabled: (name: string, enabled: boolean) => Promise<boolean>;
  /** 技能候选扫描（导入对话框数据源；失败 null + notice）。 */
  readonly scanSkillCandidates: (sourcePath?: string) => Promise<SkillCandidateView[] | null>;
  /** 批量技能导入：返回逐条失败明细供汇总渲染（重开失败 notice）。 */
  readonly importSkills: (items: readonly SkillImportRequest[]) => Promise<SkillImportSummary>;
  /** 删除用户级技能（删整技能目录；失败 notice）。 */
  readonly removeSkill: (name: string) => Promise<boolean>;
  /** 插件目录刷新（设置页插件分区进入时）。 */
  readonly refreshPlugins: () => void;
  /** 插件启停：写 hub 名单 + 活跃会话热装/热卸（失败降级重开；仍败 notice）。 */
  readonly setPluginEnabled: (name: string, enabled: boolean) => Promise<boolean>;
  /** 插件候选扫描（导入对话框数据源；失败 null + notice）。 */
  readonly scanPluginCandidates: (sourcePath?: string) => Promise<PluginCandidateView[] | null>;
  /** 批量插件导入：返回逐条失败明细供汇总渲染（热装失败 notice）。 */
  readonly importPlugins: (items: readonly PluginImportRequest[]) => Promise<PluginImportSummary>;
  /** 移除 vendor 件（热卸 + 删目录；失败 notice）。 */
  readonly removePlugin: (name: string) => Promise<boolean>;
  /** agent 提案面板（登记态直读；失败 null）。 */
  readonly listPluginProposals: () => Promise<PluginProposalRow[] | null>;
  /** 确认提案（host 内存置位）。 */
  readonly confirmPluginProposal: (proposalId: string) => Promise<boolean>;
  /** 拒绝提案。 */
  readonly rejectPluginProposal: (proposalId: string) => Promise<boolean>;
  readonly searchFiles: (query: string) => Promise<string[] | null>;
  /** 指定目录的 @ 文件搜索（新任务页无活跃会话，按所选目录搜索）。 */
  readonly searchFilesIn: (cwd: string, query: string) => Promise<string[] | null>;
  /** 本地 git 分支列表（非仓库为空形态；失败 {ok:false}）。 */
  readonly listGitBranches: (cwd: string) => Promise<ApiOutcome<'git/branches'>>;
  /** 本地 git 图谱（分支面板「Git 图谱」入口数据源）。 */
  readonly listGitGraph: (cwd: string) => Promise<ApiOutcome<'git/graph'>>;
  /** 工作区变更速览（速览面板 Git 区数据源）。 */
  readonly listGitStatus: (cwd: string) => Promise<ApiOutcome<'git/status'>>;
  /** 切换/创建并检出分支（失败原因交调用方转文案：切换走通知条，创建走弹窗内联）。 */
  readonly checkoutGitBranch: (cwd: string, branch: string, create: boolean) => Promise<ApiOutcome<'git/checkout'>>;
  readonly runBash: (command: string) => Promise<string | null>;
  readonly abortBash: () => void;
  readonly revealSession: (sessionPath: string) => void;
  /** 系统目录选择对话框；null = 取消（新会话弹窗浏览入口）。 */
  readonly pickDirectory: (defaultPath: string | null) => Promise<string | null>;
  readonly togglePinnedSession: (sessionPath: string) => void;
  /** 移除项目 = 隐藏该 cwd 的全部会话（同目录新建任务解除）。 */
  readonly removeProject: (cwd: string) => void;
  /** 项目文件清单（空查询全量 ≤200 条相对路径；cwd 须为已知会话目录）。 */
  readonly listProjectFiles: (cwd: string) => Promise<string[] | null>;
  /** 从历史条目分叉（entryId = `seq-<n>` 水化条目 id；解析失败返回 null 并提示）。 */
  readonly forkFromEntry: (entryId: string) => Promise<string | null>;
  readonly reloadSessionTrusted: (threadId: string, trusted: boolean) => void;
  /** 向运行中子代理注入 steer（agentId 寻址）。 */
  readonly steerSubagent: (agentId: string, message: string) => void;
  readonly restartHost: () => void;
  /** 指定线程停止当前轮（运行状态页执行中行的停止操作；活跃线程走 stopActiveTurn）。 */
  readonly stopThread: (threadId: string) => void;
  /** 运行状态快照（T29 监控页轮询；失败 null 保持旧值）。 */
  readonly fetchRuntime: () => Promise<RuntimeSnapshotView | null>;
  /** 宿主 stderr 尾部（按需）。 */
  readonly fetchDiagnosticLog: () => Promise<string | null>;
  /** 手动/强制回收（失败推通知条）。 */
  readonly retireSession: (threadId: string) => Promise<void>;
  readonly forceRetireSession: (threadId: string) => Promise<void>;
  /** 常驻开关（失败推通知条）。 */
  readonly setKeepalive: (threadId: string, keepalive: boolean) => Promise<void>;
  /** 闲置回收档位（失败推通知条）。 */
  readonly setIdleRecycle: (minutes: IdleRecycleMinutes) => Promise<void>;
  /** 诊断包导出；失败推通知条，返回是否成功（成功提示由调用方给）。 */
  readonly exportDiagnostics: () => Promise<boolean>;
  /** 历史水化失败的重试（活跃会话全量重拉）。 */
  readonly retryHydration: () => void;
  /** 打开 Usage 页时对全部活跃线程补拉 stats（防未访问会话显示 0）。 */
  readonly refreshAllStats: () => void;
  /** 通用通知（bash 携图拒绝等接线层提示）。 */
  readonly showNotice: (text: string) => void;
  /** J2 通用偏好保存（trustedDefault / 宿主路径）。 */
  readonly saveGeneralPreferences: (patch: { trustedDefault?: boolean }) => Promise<boolean>;
  /** 保存 relay 配置（写 settings.json 唯一真相 + 网关重启重载）。 */
  readonly saveRelay: (relay: RelayConfig) => Promise<boolean>;
  readonly testProvider: (name: string, modelId: string | undefined) => Promise<{ ok: true; latencyMs: number } | { ok: false; reason: string }>;
  readonly upsertProvider: (input: { name: string; baseUrl: string; api: string; models: ProviderModel[]; apiKey?: string }) => Promise<string | null>;
  readonly removeProvider: (name: string) => Promise<string | null>;
  readonly renameSession: (threadId: string, name: string) => Promise<boolean>;
  /** 归档：关闭会话（文件保留）+ archivedSessions 偏好标记；侧栏与历史默认隐藏。 */
  readonly archiveSession: (threadId: string) => void;
  /** 取消归档（设置页历史分区恢复入口）。 */
  readonly unarchiveSession: (sessionPath: string) => void;
  /** 在系统工具中打开已知项目目录（访达/终端/编辑器）；失败走通知条。 */
  readonly openInSystem: (cwd: string, target: 'finder' | 'terminal' | 'editor') => Promise<void>;
  /** 剪贴板写入（复制路径/会话 ID）；失败走通知条。 */
  readonly copyText: (text: string) => Promise<boolean>;
};

/** 通知条写入（store 动作的便捷别名；保留最近 5 条）。 */
function pushNotice(text: string): void {
  store.getState().pushNotice(text);
}

/** 会话权限模式写链：写 + 回读成对串行排队，防并发写后回读乱序覆盖生效视图（与 controller.skillToggleChain 同型）。 */
let permissionModeWriteChain: Promise<void> = Promise.resolve();

function activeThreadOf(): string {
  return store.getState().activeThreadId ?? '';
}

/** 新会话模型选择链（调用时读 store 真相）：项目记忆 → 全局默认 → 当前会话 → 首个可用。 */
function defaultModelKey(cwd: string): string {
  const state = store.getState();
  const active = state.activeThreadId !== null ? state.sessions[state.activeThreadId] : undefined;
  const firstModel = state.models[0];
  const fallback = firstModel !== undefined ? `${firstModel.provider}/${firstModel.modelId}` : '';
  const picked = pickSessionModel(
    state.models,
    state.preferences.projectModels[cwd] ?? state.preferences.defaultModel,
    active?.model ?? fallback,
  );
  return picked !== undefined ? `${picked.provider}/${picked.modelId}` : '';
}

export function createWorkspaceActions(): WorkspaceActions {
  /** 建会话的共用路径（新会话入口与新建任务页首条提交）：失败推通知条，成功解除项目隐藏。 */
  const openSession = async (input: {
    cwd: string
    trusted?: boolean
    model?: string
    thinkingLevel?: string
    permissionMode?: string
  }): Promise<{ ok: true; threadId: string } | { ok: false }> => {
    const model = parseModelKey(input.model ?? defaultModelKey(input.cwd));
    const outcome = await controller.createSession({
      cwd: input.cwd,
      trusted: input.trusted,
      model: model ?? undefined,
      thinkingLevel: input.thinkingLevel,
      permissionMode: input.permissionMode,
    });
    if (!outcome.ok) {
      // 失败文案已由 controller.createSession 经 errorCopy 查表定型（含思考档指引/宿主未就绪等分派）
      pushNotice(outcome.reason);
      return { ok: false };
    }
    // 同目录新建任务 = 解除项目隐藏（移除项目的恢复通路）
    const hidden = store.getState().preferences.hiddenProjects;
    if (hidden.includes(input.cwd)) {
      void controller.updatePreferences({ hiddenProjects: hidden.filter((path) => path !== input.cwd) });
    }
    return { ok: true, threadId: outcome.threadId };
  };

  return {
    submitDraft: (message, images, mode) => {
      // 调用时读 store 真相：fork/重开等异步链路后的旧闭包不得打到旧线程；
      // 空舞台守卫/parked 懒唤醒/unknown_thread 自愈在主进程 session/prompt 管线内
      const threadId = activeThreadOf();
      // 回显标识先铸（无论是否回显都要传结结算——失败回滚按它精确对账）
      const localId = `local-${threadId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (message.trim().length > 0 && mode !== 'steer') {
        // 乐观回显：同 tick 上屏 pending 气泡（直执行 `! ` 不回显——结果条目由 bash 事件
        // 呈现；steer 不回显——注入消息非用户气泡；纯图无文本消息不回显——
        // 失败回填草稿仅携文本，回显会造出失败后无法复原的气泡）。回显身份
        // `msg-<localId>`；权威气泡到达时由 onEvent 侧按 WAL seq 收敛到 `msg-seq-<seq>`。
        store.getState().echoPendingMessage(
          threadId,
          localId,
          message,
          (images ?? []).map(({ data, mediaType }) => ({ data, mimeType: mediaType })),
        );
        pendingEchoes.set(threadId, [...(pendingEchoes.get(threadId) ?? []), { localId, text: message }]);
      }
      void controller.submitDraft(threadId, message, images, mode).then((reason) => settleSubmit(threadId, localId, message, reason), () => settleSubmit(threadId, localId, message, 'rejected'));
      return null;
    },
    stopActiveTurn: () => void controller.stopActiveTurn(activeThreadOf()),
    removeQueuedMessage: (threadId, entryId) => {
      if (threadId.length === 0) return;
      void controller.queueDrop(threadId, entryId).then((outcome) => {
        // 条目已入轮/已被清空（点击竞态）：镜像由 queueChanged 收敛，提示解释卡片为何未消失
        if (outcome === 'consumed') pushNotice(copy.flow.queuedEntryConsumed);
        else if (outcome === 'failed') pushNotice(copy.flow.queueOpFailed);
      });
    },
    editQueuedMessage: (threadId, entryId) => {
      if (threadId.length === 0) return;
      const text = store.getState().threads[threadId]?.queue.followUp.find((entry) => entry.id === entryId)?.text;
      void controller.queueDrop(threadId, entryId).then((outcome) => {
        if (outcome === 'consumed') {
          pushNotice(copy.flow.queuedEntryConsumed);
          return;
        }
        if (outcome !== 'ok') {
          pushNotice(copy.flow.queueOpFailed);
          return;
        }
        // 回填草稿（非空草稿追加，不覆盖在编内容）；空文本条目（纯图）只移除不回填
        if (text === undefined || text.length === 0) return;
        const current = uiStore.getState().drafts[threadId] ?? '';
        uiStore.getState().setDraft(threadId, current.length > 0 ? `${current}\n${text}` : text);
      });
    },
    sendQueuedMessageNow: (threadId, entryId) => {
      if (threadId.length === 0) return;
      void controller.queueSendNow(threadId, entryId).then((outcome) => {
        // 无可注入的运行中轮：条目留在队列（下轮 step0 消费），提示不对「已改向」说谎
        if (outcome === 'window') pushNotice(copy.flow.queuedSendNowUnavailable);
        else if (outcome === 'consumed') {
          pushNotice(copy.flow.queuedEntryConsumed);
          // 竞态撞已消费：条目已入轮（消息在流里），与受理同口径回底
          uiStore.getState().requestFollowLatest(threadId);
        } else if (outcome === 'ok') {
          // 立即改向受理成功：消息即刻注入当前轮，用户主动看最新 → 回底跟随
          uiStore.getState().requestFollowLatest(threadId);
        } else if (outcome === 'failed') pushNotice(copy.flow.queueOpFailed);
      });
    },
    selectSession: (threadId) => controller.selectSession(threadId),
    createSession: async (input) => (await openSession(input)).ok,
    startTask: async (input) => {
      const created = await openSession({
        cwd: input.cwd,
        trusted: input.trusted,
        model: input.model,
        thinkingLevel: input.thinkingLevel ?? undefined,
        permissionMode: input.permissionMode ?? undefined,
      });
      if (!created.ok) return { ok: false };
      // 首条消息投递：失败不撤销会话（threadId 已返回，调用方把文本回填草稿槽）
      const reason = await controller.submitDraft(created.threadId, input.text, input.images);
      notifySubmitFailure(reason);
      return { ok: true, threadId: created.threadId, sendFailed: reason !== null };
    },
    defaultModelFor: (cwd) => defaultModelKey(cwd),
    openSavedSession: (sessionPath) => controller.openSavedSession(sessionPath),
    closeSession: (threadId) => void controller.closeSession(threadId),
    selectEffort: (value: string) => {
      void controller.selectThinking(activeThreadOf(), thinkingLevelOfLabel(value));
    },
    selectModel: (value: string) => {
      const state = store.getState();
      const model = state.models.find((entry) => `${entry.provider}/${entry.modelId}` === value);
      if (model === undefined) return;
      const threadId = state.activeThreadId ?? '';
      void controller.selectModel(threadId, model.provider, model.modelId);
      // 项目默认模型记忆（A4）：该 cwd 下次新建会话预选
      const cwd = state.activeThreadId !== null ? state.sessions[state.activeThreadId]?.cwd : undefined;
      if (cwd !== undefined && cwd.length > 0) {
        // 记忆上限 50 项：超出按插入序淘汰最旧（防 settings.json 无界增长）
        const entries = [...Object.entries(state.preferences.projectModels), [cwd, value] as const];
        const projectModels = Object.fromEntries(entries.slice(Math.max(0, entries.length - 50)));
        void controller.updatePreferences({ projectModels });
      }
    },
    respondDialog: (requestId, payload) => void controller.respondDialog(requestId, payload),
    cancelDialog: (requestId) => void controller.cancelDialog(requestId),
    dismissNotice: (id) => store.getState().dismissNotice(id),
    refreshSaved: () => void controller.refreshSaved(),
    refreshModels: () => void controller.refreshModels(),
    setDefaultModel: (value) => {
      void controller.updatePreferences({ defaultModel: value }).then((next) => {
        if (next === null) pushNotice(copy.settings.preferenceSaveFailed);
      });
    },
    completeOnboarding: () => {
      void controller.updatePreferences({ onboarded: true }).then((next) => {
        if (next === null) pushNotice(copy.settings.preferenceSaveFailed);
      });
    },
    restartOnboarding: async () => {
      const next = await controller.updatePreferences({ onboarded: false });
      if (next === null) {
        pushNotice(copy.settings.preferenceSaveFailed);
        return false;
      }
      return true;
    },
    testProvider: (name, modelId) => controller.testProvider(name, modelId),
    refreshHubSettings: () => {
      void controller.readHubSettings();
    },
    saveHubDefaults: async (patch) => {
      const reason = await controller.writeHubSettings(patch);
      if (reason !== null) {
        pushNotice(copy.settings.permissionSaveFailed);
        return false;
      }
      return true;
    },
    refreshSessionPermissionMode: () => {
      const threadId = activeThreadOf();
      if (threadId.length === 0) return;
      void controller.readSessionPermissionMode(threadId);
    },
    setSessionPermissionMode: async (mode) => {
      const threadId = activeThreadOf();
      if (threadId.length === 0) return false;
      // threadId 捕获于入队时刻（模式是按线程寻址，不是按活跃会话相对寻址）
      const run = async (): Promise<boolean> => {
        const reason = await controller.setSessionPermissionMode(threadId, mode);
        if (reason !== null) {
          pushNotice(copy.settings.permissionSaveFailed);
          return false;
        }
        await controller.readSessionPermissionMode(threadId);
        return true;
      };
      const chained = permissionModeWriteChain.then(run, run);
      permissionModeWriteChain = chained.then(
        () => undefined,
        () => undefined,
      );
      return chained;
    },
    refreshAllStats: () => {
      // stats 是 worker 级查询：parked 会话不发（会唤醒全部 worker——T27 预算），
      // 只刷新 live 会话，parked 显示最后已知值
      for (const threadId of statsTargetsOf(store.getState().sessions)) {
        void controller.refreshUsage(threadId);
      }
    },
    retryHydration: () => {
      // 历史水化失败态的重试入口：force 越过 hydrated 守卫（reconcile/rebuild 的
      // 失败可发生在已水化线程上，无 force 的重试会被守卫吞掉）
      const active = store.getState().activeThreadId;
      if (active !== null) void controller.ensureHydrated(active, { force: true });
    },
    showNotice: (text) => {
      pushNotice(text);
    },
    saveGeneralPreferences: async (patch) => {
      const next = await controller.updatePreferences(patch);
      if (next === null) {
        pushNotice(copy.settings.generalSaveFailed);
        return false;
      }
      return true;
    },
    saveRelay: async (relay) => {
      const next = await controller.updatePreferences({ relay });
      if (next === null) {
        pushNotice(copy.settings.relaySaveFailed);
        return false;
      }
      return true;
    },
    restartHost: () => controller.restartHost(),
    stopThread: (threadId) => void controller.stopActiveTurn(threadId),
    fetchRuntime: () => controller.runtime.fetchRuntimeSnapshot(),
    fetchDiagnosticLog: () => controller.runtime.fetchDiagnosticLog(),
    retireSession: async (threadId) => {
      const reason = await controller.runtime.retireSession(threadId);
      if (reason !== null) pushNotice(copy.runtime.recycleFailed);
    },
    forceRetireSession: async (threadId) => {
      const reason = await controller.runtime.forceRetireSession(threadId);
      if (reason !== null) pushNotice(copy.runtime.recycleFailed);
    },
    setKeepalive: async (threadId, keepalive) => {
      const reason = await controller.runtime.setKeepalive(threadId, keepalive);
      if (reason !== null) pushNotice(copy.runtime.keepaliveFailed);
    },
    setIdleRecycle: async (minutes) => {
      const applied = await controller.runtime.setIdleRecycle(minutes);
      if (applied === null) pushNotice(copy.runtime.recycleSettingFailed);
    },
    exportDiagnostics: async () => {
      const directory = await controller.runtime.exportDiagnostics();
      if (directory === null) {
        pushNotice(copy.runtime.exportFailed);
        return false;
      }
      return true;
    },
    reloadSessionTrusted: (threadId, trusted) => {
      void controller.reloadSessionTrusted(threadId, trusted).then((ok) => {
        if (!ok) pushNotice(copy.thread.reloadTrustFailed);
      });
    },
    refreshAgentDefinitions: () => {
      void controller.refreshAgentDefinitions();
    },
    upsertAgentDefinition: (definition, previous) => controller.upsertAgentDefinition(definition, previous),
    removeAgentDefinition: (key) => controller.removeAgentDefinition(key),
    ...resourceActions({ controller, pushNotice }),
    searchFiles: (query) => {
      const state = store.getState();
      const cwd = state.activeThreadId !== null ? state.sessions[state.activeThreadId]?.cwd ?? '' : '';
      return controller.searchFiles(cwd, query);
    },
    searchFilesIn: (cwd, query) => controller.searchFiles(cwd, query),
    listGitBranches: (cwd) => controller.listGitBranches(cwd),
    listGitGraph: (cwd) => controller.listGitGraph(cwd),
    listGitStatus: (cwd) => controller.listGitStatus(cwd),
    checkoutGitBranch: (cwd, branch, create) => controller.checkoutGitBranch(cwd, branch, create),
    runBash: async (command) => {
      const reason = await controller.runBash(activeThreadOf(), command);
      // 空舞台（无活跃会话）直执行：给可行动去向，不透传 schema 密文
      if (reason === 'no_active_session') {
        pushNotice(copy.flow.noActiveSession);
        return reason;
      }
      if (reason !== null) pushNotice(copy.flow.bashFailed(reason));
      return reason;
    },
    abortBash: () => void controller.abortBash(activeThreadOf()),
    revealSession: (sessionPath) => void controller.revealSession(sessionPath),
    pickDirectory: async (defaultPath) => {
      const outcome = await apiClient.dialog.pickDirectory(defaultPath !== null ? { defaultPath } : {});
      if (!outcome.ok) {
        // 失败与取消区分：取消静默，失败要给用户反馈（通知条层级高于弹窗）
        pushNotice(copy.newTask.pickFailed);
        return null;
      }
      return outcome.data;
    },
    removeProject: (cwd) => {
      const current = store.getState().preferences.hiddenProjects;
      if (current.includes(cwd)) return;
      void controller.updatePreferences({ hiddenProjects: [...current, cwd] }).then((next) => {
        if (next === null) pushNotice(copy.settings.preferenceSaveFailed);
      });
    },
    listProjectFiles: (cwd) => apiClient.files.search({ cwd, query: '' }).then((outcome) => {
      if (!outcome.ok) return null;
      return outcome.data;
    }),
    archiveSession: (threadId) => {
      // 先落偏好再关会话：关闭是 fire-and-forget，若先关，标记失败会话已从侧栏消失且无归档记录
      const session = store.getState().sessions[threadId];
      const sessionPath = session?.sessionPath ?? '';
      if (sessionPath.length > 0) {
        const current = store.getState().preferences.archivedSessions;
        if (!current.includes(sessionPath)) {
          void controller.updatePreferences({ archivedSessions: [...current, sessionPath] }).then((next) => {
            if (next === null) pushNotice(copy.settings.preferenceSaveFailed);
          });
        }
      }
      void controller.closeSession(threadId);
    },
    unarchiveSession: (sessionPath) => {
      const current = store.getState().preferences.archivedSessions;
      if (!current.includes(sessionPath)) return;
      void controller.updatePreferences({ archivedSessions: current.filter((path) => path !== sessionPath) }).then((next) => {
        if (next === null) pushNotice(copy.settings.preferenceSaveFailed);
      });
    },
    togglePinnedSession: (sessionPath) => {
      const current = store.getState().preferences.pinnedSessions;
      const pinnedSessions = current.includes(sessionPath)
        ? current.filter((path) => path !== sessionPath)
        : [...current, sessionPath];
      void controller.updatePreferences({ pinnedSessions }).then((next) => {
        if (next === null) pushNotice(copy.settings.preferenceSaveFailed);
      });
    },
    forkFromEntry: async (entryId) => {
      // fork 寻址 = WAL seq：水化条目 id `seq-<n>` 解析（live 回显 id 不可分叉，判定在消息行）
      const seq = entrySeqOf(entryId);
      if (seq === null) {
        pushNotice(copy.flow.forkFailed);
        return null;
      }
      const outcome = await controller.forkSession(activeThreadOf(), seq);
      if (!outcome.ok) {
        // 流式中的 fork 被 hub 拒绝（streaming_window）：停止前重试无意义，指引用户先停止
        pushNotice(outcome.reason === 'streaming_window' ? copy.flow.forkStreaming : copy.flow.forkFailed);
        return null;
      }
      return outcome.threadId;
    },
    upsertProvider: (input) => controller.upsertProvider(input),
    removeProvider: (name) => controller.removeProvider(name),
    renameSession: async (threadId, name) => {
      const ok = await controller.renameSession(threadId, name);
      if (!ok) pushNotice(copy.notices.renameFailed);
      return ok;
    },
    openInSystem: async (cwd, target) => {
      if (cwd.length === 0) return;
      const outcome = await apiClient.app.openShell({ cwd, target });
      if (!outcome.ok) {
        // editor_not_found 有更强的独立指引（不套「打开失败」外壳）；其余查表文案进外壳
        pushNotice(outcome.error.kind === 'editor_not_found' ? copy.thread.openEditorMissing : copy.thread.openFailed(copyOfError(outcome.error)));
      }
    },
    copyText: async (text) => {
      const ok = await writeClipboard(text);
      if (!ok) pushNotice(copy.thread.copyFailed);
      return ok;
    },
    steerSubagent: (agentId, message) => {
      void controller.steerSubagent(activeThreadOf(), agentId, message).then((reason) => {
        if (reason !== null) pushNotice(copy.flow.steerFailed(reason));
      });
    },
  };
}
