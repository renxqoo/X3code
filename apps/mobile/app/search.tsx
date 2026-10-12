import * as React from 'react';
import { TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Search } from 'lucide-react-native';
import { PageHeader } from '@/components/navigation/page-header';
import { ContentCard } from '@/components/ui/content-card';
import { EmptyState } from '@/components/ui/empty-state';
import { KeyboardScrollScreen } from '@/components/ui/keyboard-scroll-screen';
import { useHistoryStore } from '@/store/history-store';
import { openSessionAndAttach } from '@/mobile/relay/runtime';
import { useAppTheme } from '@/theme/theme-context';
import { radius, spacing } from '@/theme/tokens';

export default function SearchRoute() {
  const router = useRouter();
  const { colors } = useAppTheme();
  const sessions = useHistoryStore((state) => state.sessions);
  const query = useHistoryStore((state) => state.query);
  const setQuery = useHistoryStore((state) => state.setQuery);
  const open = openSessionAndAttach;
  const results = sessions.filter((item) => !item.archived && `${item.title}${item.preview}${item.project}`.toLowerCase().includes(query.toLowerCase()));
  return <View style={{ backgroundColor: colors.background, flex: 1 }}><KeyboardScrollScreen backgroundColor={colors.background} scrollProps={{ contentContainerStyle: { padding: spacing.xs3 } }}>
    <PageHeader title="搜索" />
    <View style={{ marginHorizontal: spacing.xs3 }}><View style={{ alignItems: 'center', backgroundColor: colors.surfaceSubtle, borderRadius: radius.pill, flexDirection: 'row', minHeight: 46, paddingHorizontal: 14 }}><Search color={colors.textFaint} size={18} /><TextInput accessibilityLabel="搜索对话" onChangeText={setQuery} placeholder="搜索标题、内容或项目" placeholderTextColor={colors.textFaint} style={{ color: colors.text, flex: 1, fontSize: 14, minHeight: 46, paddingHorizontal: 10 }} value={query} /></View></View>
    {results.length === 0 ? <EmptyState description="试试项目名、文件名或对话关键词。" icon={Search} title="没有找到对话" /> : <ContentCard items={results.map((item) => ({ detail: `${item.project} · ${item.timeLabel} · ${item.preview}`, label: item.title, onPress: () => { void open(item); router.push('/'); }, trailing: item.state === 'working' ? '进行中' : undefined }))} />}
  </KeyboardScrollScreen></View>;
}
