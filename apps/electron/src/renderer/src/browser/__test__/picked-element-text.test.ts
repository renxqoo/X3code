import { describe, expect, test } from 'bun:test';

import type { PickedElement } from '@x3code/contracts';

import { pickedElementText, pickedImageName } from '../picked-element-text';

/** 拾取卡片序列化（T61 §7 接缝：首行人类可读 + 机器段定界）。 */

const element: PickedElement = {
  tag: 'button',
  id: 'submit',
  classes: ['btn'],
  textPreview: '提交订单',
  selector: '#submit',
  bbox: { x: 10, y: 20, width: 80, height: 32 },
  styles: { fontSize: '14px', color: 'rgb(255,255,255)', backgroundColor: 'rgb(37,99,235)', margin: '0px', padding: '4px 12px', display: 'inline-block' },
  outerHtml: '<button id="submit">提交订单</button>',
  pageUrl: 'https://a.com/order',
};

describe('pickedElementText', () => {
  test('首行人类可读（含 tag#id 与可见文本）', () => {
    const text = pickedElementText(element);
    expect(text.split('\n')[0]).toBe('[页面元素] button#submit 提交订单');
  });

  test('机器段含 selector/pageUrl/bbox/styles 且 --- 定界', () => {
    const text = pickedElementText(element);
    expect(text).toContain('---');
    expect(text).toContain('selector: #submit');
    expect(text).toContain('pageUrl: https://a.com/order');
    expect(text).toContain('bbox: 10,20 80x32');
    expect(text).toContain('styles: font-size 14px');
  });

  test('ariaLabel 优先于 textPreview 作标签', () => {
    const text = pickedElementText({ ...element, ariaLabel: '确认支付' });
    expect(text.split('\n')[0]).toBe('[页面元素] button#submit 确认支付');
  });

  test('无 id 无文本的最小形态仍合法', () => {
    const text = pickedElementText({ ...element, id: undefined, ariaLabel: undefined, textPreview: '' });
    expect(text.split('\n')[0]).toBe('[页面元素] button');
  });
});

describe('pickedImageName', () => {
  test('tag-id-时间戳.jpg 形态', () => {
    const name = pickedImageName(element, 123);
    expect(name).toBe('button-submit-123.jpg');
  });
  test('无 id 兜底', () => {
    const name = pickedImageName({ ...element, id: undefined }, 5);
    expect(name).toBe('button-5.jpg');
  });
});
