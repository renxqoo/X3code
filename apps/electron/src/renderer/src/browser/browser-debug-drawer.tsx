import * as React from 'react';

import { cn } from '@/lib/utils';
import { copy } from '@/strings';

/**
 * 调试 drawer（T61 M4）：bw s console/errors/requests/perf 面板化。
 * 数据按需拉取（tab 切换触发；失败/无会话匹配显示空态）。
 */

const SOURCES = ['console', 'errors', 'requests', 'perf'] as const;
type DebugSource = (typeof SOURCES)[number];

const SOURCE_LABEL: Record<DebugSource, string> = {
  console: copy.browser.debugConsole,
  errors: copy.browser.debugErrors,
  requests: copy.browser.debugRequests,
  perf: copy.browser.debugPerf,
};

type ConsoleRow = { level: string; text: string };
type RequestRow = { url: string; method: string; status: number; durationMs: number; size: number };

export function BrowserDebugDrawer({ bridge, targetId }: { bridge: { invoke(method: string, params: unknown): Promise<unknown> } | null; targetId: string | null }) {
  const [source, setSource] = React.useState<DebugSource>('console');
  const [rows, setRows] = React.useState<ReadonlyArray<ConsoleRow | RequestRow>>([]);
  const [summary, setSummary] = React.useState('');
  const [empty, setEmpty] = React.useState(false);

  React.useEffect(() => {
    if (bridge === null || targetId === null) return;
    setEmpty(false);
    setRows([]);
    setSummary('');
    void bridge.invoke('browser/debugQuery', { targetId, source }).then(
      (raw) => {
        if (typeof raw !== 'object' || raw === null || (raw as { ok?: boolean }).ok !== true) {
          setEmpty(true);
          return;
        }
        const data = (raw as { data: Record<string, unknown> }).data;
        if (source === 'perf') {
          setSummary(typeof data['summary'] === 'string' ? data['summary'] : '');
        } else {
          const list = data['rows'];
          setRows(Array.isArray(list) ? (list as (ConsoleRow | RequestRow)[]) : []);
        }
      },
      () => setEmpty(true),
    );
  }, [bridge, targetId, source]);

  return (
    <div className="flex h-full min-h-0 flex-col border-t border-border">
      <div className="flex shrink-0 items-center gap-[2px] px-[8px] pt-[4px]">
        {SOURCES.map((entry) => (
          <button
            key={entry}
            type="button"
            className={cn('rounded-md px-[8px] py-[3px] text-[11px]', source === entry ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50')}
            onClick={() => setSource(entry)}
          >
            {SOURCE_LABEL[entry]}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-[12px] py-[6px]">
        {empty ? (
          <p className="text-[11px] text-muted-foreground/70">{copy.browser.debugEmpty}</p>
        ) : source === 'perf' ? (
          <pre className="whitespace-pre-wrap text-[11px] text-muted-foreground">{summary}</pre>
        ) : source === 'requests' ? (
          (rows as ReadonlyArray<RequestRow>).map((row, index) => (
            <div key={index} className="flex items-baseline gap-[8px] py-[1px] text-[11px]">
              <span className={cn('shrink-0 tabular-nums', row.status >= 400 ? 'text-destructive' : 'text-muted-foreground')}>{row.status}</span>
              <span className="shrink-0 text-muted-foreground">{row.method}</span>
              <span className="min-w-0 truncate">{row.url}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground/60">{row.durationMs}ms</span>
            </div>
          ))
        ) : (
          (rows as ReadonlyArray<ConsoleRow>).map((row, index) => (
            <div key={index} className="py-[1px] text-[11px]">
              <span className={cn('mr-[6px]', row.level === 'error' ? 'text-destructive' : 'text-muted-foreground/60')}>[{row.level}]</span>
              <span className="whitespace-pre-wrap break-all">{row.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
