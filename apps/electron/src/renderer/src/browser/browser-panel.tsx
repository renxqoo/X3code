import * as React from 'react';

import { cn } from '@/lib/utils';
import { copy } from '@/strings';

import { useBrowserPanel, type BrowserBridge } from './use-browser-panel';

/**
 * 浏览器面板（T61 M1）：投屏画布 + tab 条 + 地址栏 + attach 复制条。
 * 输入转发：画布鼠标/滚轮/键盘 → invoke browser/input（页面 CSS 坐标）。
 */

export function BrowserPanel({ bridge }: { bridge: BrowserBridge | null }) {
  const state = useBrowserPanel(bridge);
  const canvasRef = React.useRef<HTMLImageElement | null>(null);
  const [address, setAddress] = React.useState('');
  const [copied, setCopied] = React.useState(false);

  const activeTab = state.tabs.find((tab) => tab.active);
  const frameSrc =
    state.frame !== null && state.frame.targetId === activeTab?.targetId
      ? `data:image/jpeg;base64,${state.frame.jpegB64}`
      : null;

  React.useEffect(() => {
    setAddress(activeTab?.url ?? '');
  }, [activeTab?.url]);

  const invoke = React.useCallback(
    (method: string, params: unknown) => {
      void bridge?.invoke(method, params).catch(() => undefined);
    },
    [bridge],
  );

  /** 画布事件 → 页面坐标（meta 换算）→ browser/input。 */
  const toPage = (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const img = canvasRef.current;
    if (img === null || state.frame === null) return null;
    const rect = img.getBoundingClientRect();
    const scaleX = state.frame.meta.deviceWidth / Math.max(1, rect.width);
    const scaleY = state.frame.meta.deviceHeight / Math.max(1, rect.height);
    const x = Math.round((event.clientX - rect.left) * scaleX);
    const y = Math.round((event.clientY - rect.top) * scaleY);
    if (x < 0 || y < 0 || x > state.frame.meta.deviceWidth || y > state.frame.meta.deviceHeight) return null;
    return { x, y };
  };

  const onNavigate = (): void => {
    if (activeTab === undefined || address.trim().length === 0) return;
    invoke('browser/navigate', { targetId: activeTab.targetId, url: address.trim() });
  };

  const onCopyAttach = (): void => {
    if (state.cdpEndpoint === null) return;
    void navigator.clipboard.writeText(`bw s create --cdp-url ${state.cdpEndpoint} --allow-eval --allow-private-network`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* tab 条 */}
      <div className="flex items-center gap-[4px] border-b border-border px-[8px] py-[4px]">
        {state.tabs.map((tab) => (
          <button
            key={tab.targetId}
            type="button"
            className={cn(
              'flex min-w-0 max-w-[180px] items-center gap-[6px] rounded-md px-[8px] py-[3px] text-[12px]',
              tab.active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50',
            )}
            onClick={() => invoke('browser/tabActivate', { targetId: tab.targetId })}
            title={tab.url}
          >
            <span className="truncate">{tab.title || tab.url}</span>
            <span
              role="button"
              tabIndex={-1}
              aria-label={copy.panel.closeTab(tab.title || tab.url)}
              className="shrink-0 rounded p-[1px] hover:bg-background/60"
              onClick={(e) => {
                e.stopPropagation();
                invoke('browser/tabClose', { targetId: tab.targetId });
              }}
              onKeyDown={undefined}
            >
              ×
            </span>
          </button>
        ))}
        <button
          type="button"
          className="rounded-md px-[6px] py-[3px] text-[12px] text-muted-foreground hover:bg-accent/50"
          aria-label={copy.browser.newTab}
          onClick={() => invoke('browser/tabOpen', {})}
        >
          +
        </button>
      </div>

      {/* 地址栏 + attach 条 */}
      <div className="flex items-center gap-[8px] border-b border-border px-[10px] py-[6px]">
        <input
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-[8px] py-[4px] text-[12px] outline-none focus:border-ring"
          placeholder={copy.browser.addressPlaceholder}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onNavigate();
          }}
          aria-label={copy.browser.addressLabel}
        />
        <button
          type="button"
          className="shrink-0 rounded-md border border-border px-[8px] py-[4px] text-[11px] text-muted-foreground hover:bg-accent/50"
          onClick={onCopyAttach}
          title={copy.browser.attachHint}
        >
          {copied ? copy.browser.attachCopied : copy.browser.attach}
        </button>
      </div>

      {/* 投屏画布 */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-black/5">
        {frameSrc !== null ? (
          <img
            ref={canvasRef}
            src={frameSrc}
            alt={copy.browser.canvasAlt}
            className="h-full w-full object-contain"
            draggable={false}
            onClick={(e) => {
              const point = toPage(e);
              if (point === null || activeTab === undefined) return;
              invoke('browser/input', { targetId: activeTab.targetId, input: { kind: 'mouse', x: point.x, y: point.y, button: 'left', press: true } });
              invoke('browser/input', { targetId: activeTab.targetId, input: { kind: 'mouse', x: point.x, y: point.y, button: 'left', press: false } });
            }}
            onWheel={(e) => {
              const point = toPage(e);
              if (point === null || activeTab === undefined) return;
              invoke('browser/input', { targetId: activeTab.targetId, input: { kind: 'wheel', x: point.x, y: point.y, deltaX: e.deltaX, deltaY: e.deltaY } });
            }}
            onKeyDown={(e) => {
              if (activeTab === undefined) return;
              invoke('browser/input', { targetId: activeTab.targetId, input: { kind: 'key', key: e.key, down: true } });
            }}
            tabIndex={0}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
            {state.phase === 'ready' ? copy.browser.emptyFrame : copy.browser.starting}
          </div>
        )}
      </div>
    </div>
  );
}
