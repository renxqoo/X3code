/**
 * host（x-harness）响应形状 → 手机 ApiData 形状（R2 H-4）。
 * x-harness host 的 WAL 事件词表（packages/core/session/src/types.ts）：
 * - user/message {content: ContentBlock[]}
 * - assistant/message {content: ContentBlock[]; thinking?}
 * - tool/call {callId,name,arguments} / tool/result {callId,content,isError?}
 * ContentBlock = text | tool_use | image。
 * 折叠为移动端 ChatMessage[]；未知事件类型保守跳过。
 */
import type { ChatMessage } from '@/types/domain';
import { isSnapshotFrame } from '@x3code/api/views/snapshot-frame';
import { foldToolRows, toolRowId } from './tool-rows';

interface WalLine {
  seq: number;
  ts: number;
  event: { type: string; [key: string]: unknown };
}

interface ContentBlockLike {
  type: string;
  text?: string;
  callId?: string;
  name?: string;
  input?: string;
  data?: string;
  mediaType?: string;
}

export interface EntriesResponse {
  entries: WalLine[];
  leafSeq: number;
  hasMore: boolean;
}

interface HostThreadRow {
  threadId: string;
  cwd: string;
  sessionPath: string | null;
  state: string;
  isStreaming?: boolean;
  /** 正文摘要（内容搜索与列表预览的锚点） */
  preview?: string;
}

