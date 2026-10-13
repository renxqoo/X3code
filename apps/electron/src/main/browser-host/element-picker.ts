import { PICK_MASK, PICK_OUTER_HTML_LIMIT, PICK_SENSITIVE_KEY_PATTERN, PICK_SENSITIVE_TEXT_PATTERNS } from '@x3code/contracts';
import type { PickedElement } from './picked-element';

/**
 * 元素拾取（T61 §3.2）：elementFromPoint 结构化解析 + 敏感过滤（先脱敏后截断）。
 * 页内执行脚本生成原始数据，本层只做脱敏与裁剪（敌意载荷防御）。
 */

export type RawPick = {
  tag: string;
  id: string | null;
  classes: string[];
  ariaLabel: string | null;
  textPreview: string;
  selector: string;
  bbox: { x: number; y: number; width: number; height: number };
  styles: { fontSize: string; color: string; backgroundColor: string; margin: string; padding: string; display: string };
  outerHtml: string;
  pageUrl: string;
};

/** 页内采集脚本（字符串注入；返回 JSON 由调用方解析）。 */
export const PICK_COLLECT_EXPRESSION = `(() => {
  const el = document.elementFromPoint(PICK_X, PICK_Y);
  if (el === null) return null;
  const cs = getComputedStyle(el);
  const bbox = el.getBoundingClientRect();
  const attrs = {};
  for (const a of el.attributes) attrs[a.name] = a.value;
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: el.className && typeof el.className === 'string' ? el.className.split(/\\s+/).filter(Boolean) : [],
    ariaLabel: el.getAttribute('aria-label'),
    textPreview: (el.innerText || '').trim(),
    selector: (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' && el.className.split(/\\s+/)[0] ? '.' + el.className.trim().split(/\\s+/)[0] : '')),
    bbox: { x: Math.round(bbox.x), y: Math.round(bbox.y), width: Math.round(bbox.width), height: Math.round(bbox.height) },
    styles: { fontSize: cs.fontSize, color: cs.color, backgroundColor: cs.backgroundColor, margin: cs.margin, padding: cs.padding, display: cs.display },
    outerHtml: el.outerHTML || '',
    pageUrl: location.href,
    attrs,
  };
})()`;

/** 文本敏感模式脱敏（sk-/ghp_/AKIA/Bearer/长 base64）。 */
export function maskSensitiveText(text: string): string {
  let out = text;
  for (const pattern of PICK_SENSITIVE_TEXT_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags), PICK_MASK);
  }
  return out;
}

/** outerHTML 脱敏：敏感属性名的值替换（含「值属主敏感」——name="password" 声明字段性质，
 *  同元素后续 value 属性同样敏感）；先脱敏后截断。 */
export function sanitizeOuterHtml(html: string): string {
  let out = html;
  // 第一遍：直接敏感属性名（data-token=... 等）
  out = out.replace(/([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, (match, name: string) => {
    if (PICK_SENSITIVE_KEY_PATTERN.test(name)) {
      return `${name}="${PICK_MASK}"`;
    }
    return match;
  });
  // 第二遍：值属主敏感（name/type/password 等声明性属性命中时，同标签内的 value 一并脱敏）
  if (/([a-zA-Z-]+)\s*=\s*["']?(password|passwd|secret|token|credential)["']?/i.test(out)) {
    out = out.replace(/(value)\s*=\s*("([^"]*)"|'([^']*)')/g, (_m, name: string) => `${name}="${PICK_MASK}"`);
  }
  out = maskSensitiveText(out);
  return out.length > PICK_OUTER_HTML_LIMIT ? out.slice(0, PICK_OUTER_HTML_LIMIT) : out;
}

/** URL query/fragment 敏感键值脱敏。 */
export function sanitizeUrl(url: string): string {
  return url.replace(/([?&])([a-zA-Z0-9_-]+)=([^&#]*)/g, (match, sep: string, key: string) => {
    if (PICK_SENSITIVE_KEY_PATTERN.test(key)) return `${sep}${key}=${PICK_MASK}`;
    return match;
  });
}

/** RawPick → PickedElement（全量脱敏管线：text/outerHtml/url）。 */
export function toPickedElement(raw: RawPick): PickedElement {
  return {
    tag: raw.tag,
    ...(raw.id !== null ? { id: raw.id } : {}),
    classes: raw.classes.slice(0, 20),
    ...(raw.ariaLabel !== null ? { ariaLabel: raw.ariaLabel.slice(0, 100) } : {}),
    textPreview: maskSensitiveText(raw.textPreview).slice(0, 120),
    selector: raw.selector.slice(0, 200),
    bbox: raw.bbox,
    styles: raw.styles,
    outerHtml: sanitizeOuterHtml(raw.outerHtml),
    pageUrl: sanitizeUrl(raw.pageUrl),
  };
}

export type { PickedElement } from './picked-element';
