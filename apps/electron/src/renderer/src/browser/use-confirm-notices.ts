import * as React from 'react';

/**
 * 确认门通知状态（T61 M3）：confirmNotice 事件 → 待批清单（120s 与 bw 超时
 * 对齐自动收起；每 cid 恰好一次）。UX 层非安全边界（见方案 §4a）。
 */

export type ConfirmNotice = { sid: string; cid: string; reason: string };

export function useConfirmNotices(bridge: { subscribeBrowser(onEvent: (e: unknown) => void): () => void } | null): ReadonlyArray<ConfirmNotice> {
  const [notices, setNotices] = React.useState<ReadonlyArray<ConfirmNotice>>([]);
  const seenRef = React.useRef(new Set<string>());

  React.useEffect(() => {
    if (bridge === null) return;
    const events: ConfirmNotice[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = bridge.subscribeBrowser((raw) => {
      const event = raw as { type?: string; sid?: unknown; cid?: unknown; reason?: unknown };
      if (event.type !== 'confirmNotice' || typeof event.cid !== 'string' || typeof event.sid !== 'string') return;
      if (seenRef.current.has(event.cid)) return;
      seenRef.current.add(event.cid);
      events.push({ sid: event.sid, cid: event.cid, reason: typeof event.reason === 'string' ? event.reason : '' });
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        if (events.length === 0) return;
        const batch = events.splice(0, events.length);
        setNotices((prev) => [...prev, ...batch].slice(-3));
        setTimeout(() => {
          setNotices((prev) => prev.filter((n) => !batch.some((b) => b.cid === n.cid)));
        }, 120_000);
      }, 50);
    });
    return () => {
      unsubscribe();
      if (flushTimer !== null) clearTimeout(flushTimer);
    };
  }, [bridge]);

  return notices;
}
