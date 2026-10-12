import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Archive } from 'lucide-react-native';
import { PageHeader } from '@/components/navigation/page-header';
import { ContentCard } from '@/components/ui/content-card';
import { EmptyState } from '@/components/ui/empty-state';
import { useHistoryStore } from '@/store/history-store';
import { openSessionAndAttach } from '@/mobile/relay/runtime';
import { useAppTheme } from '@/theme/theme-context';
import { spacing } from '@/theme/tokens';

export default function ArchivedRoute() {
  const router = useRouter();
  const { colors } = useAppTheme();
  const sessions = useHistoryStore((state) => state.sessions).filter((item) => item.archived);
  const open = openSessionAndAttach;
  return <View style={{ backgroundColor: colors.background, flex: 1 }}><PageHeader title="归档对话" /><ScrollView contentContainerStyle={{ padding: spacing.xs3 }}>{sessions.length === 0 ? <EmptyState description="需要暂存的对话会出现在这里。" icon={Archive} title="没有归档对话" /> : <ContentCard items={sessions.map((item) => ({ detail: `${item.project} · ${item.timeLabel}`, icon: Archive, label: item.title, onPress: () => { void open(item); router.push('/'); } }))} />}</ScrollView></View>;
}
