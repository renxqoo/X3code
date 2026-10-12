import * as React from 'react';
import { Text, View } from 'react-native';
import { useAppTheme } from '@/theme/theme-context';
import { radius, spacing } from '@/theme/tokens';
import { getBridge, useBridgeStatus } from '@/mobile/relay/runtime';
import { useConversationStore } from '@/store/conversation-store';
import { copy } from '@/strings/zh';

interface UsageRow {
  label: string;
  percent: number;
  value: string;
}

/** 活跃会话的 token 分析（session/tokenAnalytics：used/window 构成占比）。 */
export function UsageCard() {
  const { colors } = useAppTheme();
  const { status } = useBridgeStatus();
  const [rows, setRows] = React.useState<readonly UsageRow[] | null>(null);

  const activeSessionId = useConversationStore((state) => state.activeSessionId);

  React.useEffect(() => {
    if (status !== 'ready') return;
    const bridge = getBridge();
    if (bridge === null) return;
    // 订阅来的值，不读 getState()：后者在依赖数组里无从体现，切会话不会重跑——
    // 上一条用例正因此显示上一个会话的 token 占用
    const threadId = activeSessionId;
    if (threadId === null) {
      setRows([]);
      return;
    }
    void bridge.client.invoke('session/tokenAnalytics', { threadId }).then((outcome: unknown) => {
      // 无活跃 threadId 的 invoke 会失败——空形态即可（usage 页有会话才有数据）
      const data = outcome as { ok: boolean; data?: Record<string, unknown> };
      if (!data.ok || data.data === undefined) {
        setRows([]);
        return;
      }
      // 真值两件：实报占用与实拨窗口（分项估算已从 hub 契约删除——估算归
      // token-meter，不再由展示层产「估算相减的残差」）。
      const used = typeof data.data['used'] === 'number' ? (data.data['used'] as number) : 0;
      const window = typeof data.data['window'] === 'number' ? (data.data['window'] as number) : 0;
      const rowsOut: UsageRow[] = [];
      // 窗口缺失 = 无分母：不算百分比（不给假值）
      if (window > 0) {
        rowsOut.push({ label: '上下文占用', percent: Math.min(100, Math.round((used / window) * 100)), value: formatTokens(used) });
        rowsOut.push({ label: '剩余空间', percent: Math.min(100, Math.round(((window - used) / window) * 100)), value: formatTokens(Math.max(0, window - used)) });
      }
      setRows(rowsOut);
    });
  }, [status, activeSessionId]);

  const list: readonly UsageRow[] = rows ?? [];

  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: 24, padding: spacing.xs4, shadowColor: '#3F3F46', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.07, shadowRadius: 22, elevation: 3 }}>
      {list.length === 0 ? <Text style={{ color: colors.textMuted, fontSize: 13, paddingVertical: 10 }}>{copy.usageNoSession}</Text> : null}
      {list.map((item, index) => (
        <View key={item.label} style={{ borderTopColor: colors.divider, borderTopWidth: index === 0 ? 0 : 1, paddingVertical: 13 }}>
          <View style={{ alignItems: 'center', flexDirection: 'row' }}>
            <Text style={{ color: colors.text, flex: 1, fontSize: 14 }}>{item.label}</Text>
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>{item.value} · {item.percent}%</Text>
          </View>
          <View style={{ backgroundColor: colors.surfaceSubtle, borderRadius: radius.pill, height: 8, marginTop: 10, overflow: 'hidden' }}>
            <View style={{ backgroundColor: colors.text, borderRadius: radius.pill, height: 8, width: `${item.percent}%` }} />
          </View>
        </View>
      ))}
    </View>
  );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}