interface HostModelRow {
  id: string;
  provider: string;
  [key: string]: unknown;
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
const blocks = (value: unknown): ContentBlockLike[] => (Array.isArray(value) ? (value as ContentBlockLike[]) : []);

/** WAL 行 → ChatMessage[]（词表逐型折叠）。 */
function walToMessages(line: WalLine): ChatMessage[] {
  const ev = line.event;
  const type = ev['type'];
  const at = new Date(line.ts).toISOString();
  if (type === 'user/message') {
    // 内核尾部快照信封帧（agent-types/date/project-instructions/技能清单）：模型上下文
    // 非对话内容——不做此门会把注入快照当用户消息渲染进手机端历史。
    if (isSnapshotFrame(ev)) return [];
    const message: ChatMessage = { id: `u-${line.seq}`, kind: 'user', text: '', createdAt: at };
    const images: Array<{ uri: string }> = [];
    for (const block of blocks(ev['content'])) {
      if (block.type === 'text') message.text += textOf(block.text);
      else if (block.type === 'image' && typeof block.data === 'string') images.push({ uri: `data:${textOf(block.mediaType)};base64,${block.data}` });
    }
    if (images.length > 0) {
      message.attachments = images.map((image, index) => ({ id: `img-${line.seq}-${index}`, name: 'image', size: 0, kind: 'image' as const, status: 'ready' as const, uri: image.uri }));
    }
    return [message];
  }
  if (type === 'assistant/message') {
    const messages: ChatMessage[] = [];
    const thinking = textOf(ev['thinking']);
    if (thinking.length > 0) messages.push({ id: `th-${line.seq}`, kind: 'thinking', text: thinking, createdAt: at, status: 'ok' });
    const text = blocks(ev['content'])
      .filter((block) => block.type === 'text')
      .map((block) => textOf(block.text))
      .join('');
    if (text.length > 0) messages.push({ id: `a-${line.seq}`, kind: 'assistant', text, createdAt: at });
    return messages;
  }
  if (type === 'tool/call') {
    return [{ id: toolRowId(textOf(ev['callId'])), kind: 'tool', text: '', createdAt: at, status: 'running', toolName: textOf(ev['name']), argsPreview: textOf(ev['arguments']).slice(0, 120) }];
  }
  if (type === 'tool/result') {
    return [{ id: toolRowId(textOf(ev['callId'])), kind: 'tool', text: textOf(ev['content']), createdAt: at, status: ev['isError'] === true ? 'failed' : 'ok', toolName: textOf(ev['name']) }];
  }
  return []; // turn/step、agent/status、system/message 等过程事件不进历史
}

export function mapEntriesResponse(data: unknown): { items: ChatMessage[]; cursor: number | null; hasMore: boolean } {
  if (data === null || typeof data !== 'object') return { items: [], cursor: null, hasMore: false };
  const res = data as Partial<EntriesResponse>;
  const entries = Array.isArray(res.entries) ? res.entries : [];
  const items: ChatMessage[] = [];
  for (const line of entries) {
    if (typeof line !== 'object' || line === null) continue;
    items.push(...walToMessages(line as WalLine));
  }
  return { items: foldToolRows(items), cursor: typeof res.leafSeq === 'number' ? res.leafSeq : null, hasMore: res.hasMore === true };
}

/**
 * thread/list 行 → history-sync SessionLike。
 * host 的 thread/list 只有运行态字段（threadId/cwd/state/sessionPath/isStreaming）——
 * 标题与最后活动时间不在该命令面，故这两项缺省缺席（history-sync 逐字段保留语义）。
 */
export function mapThreadRows(data: unknown): Array<{ threadId: string; cwd: string; state: string; streaming: boolean; sessionPath: string | null; lastActivityAt?: number; preview?: string }> {
  if (!Array.isArray(data)) return [];
  return (data as HostThreadRow[]).filter((row) => typeof row?.threadId === 'string').map((row) => ({
    threadId: row.threadId,
    cwd: row.cwd ?? '',
    state: row.state ?? 'live',
    streaming: row.isStreaming === true,
    sessionPath: row.sessionPath ?? null,
    // preview 是内容搜索与列表预览的锚点：不透传则 host 下发的摘要在此丢失，
    // history-sync 侧永远读到 undefined（字段断链会让整条特性静默失效）
    ...(typeof row.preview === 'string' ? { preview: row.preview } : {}),
  }));
}

/** get_models 行 → ModelInfoView 形态（id → modelId）。 */
export function mapModelRows(data: unknown): Array<{ provider: string; modelId: string; reasoning?: boolean }> {
  if (!Array.isArray(data)) return [];
  return (data as HostModelRow[]).filter((row) => typeof row?.id === 'string').map((row) => ({ provider: row.provider ?? '', modelId: row.id }));
}

/** thread/list_saved → saved 形态。 */
export function mapSavedSessions(data: unknown): Array<Record<string, string | number | undefined>> {
  const rows = data !== null && typeof data === 'object' && Array.isArray((data as { sessions?: unknown }).sessions) ? ((data as { sessions: unknown[] }).sessions) : Array.isArray(data) ? data : [];
  const out: Array<Record<string, string | number | undefined>> = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    // R3 H8：host saved 行主键是 id（saved-query）——id/threadId/sessionId/sessionPath 任一
    if (typeof row?.['id'] !== 'string' && typeof row?.['sessionPath'] !== 'string' && typeof row?.['sessionId'] !== 'string' && typeof row?.['threadId'] !== 'string') continue;
    const entry: Record<string, string | number | undefined> = {
      sessionId: typeof row['id'] === 'string' ? (row['id'] as string) : typeof row['threadId'] === 'string' ? (row['threadId'] as string) : typeof row['sessionId'] === 'string' ? (row['sessionId'] as string) : (row['sessionPath'] as string),
    };
    if (typeof row['sessionPath'] === 'string') entry['sessionPath'] = row['sessionPath'] as string;
    if (typeof row['title'] === 'string') entry['title'] = row['title'] as string;
    if (typeof row['cwd'] === 'string') entry['cwd'] = row['cwd'] as string;
    if (typeof row['preview'] === 'string') entry['preview'] = row['preview'] as string;
    const activity = num(row['lastActivityAt']) ?? num(row['updatedAt']) ?? num(row['endedAtMs']);
    if (activity !== undefined) entry['lastActivityAt'] = activity;
    out.push(entry);
  }
  return out;
}
