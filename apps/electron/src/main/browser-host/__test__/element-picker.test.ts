import { describe, expect, test } from 'bun:test';

import { maskSensitiveText, sanitizeOuterHtml, sanitizeUrl, toPickedElement, type RawPick } from '../element-picker';

/** 脱敏管线表驱动（T61 §3.2 敏感过滤矩阵）。 */

function rawPick(overrides: Partial<RawPick> = {}): RawPick {
  return {
    tag: 'button',
    id: 'submit-btn',
    classes: ['btn', 'btn-primary'],
    ariaLabel: '提交',
    textPreview: '提交订单',
    selector: '#submit-btn',
    bbox: { x: 100, y: 200, width: 80, height: 32 },
    styles: { fontSize: '14px', color: 'rgb(255, 255, 255)', backgroundColor: 'rgb(37, 99, 235)', margin: '0px', padding: '4px 12px', display: 'inline-block' },
    outerHtml: '<button id="submit-btn" class="btn">提交订单</button>',
    pageUrl: 'https://shop.example.com/order',
    ...overrides,
  };
}

describe('maskSensitiveText', () => {
  test.each([
    ['key sk-abc123def456ghi', 'key ***'],
    ['token ghp_' + 'a'.repeat(30), 'token ***'],
    ['aws AKIAIOSFODNN7EXAMPLE', 'aws ***'],
    ['auth Bearer eyJhbGciOiJIUzI1NiIs', 'auth ***'],
    ['正常文本不受影响', '正常文本不受影响'],
  ])('%s → %s', (input, expected) => {
    expect(maskSensitiveText(input)).toBe(expected);
  });
});

describe('sanitizeOuterHtml', () => {
  test('敏感属性名命中（大小写不敏感）→ 值替换', () => {
    expect(sanitizeOuterHtml('<input name="password" value="hunter2">')).toBe('<input name="password" value="***">');
    expect(sanitizeOuterHtml('<a data-Api-Token="xyz123">x</a>')).toBe('<a data-Api-Token="***">x</a>');
    expect(sanitizeOuterHtml("<input value='secret-v' type='text'>")).toBe('<input value="***" type=\'text\'>');
  });

  test('正常属性保留', () => {
    expect(sanitizeOuterHtml('<a href="https://a.com" class="link">x</a>')).toBe('<a href="https://a.com" class="link">x</a>');
  });

  test('先脱敏后截断（≤2KB）', () => {
    const html = '<div data-token="leak-1234567890">' + 'x'.repeat(3000) + '</div>';
    const out = sanitizeOuterHtml(html);
    expect(out.length).toBeLessThanOrEqual(2048);
    expect(out).toContain('***');
  });
});

describe('sanitizeUrl', () => {
  test('query 敏感键值替换；正常键保留', () => {
    expect(sanitizeUrl('https://a.com/page?token=abc123&lang=zh')).toBe('https://a.com/page?token=***&lang=zh');
    expect(sanitizeUrl('https://a.com/page?ok=1')).toBe('https://a.com/page?ok=1');
  });
});

describe('toPickedElement 全管线', () => {
  test('textPreview/outerHtml/pageUrl 三路脱敏', () => {
    const picked = toPickedElement(rawPick({
      textPreview: 'API key: sk-realkey123456',
      outerHtml: '<div data-auth="tok123">sk-realkey123456</div>',
      pageUrl: 'https://a.com/d?session_key=zzz&page=2',
    }));
    expect(picked.textPreview).not.toContain('sk-realkey');
    expect(picked.outerHtml).toContain('***');
    expect(picked.pageUrl).toBe('https://a.com/d?session_key=***&page=2');
  });

  test('id 缺席时可选字段不出现', () => {
    const picked = toPickedElement(rawPick({ id: null, ariaLabel: null }));
    expect(picked.id).toBeUndefined();
    expect(picked.ariaLabel).toBeUndefined();
  });

  test('textPreview 截断 ≤120', () => {
    const picked = toPickedElement(rawPick({ textPreview: '长'.repeat(300) }));
    expect(picked.textPreview.length).toBeLessThanOrEqual(120);
  });
});
