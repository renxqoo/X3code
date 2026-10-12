/**
 * 扫码模态的测试替身：visible 时把 globalThis.__scanPayload 投给 onPayload（消费即清）。
 * 独立成文件而非写在 jest.mock 工厂里——工厂只允许引用白名单标识符，
 * 取 React（useEffect）必须用 require，而 require 触犯 no-require-imports。
 */
import * as React from 'react';

export interface ScanPayloadProps {
  visible: boolean;
  onPayload: (payload: string) => void;
}

export function QrScanModal({ visible, onPayload }: ScanPayloadProps) {
  // 投递走 effect：render 期间调父组件回调会触发 React 的 setState-in-render 警告
  React.useEffect(() => {
    const scan = globalThis as { __scanPayload?: string };
    if (!visible || scan.__scanPayload === undefined) return;
    const payload = scan.__scanPayload;
    scan.__scanPayload = undefined;
    onPayload(payload);
  }, [visible, onPayload]);
  return null;
}