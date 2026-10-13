import type { PickedElement } from '@x3code/contracts';

/**
 * 拾取卡片 → 输入区序列化（T61 §7 接缝：首行人类可读，其后机器段定界）。
 * 渲染层卡片按首行渲染；Agent 按机器段解析（selector/styles/bbox/pageUrl）。
 */

export function pickedElementText(element: PickedElement): string {
  const label = element.ariaLabel ?? element.textPreview;
  const header = `[页面元素] ${element.tag}${element.id !== undefined ? `#${element.id}` : ''}${label.length > 0 ? ` ${label}` : ''}`;
  const lines = [
    header,
    '---',
    `selector: ${element.selector}`,
    `pageUrl: ${element.pageUrl}`,
    `bbox: ${element.bbox.x},${element.bbox.y} ${element.bbox.width}x${element.bbox.height}`,
    `styles: font-size ${element.styles.fontSize}; color ${element.styles.color}; background ${element.styles.backgroundColor}; margin ${element.styles.margin}; padding ${element.styles.padding}; display ${element.styles.display}`,
  ];
  return lines.join('\n');
}

/** 附件名（拾取无文件概念：tag+序号占位）。 */
export function pickedImageName(element: PickedElement, index: number): string {
  return `${element.tag}${element.id !== undefined ? `-${element.id}` : ''}-${index}.jpg`;
}
