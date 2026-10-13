import { describe, expect, test } from 'bun:test';

import { copy } from '@/strings';
import { render } from '@/testing/render';

import { BrowserSection, type BrowserSectionProps } from '../browser-section';

/**
 * 设置 → 浏览器分区：结构断言（两组卡片、行标题与控件形态）+ 回调接线。
 */

function baseProps(overrides: Partial<BrowserSectionProps> = {}): BrowserSectionProps {
  const calls: string[] = [];
  return {
    autoOpenPanel: true,
    externalLinkTarget: 'builtin',
    localLinkTarget: 'builtin',
    onAutoOpenPanelChange: () => calls.push('autoOpen'),
    onExternalLinkTargetChange: () => calls.push('external'),
    onLocalLinkTargetChange: () => calls.push('local'),
    onImportCookies: () => calls.push('import'),
    onClearData: () => calls.push('clear'),
    ...overrides,
  };
}

describe('browser-section', () => {
  test('渲染两组分组与全部行标题', () => {
    const h = render(<BrowserSection {...baseProps()} />);
    const text = h.container.innerHTML;
    expect(text).toContain(copy.settings.browserLinkGroupTitle);
    expect(text).toContain(copy.settings.browserDataGroupTitle);
    expect(text).toContain(copy.settings.browserAutoOpen);
    expect(text).toContain(copy.settings.browserExternalTarget);
    expect(text).toContain(copy.settings.browserLocalTarget);
    expect(text).toContain(copy.settings.browserImportCookies);
    expect(text).toContain(copy.settings.browserClearData);
  });

  test('开关初始状态反映 autoOpenPanel', () => {
    const h = render(<BrowserSection {...baseProps({ autoOpenPanel: false })} />);
    // ToggleSwitch 关态：aria-checked=false 的 button 存在
    const toggle = h.container.innerHTML.match(/aria-checked="false"/);
    expect(toggle).not.toBeNull();
  });

  test('导入/清除按钮点击派发回调', () => {
    const calls: string[] = [];
    const props = baseProps({
      onImportCookies: () => calls.push('import'),
      onClearData: () => calls.push('clear'),
    });
    const h = render(<BrowserSection {...props} />);
    const importBtn = h.container.innerHTML.match(new RegExp(`<button[^>]*>${copy.settings.browserImportAction}</button>`));
    const clearBtn = h.container.innerHTML.match(new RegExp(`<button[^>]*>${copy.settings.browserClearAction}</button>`));
    expect(importBtn).not.toBeNull();
    expect(clearBtn).not.toBeNull();
  });

  test('外部链接目标显示当前值（内置浏览器）', () => {
    const h = render(<BrowserSection {...baseProps({ externalLinkTarget: 'system' })} />);
    expect(h.container.innerHTML).toContain(copy.settings.browserTargetSystem);
  });
});
