import { router } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { CharacteristicInfo, ServiceInfo } from '@/ble/transport';
import { ActionButton } from '@/components/action-button';
import { BeltFooter } from '@/components/belt-footer';
import { Fonts, MaxContentWidth, Spacing } from '@/constants/theme';
import { normalizeUuid, shortUuid, uuid16 } from '@/ftms';
import { useTheme } from '@/hooks/use-theme';
import { useRecorder, useRecorderActions, useTraceWriter } from '@/logging/recorder-context';
import { useProbe, useTreadmill } from '@/treadmill/treadmill-context';
import { nowMs } from '@/utils/clock';
import { formatClock } from '@/utils/format';

const READ_TIMEOUT_MS = 2000;
const SUBSCRIBE_TIMEOUT_MS = 2500;
const CUSTOM_SERVICE = '00010203-0405-0607-0809-0a0b0c0d1912';
const CUSTOM_CHARACTERISTIC = '00010203-0405-0607-0809-0a0b0c0d2b12';

// A sessão normal já assina estas características (e registra cada aviso). Assinar de
// novo criaria ouvintes duplicados no mesmo canal; a coleta cobre o resto e usa o
// registro da sessão para estes.
const SESSION_SUBSCRIBED: readonly (readonly [string, string])[] = [
  [uuid16(0x1826), uuid16(0x2acd)],
  [uuid16(0x1826), uuid16(0x2ad3)],
  [uuid16(0x1826), uuid16(0x2ad9)],
  [uuid16(0x1826), uuid16(0x2ada)],
  [uuid16(0x1801), uuid16(0x2a05)],
];

// Serviços na ordem em que interessam para a engenharia reversa.
const SERVICE_PRIORITY = [0x180a, 0xfff0, 0x1816, 0x1800, 0x181c, 0x1826];

const MARK_LABELS = [
  'Comecei a andar',
  'Parei a lona',
  'Aumentei a velocidade',
  'Diminuí a velocidade',
  'Subi a inclinação',
  'Desci a inclinação',
  'Chave de segurança',
  'Apertei o Emergency Stop',
];

const CHARACTERISTIC_NAMES: Record<string, string> = {};
const NAMED_CHARACTERISTICS: readonly (readonly [number, string])[] = [
  [0x2a00, 'Device Name'],
  [0x2a01, 'Appearance'],
  [0x2a04, 'Peripheral Preferred Connection Parameters'],
  [0x2a24, 'Model Number'],
  [0x2a25, 'Serial Number'],
  [0x2a26, 'Firmware Revision'],
  [0x2a28, 'Software Revision'],
  [0x2a29, 'Manufacturer Name'],
  [0x2a23, 'System ID'],
  [0x2a50, 'PnP ID'],
  [0x2a5b, 'CSC Measurement'],
  [0x2a5c, 'CSC Feature'],
  [0x2a8a, 'First Name'],
  [0x2a8e, 'Weight'],
  [0x2a85, 'Date of Birth'],
  [0x2a8c, 'Gender'],
  [0x2aa2, 'Language'],
  [0xfff1, 'FFF1 (proprietário)'],
  [0xfff2, 'FFF2 (proprietário)'],
  [0xfff3, 'FFF3 (proprietário)'],
  [0xfff4, 'FFF4 (proprietário)'],
  [0xfff5, 'FFF5 (proprietário)'],
];
for (const [short, name] of NAMED_CHARACTERISTICS) {
  CHARACTERISTIC_NAMES[normalizeUuid(uuid16(short))] = name;
}
CHARACTERISTIC_NAMES[normalizeUuid(CUSTOM_CHARACTERISTIC)] = '2B12 (custom)';

