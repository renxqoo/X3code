/**
 * 症状回归（发送失败静默）：手机端发送失败时提示行「闪一下就没了」——本地提示
 * 直接 append 到 store，而事件泵每个事件都用归并器快照整体替换 session.messages，
 * 两路事实源共用同一槽，本地行必被下一个快照吃掉。
 *
 * 治本口径：本地行与桥接行经同一条 messages 数组（sync 为唯一写入口），
 * 且本地提示行跨历史水合存活——用户回来看历史时不该以为当时送达了。
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { createSessionSync, isLocalRow, localRowId } from '@/mobile/state/session-sync';
import type { ChatMessage } from '@/types/domain';

const localStatus = (key: string, text: string): ChatMessage => ({ id: localRowId(key), kind: 'status', text, createdAt: 'now', status: 'failed', summary: '未送达' });

function sync(): ReturnType<typeof createSessionSync> {
  return createSessionSync({ onDialogRequest: () => undefined, onSessionEvent: () => undefined });
}

const texts = (messages: ChatMessage[]): string[] => messages.map((message) => message.text);

describe('本地提示行不被事件快照冲掉（症状：发送失败提示闪一下就没）', () => {
  let instance: ReturnType<typeof createSessionSync>;
  beforeEach(() => {
    instance = sync();
    jest.clearAllMocks();
  });

  it('本地提示行入流后，来一串事件仍在——不再被整体替换吃掉', () => {
    instance.appendLocal(localStatus('send-failed', '发送失败：设备权限不足'));
    instance.handleEvent({ type: 'turnStarted' });
    instance.handleEvent({ type: 'textDelta', messageId: 'm1', delta: '正在处理' });
    instance.handleEvent({ type: 'messageFinal', message: { id: 'm1', text: '完成了' } });
    expect(texts(instance.snapshot().messages)).toContain('发送失败：设备权限不足');
  });

  it('本地提示行跨历史水合存活——回看历史时「没送出去」的事实不被抹掉', () => {
    instance.appendLocal(localStatus('send-failed', '发送失败：会话已在桌面端关闭'));
    instance.seed([{ id: 'u-1', kind: 'user', text: '早先那句', createdAt: 'now' }]);
    expect(texts(instance.snapshot().messages)).toContain('发送失败：会话已在桌面端关闭');
  });

  it('连续两次同因失败只留一行——重复投递不堆叠', () => {
    instance.appendLocal(localStatus('send-not-connected', '未连接电脑端'));
    instance.appendLocal(localStatus('send-not-connected', '未连接电脑端'));
    expect(instance.snapshot().messages.filter(isLocalRow)).toHaveLength(1);
  });

  it('投递失败摘除本次乐观 user 回显——不会既显示送达又显示失败', () => {
    instance.appendLocal({ id: localRowId('user-1'), kind: 'user', text: '那句话', createdAt: 'now' });
    instance.appendLocal(localStatus('send-failed', '发送失败：桌面端不可用'));
    const snapshot = instance.snapshot().messages;
    expect(texts(snapshot)).toContain('发送失败：桌面端不可用');
    expect(texts(snapshot)).not.toContain('那句话');
  });

  it('权威 userMessage 回显到达时摘除乐观回显——同句话不裂成两条气泡', () => {
    instance.appendLocal({ id: localRowId('user-1'), kind: 'user', text: '同一句话', createdAt: 'now' });
    instance.handleEvent({ type: 'userMessage', message: { seq: 3, text: '同一句话', origin: 'user' } });
    const userRows = instance.snapshot().messages.filter((message) => message.kind === 'user');
    expect(userRows).toHaveLength(1);
    expect(userRows[0]?.id).toBe('u-3');
  });

  it('起点重置不保留旧会话的本地行——切会话后不留上个会话的失败提示', () => {
    instance.appendLocal(localStatus('send-failed', '上个会话的失败'));
    instance.rebaseline([]);
    instance.appendLocal(localStatus('send-failed', '本会话的失败'));
    expect(texts(instance.snapshot().messages)).toEqual(['本会话的失败']);
  });

  it('起点重置时乐观回显一并清掉——不带着上个会话的半截消息进新会话', () => {
    instance.appendLocal({ id: localRowId('user-9'), kind: 'user', text: '上个会话半截', createdAt: 'now' });
    instance.rebaseline([]);
    expect(instance.snapshot().messages).toEqual([]);
  });
});