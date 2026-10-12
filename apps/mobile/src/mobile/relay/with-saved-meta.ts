/**
 * 会话列表元数据归并（thread/list × thread/list_saved）。
 *
 * thread/list_saved 是 PC 侧会话元数据的唯一真源（title/最后活动时间/模型都在这条命令面；
 * thread/list 只有运行态字段）。两份按 threadId 归并：live 行补上缺失的标题与时间，
 * 在册行仍以 live 的运行态（state/streaming）为真相。
 */
/** 字段安全取串（object → ''）。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function withSavedMeta(
  live: Array<Record<string, unknown>>,
  saved: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of saved) {
    const id = typeof row['sessionId'] === 'string' ? (row['sessionId'] as string) : typeof row['id'] === 'string' ? (row['id'] as string) : '';
    if (id.length > 0) byId.set(id, row);
  }
  return live.map((row) => {
    const id = textOf(row['threadId']);
    const meta = byId.get(id);
    if (meta === undefined) return row;
    const merged: Record<string, unknown> = { ...row };
    if (typeof merged['title'] !== 'string' && typeof meta['title'] === 'string') merged['title'] = meta['title'];
    if (typeof merged['cwd'] !== 'string' && typeof meta['cwd'] === 'string') merged['cwd'] = meta['cwd'];
    // live 行的 preview 可能缺（宿主表未折叠）或为空串；saved 面是内容摘要的权威，
    // 只在 live 侧拿不到值时补，不覆盖已有摘要
    if ((merged['preview'] === undefined || merged['preview'] === '') && typeof meta['preview'] === 'string') {
      merged['preview'] = meta['preview'];
    }
    if (typeof merged['lastActivityAt'] !== 'number') {
      const at = typeof meta['lastActivityAt'] === 'number' ? (meta['lastActivityAt'] as number) : undefined;
      if (at !== undefined) merged['lastActivityAt'] = at;
    }
    return merged;
  });
}
