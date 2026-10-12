import * as React from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { useAppTheme } from '@/theme/theme-context';
import { spacing } from '@/theme/tokens';
import { IconButton } from '@/components/ui/icon-button';
import { KeyboardAvoidingPanel } from '@/components/ui/keyboard-avoiding-panel';

type SheetProps = { visible: boolean; title: string; onClose: () => void; children: React.ReactNode };

export function Sheet({ visible, title, onClose, children }: SheetProps) {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <KeyboardAvoidingPanel backgroundColor={colors.overlay} style={{ justifyContent: 'flex-end' }}>
        <Pressable accessibilityLabel="关闭面板" onPress={onClose} style={{ flex: 1 }} />
        <View style={{ backgroundColor: colors.surfaceRaised, borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: '78%', paddingBottom: Math.max(insets.bottom, spacing.xs4), paddingHorizontal: spacing.xs4, shadowColor: '#000000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.1, shadowRadius: 18, elevation: 12 }}>

          <View style={{ alignItems: 'center', flexDirection: 'row', minHeight: 48 }}>
            <Text accessibilityRole="header" style={{ color: colors.text, flex: 1, fontSize: 18, fontWeight: '700' }}>{title}</Text>
            <IconButton icon={X} label="关闭" onPress={onClose} />
          </View>
          <ScrollView contentContainerStyle={{ paddingBottom: spacing.xs4 }} keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingPanel>
    </Modal>
  );
}
