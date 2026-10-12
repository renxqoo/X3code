import * as React from 'react';
import { ActivityIndicator, Text, TextInput, View } from 'react-native';
import { Link2, RefreshCw, Smartphone } from 'lucide-react-native';
import { PageHeader } from '@/components/navigation/page-header';
import { Card } from '@/components/ui/card';
import { ContentCard } from '@/components/ui/content-card';
import { SectionHeader } from '@/components/ui/section-header';
import { useAppTheme } from '@/theme/theme-context';
import { radius, spacing } from '@/theme/tokens';
import { Button } from '@/components/ui/button';
import { initializeRelayRuntime, useRelayStatus } from '@/mobile/relay/runtime';
import { copy } from '@/strings/zh';
import { Platform } from 'react-native';
import { createPairingSession, generateDeviceIdentity, type PairingStep } from '@/mobile/relay/pairing';
import { dialWebSocket } from '@/mobile/relay/ws-dial';
import { relayCredentialsStore } from '@/mobile/relay/credentials';
import { QrScanModal } from '@/mobile/relay/qr-scan-modal';
import { TextField } from '@/components/ui/text-field';
import { KeyboardScrollScreen } from '@/components/ui/keyboard-scroll-screen';
import { discoverGateway } from '@/mobile/relay/discover';

const STATUS_LABEL: Record<string, string> = {
  disconnected: '未连接',
  connecting: '连接中…',
  connected: '已连接',
};

