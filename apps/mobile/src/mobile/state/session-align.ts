/**
 * 会话消息面的起点对齐（store 与事件归并器两端的锚点）。
 *
 * 症状域：本地提示行（发送失败/未连接/缺工作区）与桥接行曾分两路写入同一槽
 * ——store 的直写 append 会被归并器下一个快照整体替换吃掉（提示闪一下就没）。
 * 归并器成为唯一消息流写入口后，两端必须始终同起点：store 因切会话/重连换了
 * 消息面时，归并器内的旧行（含上个会话的本地行）会随下个快照被带出来。
 *
 * 归并器实例住在 runtime（它随 relay 连接建立），本模块只持有它的引用面，
 * 不复制状态——单一真相仍在 createSessionSync。
 */
import { useConversationStore } from '@/store/conversation-store';
import type { createSessionSync } from '@/mobile/state/session-sync';
import type { ChatMessage } from '@/types/domain';

type SessionSync = ReturnType<typeof createSessionSync>;

let syncRef: SessionSync | null = null;

/** runtime 建立归并器后登记（持有者唯一，见 runtime 的 sessionSyncRef）。 */
export function setSessionSync(instance: SessionSync | null): void {
  syncRef = instance;
}

/**
 * 把归并器起点对齐到 store 当前消息面。
 *
 * 与 seed 的差别是「旧本地行去不去」：这里一律不保留——调用点都在会话切换/重连
 * 之后，保留会把上个会话的行带进新会话。
 */
export function rebaselineSession(): void {
  syncRef?.rebaseline([...useConversationStore.getState().session.messages]);
}

/**
 * 设备侧本地行入流（发送失败/未连接/缺工作区）。
 *
 * 经归并器而非直改 store：事件泵每个事件都用快照整体替换 session.messages，
 * 直改 store 的行会闪一下即被冲掉。与桥接行共用一条 messages 数组及去重域。
 *
 * 未挂线程（离线/首配）时归并器尚不存在且没有事件泵会覆盖，本地直接持有，
 * 去重按 id——连续多次同类失败不堆叠行。
 */
export function appendLocalRow(message: ChatMessage): void {
  const sync = syncRef;
  if (sync === null) {
    const store = useConversationStore.getState();
    if (store.session.messages.some((row) => row.id === message.id)) return;
    store.appendMessages([...store.session.messages, message]);
    return;
  }
  sync.appendLocal(message);
  useConversationStore.getState().appendMessages(sync.snapshot().messages);
}