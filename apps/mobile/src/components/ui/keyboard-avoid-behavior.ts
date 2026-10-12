/**
 * 键盘避让行为取值（单一真相）。
 *
 * iOS 用 padding（软键盘浮于内容之上，靠内边距让位）；Android 用 height
 * （系统 resize 窗口，容器必须随窗口缩高才能让位）。两平台同值会让
 * Android 内容被整体上推 iOS 那么多，或 iOS 上键盘盖住内容。
 */
import { Platform } from 'react-native';

export function keyboardAvoidBehavior(): 'padding' | 'height' {
  return Platform.OS === 'ios' ? 'padding' : 'height';
}