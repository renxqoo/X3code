/**
 * 键盘避让容器（不滚动，供 Modal/Sheet 内的表单面复用）。
 *
 * Modal 内表单与屏级表单的避让需求同源，但布局基座不同——故独立于
 * KeyboardScrollScreen（屏级滚动容器 vs 面板容器，两种布局互不套用）。
 *
 * 避让视图自身 flex:1，会填满父容器：调用方的贴底布局
 * （justifyContent:'flex-end' 之类）必须挂在本组件的 style 上，
 * 留在外层会在避让占满后布局失效。
 */
import * as React from 'react';
import { KeyboardAvoidingView, type ViewStyle } from 'react-native';

import { keyboardAvoidBehavior } from '@/components/ui/keyboard-avoid-behavior';

export function KeyboardAvoidingPanel({ children, backgroundColor, style }: { children: React.ReactNode; backgroundColor: string; style?: ViewStyle }) {
  return (
    <KeyboardAvoidingView behavior={keyboardAvoidBehavior()} keyboardVerticalOffset={0} style={[{ backgroundColor, flex: 1 }, style]}>
      {children}
    </KeyboardAvoidingView>
  );
}