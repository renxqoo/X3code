import * as React from 'react';

/**
 * 点击涟漪层（T61 M3）：画布叠加最近动作的扩散圆环（click 有坐标时）。
 * 坐标是页面 CSS 坐标，按帧 meta 换算画布位置；2s 动画后自清。
 */

export type Ripple = { id: number; x: number; y: number; at: number };

const RIPPLE_MS = 1800;

export function useRipples(actions: ReadonlyArray<{ id: number; kind: string; x?: number; y?: number }>): ReadonlyArray<Ripple> {
  const [ripples, setRipples] = React.useState<ReadonlyArray<Ripple>>([]);
  const lastIdRef = React.useRef(0);

  React.useEffect(() => {
    const lastAction = actions[actions.length - 1];
    const fresh = actions.filter((a) => a.id > lastIdRef.current && a.kind === 'click' && a.x !== undefined && a.y !== undefined);
    if (lastAction !== undefined) lastIdRef.current = lastAction.id;
    if (fresh.length === 0) return;
    setRipples((prev) => [
      ...prev,
      ...fresh.flatMap((a) => (a.x !== undefined && a.y !== undefined ? [{ id: a.id, x: a.x, y: a.y, at: Date.now() }] : [])),
    ].slice(-8));
    const timer = setTimeout(() => {
      setRipples((prev) => prev.filter((r) => Date.now() - r.at < RIPPLE_MS));
    }, RIPPLE_MS + 100);
    return () => clearTimeout(timer);
  }, [actions]);

  return ripples;
}
