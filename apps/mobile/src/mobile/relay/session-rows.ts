/**
 * 会话列表形状归一。
 *
 * 症状：手机端历史/工作空间列表恒空 → cwd 守卫永不满足 → 手机端发不出第一条消息
 * （文案「先选择电脑端已有的工作空间，再发送消息」），而电脑端明明有会话。
 *
 * 根因：listBootstrap 对 live 面认 `{sessions:[...]}`、对 saved 面只认裸数组。host 的
 * 响应包装并不一致（有的包一层、有的不包），包装形态下 saved 侧整体落空，而 cwd 守卫的
 * 候选正来自 live+saved 合并。两侧必须用同一套形状归一。
 */

type SessionRow = Record<string, unknown>;

/** 归一为行数组：接受裸数组与 {sessions:[...]} 两种包装，其余（null/对象/缺字段）返空。 */
export function normalizeSessionRows(data: unknown): SessionRow[] {
  if (Array.isArray(data)) return data as SessionRow[];
  if (data !== null && typeof data === 'object') {
    const rows = (data as { sessions?: unknown }).sessions;
    if (Array.isArray(rows)) return rows as SessionRow[];
  }
  return [];
}