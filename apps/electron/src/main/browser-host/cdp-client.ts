import type { BrowserEvent, BrowserInputEvent } from '@x3code/contracts';

/**
 * CDP 客户端（T61 §2）：browser-level ws 观察 target 增删 + per-target 会话
 * （screencast ack 旁路 / 输入转发 / 事件钩子注入）。
 * 全局 WebSocket（Electron main Node 22 / bun 同源）；无第三方依赖。
 */

export type CdpSend = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>;

export type CdpClientDeps = {
  /** browser-level ws URL（ws://127.0.0.1:port/devtools/browser/...）。 */
  browserWsUrl: string;
  /** 事件出口（frame/tabsChanged/action/navState/...，契约见 contracts）。 */
  onEvent: (event: BrowserEvent) => void;
  /** 诊断日志。 */
  log?: (message: string) => void;
};

/** per-target 运行态。 */
type TargetSession = {
  targetId: string;
  cdpSessionId: string | null;
  ws: WebSocket;
  seq: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  streamEpoch: number;
  screencastOn: boolean;
  lastAckFrameId: string | null;
};

const INPUT_HOOK_SOURCE = `
(function () {
  if (window.__x3bHooked) return; window.__x3bHooked = true;
  var LIMIT = 200;
  var describe = function (el) {
    if (!el || !el.tagName) return '';
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) s += '[' + aria.slice(0, 40) + ']';
    var t = (el.innerText || '').trim().slice(0, 24);
    if (t) s += '{' + t + '}';
    return s.slice(0, LIMIT);
  };
  var last = 0;
  var report = function (payload) {
    var now = Date.now();
    if (now - last < 50) return; // 20/s 节流
    last = now;
    try { window.__x3bReport(JSON.stringify(payload).slice(0, 2048)); } catch (e) {}
  };
  var describeAt = function (e) {
    // input/change/keydown 非鼠标事件无 clientX/Y——坐标解析只对鼠标事件做
    if (typeof e.clientX !== 'number') return { el: describe(e.target) };
    var el = document.elementFromPoint(e.clientX, e.clientY) || e.target;
    return { el: describe(el) };
  };
  ['click', 'input', 'change', 'keydown'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      var payload = { kind: type, x: Math.round(e.clientX || 0), y: Math.round(e.clientY || 0) };
      if (type === 'keydown') payload.key = (e.key || '').slice(0, 20);
      else payload.el = describeAt(e).el;
      report(payload);
    }, true);
  });
  window.addEventListener('scroll', function () {
    report({ kind: 'scroll', y: Math.round(window.scrollY) });
  }, true);
})();
`;

