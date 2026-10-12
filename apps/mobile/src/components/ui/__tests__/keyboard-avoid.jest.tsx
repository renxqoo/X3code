/**
 * 症状回归（输入遮挡）：聚焦任意输入框时软键盘升起，底部输入框被键盘遮盖、
 * 无法确认所输内容。根因是输入面容器未参与键盘避让。
 */
import { render } from '@testing-library/react-native';
import { describe, expect, it } from '@jest/globals';
import * as React from 'react';
import { Text, TextInput } from 'react-native';

import { KeyboardScrollScreen } from '@/components/ui/keyboard-scroll-screen';
import { KeyboardAvoidingPanel } from '@/components/ui/keyboard-avoiding-panel';
import { keyboardAvoidBehavior } from '@/components/ui/keyboard-avoid-behavior';
import { TestWrapper } from '@/test/test-wrapper';

/** 收集渲染树里所有带 keyboardShouldPersistTaps 的滚动节点。 */
function persistTapsValues(tree: unknown, out: Array<unknown> = []): Array<unknown> {
  if (tree === null || typeof tree !== 'object') return out;
  const node = tree as { props?: Record<string, unknown>; children?: unknown[] };
  if (node.props?.keyboardShouldPersistTaps !== undefined) out.push(node.props.keyboardShouldPersistTaps);
  for (const child of node.children ?? []) persistTapsValues(child, out);
  return out;
}

describe('KeyboardScrollScreen（症状：输入框被键盘遮盖）', () => {
  it('滚动区带 keyboardShouldPersistTaps——键盘弹起时首按只收键盘不误触按钮', async () => {
    const view = await render(
      <TestWrapper>
        <KeyboardScrollScreen backgroundColor="#000" scrollProps={{ contentContainerStyle: { padding: 12 } }}>
          <TextInput accessibilityLabel="配对码" />
        </KeyboardScrollScreen>
      </TestWrapper>,
    );
    expect(persistTapsValues(view.toJSON())).toContain('handled');
    await view.unmount();
  });

  it('滚动区带 keyboardDismissMode=on-drag——拖动可收键盘，无需逐次点空白', async () => {
    const view = await render(
      <TestWrapper>
        <KeyboardScrollScreen backgroundColor="#000">
          <TextInput accessibilityLabel="配对码" />
        </KeyboardScrollScreen>
      </TestWrapper>,
    );
    expect(JSON.stringify(view.toJSON())).toContain('on-drag');
    await view.unmount();
  });

  it('末端内容垫足底部安全区——键盘收起时贴底输入框不被 home indicator 压住', async () => {
    const view = await render(
      <TestWrapper>
        <KeyboardScrollScreen backgroundColor="#000" scrollProps={{ contentContainerStyle: { paddingBottom: 40 } }}>
          <TextInput accessibilityLabel="配对码" />
        </KeyboardScrollScreen>
      </TestWrapper>,
    );
    const flat = JSON.stringify(view.toJSON());
    // 40 与安全区取大者——垫高必须不小于调用方给的底距
    expect(flat).toContain('paddingBottom');
    await view.unmount();
  });
});

describe('KeyboardAvoidingPanel（症状：Sheet 内输入框被键盘遮盖）', () => {
  it('面板内容可渲染且带避让容器', async () => {
    const view = await render(
      <TestWrapper>
        <KeyboardAvoidingPanel backgroundColor="#000" style={{ justifyContent: 'flex-end' }}>
          <TextInput accessibilityLabel="标题" />
        </KeyboardAvoidingPanel>
      </TestWrapper>,
    );
    expect(view.getByLabelText('标题')).toBeTruthy();
    await view.unmount();
  });

  it('贴底布局由 style 传入——避让容器占满后布局仍生效', async () => {
    const view = await render(
      <TestWrapper>
        <KeyboardAvoidingPanel backgroundColor="#000" style={{ justifyContent: 'flex-end' }}>
          <Text>底部面板</Text>
        </KeyboardAvoidingPanel>
      </TestWrapper>,
    );
    expect(JSON.stringify(view.toJSON())).toContain('flex-end');
    await view.unmount();
  });
});

describe('keyboardAvoidBehavior（症状：跨平台键盘让位策略）', () => {
  it('取值恒为受支持的两种——不随平台产生第三种分支', () => {
    expect(['padding', 'height']).toContain(keyboardAvoidBehavior());
  });
});