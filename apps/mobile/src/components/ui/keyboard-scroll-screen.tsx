/**
 * 带键盘避让的滚动屏（输入面统一容器）。
 *
 * 症状：聚焦任意输入框时软键盘升起，底部输入框被遮盖、无法确认所输内容。
 * 根因：屏级滚动容器未参与键盘避让——键盘只压缩可视区，不推内容，
 * 处于视口底缘的输入框直接落到键盘之下。
 *
 * 三件事缺一不可（单做任一件都会残留遮挡或误触）：
 * - KeyboardAvoidingView 包住整屏：随键盘高度实时让位（不写死键盘高度——
 *   输入法与机型各异，写死必在某些机型上错位）。
 * - 底部安全区垫高：键盘收起时也要避开 home indicator，否则贴底输入框被手势条压住。
 * - keyboardShouldPersistTaps="handled"：首次点按只收键盘、第二次才触发按钮，
 *   否则键盘弹起瞬间误触下方按钮。
 */
import * as React from 'react';
import { KeyboardAvoidingView, ScrollView, type ScrollViewProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { keyboardAvoidBehavior } from '@/components/ui/keyboard-avoid-behavior';

type KeyboardScrollScreenProps = {
  children: React.ReactNode;
  /** 屏幕底色（避让视图铺底，键盘升起时不露白）。 */
  backgroundColor: string;
  /** 透传给内部 ScrollView（contentContainerStyle 等）。 */
  scrollProps?: Omit<ScrollViewProps, 'children'>;
};

export function KeyboardScrollScreen({ children, backgroundColor, scrollProps }: KeyboardScrollScreenProps) {
  const insets = useSafeAreaInsets();
  const contentStyle = scrollProps?.contentContainerStyle as { paddingBottom?: number } | undefined;
  // 调用方已垫的底距与安全区取大者——两者都表达「末端内容离屏底多远」，
  // 取和会让原本为安全区预留的屏在键盘收起后多出一段空白。
  const bottomPadding = Math.max(insets.bottom, contentStyle?.paddingBottom ?? 0);
  return (
    <KeyboardAvoidingView behavior={keyboardAvoidBehavior()} keyboardVerticalOffset={0} style={{ backgroundColor, flex: 1 }}>
      <ScrollView
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        {...scrollProps}
        contentContainerStyle={[contentStyle, { paddingBottom: bottomPadding }]}
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}