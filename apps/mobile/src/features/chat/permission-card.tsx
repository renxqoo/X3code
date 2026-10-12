import * as React from 'react';
import { Text, View } from 'react-native';
import { ShieldCheck } from 'lucide-react-native';
import { useAppTheme } from '@/theme/theme-context';
import { radius, spacing, type } from '@/theme/tokens';
import { Button } from '@/components/ui/button';
import { monospaceFont } from '@/components/monospace-font';
import { useConversationStore } from '@/store/conversation-store';
import { getBridge } from '@/mobile/relay/runtime';

export function PermissionCard() {
  const { colors } = useAppTheme();
  // 队首：同时多张时逐张应答，不互相顶掉
  const request = useConversationStore((state) => state.permissionQueue[0] ?? null);
  const answerPermission = useConversationStore((state) => state.answerPermission);
  // 应答：dialog/respond（受理即出队——裁决结果经事件流对账，PC 端同语义）。
  // 出队是一个 action 完成的：拆成「标记 + 出队」两步时，帧发送恰好在两步之间抛错
  // 会留下「已标记但卡还在」的残卡，此时按钮已消失，用户对这轮做不了第二次应答。
  const respond = (approved: boolean) => {
    const bridge = getBridge();
    if (bridge?.status === 'ready' || bridge?.status === 'connected') {
      // 权限应答走 L2 ui_response 帧（gateway inbound 专用面——非 host 命令）
      void bridge.transport.sendFrame({ kind: 'ui_response', streamId: `ui:${request?.id ?? ''}`, seq: 1, body: { requestId: request?.id ?? '', threadId: useConversationStore.getState().activeSessionId ?? '', method: 'confirm', payload: { confirmed: approved } } });
    }
    answerPermission(approved);
  };
  if (request === null) return null;
  return (
    <View accessibilityLabel="权限确认" style={{ backgroundColor: colors.accentSoft, borderRadius: radius.lg, marginTop: spacing.sm, padding: spacing.xs3 }}>
      <View style={{ alignItems: 'center', flexDirection: 'row' }}>
        <ShieldCheck color={colors.accent} size={19} />
        <Text style={{ color: colors.text, fontSize: type.title.fontSize, fontWeight: '700', marginLeft: spacing.sm }}>{request.title}</Text>
      </View>
      <Text selectable style={{ color: colors.textMuted, fontFamily: monospaceFont, fontSize: type.row.fontSize, lineHeight: type.row.lineHeight, marginTop: spacing.sm }}>{request.command}</Text>
      {request.approved === null ? <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs3 }}><Button containerStyle={{ flex: 1 }} label="拒绝" onPress={() => respond(false)} size="small" variant="secondary" /><Button containerStyle={{ flex: 1 }} label="允许一次" onPress={() => respond(true)} size="small" /></View> : <Text style={{ color: request.approved ? colors.success : colors.destructive, fontSize: type.row.fontSize, marginTop: spacing.sm }}>{request.approved ? '已允许' : '已拒绝'}</Text>}
    </View>
  );
}
