/**
 * 症状：内容搜索永远零结果。
 *
 * 根因：会话行的 preview 恒为空串（history-sync 两处构造都写死 ''），而搜索过滤
 * 读的是 `${title}${preview}${project}`——只有标题和项目名能命中，搜索页的引导文案
 * 却写着「试试项目名、文件名或对话关键词」，承诺了做不到的能力。
 *
 * 真相源在 hub：thread/list 与 thread/list_saved 都从会话归档折叠出 preview
 * （x-harness host-hub shared/preview-fold），设备侧只负责带下来。
 */
import { describe, expect, it } from '@jest/globals';

import { createHistorySync, mergeSaved, toConversationSession } from '@/mobile/state/history-sync';

describe('会话预览（症状：内容搜索永远零结果）', () => {
  it('live 会话带 hub 下发的 preview', () => {
    const session = toConversationSession({ threadId: 't1', title: '标题', preview: '正文里有 relay 这个词' }, false, false);
    expect(session.preview).toBe('正文里有 relay 这个词');
  });

  it('hub 未下发 preview 时降级为空串（不留 undefined）', () => {
    const session = toConversationSession({ threadId: 't1', title: '标题' }, false, false);
    expect(session.preview).toBe('');
  });

  it('归档会话带 preview', () => {
    const merged = mergeSaved([], [{ sessionId: 's1', title: '标题', preview: '归档会话的正文' }]);
    expect(merged[0]?.preview).toBe('归档会话的正文');
  });

  it('preview 参与搜索匹配：内容关键词可命中', () => {
    const rows = [
      { ...toConversationSession({ threadId: 't1', title: '标题A', preview: '讨论 relay 配对' }, false, false) },
      { ...toConversationSession({ threadId: 't2', title: '标题B', preview: '讨论别的' }, false, false) },
    ];
    const hit = rows.filter((row) => `${row.title}${row.preview}${row.project}`.toLowerCase().includes('relay'));
    expect(hit.map((row) => row.id)).toEqual(['t1']);
  });

  it('sessionUpdated 带来的 preview 更新进列表行', () => {
    const emitted: Array<{ id: string; preview: string }[]> = [];
    const sync = createHistorySync({ onSessions: (sessions) => { emitted.push(sessions as never); } });
    sync.updateSession({ threadId: 't1', title: '标题', preview: '第一版摘要' } as never);
    sync.updateSession({ threadId: 't1', title: '标题', preview: '第二版摘要' } as never);
    expect(emitted[emitted.length - 1]?.[0]?.preview).toBe('第二版摘要');
  });
});