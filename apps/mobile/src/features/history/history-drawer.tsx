import * as React from 'react';
import { useRouter } from 'expo-router';
import { Modal, Pressable, SectionList, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Archive, HardDrive, Laptop, Search, Settings, SquarePen, X } from 'lucide-react-native';
import { useAppTheme } from '@/theme/theme-context';
import { radius, spacing } from '@/theme/tokens';
import { IconButton } from '@/components/ui/icon-button';
import { SectionHeader } from '@/components/ui/section-header';
import { KeyboardAvoidingPanel } from '@/components/ui/keyboard-avoiding-panel';
import { X3codeMark } from '@/components/brand/x3code-mark';
import { GroupMoreRow } from '@/features/history/group-more-row';
import { ProjectGroupHeader } from '@/features/history/project-group-header';
import { SessionRow } from '@/features/history/session-row';
import { buildHistorySections, type HistorySection } from '@/features/history/build-history-sections';
import { DrawerLink } from '@/features/navigation/drawer-link';
import { useConversationStore } from '@/store/conversation-store';
import { useGroupFoldStore } from '@/store/group-fold-store';
import { useHistoryStore } from '@/store/history-store';
import { useNavigationStore } from '@/store/navigation-store';
import { openSessionAndAttach } from '@/mobile/relay/runtime';
import { copy } from '@/strings/zh';
import type { ConversationSession } from '@/types/domain';

