import { createApiClient } from '@x3code/api/client';
import type { CommandView, ImagePayload, PreferencesView, ProviderModel, RelayConfig, UiEvent } from '@x3code/contracts';
import { isSettableThinkingLevel } from '@x3code/contracts';

import { copy } from '@/strings';
import { uiStore } from '@/ui/ui-store';
import { copyOfError } from '@/lib/error-text';
import type { BridgeClient } from './client-invoke';
import { bindEchoEntries, claimEchoes } from './pending-echoes';
import { createRuntimeController } from './runtime-controller';
import { createBashEndProbe } from './bash-end-probe';
import { createEntryHydration, createReadonlyHydration } from './entry-hydration';
import { createDialogTimers } from './dialog-timers';
import { createLazyResume } from './lazy-resume';
import { createReadPorts } from './read-ports';
import { createSettingsPorts } from './settings-ports';
import { createAgentsActions } from './agents-actions';
import { createSkillsActions } from './skills-actions';
import { createPluginsActions } from './plugins-actions';
import { checkoutGitBranch, listGitBranches, listGitGraph, listGitStatus, searchFiles } from './git-actions';
import type { CreateSessionInput, CreateSessionOutcome, LiveController, QueueOpOutcome } from './live-controller-types';
import { isLiveSession, type LiveStore } from './store';

/**
 * live 编排：事件订阅 → store 折叠；轮次边界的条目对账（真相源）；
 * 全部用户动作（发消息/停止/会话管理/对话框应答/模型切换）。
 *
 * 对账时序：turnStarted → 拉 entries（捕捉用户回显与通知注入）；
 * turnSettled → 再拉（以权威条目替换 live 轮次；失败则保留装饰态）。
 */

const RECONCILE_SETTLE_DELAY_MS = 120;

export type { CreateSessionInput, CreateSessionOutcome, LiveController } from './live-controller-types';

