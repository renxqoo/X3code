import { describe, expect, test } from 'bun:test';
import {
  HUB_COMMAND_TYPES,
  HUB_EVENT_NAMES,
  HUB_FRAME_TYPES,
  X3CODE_COMMAND_TYPES,
  UI_EVENT_TYPES,
  UiEventSchema,
  SessionViewSchema,
  SettingsSchema,
  ApiSchemas,
  PreferencesViewSchema,
  API_METHODS,
  ProviderConfigViewSchema,
  HistoryItemSchema,
  isValidAgentName,
  type HubCommand,
  type X3codeCommand,
  type UiEvent,
} from '../index';

const byStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

describe('词表封闭（双向）', () => {
  test('UI 事件词表与 schema 判别值一致', () => {
    const samples = samplePerUiEvent();
    for (const e of samples) {
      expect(UI_EVENT_TYPES).toContain(e.type);
      expect(UiEventSchema.parse(e)).toEqual(e);
    }
    const schemaTypes = new Set(samples.map((e) => e.type));
    expect([...schemaTypes].sort(byStr)).toEqual([...UI_EVENT_TYPES].sort(byStr));
  });

  test('未知 UiEvent 类型被拒绝', () => {
    expect(() => UiEventSchema.parse({ type: 'nope', threadId: 't1' })).toThrow();
  });

  test('retrying 缺坐标/负坐标/零序号被拒绝（词表只收真实 attempt 坐标）', () => {
    expect(() => UiEventSchema.parse({ type: 'retrying', threadId: 't1', turn: 3, attempt: 1, code: null, message: null })).toThrow();
    expect(() => UiEventSchema.parse({ type: 'retrying', threadId: 't1', step: 0, attempt: 1, code: null, message: null })).toThrow();
    expect(() => UiEventSchema.parse({ type: 'retrying', threadId: 't1', turn: 3, step: 0, code: null, message: null })).toThrow();
    expect(() => UiEventSchema.parse({ type: 'retrying', threadId: 't1', turn: -1, step: 0, attempt: 1, code: null, message: null })).toThrow();
    expect(() => UiEventSchema.parse({ type: 'retrying', threadId: 't1', turn: 3, step: -1, attempt: 1, code: null, message: null })).toThrow();
    expect(() => UiEventSchema.parse({ type: 'retrying', threadId: 't1', turn: 3, step: 0, attempt: 0, code: null, message: null })).toThrow();
  });

  test('hub 帧词表 == 七类（x-harness host-hub 协议帧全集）', () => {
    expect([...HUB_FRAME_TYPES].sort(byStr)).toEqual(
      ['event', 'heartbeat', 'hub_error', 'response', 'thread_died', 'thread_parked', 'ui_request'].sort(byStr),
    );
  });

  test('hub 命令词表 == 74（x-harness host-hub COMMAND_NAMES 镜像；thread/notify 为事实注入面；queue/drop、queue/send_now 为单条队列操作面；skills/inspect|install 为技能安装面；get_token_analytics 为上下文分析面；plugins/* 为插件管理面）', () => {
    expect(HUB_COMMAND_TYPES.length).toBe(74);
    expect(HUB_COMMAND_TYPES).toContain('thread/delete');
    expect(HUB_COMMAND_TYPES).toContain('queue/drop');
    expect(HUB_COMMAND_TYPES).toContain('queue/send_now');
    expect([...HUB_COMMAND_TYPES].sort(byStr)).toEqual(
      [
        'thread/start', 'thread/resume', 'thread/register', 'thread/stop', 'thread/notify', 'thread/retire', 'thread/delete', 'thread/set_keepalive', 'thread/list', 'thread/list_saved',
        'get_host_info', 'set_idle_retire_ms', 'set_rss_retire_bytes',
        'prompt', 'steer', 'follow_up', 'abort', 'clear_queue', 'queue/drop', 'queue/send_now', 'compact',
        'get_state', 'get_messages', 'get_entries', 'get_tree', 'get_session_stats', 'get_token_analytics', 'set_session_name', 'get_commands', 'get_fork_messages',
        'get_inflight', 'get_subagents', 'get_pending_dialogs',
        'fork', 'clone',
        'get_models', 'set_model', 'set_model_override',
        'set_thinking_level', 'get_thinking_level',
        'permission/set_mode', 'permission/get_mode',
        'auth/list', 'auth/set_api_key', 'auth/remove_key',
        'bash', 'abort_bash',
        'ui_response',
        'settings/get', 'settings/set',
        'workspace/trust',
        'models/add', 'models/remove', 'models/reload',
        'agents/list', 'agents/create', 'agents/remove',
        'skills/inspect', 'skills/install', 'skills/list', 'skills/set_enabled', 'skills/remove',
        'plugins/list', 'plugins/inspect', 'plugins/install', 'plugins/uninstall', 'plugins/set_enabled', 'plugins/remove', 'plugins/hot_install', 'plugins/hot_uninstall',
        'plugins/trusted_source/list', 'plugins/trusted_source/confirm', 'plugins/trusted_source/reject',
        'subagent/steer',
      ].sort(byStr),
    );
  });

  test('hub 事件名词表封闭（app 消费子集；x-harness 另发 request/*、system/message、assistant/attempt、session/*、command/run|done、autocompact/*、compaction/served-window|diagnostic、agent/error、step/start|end——app 忽略）', () => {
    expect(HUB_EVENT_NAMES.length).toBe(19);
    expect([...HUB_EVENT_NAMES].sort(byStr)).toEqual(
      [
        'turn/start', 'turn/end',
        'user/message', 'assistant/message',
        'tool/call', 'tool/result',
        'llm/retry', 'llm/chunk',
        'agent/inbox/spliced', 'agent/assistant-stream', 'agent/tool-stream',
        'agent/status', 'agent/spawned', 'agent/finished',
        'compaction/landed', 'permission/decided',
        'settled', 'todo/snapshot',
        'bash_execution_update',
      ].sort(byStr),
    );
  });

  test('Pai 命令词表是 hub 命令词表的子集', () => {
    for (const t of X3CODE_COMMAND_TYPES) {
      expect(HUB_COMMAND_TYPES).toContain(t);
    }
  });

  test('Pai 命令子集含 x-harness 新面：compact/thread/delete 与 agents CRUD 直接寻址（hub 协议一等命令）', () => {
    for (const t of ['compact', 'thread/delete', 'agents/create', 'agents/remove']) {
      expect(X3CODE_COMMAND_TYPES).toContain(t);
      expect(HUB_COMMAND_TYPES).toContain(t);
    }
  });

  test('命令词表类型级校验：X3codeCommand 可赋给 HubCommand 的 type 集', () => {
    const all: HubCommand['type'][] = [...HUB_COMMAND_TYPES];
    const x3code: X3codeCommand['type'][] = [...X3CODE_COMMAND_TYPES];
    for (const t of x3code) expect(all).toContain(t);
    expect(all.length).toBe(HUB_COMMAND_TYPES.length);
  });

  test('API 方法词表与 schema 注册表一致', () => {
    expect([...API_METHODS].sort(byStr)).toEqual(Object.keys(ApiSchemas).sort(byStr));
  });
});

