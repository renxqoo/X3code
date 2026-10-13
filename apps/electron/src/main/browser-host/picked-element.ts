/** 拾取元素契约形状（T61 §3.2；脱敏在 element-picker 管线完成后才成形）。 */
export type PickedElement = {
  tag: string;
  id?: string;
  classes: string[];
  ariaLabel?: string;
  /** ≤120 chars，敏感模式脱敏后。 */
  textPreview: string;
  selector: string;
  bbox: { x: number; y: number; width: number; height: number };
  styles: { fontSize: string; color: string; backgroundColor: string; margin: string; padding: string; display: string };
  /** 先脱敏后截断 ≤2KB。 */
  outerHtml: string;
  pageUrl: string;
};
