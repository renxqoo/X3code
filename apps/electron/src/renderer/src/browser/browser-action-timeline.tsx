import * as React from 'react';

import { cn } from '@/lib/utils';
import { copy } from '@/strings';

import type { BrowserActionEntry } from './use-browser-panel';

/**
 * 动作时间线（T61 M3）：人/Agent 两侧输入动作的环形列表（钩子统一来源，
 * 不区分产生者）。密码框值已在钩子源头打码；敌意伪造只污染显示不驱动决策。
 */

const KIND_LABEL: Record<BrowserActionEntry['kind'], string> = {
  click: copy.browser.actionClick,
  input: copy.browser.actionInput,
  change: copy.browser.actionChange,
  keydown: copy.browser.actionKey,
  scroll: copy.browser.actionScroll,
};

function entryLabel(entry: BrowserActionEntry): string {
  const kind = KIND_LABEL[entry.kind];
  if (entry.elementLabel !== undefined && entry.elementLabel.length > 0) return `${kind} · ${entry.elementLabel}`;
  if (entry.kind === 'scroll' && entry.y !== undefined) return `${kind} · y=${entry.y}`;
  return kind;
}

export function BrowserActionTimeline({ actions }: { actions: ReadonlyArray<BrowserActionEntry> }) {
  const listRef = React.useRef<HTMLDivElement | null>(null);
  // 新动作到达时贴底（用户上翻时不动）
  React.useEffect(() => {
    const el = listRef.current;
    if (el === null) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [actions]);

  const recent = actions.slice(-100);
  return (
    <div className="flex h-full min-h-0 flex-col border-t border-border">
      <div className="shrink-0 px-[12px] py-[6px] text-[11px] font-medium text-muted-foreground">{copy.browser.timelineTitle}</div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-[12px] pb-[8px]">
        {recent.length === 0 ? (
          <p className="py-[8px] text-[11px] text-muted-foreground/70">{copy.browser.timelineEmpty}</p>
        ) : (
          recent.map((entry) => (
            <div
              key={entry.id}
              className={cn('flex items-baseline gap-[8px] py-[2px] text-[11px]', entry.kind === 'click' ? 'text-foreground' : 'text-muted-foreground')}
            >
              <span className="w-[38px] shrink-0 tabular-nums text-muted-foreground/60">
                {new Date(entry.at).toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' })}
              </span>
              <span className="min-w-0 truncate">{entryLabel(entry)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
