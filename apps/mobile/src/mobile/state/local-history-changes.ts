/**
 * 历史列表的本地变更登记（置顶/归档/改名/删除）。
 *
 * 症状：用户置顶/归档/改名后，下一条 sessionUpdated 到达即回滚，删除的会话还会复活。
 * 根因：history-sync 的 Map 是历史真相，store 只是它的投影拷贝；本地动作只改拷贝，
 * 下一次整体替换把拷贝换回旧值。
 *
 * 为什么走登记而不是让 store 直写 sync：store 引 runtime 会成环（runtime 已引 store）。
 * 登记把「本地意图」与「真相同步」解耦——store 只登记意图，runtime 装配就绪后消费。
 *
 * pending 只在 sink 未就绪时留存（bootstrap 前用户就操作了也不丢）。sink 一旦就绪，
 * 意图即由真相层自己持有（localTitles + 墓碑），本模块不留副本——留副本会让上一次
 * 的删除意图（终态 null）污染下一次同 id 的置顶/改名。
 */

type LocalChange = { pinned?: boolean; archived?: boolean; title?: string } | null;

let pending: Array<[string, LocalChange]> = [];
let sink: ((id: string, change: LocalChange) => void) | null = null;

/**
 * 登记本地变更。sink 未就绪时先攒着（同一 id 合并，取最后意图；删除是终态）。
 */
export function recordLocalHistoryChange(id: string, change: LocalChange): void {
  const consumer = sink;
  if (consumer !== null) {
    consumer(id, change);
    return;
  }
  const at = pending.findIndex(([pendingId]) => pendingId === id);
  const merged = at < 0 ? change : pending[at]?.[1] === null || change === null ? null : { ...pending[at]?.[1], ...change };
  if (at < 0) pending.push([id, merged]);
  else pending[at] = [id, merged];
}

/** runtime 装配就绪后登记消费口，并把之前攒的变更一次性冲刷进去。 */
export function bindLocalHistorySink(handler: (id: string, change: LocalChange) => void): void {
  sink = handler;
  const flushed = pending;
  pending = [];
  for (const [id, change] of flushed) handler(id, change);
}