/**
 * 错误码文案覆盖（症状：手机端 UI 直接吐英文错误码，如「发送失败：internal」）。
 */
import { describe, expect, it } from '@jest/globals';

import { HUB_ERROR_CODES } from '@x3code/contracts';

import { copyReason } from '@/strings/zh';

describe('错误码文案覆盖（症状：UI 直出英文错误码）', () => {
  it.each(HUB_ERROR_CODES)('%s 有中文文案（不回退成裸码）', (code) => {
    const text = copyReason(code);
    expect(text).not.toBe(code);
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it('兜底码 internal 指向电脑端日志而非裸码', () => {
    expect(copyReason('internal')).toContain('电脑端');
  });

  it.each([null, undefined, ''])('空原因降级为「未知错误」（%p）', (code) => {
    expect(copyReason(code)).toBe('未知错误');
  });

  it('未登记码透传原值（线上新码不崩）', () => {
    expect(copyReason('brand_new_code')).toBe('brand_new_code');
  });
});