export function HistoryDrawer() {
  const router = useRouter();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const open = useNavigationStore((state) => state.drawerOpen);
  const setDrawerOpen = useNavigationStore((state) => state.setDrawerOpen);
  const openSheet = useNavigationStore((state) => state.openSheet);
  const sessions = useHistoryStore((state) => state.sessions);
  const query = useHistoryStore((state) => state.query);
  const setQuery = useHistoryStore((state) => state.setQuery);
  const selectSession = useHistoryStore((state) => state.selectSession);
  const currentSessionId = useConversationStore((state) => state.session.id);
  const startNewSession = useConversationStore((state) => state.startNewSession);
  const chooseWorkspace = useConversationStore((state) => state.chooseWorkspace);
  const collapsed = useGroupFoldStore((state) => state.collapsed);
  const expanded = useGroupFoldStore((state) => state.expanded);
  const toggleCollapsed = useGroupFoldStore((state) => state.toggleCollapsed);
  const toggleExpanded = useGroupFoldStore((state) => state.toggleExpanded);
  const openRemoteSession = React.useCallback((session: ConversationSession) => {
    void openSessionAndAttach(session);
  }, []);
  const handleOpen = React.useCallback((session: ConversationSession) => {
    selectSession(session.id);
    openRemoteSession(session);
    setDrawerOpen(false);
  }, [openRemoteSession, selectSession, setDrawerOpen]);
  const handleAction = React.useCallback((session: ConversationSession) => {
    selectSession(session.id);
    openRemoteSession(session);
    openSheet('session-actions');
  }, [openRemoteSession, openSheet, selectSession]);
  // 组内新建：工作目录即项目真值（显示名只给 UI 看）；未选工作空间的会话归在一组，
  // 这一组没有可继承的目录，交给工作空间选择面板而不是静默按上次目录建会话。
  const startTaskIn = React.useCallback((section: HistorySection) => {
    if (section.key.length === 0) {
      openSheet('workspace');
      return;
    }
    startNewSession();
    chooseWorkspace(section.key, section.title, section.key);
    setDrawerOpen(false);
  }, [chooseWorkspace, openSheet, setDrawerOpen, startNewSession]);
  const sections = React.useMemo(() => buildHistorySections(sessions, query, collapsed, expanded), [sessions, query, collapsed, expanded]);
  const renderItem = React.useCallback(({ item }: { item: ConversationSession }) => (
    <SessionRow active={item.id === currentSessionId} indent={item.pinned !== true} onAction={handleAction} onOpen={handleOpen} session={item} />
  ), [currentSessionId, handleAction, handleOpen]);
  const renderSectionHeader = React.useCallback(({ section }: { section: HistorySection }) => (
    section.kind === 'pinned'
      ? <SectionHeader title={copy.pinned} />
      : <ProjectGroupHeader collapsed={section.collapsed} count={section.total} name={section.title.length > 0 ? section.title : copy.noProject} onNewTask={() => startTaskIn(section)} onToggle={() => toggleCollapsed(section.key)} />
  ), [startTaskIn, toggleCollapsed]);
  const renderSectionFooter = React.useCallback(({ section }: { section: HistorySection }) => {
    if (section.kind !== 'project' || section.collapsed || section.total <= section.data.length) return null;
    return <GroupMoreRow label={copy.showMoreSessions(section.total - section.data.length)} onPress={() => toggleExpanded(section.key)} />;
  }, [toggleExpanded]);
  const goProjects = React.useCallback(() => {
    router.push('/projects');
    setDrawerOpen(false);
  }, [router, setDrawerOpen]);
  const listFooter = React.useMemo(() => <SectionHeader action={copy.addProject} onAction={goProjects} title={copy.projects} />, [goProjects]);
  const listEmpty = React.useMemo(() => <Text style={{ color: colors.textMuted, fontSize: 13, paddingHorizontal: spacing.xs2, paddingVertical: spacing.xs3 }}>{copy.historyEmpty}</Text>, [colors.textMuted]);
  return (
    <Modal animationType="fade" onRequestClose={() => setDrawerOpen(false)} transparent visible={open}>
      <View style={{ backgroundColor: colors.overlay, flex: 1 }}><Pressable accessibilityLabel={copy.closeHistory} onPress={() => setDrawerOpen(false)} style={{ flex: 1 }} /><View accessibilityLabel={copy.history} style={{ backgroundColor: colors.background, borderTopRightRadius: 28, bottom: 0, left: 0, paddingTop: insets.top, position: 'absolute', shadowColor: '#000000', shadowOffset: { width: 5, height: 0 }, shadowOpacity: 0.12, shadowRadius: 20, top: 0, width: '88%' }}>
        <KeyboardAvoidingPanel backgroundColor={colors.background} style={{ flex: 1 }}>
        <View style={{ alignItems: 'center', flexDirection: 'row', minHeight: 58, paddingHorizontal: spacing.xs3 }}><X3codeMark size={30} /><Text style={{ color: colors.text, fontSize: 17, fontWeight: '700', marginLeft: 9 }}>{copy.appName}</Text><IconButton icon={X} label={copy.close} onPress={() => setDrawerOpen(false)} style={{ marginLeft: 'auto' }} /></View>
        <View style={{ paddingHorizontal: spacing.xs3 }}><Pressable accessibilityRole="button" onPress={() => { startNewSession(); setDrawerOpen(false); }} style={{ alignItems: 'center', backgroundColor: 'transparent', borderRadius: radius.lg, flexDirection: 'row', minHeight: 54, paddingHorizontal: 4 }}><SquarePen color={colors.text} size={21} /><Text style={{ color: colors.text, fontSize: 16, fontWeight: '500', marginLeft: 12 }}>{copy.newChat}</Text></Pressable>
          <DrawerLink icon={Laptop} label={copy.connectedComputer} onPress={() => { router.push('/devices'); setDrawerOpen(false); }} />
          <DrawerLink icon={HardDrive} label={copy.assets} onPress={() => { router.push('/files'); setDrawerOpen(false); }} />
          <View style={{ alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.pill, flexDirection: 'row', marginTop: spacing.sm, minHeight: 46, paddingHorizontal: 14 }}><Search color={colors.textFaint} size={17} /><TextInput accessibilityLabel={copy.searchConversations} onChangeText={setQuery} onSubmitEditing={() => { if (query.trim().length > 0) { router.push('/search'); setDrawerOpen(false); } }} placeholder={copy.searchPlaceholder} placeholderTextColor={colors.textFaint} returnKeyType="search" style={{ color: colors.text, flex: 1, fontSize: 14, padding: 10 }} value={query} /></View>
        </View>
        {/* 会话列表按项目虚拟化：会话总量上千时也只挂载视口附近的行（历史上是全量 ScrollView + map） */}
        <SectionList<ConversationSession, HistorySection>
          contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xs6, paddingHorizontal: spacing.xs2 }}
          initialNumToRender={12}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          keyExtractor={(item) => item.id}
          ListEmptyComponent={listEmpty}
          ListFooterComponent={listFooter}
          maxToRenderPerBatch={12}
          renderItem={renderItem}
          renderSectionFooter={renderSectionFooter}
          renderSectionHeader={renderSectionHeader}
          sections={sections}
          stickySectionHeadersEnabled={false}
          windowSize={9}
        />
        <View style={{ padding: spacing.xs5 }}><DrawerLink icon={Archive} label={copy.archive} onPress={() => { router.push('/archived'); setDrawerOpen(false); }} /><Pressable accessibilityRole="button" onPress={() => { router.push('/settings'); setDrawerOpen(false); }} style={{ alignItems: 'center', flexDirection: 'row', minHeight: 46 }}><Settings color={colors.text} size={19} /><Text style={{ color: colors.text, fontSize: 15, fontWeight: '600', marginLeft: 11 }}>{copy.settingsTitle}</Text></Pressable></View>
        </KeyboardAvoidingPanel>
      </View></View>
    </Modal>
  );
}