describe('Settings zod：round-trip 与拒绝表', () => {
  test('空输入落到默认值', () => {
    const s = SettingsSchema.parse({});
    expect(s.providers).toEqual([]);
    expect(s.trustedDefault).toBe(false);
    expect(s.hubDev).toEqual({ bunPath: null, hubEntry: null, gatewayEntry: null });
    expect(s.defaultModel).toBeNull();
    expect(s.onboarded).toBe(false);
    expect(s.relay).toEqual({ remoteEnabled: true, relayUrl: '', relayKeyFingerprint: '' });
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

describe('SessionView / HistoryItem schema', () => {
  test('SessionView 合法样本 round-trip', () => {
    const view = {
      threadId: 't1',
      cwd: '/w',
      sessionPath: null,
      title: 'New conversation',
      state: 'live',
      streaming: false,
      model: null,
      thinkingLevel: null,
      lastActivityAt: 1,
      createdAt: 1,
    };
    expect(SessionViewSchema.parse(view)).toEqual(view);
  });

  test('HistoryItem 三形态样本', () => {
    const items = [
      { kind: 'user', id: 'm1', text: 'hi', origin: 'user', images: [{ type: 'image', data: 'aGk=', mediaType: 'image/png' }], at: 1 },
      {
        kind: 'assistant',
        id: 'm2',
        messageTs: 2,
        at: 2,
        text: 'hello',
        thinking: '',
        toolCalls: [{ id: 'tc1', name: 'bash', argsPreview: 'ls', output: 'a\nb', isError: false, diff: null }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        stopReason: null,
        errorMessage: null,
      },
      { kind: 'bash', id: 'm3', command: 'git status', output: 'ok', exitCode: 0, cancelled: false, at: 3 },
    ] as const;
    for (const item of items) expect(HistoryItemSchema.parse(item)).toEqual(item);
  });

  test('HistoryItem assistant 异常终态：stopReason 仅收窄词表、error 可带原始信息', () => {
    const base = { kind: 'assistant', id: 'm2', messageTs: 2, at: 2, text: '', thinking: '', toolCalls: [], usage: null } as const;
    expect(HistoryItemSchema.parse({ ...base, stopReason: 'error', errorMessage: '401 invalid api key' })).toMatchObject({ stopReason: 'error', errorMessage: '401 invalid api key' });
    expect(HistoryItemSchema.parse({ ...base, stopReason: 'aborted', errorMessage: null })).toMatchObject({ stopReason: 'aborted' });
    expect(() => HistoryItemSchema.parse({ ...base, stopReason: 'stop', errorMessage: null })).toThrow();
  });

  test('HistoryItem 拒绝未知 origin', () => {
    expect(() => HistoryItemSchema.parse({ kind: 'user', id: 'm1', text: 'x', origin: 'other' })).toThrow();
  });
});

describe('API schema：每方法合法/非法样本', () => {
  test('session/start 合法样本通过', () => {
    const r = ApiSchemas['session/start'].params.parse({ cwd: '/tmp/w' });
    expect(r).toEqual({ cwd: '/tmp/w' });
  });

  test('app/setPreference 部分写合法：单字段与清空默认模型', () => {
    expect(ApiSchemas['app/setPreference'].params.parse({ onboarded: true })).toEqual({ onboarded: true });
    expect(ApiSchemas['app/setPreference'].params.parse({ defaultModel: null })).toEqual({ defaultModel: null });
  });

  /** T59：relay 是全局统一配置（settings.json 唯一真相），偏好面可读可写。 */
  test('app/setPreference 接受 relay 配置；空 patch 拒绝', () => {
    expect(ApiSchemas['app/setPreference'].params.parse({ relay: { relayUrl: 'wss://relay.example.com', relayKeyFingerprint: 'fp-1' } })).toEqual({
      relay: { remoteEnabled: true, relayUrl: 'wss://relay.example.com', relayKeyFingerprint: 'fp-1' },
    });
    expect(ApiSchemas['app/setPreference'].params.parse({ relay: {} })).toEqual({ relay: { remoteEnabled: true, relayUrl: '', relayKeyFingerprint: '' } });
    expect(() => ApiSchemas['app/setPreference'].params.parse({})).toThrow();
    expect(() => ApiSchemas['app/setPreference'].params.parse({ relay: { relayUrl: 42 } })).toThrow();
  });

  test('PreferencesView 带 relay（面板读口）', () => {
    const view = {
      defaultModel: null,
      onboarded: true,
      projectModels: {},
      pinnedSessions: [],
      trustedDefault: false,
      hiddenProjects: [],
      idleRecycleMinutes: 5,
      archivedSessions: [],
      relay: { remoteEnabled: true, relayUrl: 'wss://relay.example.com', relayKeyFingerprint: 'fp-1' },
    };
    expect(PreferencesViewSchema.parse(view)).toEqual(view);
    const { relay: _omit, ...withoutRelay } = view;
    expect(() => PreferencesViewSchema.parse(withoutRelay)).toThrow();
  });

  test('provider/test 合法样本通过', () => {
    expect(ApiSchemas['provider/test'].params.parse({ name: 'glm' })).toEqual({ name: 'glm' });
  });

  test('command/list 合法样本通过', () => {
    expect(ApiSchemas['command/list'].params.parse({ threadId: 't1' })).toEqual({ threadId: 't1' });
  });

  test('session/tokenAnalytics（T43）：params threadId 必填；result 形状往返与垃圾拒绝', () => {
    expect(ApiSchemas['session/tokenAnalytics'].params.parse({ threadId: 't1' })).toEqual({ threadId: 't1' });
    expect(() => ApiSchemas['session/tokenAnalytics'].params.parse({})).toThrow();
    // 契约收窄为占用构成的两个静态分量：占用走事件流、窗口走模型目录
    const view = { systemPrompt: 2_000, tools: 35_000 };
    expect(ApiSchemas['session/tokenAnalytics'].result.parse(view)).toEqual(view);
    expect(() => ApiSchemas['session/tokenAnalytics'].result.parse({ systemPrompt: 2_000 })).toThrow(); // tools 必填
  });

  test('session/prompt 携带 images 合法；畸形 image 拒绝', () => {
    const ok = ApiSchemas['session/prompt'].params.parse({
      threadId: 't',
      message: 'hi',
      images: [{ type: 'image', data: 'aGk=', mediaType: 'image/png' }],
    });
    expect(ok.images?.length).toBe(1);
    expect(() =>
      ApiSchemas['session/prompt'].params.parse({ threadId: 't', message: 'hi', images: [{ type: 'image', data: '', mediaType: 'image/png' }] }),
    ).toThrow();
    expect(() =>
      ApiSchemas['session/prompt'].params.parse({ threadId: 't', message: 'hi', images: [{ type: 'file', data: 'x', mediaType: 'text/plain' }] }),
    ).toThrow();
  });

  test('session/prompt 纯图消息（message 空但带 images）过闸；文本图片全空拒绝', () => {
    // fork 重试带图消息的形态：hub 协议不要求 message 非空
    const imageOnly = ApiSchemas['session/prompt'].params.parse({
      threadId: 't',
      message: '',
      images: [{ type: 'image', data: 'aGk=', mediaType: 'image/png' }],
    });
    expect(imageOnly.message).toBe('');
    expect(() => ApiSchemas['session/prompt'].params.parse({ threadId: 't', message: '' })).toThrow();
    expect(() => ApiSchemas['session/prompt'].params.parse({ threadId: 't', message: '', images: [] })).toThrow();
  });

  test('session/bash 与 abortBash 样本', () => {
    expect(ApiSchemas['session/bash'].params.parse({ threadId: 't', command: 'git status' })).toEqual({ threadId: 't', command: 'git status' });
    expect(() => ApiSchemas['session/bash'].params.parse({ threadId: 't', command: '' })).toThrow();
    expect(ApiSchemas['session/abortBash'].params.parse({ threadId: 't' })).toEqual({ threadId: 't' });
  });

  test('session/fork（seq 域）与 clearQueue 样本', () => {
    expect(ApiSchemas['session/fork'].params.parse({ threadId: 't', seq: 5 })).toEqual({ threadId: 't', seq: 5 });
    expect(ApiSchemas['session/fork'].params.parse({ threadId: 't', seq: 5, position: 'at' })).toEqual({ threadId: 't', seq: 5, position: 'at' });
    expect(() => ApiSchemas['session/fork'].params.parse({ threadId: 't', seq: 0 })).toThrow();
    expect(() => ApiSchemas['session/fork'].params.parse({ threadId: 't', seq: 5, position: 'after' })).toThrow();
    expect(ApiSchemas['session/clearQueue'].params.parse({ threadId: 't' })).toEqual({ threadId: 't' });
  });

  test('file/search 合法样本与拒绝', () => {
    expect(ApiSchemas['file/search'].params.parse({ cwd: '/w', query: 'ap' })).toEqual({ cwd: '/w', query: 'ap' });
    expect(() => ApiSchemas['file/search'].params.parse({ cwd: '', query: '' })).toThrow();
    expect(() => ApiSchemas['file/search'].params.parse({ cwd: '/w' })).toThrow();
  });

  test('isValidAgentName：x-harness 规则镜像（非空、不含 /、不含换行；无 kebab 正则与保留名——判重归 hub）', () => {
    expect(isValidAgentName('code-reviewer')).toBe(true);
    expect(isValidAgentName('explore2')).toBe(true);
    expect(isValidAgentName('a-b-c-d')).toBe(true);
    for (const ok of ['Code', 'code_reviewer', 'code reviewer', '代码审查员', 'fork', 'main']) {
      expect(isValidAgentName(ok)).toBe(true);
    }
    for (const bad of ['', 'a/b', 'a\nb']) {
      expect(isValidAgentName(bad)).toBe(false);
    }
  });

  test('provider/upsert 模型参数全链合法：contextWindow/maxTokens 随条目通过，回读视图同构（回归：IPC strict 层曾剥掉新字段）', () => {
    const params = ApiSchemas['provider/upsert'].params.parse({
      name: 'glm',
      baseUrl: 'https://x.example.com',
      api: 'openai',
      models: [
        { id: 'tuned', reasoning: true, vision: true, contextWindow: 200000, maxTokens: 8192 },
        { id: 'defaulted', reasoning: false, vision: false },
      ],
    });
    expect(params.models[0]).toEqual({ id: 'tuned', reasoning: true, vision: true, contextWindow: 200000, maxTokens: 8192 });
    expect(params.models[1]).toEqual({ id: 'defaulted', reasoning: false, vision: false });
    const view = ProviderConfigViewSchema.parse({
      name: 'glm',
      baseUrl: 'https://x.example.com',
      api: 'openai',
      models: params.models,
      hasKey: false,
    });
    expect(view.models[0]?.contextWindow).toBe(200000);
    expect(view.models[0]?.maxTokens).toBe(8192);
  });

  test('provider/test 指定模型：modelId 合法通过且可缺省；空串与未知键拒绝', () => {
    expect(ApiSchemas['provider/test'].params.parse({ name: 'glm', modelId: 'glm-4.7' })).toEqual({ name: 'glm', modelId: 'glm-4.7' });
    expect(ApiSchemas['provider/test'].params.parse({ name: 'glm' })).toEqual({ name: 'glm' });
    expect(() => ApiSchemas['provider/test'].params.parse({ name: 'glm', modelId: '' })).toThrow();
    expect(() => ApiSchemas['provider/test'].params.parse({ name: 'glm', nope: 1 })).toThrow();
  });

  test('agent 定义管理三方法：definitions 空 params；upsert/remove 键位校验', () => {
    const definition = { name: 'search', description: 'd', systemPrompt: 'p', tools: null, model: null, scope: 'user', project: null };
    expect(ApiSchemas['agent/definitions'].params.parse({})).toEqual({});
    expect(ApiSchemas['agent/upsert'].params.parse({ definition, previous: null })).toEqual({ definition, previous: null });
    expect(ApiSchemas['agent/upsert'].params.parse({ definition, previous: { name: 'old', scope: 'user', project: null } }).previous).toEqual({ name: 'old', scope: 'user', project: null });
    expect(ApiSchemas['agent/remove'].params.parse({ name: 'search', scope: 'project', project: '/w' })).toEqual({ name: 'search', scope: 'project', project: '/w' });
  });

  test.each([
    ['session/start 缺 cwd', 'session/start', {}],
    ['session/start 未知键', 'session/start', { cwd: '/w', nope: 1 }],
    ['dialog/respond 缺 payload', 'dialog/respond', { requestId: 'r1' }],
    ['app/setPreference 空 patch（empty_preference）', 'app/setPreference', {}],
    ['app/setPreference 未知键', 'app/setPreference', { nope: 1 }],
    ['provider/test 空 name', 'provider/test', { name: '' }],
    ['command/list 缺 threadId', 'command/list', {}],
    ['command/list 未知键', 'command/list', { threadId: 't', nope: 1 }],
    ['agent/upsert 未知键', 'agent/upsert', { definition: { name: 'a', description: 'd', systemPrompt: 'p', tools: null, model: null, scope: 'user', project: null }, previous: null, nope: 1 }],
    ['agent/remove 非法 scope', 'agent/remove', { name: 'a', scope: 'global', project: null }],
    ['session/prompt 空消息', 'session/prompt', { threadId: 't', message: '' }],
    ['session/prompt 非法 streamingBehavior', 'session/prompt', { threadId: 't', message: 'hi', streamingBehavior: 'queue' }],
    ['provider/upsert 空 models', 'provider/upsert', { name: 'p', baseUrl: 'u', api: 'openai', models: [] }],
    ['provider/upsert 旧形态 string models', 'provider/upsert', { name: 'p', baseUrl: 'u', api: 'openai', models: ['m'] }],
    ['dialog/pickDirectory 未知键', 'dialog/pickDirectory', { defaultPath: '/w', extra: 1 }],
    ['dialog/pickDirectory 空 defaultPath', 'dialog/pickDirectory', { defaultPath: '' }],
    ['git/branches 缺 cwd', 'git/branches', {}],
    ['git/branches 空 cwd', 'git/branches', { cwd: '' }],
    ['git/branches 未知键', 'git/branches', { cwd: '/w', extra: 1 }],
    ['git/checkout 缺 cwd', 'git/checkout', { branch: 'main' }],
    ['git/checkout 空 cwd', 'git/checkout', { cwd: '', branch: 'main' }],
    ['git/checkout 空 branch', 'git/checkout', { cwd: '/w', branch: '' }],
    ['git/checkout 非法 create 类型', 'git/checkout', { cwd: '/w', branch: 'main', create: 'yes' }],
    ['git/checkout 未知键', 'git/checkout', { cwd: '/w', branch: 'main', extra: 1 }],
    ['git/graph 缺 cwd', 'git/graph', {}],
    ['git/graph 空 cwd', 'git/graph', { cwd: '' }],
    ['git/graph 未知键', 'git/graph', { cwd: '/w', extra: 1 }],
  ])('拒绝：%s', (_name: string, method: string, bad: unknown) => {
    expect(() => ApiSchemas[method as keyof typeof ApiSchemas].params.parse(bad)).toThrow();
  });
});

describe('dialog/pickDirectory 契约（新会话目录选择）', () => {
  test.each([
    ['空对象', {}],
    ['带 defaultPath', { defaultPath: '/w/proj' }],
  ])('合法：%s → result 为 string|null', (_name: string, params: unknown) => {
    const parsed = ApiSchemas['dialog/pickDirectory'].params.parse(params);
    expect(parsed).toEqual(params);
    expect(ApiSchemas['dialog/pickDirectory'].result.nullable().parse(null)).toBeNull();
    expect(ApiSchemas['dialog/pickDirectory'].result.parse('/w/proj')).toBe('/w/proj');
  });
});

describe('git 分支契约（两页分支面板共用）', () => {
  test('git/branches 参数与空形态结果', () => {
    expect(ApiSchemas['git/branches'].params.parse({ cwd: '/w/proj' })).toEqual({ cwd: '/w/proj' });
    const empty = ApiSchemas['git/branches'].result.parse({ isRepo: false, current: null, branches: [], dirtyFiles: 0 });
    expect(empty).toEqual({ isRepo: false, current: null, branches: [], dirtyFiles: 0 });
    expect(ApiSchemas['git/branches'].result.parse({ isRepo: true, current: 'main', branches: ['dev', 'main'], dirtyFiles: 3 })).toEqual({
      isRepo: true,
      current: 'main',
      branches: ['dev', 'main'],
      dirtyFiles: 3,
    });
    expect(() => ApiSchemas['git/branches'].result.parse({ isRepo: true, current: null })).toThrow();
    expect(() => ApiSchemas['git/branches'].result.parse({ isRepo: true, current: 'main', branches: [], dirtyFiles: -1 })).toThrow();
    expect(() => ApiSchemas['git/branches'].result.parse({ isRepo: true, current: 'main', branches: [], dirtyFiles: 1.5 })).toThrow();
  });

  test('git/checkout create 缺省为 false，结果只含 branch', () => {
    expect(ApiSchemas['git/checkout'].params.parse({ cwd: '/w/proj', branch: 'main' })).toEqual({
      cwd: '/w/proj',
      branch: 'main',
      create: false,
    });
    expect(ApiSchemas['git/checkout'].params.parse({ cwd: '/w/proj', branch: 'feat/x', create: true })).toEqual({
      cwd: '/w/proj',
      branch: 'feat/x',
      create: true,
    });
    expect(ApiSchemas['git/checkout'].result.parse({ branch: 'feat/x' })).toEqual({ branch: 'feat/x' });
    expect(() => ApiSchemas['git/checkout'].result.parse({ branch: 'feat/x', cwd: '/w' })).toThrow();
  });

  test('git/graph 结果 strict：单条提交词表封闭，缺字段/多字段拒绝', () => {
    expect(ApiSchemas['git/graph'].params.parse({ cwd: '/w/proj' })).toEqual({ cwd: '/w/proj' });
    const commit = {
      hash: 'a'.repeat(40),
      shortHash: 'aaaaaaa',
      subject: 'feat: x',
      author: 'x3code',
      timestamp: 1_760_000_000,
      parents: ['b'.repeat(40)],
      refs: ['HEAD -> main', 'main'],
      isHead: true,
    };
    const view = ApiSchemas['git/graph'].result.parse({ isRepo: true, commits: [commit], truncated: false });
    expect(view).toEqual({ isRepo: true, commits: [commit], truncated: false });
    expect(ApiSchemas['git/graph'].result.parse({ isRepo: true, commits: [], truncated: false })).toEqual({
      isRepo: true,
      commits: [],
      truncated: false,
    });
    expect(() => ApiSchemas['git/graph'].result.parse({ isRepo: true, commits: [commit] })).toThrow();
    expect(() => ApiSchemas['git/graph'].result.parse({ isRepo: true, commits: [{ ...commit, extra: 1 }], truncated: false })).toThrow();
    const { isHead, ...withoutIsHead } = commit;
    expect(isHead).toBe(true);
    expect(() => ApiSchemas['git/graph'].result.parse({ isRepo: true, commits: [withoutIsHead], truncated: false })).toThrow();
  });
});

/** 每个 UiEvent 形态至少一个合法样本（判别联合穷举的样本面）。 */
function samplePerUiEvent(): UiEvent[] {
  const t = 't1';
  return [
    { type: 'host', phase: 'ready' },
    { type: 'sessionUpdated', session: sampleSession(t) },
    { type: 'sessionRemoved', threadId: t },
    { type: 'sessionDied', threadId: t, reason: 'worker crash' },
    { type: 'sessionParked', threadId: t, reason: 'idle' },
    { type: 'sessionParked', threadId: t, reason: 'manual' },
    { type: 'turnStarted', threadId: t, at: 1 },
    { type: 'userMessage', threadId: t, message: { seq: 42, text: 'hi', origin: 'user', images: [] } },
    { type: 'userMessage', threadId: t, message: { seq: 43, text: '[task-notification]', origin: 'system', images: [] } },
    { type: 'messageStarted', threadId: t, messageId: 'a1', at: 1 },
    { type: 'textDelta', threadId: t, messageId: 'a1', delta: 'he' },
    { type: 'thinkingDelta', threadId: t, messageId: 'a1', delta: '...' },
    { type: 'streamRestarted', threadId: t, messageId: 'a1' },
    { type: 'toolCallAdded', threadId: t, messageId: 'a1', call: { id: 'tc1', name: 'bash', argsPreview: 'ls' }, diff: null },
    { type: 'toolUpdated', threadId: t, callId: 'tc1', output: 'partial' },
    { type: 'toolEnded', threadId: t, callId: 'tc1', output: 'done', isError: false, durationMs: 12, diff: null },
    { type: 'toolEnded', threadId: t, callId: 'tc2', output: 'edit', isError: false, durationMs: 5, diff: [{ path: 'a.ts', additions: 3, deletions: 1 }] },
    {
      type: 'messageFinal',
      threadId: t,
      message: { id: 'a1', text: 'final', thinking: '', toolCalls: [{ id: 'tc1', name: 'bash', argsPreview: 'ls' }], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
    },
    { type: 'turnSettled', threadId: t, ok: true, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
    { type: 'turnSettled', threadId: t, ok: false, reason: 'worker-died', usage: null },
    { type: 'queueChanged', threadId: t, steering: [{ id: 'e1', text: 'a' }], followUp: [] },
    { type: 'compacting', threadId: t, active: true },
    { type: 'compacted', threadId: t, replacedCount: 12 },
    { type: 'retrying', threadId: t, turn: 3, step: 0, attempt: 1, code: 'http-429', message: 'rate limited' },
    { type: 'retrying', threadId: t, turn: 3, step: 0, attempt: 2, code: null, message: null },
    { type: 'subagentStarted', threadId: t, agentId: 'ag1', agentName: 'general-purpose', task: 'explore' },
    { type: 'subagentDelta', threadId: t, agentId: 'ag1', delta: 'found' },
    { type: 'subagentTool', threadId: t, agentId: 'ag1', call: { id: 'tc2', name: 'read_file', argsPreview: 'a.ts' }, phase: 'start' },
    { type: 'subagentTool', threadId: t, agentId: 'ag1', call: { id: 'tc2', name: 'read_file', argsPreview: 'a.ts' }, phase: 'end', output: 'x', isError: false },
    { type: 'subagentSettled', threadId: t, agentId: 'ag1', status: 'completed' },
    { type: 'subagentState', threadId: t, agentId: 'ag1', busy: true },
    {
      type: 'todoSnapshot',
      threadId: t,
      snapshot: {
        seq: 2,
        tasks: [
          { id: '1', subject: '批次 A', status: 'completed' },
          { id: '2', subject: '批次 B', status: 'in_progress', description: 'd', activeForm: 'a', owner: 'worker-2' },
          { id: '3', subject: '批次 C', status: 'pending' },
        ],
        edges: [['1', '2']],
      },
    },
    { type: 'dialogRequest', threadId: t, requestId: 'r1', method: 'confirm', tool: 'bash', summary: 'npm test', reason: 'direct execution requested by client', agentName: 'explore' },
    { type: 'dialogSettled', requestId: 'r1' },
    { type: 'bashOutput', threadId: t, id: 'b1', delta: 'out', truncated: false },
    { type: 'gitChanged', threadId: t, cwd: '/w', branch: 'main' },
  ];
}

function sampleSession(threadId: string): Parameters<typeof SessionViewSchema.parse>[0] {
  return {
    threadId,
    cwd: '/w',
    sessionPath: null,
    title: 'T',
    state: 'live',
    streaming: false,
    model: 'glm/glm-5.3',
    thinkingLevel: 'high',
    lastActivityAt: 1,
    createdAt: 1,
  };
}