/** relay 配对面 WS（/pairing——明文信封域；token 是桌面端 QR 码内的 pairingTicket）。 */
function makePairingWire(relayUrl: string, pairingTicket: string) {
  // pairingTicket 走 Authorization 头（R2 M10；web 退 query——ws-dial 分支）
  const ws = dialWebSocket(`${relayUrl}/pairing`, pairingTicket);
  const listeners = new Set<(message: Record<string, unknown>) => void>();
  let openedResolve: ((open: boolean) => void) | null = null;
  const openedPromise = new Promise<boolean>((resolve) => {
    openedResolve = resolve;
  });
  ws.onopen = () => {
    openedResolve?.(true);
  };
  ws.onerror = () => {
    openedResolve?.(false);
  };
  ws.onclose = () => {
    openedResolve?.(false);
  };
  return {
    opened: () => openedPromise,
    send(line: string): void {
      ws.send(line);
    },
    onMessage(listener: (message: Record<string, unknown>) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close(): void {
      ws.close();
    },
    wire(): void {
      ws.onmessage = (event: unknown) => {
        const line = String((event as { data: unknown }).data);
        try {
          const envelope = JSON.parse(line) as { payload?: string };
          if (typeof envelope.payload === 'string') {
            for (const listener of listeners) {
              listener(JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')) as Record<string, unknown>);
            }
          }
        } catch {
          // 半包/垃圾帧：丢弃（配对面帧小，不做跨帧缓冲）
        }
      };
    },
  };
}

export default function DevicesRoute() {
  const { colors } = useAppTheme();
  const { status, runtime } = useRelayStatus();
  const [pairCode, setPairCode] = React.useState('');
  const [pairRelayUrl, setPairRelayUrl] = React.useState('');
  const [pairing, setPairing] = React.useState(false);
  const [pairError, setPairError] = React.useState<string | null>(null);
  const [hasCredentials, setHasCredentials] = React.useState(relayCredentialsStore.load() !== null);
  const [qrScanning, setQrScanning] = React.useState(false);
  React.useEffect(() => {
    // preload 完成后（未配对态无 status 事件）随 status 变化刷新（M4）
    setHasCredentials(relayCredentialsStore.load() !== null);
  }, [status]);

  const connected = status === 'connected' || status === 'ready';

  const pairingInFlightRef = React.useRef(false);

  const pairWithTicket = async (relayUrl: string, pairingId: string, installationId: string, ticket: string, gatewayEphemeralPub?: string, manualCode?: string, gatewayKeyFingerprint?: string): Promise<void> => {
    if (pairingInFlightRef.current) return; // 同帧双击防抖（M3）
    pairingInFlightRef.current = true;
    setPairing(true);
    setPairError(null);
    let wire: ReturnType<typeof makePairingWire> | null = null;
    try {
      wire = makePairingWire(relayUrl, ticket);
      wire.wire();
      const identity = generateDeviceIdentity();
      const session = createPairingSession({
        wire: wire as never,
        endpoints: { relayUrl, installationId },
        pairingId,
        ...(gatewayEphemeralPub !== undefined ? { gatewayEphemeralPub } : {}),
        ...(gatewayKeyFingerprint !== undefined ? { gatewayKeyFingerprint } : {}),
        deviceInfo: { name: identity.deviceId, deviceType: 'phone', platform: Platform.OS, appVersion: '1' },
      });
      session.onStep((step: PairingStep) => {
        if (step.phase === 'failed') setPairError(step.reason);
      });
      if (manualCode !== undefined) {
        await session.startManual(manualCode, identity.deviceId);
      }
      // 呈递长期钥（注册表写入门；确认由桌面 owner 自动完成，手机侧不比对数字）
      await session.submitDeviceKeys(identity);
      const registered = await session.waitRegistered();
      if (!registered.ok) {
        setPairError(copy.pairIncomplete(registered.reason));
        session.close();
        return;
      }
      const saved = await relayCredentialsStore.save({
        deviceId: session.registeredDeviceId ?? identity.deviceId,
        signingSecret: identity.signingSecret,
        signingPub: identity.signingPub,
        sharedSecretHex: registered.sharedSecret,
        installationId,
        relayUrl,
        relayToken: session.relayToken ?? '',
        ...(session.relayNodeId !== null ? { relayNodeId: session.relayNodeId } : {}),
      });
      if (!saved) setPairError(copy.pairCredentialsSaveFailed);
      setHasCredentials(true);
      session.close();
      void initializeRelayRuntime().connectWithCredentials(session.relayToken ?? '');
    } catch (error) {
      wire?.close();
      setPairError(copy.pairFailed(error instanceof Error ? error.message : '未知错误'));
    } finally {
      setPairing(false);
      pairingInFlightRef.current = false;
    }
  };

  const forget = (): void => {
    void relayCredentialsStore.clear();
    setHasCredentials(false);
    runtime?.disconnect();
  };

  return (
    <View style={{ backgroundColor: colors.settingsBackground, flex: 1 }}>
      <PageHeader title="设备与连接" />
      <KeyboardScrollScreen backgroundColor={colors.settingsBackground} scrollProps={{ contentContainerStyle: { padding: spacing.xs3 } }}>
        <Card style={{ alignItems: 'center', padding: spacing.xs5 }}>
          <View style={{ alignItems: 'center', backgroundColor: colors.surfaceSubtle, borderRadius: 30, height: 60, justifyContent: 'center', width: 60 }}>
            <Smartphone color={colors.text} size={27} />
          </View>
          <Text style={{ color: colors.text, fontSize: 19, fontWeight: '700', marginTop: 12 }}>这台 iPhone</Text>
          <View style={{ backgroundColor: colors.surfaceSubtle, borderRadius: radius.pill, marginTop: 8, paddingHorizontal: 10, paddingVertical: 5 }}>
            <Text style={{ color: connected ? colors.success : colors.textMuted, fontSize: 11, fontWeight: '600' }}>
              {connected ? '已连接 · 经 relay 中继' : STATUS_LABEL[status] ?? status}
            </Text>
          </View>
        </Card>

        <SectionHeader title="连接" />
        {hasCredentials ? (
          <ContentCard
            items={[
              {
                detail: connected ? '端到端加密通道已建立' : status === 'connecting' ? '正在经 relay 连接桌面端…' : '点按重连（需桌面端网关在线）',
                icon: Link2,
                label: connected ? '已连接' : '重新连接',
                onPress: () => {
                  const credentials = relayCredentialsStore.load();
                  if (credentials !== null) void initializeRelayRuntime().connectWithCredentials(credentials.relayToken);
                },
                selected: connected,
              },
              { detail: '删除本机配对凭证（桌面端同步撤销）', icon: RefreshCw, label: '取消配对', onPress: forget },
            ]}
          />
        ) : (
          <Text style={{ color: colors.textMuted, fontSize: 12, paddingHorizontal: 3, paddingBottom: spacing.sm }}>尚未配对——在桌面端「设置 → 设备与连接」发起配对，然后扫码或输入配对码。</Text>
        )}

        <SectionHeader title="配对（扫码或手输）" />
        <Button
          containerStyle={{ marginBottom: spacing.xs2 }}
          disabled={pairing}
          label={pairing ? '配对中…' : '扫码配对'}
          onPress={() => { setPairError(null); setQrScanning(true); }}
        />
        <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, marginBottom: spacing.xs2, paddingHorizontal: 12 }}>
          <TextInput
            accessibilityLabel="配对码"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="number-pad"
            maxLength={6}
            onChangeText={(value) => setPairCode(value.replace(/[^0-9]/g, '').slice(0, 6))}
            placeholder="输入桌面端显示的 6 位配对码"
            placeholderTextColor={colors.textFaint}
            style={{ color: colors.text, fontSize: 22, fontWeight: '600', letterSpacing: 6, minHeight: 54, textAlign: 'center' }}
            value={pairCode}
          />
        </View>
        <Button
          containerStyle={{ flex: 1 }}
          disabled={pairing || pairCode.length !== 6}
          label={pairing ? '配对中…' : '输入 6 位码配对'}
          onPress={() => {
            void (async () => {
              setPairError(null);
              const hit = await discoverGateway(pairCode, pairRelayUrl);
              if (hit === null) {
                setPairError(copy.pairDiscoverMiss);
                return;
              }
              // 空 ticket 必然撞 /pairing 握手 401（relay 只认 pairing kind 的 token，
              // 手机端无法自造）——在此拦下并指向二维码路径，不让用户等一个必然失败的连接。
              if (hit.pairingTicket.length === 0) {
                setPairError(copy.pairNoTicket);
                return;
              }
              void pairWithTicket(hit.relayUrl, hit.pairingId, hit.installationId, hit.pairingTicket, undefined, pairCode, hit.gatewayKeyFingerprint);
            })();
          }}
          size="small"
        />
        <TextField
          accessibilityLabel={copy.pairRelayUrlLabel}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setPairRelayUrl}
          placeholder={copy.pairRelayUrlPlaceholder}
          style={{ marginTop: spacing.xs2 }}
          value={pairRelayUrl}
        />
        {pairing ? <ActivityIndicator color={colors.textFaint} style={{ marginTop: spacing.sm }} /> : null}
        {pairError !== null ? <Text style={{ color: colors.destructive, fontSize: 12, marginTop: spacing.sm }}>{pairError}</Text> : null}

        <QrScanModal
          onClose={() => { setQrScanning(false); }}
          onPayload={(payload) => {
            setQrScanning(false);
            try {
              const parsed = JSON.parse(payload) as { relayUrl?: string; pairingId?: string; installationId?: string; gwEphemeralPub?: string; gatewayKeyFingerprint?: string; pairingTicket?: string };
              const gatewayEphemeralPub = parsed.gwEphemeralPub;
              if (typeof parsed.relayUrl === 'string' && typeof parsed.pairingId === 'string' && typeof parsed.installationId === 'string' && parsed.installationId.length > 0 && typeof parsed.gatewayKeyFingerprint === 'string' && typeof gatewayEphemeralPub === 'string') {
                // 空 ticket 必然撞 /pairing 握手 401（relay 只认 pairing kind 的 token，
                // 手机端无法自造）——在此拦下并指向二维码路径，不让用户等一个必然失败的连接。
                if (typeof parsed.pairingTicket !== 'string' || parsed.pairingTicket.length === 0) {
                  setPairError(copy.pairNoTicket);
                  return;
                }
                void pairWithTicket(parsed.relayUrl, parsed.pairingId, parsed.installationId, parsed.pairingTicket, gatewayEphemeralPub, undefined, parsed.gatewayKeyFingerprint);
                return;
              }
              setPairError(copy.pairQrMissingFields);
            } catch {
              setPairError(copy.pairQrInvalidPayload);
            }
          }}
          visible={qrScanning}
        />

        <View style={{ alignItems: 'flex-start', flexDirection: 'row', gap: 6, marginTop: spacing.xs3 }}>
          <Link2 color={colors.textFaint} size={14} />
          <Text style={{ color: colors.textMuted, fontSize: 12, flex: 1, lineHeight: 18 }}>
            连接经自建 relay 中继（非局域网也可用），全程端到端加密——relay 只见路由信息。断线不影响桌面端会话。
          </Text>
        </View>
      </KeyboardScrollScreen>
    </View>
  );
}
