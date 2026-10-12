/**
 * 软键盘实测高度（px）。
 *
 * 症状：输入区被键盘遮盖。根因是输入区用 position:absolute + 写死的 bottom
 * 钉在屏底——KeyboardAvoidingView 的 padding 只推流式内容，不动绝对定位元素，
 * 且 iOS padding 让位后键盘高度并不直接可读。各输入法高度不一（拼音/英文/
 * 手写/第三方键盘差异几十到上百 px），写死数值必在某些输入法上错位。
 *
 * 用 keyboardWillShow/Hide（iOS 带动画时序，早于布局变化）实测端点高度；
 * Android 无 will 事件，退 doShow/doHide。Windows 事件缺 endCoordinates 时按 0 处理
 * （收敛到收起态，不让 dock 悬空）。
 */
import * as React from 'react';
import { Keyboard, Platform, type KeyboardEvent } from 'react-native';

export function useKeyboardHeight(): number {
  const [height, setHeight] = React.useState(0);

  React.useEffect(() => {
    // Android: show 事件不保证带高度（部分 ROM 只在 didShow 给），双事件并联取大者
    const readHeight = (event: KeyboardEvent): number =>
      Math.max(0, event.endCoordinates?.height ?? event.startCoordinates?.height ?? 0);

    const willShow = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', (event) => {
      setHeight(readHeight(event));
    });
    const willHide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => {
      setHeight(0);
    });
    return () => {
      willShow.remove();
      willHide.remove();
    };
  }, []);

  return height;
}