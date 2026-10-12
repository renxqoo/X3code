/**
 * 命令词表翻译（T58 R1 H2/H4 修复）：手机 App 的 ApiMethod（contracts/api.ts——
 * 桌面端 hub 词表）→ x-harness gateway host 命令（remote-protocol/vocab.ts 全集：
 * thread/* prompt steer follow_up abort compact get_state get_inflight get_messages
 * get_entries get_tree get_session_stats get_commands get_fork_messages
 * set_session_name get_subagents get_pending_dialogs fork clone get_models set_model
 * set_model_override bash abort_bash ui_response models/* auth/* agents/* skills/*
 * settings/get settings/set set_thinking_level get_thinking_level permission/* …）。
 * 两套词表因历史演进分叉；本表是移动端 relay 链路的唯一翻译层（参数名随命令一并对拍）。
 * 未映射的 ApiMethod 原样透传 → gateway 判 unknown-command fail-closed（安全面不变）。
 *
 * dialog/respond 与 dialog/pickDirectory 是特殊面：respond 走 L2 ui_response 帧
 * （gateway inbound 专用面，非命令）；pickDirectory 仅桌面端有（移动端不可达）。
 */

/** ApiMethod → host 命令映射（args 键改名 + 值变换） */
import { mapEntriesResponse, mapModelRows, mapSavedSessions, mapThreadRows } from './response-map';

interface CommandMapping {
  host: string;
  /** ApiMethod args 键 → host 参数键（未列出的键丢弃） */
  args?: Record<string, string>;
  /** 完整参数构造（与 args 合并，transform 优先） */
  transform?: (args: Record<string, unknown>) => Record<string, unknown>;
}

const COMMAND_MAP: Record<string, CommandMapping> = {
  'session/start': {
    host: 'thread/start',
    transform: (args) => {
      // host ThreadStartSpec：{cwd?, provider?, modelId?, trusted?: boolean, …}（R2 H-2 修正）
      const out: Record<string, unknown> = {};
      if (typeof args['cwd'] === 'string') out['cwd'] = args['cwd'];
      if (args['trusted'] === true) out['trusted'] = true;
      return out;
    },
  },
  'session/resume': { host: 'thread/resume', args: { sessionPath: 'sessionPath', trusted: 'trusted' } },
  'session/prompt': {
    host: 'prompt',
    transform: (args) => {
      // host PromptSpec：{threadId, message}（R2 H-1 修正——text 键 host 不读）
      const out: Record<string, unknown> = {};
      if (typeof args['threadId'] === 'string') out['threadId'] = args['threadId'];
      const text = args['message'] ?? args['text'];
      if (typeof text === 'string') out['message'] = text;
      return out;
    },
  },
  'session/abort': { host: 'abort', args: { threadId: 'threadId' } },
  'session/entries': { host: 'get_entries', args: { threadId: 'threadId', since: 'since' } },
  'session/messages': { host: 'get_messages', args: { threadId: 'threadId' } },
  'session/list': { host: 'thread/list' },
  // includePreview：会话列表要正文摘要（内容搜索/列表预览）。host 侧默认不带
  // （桌面端 2s 轮询不能被逐会话读档放大），由调用方显式请求
  'session/liveThreads': { host: 'thread/list', args: { includePreview: 'includePreview' } },
  'session/listSaved': { host: 'thread/list_saved', args: { cwd: 'cwd' } },
  'session/setName': { host: 'set_session_name', args: { threadId: 'threadId', name: 'name' } },
  'session/stop': {
    // host thread/stop 无 remove 键（R2 M-7：真删除是 owner-only thread/delete——
    // 设备面不可达）；remove 请求路由 thread/retire（设备权限面内的归档删除语义）
    host: 'thread/retire',
    args: { threadId: 'threadId' },
  },
  'session/setModel': {
    host: 'set_model',
    transform: (args) => ({ threadId: args['threadId'], provider: args['provider'], modelId: args['modelId'] }),
  },
  'session/setThinking': { host: 'set_thinking_level', args: { threadId: 'threadId', level: 'level' } },
  'session/thinkingLevel': { host: 'get_thinking_level', args: { threadId: 'threadId' } },
  'session/stats': { host: 'get_session_stats', args: { threadId: 'threadId' } },
  'session/state': { host: 'get_state', args: { threadId: 'threadId' } },
  'session/tokenAnalytics': { host: 'get_token_analytics', args: { threadId: 'threadId' } },
  'session/inflight': { host: 'get_inflight', args: { threadId: 'threadId' } },
  'session/fork': { host: 'fork', args: { threadId: 'threadId', seq: 'seq' } },
  'model/list': { host: 'get_models' },
  'permission/mode': { host: 'permission/get_mode', args: { threadId: 'threadId' } },
  'permission/setMode': { host: 'permission/set_mode', args: { threadId: 'threadId', mode: 'mode' } },
  'agents/list': { host: 'agents/list' },
  'skills/list': { host: 'skills/list' },
};

/** ApiMethod → gateway host 命令 + 参数翻译。 */
export function translateCommand(method: string, args: Record<string, unknown>): { command: string; args: Record<string, unknown> } {
  const mapping = COMMAND_MAP[method];
  if (mapping === undefined) return { command: method, args };
  const renamed: Record<string, unknown> = {};
  for (const [fromKey, toKey] of Object.entries(mapping.args ?? {})) {
    if (args[fromKey] !== undefined) renamed[toKey] = args[fromKey];
  }
  const transformed = mapping.transform !== undefined ? mapping.transform(args) : {};
  return { command: mapping.host, args: { ...renamed, ...transformed } };
}

/**
 * host response data → ApiData 形状翻译（R2 H-4：直通在 get_entries/get_models/
 * thread/list/thread/list_saved 上形状不符——历史水化清屏/模型列表空/会话列表裸串）。
 */
export function mapResponseData(host: string, data: unknown): unknown {
  switch (host) {
    case 'get_entries': {
      // 调用方（runtime.hydrateThread）读 data.items——items 已是 ChatMessage[]
      return mapEntriesResponse(data);
    }
    case 'thread/list': {
      // loadBootstrap 读 data.sessions
      return { sessions: mapThreadRows(data) };
    }
    case 'get_models': {
      return mapModelRows(data);
    }
    case 'thread/list_saved': {
      return mapSavedSessions(data);
    }
    default:
      return data;
  }
}