export function createCdpClient(deps: CdpClientDeps) {
  const targets = new Map<string, TargetSession>();
  let browserWs: WebSocket | null = null;
  let bseq = 0;
  const bpending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let tabList: Array<{ targetId: string; url: string; title: string; active: boolean }> = [];
  let stopped = false;

  // —— browser-level 连接 ——

  function browserSend(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++bseq;
      bpending.set(id, { resolve, reject });
      browserWs?.send(JSON.stringify({ id, method, params }));
    });
  }

  async function connect(): Promise<void> {
    const ws = new WebSocket(deps.browserWsUrl);
    browserWs = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number; result?: unknown; error?: { message: string };
        method?: string; params?: { targetInfo?: { targetId: string; url: string; type: string } };
      };
      const bp = msg.id !== undefined ? bpending.get(msg.id) : undefined;
      if (msg.id !== undefined && bp) {
        bpending.delete(msg.id);
        if (msg.error) bp.reject(new Error(msg.error.message));
        else bp.resolve(msg.result);
      } else if (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') {
        const info = msg.params?.targetInfo;
        if (info?.type === 'page') void refreshTabs();
      } else if (msg.method === 'Target.targetDestroyed') {
        // 事件参数是顶层 { targetId }（无 targetInfo 包裹）
        const destroyedId = (msg.params as { targetId?: string }).targetId;
        if (destroyedId) {
          const session = targets.get(destroyedId);
          if (session) {
            try { session.ws.close(); } catch { /* 已关 */ }
            targets.delete(destroyedId);
          }
          tabList = tabList.filter((t) => t.targetId !== destroyedId);
          void refreshTabs();
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('browser ws open failed')));
    });
    await browserSend('Target.setDiscoverTargets', { discover: true });
    await refreshTabs();
  }

  async function refreshTabs(): Promise<void> {
    if (stopped || browserWs === null) return;
    try {
      const result = (await browserSend('Target.getTargets')) as { targetInfos: Array<{ targetId: string; url: string; type: string; attached: boolean }> };
      const pages = result.targetInfos.filter((t) => t.type === 'page');
      // 激活真相源：按会话内最后一次 activate 记忆 + 兜底首个 target
      let hasActive = false;
      tabList = pages.map((p) => {
        const existing = tabList.find((t) => t.targetId === p.targetId);
        const active = existing?.active ?? false;
        if (active) hasActive = true;
        return { targetId: p.targetId, url: p.url, title: existing?.title ?? '', active };
      });
      const firstTab = tabList[0];
      if (!hasActive && firstTab) firstTab.active = true;
      deps.onEvent({ type: 'tabsChanged', tabs: tabList });
    } catch (error) {
      deps.log?.(`refreshTabs failed: ${String(error)}`);
    }
  }

  // —— per-target 会话 ——

  function sessionSend(session: TargetSession, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++session.seq;
      session.pending.set(id, { resolve, reject });
      session.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 旁路 ack（不进任何串行队列——ack 被慢命令阻塞会停帧）。 */
  function ackFrame(session: TargetSession, frameId: string): void {
    try {
      session.ws.send(JSON.stringify({ id: ++session.seq, method: 'Page.screencastFrameAck', params: { frameId } }));
    } catch {
      // ws 已关
    }
  }

  async function attachTarget(targetId: string): Promise<TargetSession> {
    const existing = targets.get(targetId);
    if (existing) return existing;
    const pageList = (await (await fetch(`http://${new URL(deps.browserWsUrl).host}/json/list`)).json()) as Array<{ id: string; webSocketDebuggerUrl: string; type: string }>;
    const page = pageList.find((t) => t.id === targetId && t.type === 'page');
    if (!page) throw new Error('target not found');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const session: TargetSession = {
      targetId, cdpSessionId: null, ws, seq: 0, pending: new Map(), streamEpoch: 0, screencastOn: false, lastAckFrameId: null,
    };
    targets.set(targetId, session);
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>;
      };
      const sp = msg.id !== undefined ? session.pending.get(msg.id) : undefined;
      if (msg.id !== undefined && sp) {
        session.pending.delete(msg.id);
        if (msg.error) sp.reject(new Error(msg.error.message));
        else sp.resolve(msg.result);
      } else if (msg.method === 'Page.screencastFrame') {
        const params = msg.params as { frameId: string; data: string; metadata?: { deviceWidth: number; deviceHeight: number; pageScaleFactor: number } };
        // 世代号在帧载荷里由本层维护：旧世代帧已随 ws 关闭自然丢弃；此字段供渲染层判别
        ackFrame(session, params.frameId); // 先 ack（旁路）再分发
        if (session.screencastOn && params.metadata) {
          deps.onEvent({
            type: 'frame',
            targetId,
            streamEpoch: session.streamEpoch,
            jpegB64: params.data,
            meta: {
              deviceWidth: params.metadata.deviceWidth,
              deviceHeight: params.metadata.deviceHeight,
              pageScaleFactor: params.metadata.pageScaleFactor,
            },
          });
        }
      } else if (msg.method === 'Runtime.bindingCalled') {
        const params = msg.params as { name: string; payload: string };
        if (params.name === '__x3bReport') {
          try {
            const raw = JSON.parse(params.payload) as Record<string, unknown>;
            const kind = raw['kind'];
            if (typeof kind === 'string' && ['click', 'input', 'change', 'keydown', 'scroll'].includes(kind)) {
              deps.onEvent({
                type: 'action',
                targetId,
                kind: kind as 'click' | 'input' | 'change' | 'keydown' | 'scroll',
                ...(typeof raw['x'] === 'number' ? { x: Math.max(0, raw['x']) } : {}),
                ...(typeof raw['y'] === 'number' ? { y: Math.max(0, raw['y']) } : {}),
                ...(typeof raw['el'] === 'string' ? { elementLabel: raw['el'].slice(0, 200) } : {}),
              });
            }
          } catch {
            // 敌意载荷：静默丢弃（垃圾输入降级）
          }
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('target ws open failed')));
    });
    await sessionSend(session, 'Page.enable');
    await sessionSend(session, 'Runtime.enable');
    await sessionSend(session, 'Runtime.addBinding', { name: '__x3bReport' });
    await sessionSend(session, 'Page.addScriptToEvaluateOnNewDocument', { source: INPUT_HOOK_SOURCE });
    return session;
  }

  // —— 面板操作面 ——

  async function startScreencast(targetId: string, opts: { maxWidth: number; maxHeight: number }): Promise<void> {
    const session = await attachTarget(targetId);
    session.streamEpoch += 1;
    session.screencastOn = true;
    await sessionSend(session, 'Page.startScreencast', { format: 'jpeg', quality: 50, maxWidth: opts.maxWidth, maxHeight: opts.maxHeight, everyNthFrame: 1 });
  }

  function stopScreencast(targetId: string): void {
    const session = targets.get(targetId);
    if (!session) return;
    session.screencastOn = false;
    session.streamEpoch += 1; // 旧世代帧（在途迟到）由 screencastOn 门 + 渲染层世代判别双保险丢弃
    try {
      void sessionSend(session, 'Page.stopScreencast');
    } catch {
      // ws 已关
    }
  }

  async function navigate(targetId: string, url: string): Promise<void> {
    const session = await attachTarget(targetId);
    await sessionSend(session, 'Page.navigate', { url });
    // binding 不随新 document 重建（CDP 坑：addBinding 只挂在当时的 context）——
    // navigate 后重放，钧子的静默 catch 才不会掩盖 binding 缺失
    await sessionSend(session, 'Runtime.addBinding', { name: '__x3bReport' });
  }

  async function dispatchInput(targetId: string, input: BrowserInputEvent): Promise<void> {
    const session = await attachTarget(targetId);
    switch (input.kind) {
      case 'mouse': {
        if (input.press) {
          // 先 move 再 press：无前置 move 的 press 在部分页面不触发命中测试
          await sessionSend(session, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: input.x, y: input.y });
        }
        await sessionSend(session, 'Input.dispatchMouseEvent', {
          type: input.press ? 'mousePressed' : 'mouseReleased',
          // clickCount 缺省 1：CDP mousePressed 无 clickCount 不派发 DOM click 事件
          x: input.x, y: input.y, button: input.button, clickCount: input.clickCount ?? 1,
        });
        return;
      }
      case 'wheel': {
        await sessionSend(session, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY,
        });
        return;
      }
      case 'key': {
        await sessionSend(session, 'Input.dispatchKeyEvent', {
          type: input.down ? 'keyDown' : 'keyUp', key: input.key,
          ...(input.modifiers.length > 0 ? { modifiers: input.modifiers.reduce((acc, m) => acc | MODIFIER_BITS[m], 0) } : {}),
        });
        return;
      }
      case 'insertText': {
        await sessionSend(session, 'Input.insertText', { text: input.text });
        return;
      }
    }
  }

  async function setViewport(targetId: string, width: number, height: number): Promise<void> {
    const session = await attachTarget(targetId);
    await sessionSend(session, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false });
    deps.onEvent({ type: 'viewportChanged', targetId, width, height });
  }

  async function activateTab(targetId: string): Promise<void> {
    const session = await attachTarget(targetId);
    await sessionSend(session, 'Page.bringToFront');
    tabList = tabList.map((t) => ({ ...t, active: t.targetId === targetId }));
    deps.onEvent({ type: 'tabsChanged', tabs: tabList });
  }

  async function openTab(url: string): Promise<string> {
    const result = (await browserSend('Target.createTarget', { url })) as { targetId: string };
    await refreshTabs();
    return result.targetId;
  }

  async function closeTab(targetId: string): Promise<void> {
    await browserSend('Target.closeTarget', { targetId });
    const session = targets.get(targetId);
    if (session) {
      try { session.ws.close(); } catch { /* 已关 */ }
      targets.delete(targetId);
    }
    await refreshTabs();
  }

  function currentTabs(): typeof tabList {
    return tabList;
  }

  function disconnect(): void {
    stopped = true;
    for (const session of targets.values()) {
      try { session.ws.close(); } catch { /* 已关 */ }
    }
    targets.clear();
    try { browserWs?.close(); } catch { /* 已关 */ }
    browserWs = null;
  }

  return {
    connect, startScreencast, stopScreencast, navigate, dispatchInput, setViewport,
    activateTab, openTab, closeTab, refreshTabs, currentTabs, disconnect,
  };
}

const MODIFIER_BITS: Record<'alt' | 'ctrl' | 'meta' | 'shift', number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