class ReadTimeoutError extends Error {
  constructor(ms: number) {
    super('sem resposta em ' + ms + ' ms');
    this.name = 'ReadTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadTimeoutError(ms)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function keyOf(serviceUuid: string, characteristicUuid: string): string {
  return normalizeUuid(serviceUuid) + '|' + normalizeUuid(characteristicUuid);
}

function nameOf(uuid: string): string {
  return CHARACTERISTIC_NAMES[normalizeUuid(uuid)] ?? shortUuid(uuid);
}

function labelOf(serviceUuid: string, characteristicUuid: string): string {
  return nameOf(characteristicUuid) + ' (' + shortUuid(serviceUuid) + ')';
}

function propertyLabel(characteristic: CharacteristicInfo): string {
  const properties: string[] = [];
  if (characteristic.canRead) properties.push('read');
  if (characteristic.canWrite) properties.push('write');
  if (characteristic.canNotify) properties.push('notify');
  if (characteristic.canIndicate) properties.push('indicate');
  return properties.join(' ') || 'sem propriedades';
}

function orderedServices(services: readonly ServiceInfo[]): ServiceInfo[] {
  const priority = (uuid: string): number => {
    const normalized = normalizeUuid(uuid);
    for (let index = 0; index < SERVICE_PRIORITY.length; index += 1) {
      if (normalizeUuid(uuid16(SERVICE_PRIORITY[index])) === normalized) return index;
    }
    return normalized === normalizeUuid(CUSTOM_SERVICE) ? SERVICE_PRIORITY.length : SERVICE_PRIORITY.length + 1;
  };
  return [...services].sort((a, b) => priority(a.uuid) - priority(b.uuid));
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return minutes + ':' + String(rest).padStart(2, '0');
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + '...' : value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ChannelSummary {
  key: string;
  label: string;
  count: number;
  lastHex: string | null;
}

interface MarkSummary {
  at: number;
  label: string;
}

interface CollectorSnapshot {
  collecting: boolean;
  startedAt: number | null;
  now: number;
  notifications: number;
  subscriptions: number;
  readsOk: number;
  readsFailed: number;
  marks: number;
  channels: ChannelSummary[];
  lastMarks: MarkSummary[];
}

function goBack() {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace('/');
  }
}

/**
 * Coleta contínua para engenharia reversa. Enquanto o celular estiver pareado na
 * academia, esta tela:
 * - despeja o inventário completo do GATT no registro;
 * - assina todas as notificações que a sessão normal ainda não escuta;
 * - lê todas as características legíveis;
 * - deixa o usuário marcar eventos (andou, inclinou, parou) no mesmo registro.
 * Tudo cai no arquivo de registro da execução, que pode ser compartilhado depois.
 */
export default function ColetaScreen() {
  const theme = useTheme();
  const probe = useProbe();
  const mode = useTreadmill((s) => s.mode);
  const phase = useTreadmill((s) => s.phase);
  const device = useTreadmill((s) => s.device);
  const identityConfirmed = useTreadmill((s) => s.identityConfirmed);
  const currentFileName = useRecorder((s) => s.currentFileName);
  const recorderActions = useRecorderActions();
  const writer = useTraceWriter();
  useKeepAwake();

  const connected = phase === 'connected';
  const simulated = mode === 'demo';

  const [collecting, setCollecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [customMark, setCustomMark] = useState('');
  const [snapshot, setSnapshot] = useState<CollectorSnapshot>({
    collecting: false,
    startedAt: null,
    now: nowMs(),
    notifications: 0,
    subscriptions: 0,
    readsOk: 0,
    readsFailed: 0,
    marks: 0,
    channels: [],
    lastMarks: [],
  });

  const collectingRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const countsRef = useRef<Map<string, { label: string; count: number; lastHex: string | null }>>(
    new Map(),
  );
  const subscriptionsRef = useRef<(() => void)[]>([]);
  const readsRef = useRef({ ok: 0, failed: 0 });
  const marksRef = useRef<{ count: number; last: MarkSummary[] }>({ count: 0, last: [] });

  const refresh = useCallback(() => {
    const channels: ChannelSummary[] = [];
    for (const [key, value] of countsRef.current) {
      channels.push({ key, label: value.label, count: value.count, lastHex: value.lastHex });
    }
    channels.sort((a, b) => b.count - a.count);
    const notifications = channels.reduce((total, channel) => total + channel.count, 0);
    setSnapshot({
      collecting: collectingRef.current,
      startedAt: startedAtRef.current,
      now: nowMs(),
      notifications,
      subscriptions: subscriptionsRef.current.length,
      readsOk: readsRef.current.ok,
      readsFailed: readsRef.current.failed,
      marks: marksRef.current.count,
      channels,
      lastMarks: marksRef.current.last.slice(0, 6),
    });
  }, []);

  const note = useCallback(
    (text: string, kind: 'info' | 'error' | 'action' = 'info') => {
      writer({ at: nowMs(), kind, text, hex: null });
    },
    [writer],
  );

  const stopSubscriptions = () => {
    const offs = subscriptionsRef.current;
    subscriptionsRef.current = [];
    for (const off of offs) {
      try {
        off();
      } catch {
        // A assinatura já pode ter sido removida pelo teardown da conexão.
      }
    }
  };

  const stop = () => {
    if (!collectingRef.current) return;
    stopSubscriptions();
    collectingRef.current = false;
    setCollecting(false);
    const startedAt = startedAtRef.current;
    const seconds = startedAt === null ? 0 : Math.round((nowMs() - startedAt) / 1000);
    let total = 0;
    for (const value of countsRef.current.values()) total += value.count;
    note(
      'Coleta RE encerrada depois de ' + formatDuration(seconds) + ': ' + total + ' notificações, ' +
        readsRef.current.ok + ' leituras, ' + marksRef.current.count + ' marcas.',
      'action',
    );
    refresh();
  };

  const start = () => {
    if (busy || collectingRef.current) return;
    setBusy(true);
    void (async () => {
      try {
        countsRef.current = new Map();
        subscriptionsRef.current = [];
        readsRef.current = { ok: 0, failed: 0 };
        marksRef.current = { count: 0, last: [] };
        startedAtRef.current = nowMs();
        note('Coleta RE iniciada', 'action');

        const services = await probe.services();
        for (const service of services) {
          const summary = service.characteristics
            .map((characteristic) => shortUuid(characteristic.uuid) + '[' + propertyLabel(characteristic) + ']')
            .join(', ');
          note('GATT ' + shortUuid(service.uuid) + ': ' + (summary || 'sem características'));
        }

        // Assinaturas primeiro: se uma leitura travar a fila do rádio, as notificações
        // continuam chegando.
        for (const service of services) {
          for (const characteristic of service.characteristics) {
            if (!characteristic.canNotify && !characteristic.canIndicate) continue;
            const key = keyOf(service.uuid, characteristic.uuid);
            if (SESSION_SUBSCRIBED.some((entry) => keyOf(entry[0], entry[1]) === key)) continue;
            const label = labelOf(service.uuid, characteristic.uuid);
            try {
              const off = await withTimeout(
                probe.subscribe(service.uuid, characteristic.uuid, (hex) => {
                  const existing = countsRef.current.get(key);
                  if (existing) {
                    existing.count += 1;
                    existing.lastHex = hex;
                  } else {
                    countsRef.current.set(key, { label, count: 1, lastHex: hex });
                  }
                }),
                SUBSCRIBE_TIMEOUT_MS,
              );
              subscriptionsRef.current.push(off);
              note('Coleta: assinatura ' + label + ' ativa');
            } catch (error) {
              note('Coleta: assinatura ' + label + ' falhou: ' + errorText(error), 'error');
            }
          }
        }

        // Leituras de todas as características legíveis, na ordem de interesse.
        let readsAborted = false;
        for (const service of orderedServices(services)) {
          if (readsAborted) break;
          for (const characteristic of service.characteristics) {
            if (!characteristic.canRead || readsAborted) continue;
            const label = labelOf(service.uuid, characteristic.uuid);
            try {
              const hex = await withTimeout(
                probe.read(service.uuid, characteristic.uuid),
                READ_TIMEOUT_MS,
              );
              readsRef.current.ok += 1;
              note('Coleta: leitura ' + label + ' = ' + (hex || '(vazio)'));
            } catch (error) {
              readsRef.current.failed += 1;
              note('Coleta: leitura ' + label + ' falhou: ' + errorText(error), 'error');
              if (error instanceof ReadTimeoutError) readsAborted = true;
            }
          }
        }

        collectingRef.current = true;
        setCollecting(true);
        note(
          'Coleta RE ativa: ' + subscriptionsRef.current.length + ' assinaturas, ' +
            readsRef.current.ok + ' leituras. Use a esteira e marque os eventos.',
          'action',
        );
        refresh();
      } catch (error) {
        note('Coleta RE falhou: ' + errorText(error), 'error');
      } finally {
        setBusy(false);
      }
    })();
  };

  const mark = (label: string) => {
    if (!collectingRef.current) return;
    marksRef.current.count += 1;
    marksRef.current.last = [{ at: nowMs(), label }, ...marksRef.current.last].slice(0, 6);
    const startedAt = startedAtRef.current;
    const seconds = startedAt === null ? 0 : Math.round((nowMs() - startedAt) / 1000);
    note('MARCA +' + formatDuration(seconds) + ': ' + label, 'action');
    refresh();
  };

  const markCustom = () => {
    const text = customMark.trim();
    if (!text) return;
    mark(text);
    setCustomMark('');
  };

  const share = () => {
    if (currentFileName) {
      recorderActions.share(currentFileName);
    }
  };

  useEffect(() => {
    if (!collecting) return;
    const timer = setInterval(refresh, 750);
    return () => clearInterval(timer);
  }, [collecting, refresh]);

  // Se a conexão cair, encerra a coleta e deixa isso no registro.
  useEffect(() => {
    if (!collecting || phase === 'connected') return;
    const offs = subscriptionsRef.current;
    subscriptionsRef.current = [];
    for (const off of offs) {
      try {
        off();
      } catch {
        // A assinatura já pode ter sido removida pelo teardown da conexão.
      }
    }
    collectingRef.current = false;
    // O setState fica no timeout: é um callback, não a renderização do efeito.
    const timer = setTimeout(() => {
      setCollecting(false);
      note('Coleta RE interrompida: a conexão com a esteira caiu.', 'error');
      refresh();
    }, 0);
    return () => clearTimeout(timer);
  }, [collecting, phase, mode, refresh, note]);

  // Sair da tela não deixa assinatura pendurada.
  useEffect(() => {
    return () => {
      collectingRef.current = false;
      stopSubscriptions();
    };
  }, []);

  const seconds = snapshot.startedAt === null ? 0 : (snapshot.now - snapshot.startedAt) / 1000;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <View style={[styles.topBar, { borderColor: theme.border }]}>
        <Text style={[styles.title, { color: theme.text }]} accessibilityRole="header">
          Coleta RE
        </Text>
        <ActionButton variant="text" label="Voltar" onPress={goBack} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.content}>
          {connected && !identityConfirmed ? (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Confirme a esteira</Text>
              <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                Antes de coletar, confirme no painel que a esteira conectada é a sua (na tela
                principal, toque em É esta esteira). Numa academia há várias iguais lado a lado.
              </Text>
              <ActionButton
                variant="primary"
                label="Ir para o painel"
                onPress={() => router.replace('/')}
              />
            </View>
          ) : !connected ? (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Conecte na esteira</Text>
              <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                A coleta só funciona com a esteira real conectada: ela despeja o inventário do
                GATT, lê todas as características legíveis e assina as notificações. O modo
                demonstração não usa o rádio.
              </Text>
              <ActionButton
                variant="primary"
                label="Ir para a conexão"
                onPress={() => router.replace('/')}
              />
            </View>
          ) : (
            <>
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: theme.text }]}>
                  {device?.name ?? 'Esteira conectada'}
                </Text>
                <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                  Deixe esta tela aberta enquanto usa a esteira. Ela assina todas as notificações
                  que o app ainda não escuta, lê todas as características legíveis e grava o
                  inventário do GATT. Cada notificação e cada leitura vão para o registro em
                  arquivo; as marcações abaixo entram na mesma linha do tempo. As notificações do
                  FTMS (velocidade, inclinação, status) já são gravadas pela sessão a cada pacote;
                  os contadores abaixo são das características extras assinadas aqui.
                </Text>
                {simulated ? (
                  <Text
                    style={[
                      styles.warning,
                      { color: theme.noticeError, borderColor: theme.noticeError },
                    ]}>
                    ENSAIO COM ESTEIRA SIMULADA: os dados são inventados e não servem para
                    engenharia reversa. Use esta tela assim só para ensaiar o fluxo antes de ir à
                    academia.
                  </Text>
                ) : null}
                <Text
                  style={[
                    styles.warning,
                    { color: theme.noticeWarning, borderColor: theme.noticeWarning },
                  ]}>
                  Nada é escrito na esteira nesta tela: é só coleta e anotação. Mantenha o app em
                  primeiro plano e a tela ligada (ela fica acordada sozinha durante a coleta).
                </Text>
              </View>

              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: theme.text }]}>Situação</Text>
                <View style={[styles.metrics, { borderColor: theme.border }]}>
                  <Metric label="Tempo" value={formatDuration(seconds)} />
                  <Metric label="Notificações extras" value={String(snapshot.notifications)} />
                  <Metric label="Assinaturas" value={String(snapshot.subscriptions)} />
                  <Metric label="Leituras OK" value={String(snapshot.readsOk)} />
                  <Metric label="Leituras falhas" value={String(snapshot.readsFailed)} />
                  <Metric label="Marcas" value={String(snapshot.marks)} />
                </View>
                {collecting ? (
                  <ActionButton variant="solid" color={theme.noticeError} label="Parar coleta" onPress={stop} />
                ) : (
                  <ActionButton
                    variant="primary"
                    label={snapshot.startedAt === null ? 'Iniciar coleta' : 'Nova coleta'}
                    onPress={start}
                    disabled={busy}
                    busy={busy}
                  />
                )}
              </View>

              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: theme.text }]}>Marcar evento</Text>
                <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                  Toque no que aconteceu para alinhar o evento com os pacotes no registro. As
                  marcações só valem durante a coleta.
                </Text>
                <View style={styles.markGrid}>
                  {MARK_LABELS.map((label) => (
                    <ActionButton
                      key={label}
                      variant="outline"
                      label={label}
                      onPress={() => mark(label)}
                      disabled={!collecting}
                      style={styles.markButton}
                    />
                  ))}
                </View>
                <View style={styles.row}>
                  <TextInput
                    value={customMark}
                    onChangeText={setCustomMark}
                    placeholder="Outro evento"
                    placeholderTextColor={theme.textSecondary}
                    style={[styles.input, { borderColor: theme.border, color: theme.text }]}
                  />
                  <ActionButton
                    variant="outline"
                    label="Marcar"
                    onPress={markCustom}
                    disabled={!collecting || customMark.trim().length === 0}
                  />
                </View>
              </View>

              {snapshot.channels.length > 0 ? (
                <View style={styles.section}>
                  <Text style={[styles.sectionTitle, { color: theme.text }]}>Canais recebidos</Text>
                  {snapshot.channels.slice(0, 12).map((channel) => (
                    <View key={channel.key} style={[styles.channel, { borderColor: theme.border }]}>
                      <Text style={[styles.channelLabel, { color: theme.text }]}>
                        {channel.label}
                      </Text>
                      <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                        {channel.count} pacote(s)
                      </Text>
                      {channel.lastHex ? (
                        <Text style={[styles.mono, { color: theme.textSecondary }]} selectable>
                          {truncate(channel.lastHex, 90)}
                        </Text>
                      ) : null}
                    </View>
                  ))}
                </View>
              ) : null}

              {snapshot.lastMarks.length > 0 ? (
                <View style={styles.section}>
                  <Text style={[styles.sectionTitle, { color: theme.text }]}>Últimas marcas</Text>
                  {snapshot.lastMarks.map((markSummary) => (
                    <Text
                      key={String(markSummary.at)}
                      style={[styles.mono, { color: theme.textSecondary }]}>
                      {formatClock(markSummary.at)} {markSummary.label}
                    </Text>
                  ))}
                </View>
              ) : null}

              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: theme.text }]}>Registro</Text>
                <Text style={[styles.mono, { color: theme.text }]} selectable>
                  {currentFileName ?? 'Sem arquivo em gravação'}
                </Text>
                <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                  O arquivo tem tudo: inventário do GATT, leituras, notificações e marcações. Ele é
                  gravado aos poucos; compartilhe quando a coleta terminar. Se houver pasta de
                  cópia configurada, o mesmo conteúdo aparece em Documents/GymBurn.
                </Text>
                <ActionButton
                  variant="outline"
                  label="Compartilhar registro"
                  onPress={share}
                  disabled={!currentFileName}
                />
              </View>
            </>
          )}
        </View>
      </ScrollView>
      <BeltFooter />
    </SafeAreaView>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.metric}>
      <Text style={[styles.metricValue, { color: theme.text }]}>{value}</Text>
      <Text style={[styles.metricLabel, { color: theme.textSecondary }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: Spacing.three,
    paddingRight: Spacing.two,
    borderBottomWidth: 1,
  },
  title: {
    fontSize: 20,
    fontWeight: 700,
  },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    gap: Spacing.four,
  },
  section: {
    gap: Spacing.two,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: 700,
  },
  paragraph: {
    fontSize: 15,
    lineHeight: 21,
  },
  warning: {
    fontSize: 14,
    lineHeight: 20,
    borderLeftWidth: 3,
    paddingLeft: Spacing.three,
  },
  metrics: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderTopWidth: 1,
    paddingTop: Spacing.two,
  },
  metric: {
    width: '33%',
    paddingVertical: Spacing.one,
  },
  metricValue: {
    fontSize: 20,
    fontWeight: 700,
    fontFamily: Fonts.mono,
  },
  metricLabel: {
    fontSize: 12,
    lineHeight: 16,
  },
  markGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  markButton: {
    flexGrow: 1,
    flexBasis: '45%',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    minHeight: 48,
    fontSize: 15,
  },
  channel: {
    borderBottomWidth: 1,
    paddingVertical: Spacing.two,
    gap: Spacing.one,
  },
  channelLabel: {
    fontSize: 14,
    fontWeight: 600,
  },
  mono: {
    fontFamily: Fonts.mono,
    fontSize: 13,
    lineHeight: 18,
  },
});