export function createLiveController(client: BridgeClient, store: LiveStore): LiveController {
  let unsubscribe: (() => void) | null = null;
  let disposed = true;
  /** 技能编排链（串行化：开关/导入/删除共用，防重开循环交错） */
  let skillToggleChain: Promise<void> = Promise.resolve();
  const chainSkills = <T>(run: () => Promise<T>): Promise<T> => {
    const chained = skillToggleChain.then(run, run);
    skillToggleChain = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  };
  /** 对账在途标记（每线程一个），防止重复拉取。 */
  const reconciling = new Set<string>();

  /** 会话条目水化三路径（增量对账/轮末重建/冷启动全量）独立模块。 */
  const { fetchEntries, rebuildFromTranscript, hydrateFull } = createEntryHydration({
    client,
    store,
    reconciling,
    isDisposed: () => disposed,
  });

  /** 懒恢复机制（在途去重/乐观登记）独立模块。 */
  // UI→api 直调门面：transport = 既有桥（IPC 方法字符串只存在于 @x3code/api client.ts）
  const api = createApiClient(client);
  const lazy = createLazyResume(client, store);
  const { resumeByPath, ensureLiveSession, activate } = lazy;

  /** 收敛读口（能力探测缓存属本控制器实例：渲染层重载即新实例，宿主代际变化显式失效）。 */
  const ports = createReadPorts(client);

  /** 配置面读写口（目录刷新/hub 缺省/会话级权限与思考档读口——单一职责模块）。 */
  const settingsPorts = createSettingsPorts({ api, store });

  /** 代理定义动作组（拉取/写/删——纯动作模块）。 */
  const agentsActions = createAgentsActions({ api, store });
  /** 技能动作组（清单/启停/导入/移除——重开回调经 controller 闭包）。 */
  const skillsActions = createSkillsActions({
    api,
    store,
    chainSkills,
    reopenSession: (threadId) => controller.reopenSession(threadId),
  });
  /** 插件动作组（清单/启停/导入/移除——热装编排 + 重开降级）。 */
  const pluginsActions = createPluginsActions({
    api,
    store,
    chainSkills,
    reopenSession: (threadId) => controller.reopenSession(threadId),
  });

  /** 直执行 bash 的收尾探测（协议无终态帧 → 输出静默后读口确认收尾；仍在跑时有界重排）。
   *  声明须先于 readonlyHydration（后者注入 ports）。 */
  const bashProbe = createBashEndProbe({
    probe: (threadId) => ports.inflight(threadId),
    isDisposed: () => disposed,
    onSettled: (threadId) => {
      // 迟到回包 × 会话已移除：不得把已修剪的线程复活（幽灵线程）
      if (!isLiveSession(store.getState(), threadId)) return;
      store.getState().bashSettled(threadId);
      const cursor = store.getState().threads[threadId]?.cursor ?? null;
      void fetchEntries(threadId, cursor, false).catch(() => undefined);
    },
    onStillRunning: (threadId) => bashProbe.rearm(threadId),
  });

  /** 只读水化链（纳管→直读→model 补齐；纳管失败回落 resume）独立模块。 */
  const readonlyHydration = createReadonlyHydration({
    client,
    store,
    ports,
    resumeByPath: (sessionPath) => resumeByPath(sessionPath),
    activate,
    isDisposed: () => disposed,
    onInflightApplied: (threadId, bashRunning) => {
      // 收敛路径重建了「直执行 bash 在跑」的横幅 → 同样要布收尾探测（否则静默结束的横幅永亮）
      if (bashRunning) bashProbe.arm(threadId);
    },
    onDialogsHydrated: (dialogs) => {
      // 重载重建的弹窗与事件到达的弹窗同口径：宿主超时默认拒绝后无回执帧，仍要兜底收起
      for (const dialog of dialogs) {
        dialogTimers.arm(dialog.requestId, dialog.threadId, () => {
          const stillPending = store.getState().dialogs.some((pending) => pending.requestId === dialog.requestId);
          if (stillPending) void controller.cancelDialog(dialog.requestId);
        });
      }
    },
  });

  /** 对话框兜底定时器（属主线程随行回收；单一真相 live/dialog-timers） */
  const dialogTimers = createDialogTimers();

  /** 对话框本地结算：ui_response 只有 ack 无事件回执，宿主侧超时/未知 id 均静默——弹窗关闭由客户端自治。 */
  const settleDialog = (requestId: string): void => {
    dialogTimers.settle(requestId);
    store.getState().applyEvent({ type: 'dialogSettled', requestId }, Date.now());
  };

  const onEvent = (event: UiEvent): void => {
    const state = store.getState();
    state.applyEvent(event, Date.now());
    if (event.type === 'userMessage' && event.message.origin === 'user') {
      // 权威用户气泡到达（WAL 帧直通）：认领逻辑单一真相在 pending-echoes（claimedIds
      // 精准配对优先，FIFO 块数兑底——症状回归锚定见 user-bubble-identity.test）。
      claimEchoes(store.getState(), event.threadId, event.message.seq, event.message.claimedIds, event.message.userBlocks);
    }
    if (event.type === 'queueChanged') {
      // 队列镜像到达：把 hub 物化的 inbox 条目 id 绑到在途回显（claimedIds 配对的
      // 前置登记；steering + followUp 合并登记，顺序即提交序）。
      bindEchoEntries(event.threadId, [...event.steering, ...event.followUp]);
    }
    if (event.type === 'gitChanged') {
      // hub git/changed（外部 checkout 失效信号）：bump 分支代次——use-git-branches 按
      // cwd 匹配的会话分支视图重拉（ui-store 全局单值——多余重拉为已知可接受项）
      uiStore.getState().bumpBranchRevision();
      return;
    }
    if (event.type === 'host' && (event.phase === 'restarting' || event.phase === 'failed')) {
      // host 进程消亡：乐观登记的「已恢复」随 worker 全灭失效（对账会重发 parked 视图）；
      // 挂起弹窗兜底 timer 与轮首游标全部随进程消亡回收（与 dispose 同口径）
      lazy.invalidate();
      dialogTimers.clearAll();
      bashProbe.clearAll();
      // 宿主进程代际变化：读口可用性缓存（能力探测）随之失效重探（协议能力是 hub 的属性）
      ports.invalidate();
      return;
    }
    if (event.type === 'sessionRemoved') {
      // 线程移除后轮次永不结算：该线程挂起弹窗的兜底 timer 与 bash 收尾探测随行回收
      dialogTimers.dropThread(event.threadId);
      bashProbe.clear(event.threadId);
    }
    if (event.type === 'dialogRequest') {
      // 宿主侧超时默认拒绝后无回执帧：客户端同步兜底收起（超时回调复查
      // stillPending，已结算则 no-op）。host-hub 仅 confirm 一种形态，全部入队计时。
      dialogTimers.arm(event.requestId, event.threadId, () => {
        const stillPending = store.getState().dialogs.some((dialog) => dialog.requestId === event.requestId);
        if (stillPending) void controller.cancelDialog(event.requestId);
      });
      return;
    }
    if (event.type === 'sessionDied') {
      // 线程消亡：该线程的挂起弹窗已被 store 折叠收走，兜底 timer 与 bash 收尾探测随行回收
      dialogTimers.dropThread(event.threadId);
      bashProbe.clear(event.threadId);
    }
    if (
      (event.type === 'messageStarted' || event.type === 'textDelta') &&
      state.threads[event.threadId]?.liveTurnId == null &&
      (state.threads[event.threadId]?.items.length ?? 0) > 0
    ) {
      // 错过 turnStarted 的在途轮（重载回落）：live 轮刚由本事件折出，而冷启动
      // 拉补已把该轮的持久前缀插入成独立折叠轮（同轮双渲染）——补挂一次重定基
      // 对账收回，settle 的权威重建统一收口
      void rebuildFromTranscript(event.threadId, null, { liveTurnPresent: () => true }).catch(() => undefined);
    }
    if (event.type === 'bashOutput') {
      // 重载前发起的直接执行：横幅无本地登记（事件折叠只写尾部输出），先点亮再排收尾探测
      if (state.threads[event.threadId]?.bashRunning !== true) store.getState().bashStarted(event.threadId);
      bashProbe.arm(event.threadId);
    }
    if (event.type === 'turnStarted') {
      // 轮首边界 = 读口事实（`get_inflight.turnStartSeq`，turn/start 时刻的 WAL seq）：
      // settle 窗口重建的 since 下界与尾 span 归属共用它；事件派生游标在重载场景必然丢失。
      // 守卫：读发出之后该轮若已结算 → 快照过期（事件只是迟到于结算），丢弃。
      const settledAtTurnStart = store.getState().threads[event.threadId]?.turnsSettled ?? 0;
      void ports
        .inflight(event.threadId)
        .then((view) => {
          if (disposed || view === null) return;
          if (!isLiveSession(store.getState(), event.threadId)) return;
          if ((store.getState().threads[event.threadId]?.turnsSettled ?? 0) !== settledAtTurnStart) return;
          store.getState().hydrate(event.threadId, { kind: 'hydrate/inflight', view, at: Date.now() });
          if (view.bash !== null) bashProbe.arm(event.threadId);
        })
        .catch(() => undefined);
      // 用户回显/通知注入经条目对账到达（消息不走事件流）
      void fetchEntries(event.threadId, state.threads[event.threadId]?.cursor ?? null, false).catch(() => undefined);
    } else if (event.type === 'turnSettled') {
      // ok=false 的回合失败不再走通知条（toast）：错误以终态消息（turnFailure 块）
      // 在轮末常驻呈现——通知条是一次性装饰、刷新即失，不是错误的正确展示面
      // 等条目落盘的短延迟后【轮内窗口重建】：since = 轮首游标，以完整转写替换
      // 本轮 span（根治配对丢失的语义不变，长会话不再每轮 O(全部条目) 全量拉取；
      // 游标失效由主进程兜底全量重拉）。代际守卫：窗口内若新一轮已开始（followUp
      // 自动续轮），本次重建让位给下一轮的 settle——invoke 在途的翻代由
      // staleGuard 二次复检兜住。
      const settledTurnId = state.threads[event.threadId]?.liveTurnId ?? null;
      // 轮首边界取折叠态事实（本事件折叠前捕获的 state；fold 会在应用时清空该字段）
      const turnStartCursor = state.threads[event.threadId]?.turnStartSeq ?? null;
      setTimeout(() => {
        if (disposed) return;
        const current = store.getState().threads[event.threadId];
        if (current !== undefined && current.liveTurnId !== settledTurnId) return;
        void rebuildFromTranscript(event.threadId, turnStartCursor, {
          staleGuard: () => {
            const latest = store.getState().threads[event.threadId];
            return latest !== undefined && latest.liveTurnId !== null && latest.liveTurnId !== settledTurnId;
          },
        }).catch(() => undefined);
        void controller.refreshUsage(event.threadId);
      }, RECONCILE_SETTLE_DELAY_MS);
    }
  };

  const controller: LiveController = {
    async start(): Promise<void> {
      // 可重入：StrictMode/HMR 的双挂载会先 dispose 再 start；复原 disposed、
      // 订阅以 unsubscribe 为准只建一次，bootstrap 每次刷新（幂等快照替换）。
      disposed = false;
      unsubscribe ??= client.subscribe((raw) => {
        // 事件到达即逐条同步折叠进 store（无批缓冲：主进程直发，渲染层 zustand
        // 订阅直出）；壳层混入的非 UiEvent 消息按形状静默丢弃
        const event = parseEvent(raw);
        if (event !== null) onEvent(event);
      });
      let outcome: Awaited<ReturnType<typeof client.invoke<'app/bootstrap'>>> | null = null;
      try {
        outcome = await api.app.bootstrap({});
      } catch {
        outcome = { ok: false, error: { kind: 'bootstrap_crashed' } };
      }
      if (disposed) return;
      if (outcome !== null && !outcome.ok) {
        store.getState().bootstrapFailed(copyOfError(outcome.error));
        return;
      }
      if (outcome === null) return;
      store.getState().bootstrap(outcome.data);
      // hub 用户级缺省启动即载（新任务页权限控件的数据源；此前仅设置页进入时拉取）
      void settingsPorts.readHubSettings();
      // bootstrap 自动选中的 parked 会话保持只读激活（历史经直读水化），
      // 发消息才唤醒 worker（T27：读不唤醒）
    },
    dispose(): void {
      disposed = true;
      dialogTimers.clearAll();
      // bash 探测定时器随控制器消亡回收（start 可重入复原 disposed——旧世代定时器
      // 不得在新世代继续探测并对共享 store 触发 onSettled 链）
      bashProbe.clearAll();
      unsubscribe?.();
      unsubscribe = null;
    },
    async submitDraft(
      threadId: string,
      message: string,
      images?: readonly ImagePayload[],
      mode: 'auto' | 'steer' | 'followUp' = 'auto',
    ): Promise<string | null> {
      const text = message.trim();
      // 纯图消息合法投递（fork 重试带图）：文本与图片都空才是空消息——本地一行免 IPC 往返
      if (text.length === 0 && (images === undefined || images.length === 0)) return 'empty_message';
      // 空舞台守卫：无活跃会话时 threadId 为空串，定址只会换回 schema 拒绝密文
      if (threadId.length === 0) return 'no_active_session';
      // 发送管线（`! ` 路由/空舞台守卫/懒唤醒/unknown_thread 自愈/streaming_window
      // 降级）整体居主进程 session/prompt 路由——这里只投递。投递裁决交给 hub 的
      // 原子语义（prompt+streamingBehavior）：空闲立即发送、流式中入队轮末自动消费。
      const outcome = await api.session.prompt({
        threadId,
        message: text,
        streamingBehavior: mode === 'steer' ? 'steer' : 'followUp',
        ...(images === undefined || images.length === 0 ? {} : { images: [...images] }),
      });
      if (!outcome.ok) {
        // transient 失败回 face（bridge_unavailable/host_*/timeout/busy）：face 比 kind
        // 更可行动——通知层按 face 出「宿主未就绪请重试」级精准文案而非泛化 transient；
        // bridge_unavailable 沿用同口径（横幅已显式呈现，通知层不再叠加）
        if (outcome.error.kind === 'transient') return outcome.error.face;
        return outcome.error.kind;
      }
      // 直执行（`! ` 分支）的 [bash] 结果条目无事件终态帧（hub bash 只推增量）：
      // 受理回执即命令已完成——对账一次使条目不依赖输出事件到达（静默命令也进流）。
      // 模型轮消息的权威回显仍由 turnStarted 对账负责（此处早拉无害）。
      void fetchEntries(threadId, store.getState().threads[threadId]?.cursor ?? null, false).catch(() => undefined);
      return null;
    },
    async stopActiveTurn(threadId: string): Promise<void> {
      // 空舞台守卫：无目标会话即无在飞轮次——停止天然幂等，静默返回
      if (threadId.length === 0) return;
      store.getState().stopIntent(threadId);
      await api.session.abort({ threadId });
    },
    async queueDrop(threadId: string, entryId: string): Promise<QueueOpOutcome> {
      // 成功后队列镜像随 agent/inbox/spliced 触发的 queueChanged 收敛，此处无需回写
      const outcome = threadId.length === 0 || entryId.length === 0 ? null : await api.session.queueDrop({ threadId, entryId });
      if (outcome === null) return 'failed';
      if (outcome.ok) return 'ok';
      return outcome.error.kind === 'state_conflict' ? 'consumed' : 'failed';
    },
    async queueSendNow(threadId: string, entryId: string): Promise<QueueOpOutcome> {
      const outcome = threadId.length === 0 || entryId.length === 0 ? null : await api.session.queueSendNow({ threadId, entryId });
      if (outcome === null) return 'failed';
      if (outcome.ok) return 'ok';
      if (outcome.error.kind === 'state_conflict') return 'consumed';
      if (outcome.error.kind === 'streaming_window') return 'window';
      return 'failed';
    },
    async createSession(input: CreateSessionInput): Promise<CreateSessionOutcome> {
      // 权限模式与思考档是 session/start 的原生参数（hub 建线程即生效，无后置应用窗口）
      const outcome = await api.thread.start({
        cwd: input.cwd,
        modelId: input.model?.modelId,
        trusted: input.trusted,
        ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
        ...(input.thinkingLevel !== undefined && isSettableThinkingLevel(input.thinkingLevel)
          ? { thinkingLevel: input.thinkingLevel }
          : {}),
      });
      if (!outcome.ok) return { ok: false, reason: copyOfError(outcome.error) };
      const { threadId } = outcome.data;
      activate(threadId);
      await hydrateFull(threadId).catch(() => undefined);
      return { ok: true, threadId };
    },
    async openSavedSession(sessionPath: string, trusted?: boolean): Promise<boolean> {
      // 同文件已在会话表（占位点击与 History 打开收敛）：不撞 hub 双开守卫。
      // parked/dead 占位是纯浏览意图——只读激活走纳管直读链（T27 读不唤醒）；
      // live 会话幂等用既有 id
      const existing = Object.values(store.getState().sessions).find((session) => session.sessionPath === sessionPath);
      let liveId: string | null;
      if (existing === undefined) {
        liveId = await resumeByPath(sessionPath, trusted);
      } else if (existing.state === 'live') {
        liveId = existing.threadId;
      } else {
        activate(existing.threadId);
        await readonlyHydration.ensureHydrated(existing.threadId);
        await this.refreshSaved();
        return true;
      }
      if (liveId === null) {
        store.getState().pushNotice(copy.flow.resumeFailed);
        return false;
      }
      activate(liveId);
      await hydrateFull(liveId).catch(() => undefined);
      await this.refreshSaved();
      return true;
    },
    async reloadSessionTrusted(threadId: string, trusted: boolean): Promise<boolean> {
      const sessionPath = store.getState().sessions[threadId]?.sessionPath ?? null;
      if (sessionPath === null || sessionPath.length === 0) return false;
      // 在途懒恢复先结算（trusted 分歧的去重通路会静默降级信任态，必须串行化后再重开）
      await ensureLiveSession(threadId).catch(() => undefined);
      // 记住重开前是否活跃：resume 成功后仅在该会话原本活跃时跟随切换（用户在途切换别会话时不劫持）
      const wasActive = store.getState().activeThreadId === threadId;
      const stop = await api.thread.stop({ threadId, remove: false });
      if (!stop.ok) return false;
      lazy.discardResumed(sessionPath);
      const liveId = await resumeByPath(sessionPath, trusted);
      if (liveId === null) {
        // 失败兜底：旧线程已被移除，刷新历史列表让会话可从 History 找回
        await this.refreshSaved();
        return false;
      }
      if (wasActive) activate(liveId);
      await hydrateFull(liveId).catch(() => undefined);
      await this.refreshSaved();
      return true;
    },
    async closeSession(threadId: string): Promise<void> {
      // 用户关闭：stop(dispose) + 注册表删行（remove 路由语义）
      const sessionPath = store.getState().sessions[threadId]?.sessionPath ?? null;
      await api.thread.stop({ threadId, remove: true });
      if (sessionPath !== null) lazy.discardResumed(sessionPath);
    },
    async renameSession(threadId: string, name: string): Promise<boolean> {
      const trimmed = name.trim();
      if (trimmed.length === 0) return false;
      const outcome = await api.session.setName({ threadId, name: trimmed });
      return outcome.ok;
    },
    async respondDialog(requestId: string, payload: Record<string, unknown>): Promise<void> {
      settleDialog(requestId);
      await api.dialog.respond({ requestId, payload }).catch(() => undefined);
    },
    async cancelDialog(requestId: string): Promise<void> {
      settleDialog(requestId);
      await api.dialog.respond({ requestId, payload: { cancelled: true } }).catch(() => undefined);
    },
    async selectModel(threadId: string, provider: string, modelId: string): Promise<void> {
      // 空舞台守卫：无活跃会话时菜单仍可见，点击必须得到可行动反馈而非 schema 密文
      if (threadId.length === 0) {
        store.getState().pushNotice(copy.flow.noActiveSession);
        return;
      }
      const outcome = await api.session.setModel({ threadId, provider, modelId });
      // hub 拒绝（如模型不在目录）：用户选择未生效，查表文案通报（与思考档同型）
      if (!outcome.ok) store.getState().pushNotice(copy.flow.modelRejected(copyOfError(outcome.error)));
    },
    async selectThinking(threadId: string, level: string): Promise<void> {
      // 空舞台守卫：无活跃会话时菜单仍可见，点击必须得到可行动反馈而非 schema 密文
      if (threadId.length === 0) {
        store.getState().pushNotice(copy.flow.noActiveSession);
        return;
      }
      // 词表校验先行（词表外值 hub 静默忽略——渲染层拒绝发送并提示）
      if (!isSettableThinkingLevel(level)) {
        store.getState().pushNotice(copy.flow.thinkingInvalid);
        return;
      }
      const outcome = await api.session.setThinking({ threadId, level });
      // hub 拒绝（如模型不支持该档位）：用户选择未生效，查表文案通报
      if (!outcome.ok) store.getState().pushNotice(copy.flow.thinkingRejected(copyOfError(outcome.error)));
    },
    ...settingsPorts,
    async steerSubagent(threadId: string, agentId: string, message: string): Promise<string | null> {
      const text = message.trim();
      if (text.length === 0) return 'empty_message';
      const outcome = await api.session.steer({ threadId, agentId, message: text });
      return outcome.ok ? null : outcome.error.kind;
    },
    restartHost(): void {
      void api.app.restartHost({}).then(() => undefined);
    },
    runtime: createRuntimeController(client),
    ...agentsActions,
    ...skillsActions,
    ...pluginsActions,
    /** 预会话命令目录（新建任务页 `/` 补全数据源；失败空目录降级）。 */
    async fetchCommandPreview(): Promise<CommandView[]> {
      const outcome = await api.command.preview({});
      return outcome.ok ? outcome.data : [];
    },
    async reopenSession(threadId: string): Promise<boolean> {
      const sessionPath = store.getState().sessions[threadId]?.sessionPath ?? null;
      if (sessionPath === null || sessionPath.length === 0) return false;
      const wasActive = store.getState().activeThreadId === threadId;
      const stop = await api.thread.stop({ threadId, remove: false });
      if (!stop.ok) return false;
      lazy.discardResumed(sessionPath);
      const liveId = await resumeByPath(sessionPath);
      if (liveId === null) {
        await this.refreshSaved();
        return false;
      }
      if (wasActive) activate(liveId);
      await hydrateFull(liveId).catch(() => undefined);
      await this.refreshSaved();
      return true;
    },
    async runBash(threadId: string, command: string): Promise<string | null> {
      const text = command.trim();
      if (text.length === 0) return 'empty_command';
      // 空舞台守卫：无活跃会话时直执行 bash 无定址目标（与 submitDraft 同口径）
      if (threadId.length === 0) return 'no_active_session';
      const cursorBefore = store.getState().threads[threadId]?.cursor ?? null;
      store.getState().bashStarted(threadId);
      try {
        // invoke reject（桥断连等）同样必须落 bashSettled：executing 永真会使
        // 消息流尾部永久 loading 且 1Hz 走表定时器永不停
        const outcome = await api.session.bash({ threadId, command: text });
        bashProbe.clear(threadId);
        store.getState().bashSettled(threadId);
        // bash 与模型轮并发（流式中直执行）时在途内容未落盘：重建一律降级为
        // 不拆轮的 reconcile，权威替换留给轮结算
        await rebuildFromTranscript(threadId, cursorBefore, {
          liveTurnPresent: () => store.getState().threads[threadId]?.streaming === true,
        }).catch(() => undefined);
        // 直执行失败上抛 kind 字符串（本地 token empty_command/no_active_session 同通道，W2 再定型）
        return outcome.ok ? null : outcome.error.kind;
      } catch {
        store.getState().bashSettled(threadId);
        return 'bridge_unavailable';
      }
    },
    async abortBash(threadId: string): Promise<void> {
      // 空舞台守卫：无目标会话即无在跑命令——中止天然幂等，静默返回
      if (threadId.length === 0) return;
      await api.session.abortBash({ threadId });
    },
    async revealSession(sessionPath: string): Promise<void> {
      await api.session.reveal({ sessionPath });
    },
    async forkSession(threadId: string, seq: number): Promise<{ ok: true; threadId: string } | { ok: false; reason: string }> {
      const outcome = await api.thread.fork({ threadId, seq, position: 'before' });
      // kind 字符串通道：消费方按 kind 判定文案分支（forkStreaming ← streaming_window）
      if (!outcome.ok) return { ok: false, reason: outcome.error.kind };
      // fork 是原地换轨：旧 id 已失效且不再有事件，运行面镜像就地终态
      store.getState().parkThread(threadId);
      activate(outcome.data.threadId);
      await hydrateFull(outcome.data.threadId).catch(() => undefined);
      return { ok: true, threadId: outcome.data.threadId };
    },
    searchFiles: (cwd: string, query: string) => searchFiles(client, cwd, query),
    listGitBranches: (cwd: string) => listGitBranches(client, cwd),
    listGitGraph: (cwd: string) => listGitGraph(client, cwd),
    listGitStatus: (cwd: string) => listGitStatus(client, cwd),
    checkoutGitBranch: (cwd: string, branch: string, create: boolean) => checkoutGitBranch(client, cwd, branch, create),
    async upsertProvider(input: { name: string; baseUrl: string; api: string; models: ProviderModel[]; apiKey?: string }): Promise<string | null> {
      const outcome = await api.provider.upsert(input);
      if (!outcome.ok) return copyOfError(outcome.error);
      store.setState({ providers: outcome.data });
      const models = await api.models.list({});
      if (models.ok) store.setState({ models: models.data });
      return null;
    },
    async removeProvider(name: string): Promise<string | null> {
      const outcome = await api.provider.remove({ name });
      if (!outcome.ok) return copyOfError(outcome.error);
      store.setState({ providers: outcome.data });
      const models = await api.models.list({});
      if (models.ok) store.setState({ models: models.data });
      return null;
    },
    async updatePreferences(patch: { defaultModel?: string | null; onboarded?: boolean; projectModels?: Record<string, string>; pinnedSessions?: string[]; trustedDefault?: boolean; hiddenProjects?: string[]; archivedSessions?: string[]; relay?: RelayConfig; hubDev?: { bunPath: string | null; hubEntry: string | null } }): Promise<PreferencesView | null> {
      const outcome = await api.app.setPreference(patch);
      if (!outcome.ok) return null;
      store.setState({ preferences: outcome.data });
      return outcome.data;
    },
    async testProvider(name: string, modelId: string | undefined): Promise<{ ok: true; latencyMs: number } | { ok: false; reason: string }> {
      const outcome = await api.provider.test(modelId === undefined ? { name } : { name, modelId });
      return outcome.ok ? { ok: true, latencyMs: outcome.data.latencyMs } : { ok: false, reason: copyOfError(outcome.error) };
    },
    async refreshUsage(threadId: string): Promise<void> {
      // 累计统计 + 占用构成的两个静态分量（系统提示词/工具）。占用本身走事件流
      // （assistant/message 实报 usage，每 step 推进）、窗口走模型目录——此处只取
      // 展示层无从得知的静态分量；缺席（插件未装载/旧 hub）不报错不重试。
      const [stats, analytics] = await Promise.all([
        api.session.stats({ threadId }),
        api.session.tokenAnalytics({ threadId }).catch(() => null),
      ]);
      if (stats.ok) store.getState().updateStats(threadId, stats.data);
      if (analytics?.ok) store.getState().updateAnalytics(threadId, analytics.data);
    },
    ensureHydrated: (threadId: string, options?: { force?: boolean }) => readonlyHydration.ensureHydrated(threadId, options),
    selectSession(threadId: string): void {
      // parked 只读激活（历史经 host 直读水化，不唤醒 worker）；发消息的唤醒居主进程
      // session/prompt 管线（T41 R1；读不唤醒、写才唤醒）。此处后台预热：激活即
      // fire-and-forget 唤活（与 lazy-resume 的在途去重同键），用户打完字时 worker
      // 已 live、prompt 缓存已热——发送路径上的 0.75s+ 懒唤醒串行窗被移出。
      activate(threadId);
      const session = store.getState().sessions[threadId];
      if (session?.state === 'parked' && session.sessionPath !== null) {
        void lazy.resumeByPath(session.sessionPath).catch(() => undefined);
      }
    },
  };

  return controller;
}

/** 事件通道混有壳层消息（window-state 等）：非 UiEvent 形状静默丢弃。 */
function parseEvent(raw: unknown): UiEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const type = (raw as { type?: unknown }).type;
  return typeof type === 'string' ? (raw as UiEvent) : null;
}
