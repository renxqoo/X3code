/**
 * 会话列表形状归一（症状：手机端列表恒空 → cwd 守卫永不满足 → 发不出第一条消息）。
 */
import { describe, expect, it } from '@jest/globals';

import { normalizeSessionRows } from '@/mobile/relay/session-rows';

describe('会话列表形状归一（症状：工作空间候选恒空，手机端发不出消息）', () => {
  it.each([
    ['裸数组', [{ id: 'a' }]],
    ['{sessions:[...]} 包装', { sessions: [{ id: 'a' }] }],
  ])('%s：识别出行', (_name, data) => {
    expect(normalizeSessionRows(data)).toHaveLength(1);
  });

  it('两侧用同一套归一——包装形态下 saved 不再整体落空', () => {
    const live = normalizeSessionRows({ sessions: [{ id: 'live-1' }] });
    const saved = normalizeSessionRows({ sessions: [{ id: 'saved-1' }] });
    expect([...live, ...saved].map((row) => row['id'])).toEqual(['live-1', 'saved-1']);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['空对象', {}],
    ['sessions 非数组', { sessions: 'oops' }],
    ['数组外的字符串', 'nope'],
    ['数字', 42],
  ])('%s：降级为空形态（不抛）', (_name, data) => {
    expect(normalizeSessionRows(data)).toEqual([]);
  });

  it('空数组保持空', () => {
    expect(normalizeSessionRows([])).toEqual([]);
    expect(normalizeSessionRows({ sessions: [] })).toEqual([]);
  });
});