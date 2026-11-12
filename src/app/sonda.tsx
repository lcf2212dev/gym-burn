import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { BeltFooter } from '@/components/belt-footer';
import { Fonts, MaxContentWidth, Spacing } from '@/constants/theme';
import {
  DEVICE_INFORMATION_SERVICE,
  decodeDeviceInformationText,
  hexToBytes,
  uuid16,
} from '@/ftms';
import { useTheme } from '@/hooks/use-theme';
import { useProbe, useTreadmill } from '@/treadmill/treadmill-context';
import { formatClock } from '@/utils/format';

// Serviço proprietário que a T600X expôs no teste real de 11/11/2026.
const PROPRIETARY_SERVICE = uuid16(0xfff0);
const FFF1 = uuid16(0xfff1);
const FFF2 = uuid16(0xfff2);
const FFF3 = uuid16(0xfff3);
const FFF4 = uuid16(0xfff4);
const FFF5 = uuid16(0xfff5);
const CSC_SERVICE = uuid16(0x1816);
const CSC_FEATURE = uuid16(0x2a5c);
const CUSTOM_SERVICE = '00010203-0405-0607-0809-0a0b0c0d1912';
const CUSTOM_CHARACTERISTIC = '00010203-0405-0607-0809-0a0b0c0d2b12';

const DEVICE_INFORMATION_FIELDS: readonly { uuid: string; name: string }[] = [
  { uuid: uuid16(0x2a24), name: 'Modelo' },
  { uuid: uuid16(0x2a29), name: 'Fabricante' },
  { uuid: uuid16(0x2a25), name: 'Serial' },
  { uuid: uuid16(0x2a26), name: 'Firmware' },
  { uuid: uuid16(0x2a28), name: 'Software' },
];

type ResultKind = 'leitura' | 'escrita' | 'notificação' | 'erro';

interface ProbeResult {
  id: number;
  at: number;
  kind: ResultKind;
  label: string;
  value: string;
}

function goBack() {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace('/');
  }
}

/**
 * Sonda GATT para o serviço proprietário 0xFFF0 que a T600X expôs no teste real.
 * É uma ferramenta de diagnóstico manual: nada é escrito sem um toque e tudo o
 * que acontece vai para o registro em arquivo da sessão.
 */
export default function SondaScreen() {
  const theme = useTheme();
  const probe = useProbe();
  const mode = useTreadmill((s) => s.mode);
  const phase = useTreadmill((s) => s.phase);
  const device = useTreadmill((s) => s.device);
  const identityConfirmed = useTreadmill((s) => s.identityConfirmed);
  const connected = mode === 'ble' && phase === 'connected';

  const [results, setResults] = useState<ProbeResult[]>([]);
  const [hexInput, setHexInput] = useState('00');
  const [writeTo, setWriteTo] = useState<'fff1' | 'fff3'>('fff3');
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Sair da tela cancela a assinatura: o registro continua sendo gravado,
  // mas nenhuma notificação fica pendurada em uma tela que não existe mais.
  useEffect(() => {
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, []);

  const add = (kind: ResultKind, label: string, value: string) => {
    setResults((previous) => {
      const next: ProbeResult[] = [
        { id: nextId.current++, at: Date.now(), kind, label, value },
        ...previous,
      ];
      return next.slice(0, 80);
    });
  };

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      add('erro', label, String(error));
    } finally {
      setBusy(false);
    }
  };

  const read = (serviceUuid: string, characteristicUuid: string, label: string) => {
    void run(label, async () => {
      const hex = await probe.read(serviceUuid, characteristicUuid);
      add('leitura', label, hex);
    });
  };

  const write = () => {
    const target = writeTo === 'fff1' ? FFF1 : FFF3;
    void run('Escrita ' + writeTo.toUpperCase(), async () => {
      await probe.write(PROPRIETARY_SERVICE, target, hexInput);
      add('escrita', 'Escrita ' + writeTo.toUpperCase(), hexInput.trim());
    });
  };

  const toggleSubscribe = () => {
    void run('FFF4', async () => {
      const current = unsubscribeRef.current;
      if (current) {
        current();
        unsubscribeRef.current = null;
        setSubscribed(false);
        add('leitura', 'FFF4', 'assinatura cancelada');
        return;
      }
      const off = await probe.subscribe(PROPRIETARY_SERVICE, FFF4, (hex) => {
        add('notificação', 'FFF4', hex);
      });
      unsubscribeRef.current = off;
      setSubscribed(true);
      add('leitura', 'FFF4', 'assinatura ativa');
    });
  };

  const readDeviceInformation = () => {
    void run('Device Information', async () => {
      for (const field of DEVICE_INFORMATION_FIELDS) {
        try {
          const hex = await probe.read(DEVICE_INFORMATION_SERVICE, field.uuid);
          const text = decodeDeviceInformationText(hexToBytes(hex));
          add('leitura', field.name, text ? text + ' (' + hex + ')' : hex);
        } catch (error) {
          add('erro', field.name, String(error));
        }
      }
    });
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <View style={[styles.topBar, { borderColor: theme.border }]}>
        <Text style={[styles.title, { color: theme.text }]} accessibilityRole="header">
          Sonda BLE
        </Text>
        <ActionButton variant="text" label="Voltar" onPress={goBack} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.content}>
          {connected && !identityConfirmed ? (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Confirme a esteira</Text>
              <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                Antes de ler ou escrever qualquer característica, confirme no painel que a esteira
                conectada é a sua (na tela principal, toque em É esta esteira). Numa academia há
                várias iguais lado a lado; escrever na errada poderia mexer na lona de outra pessoa.
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
                A sonda lê e escreve características do serviço proprietário 0xFFF0. Ela só
                funciona com a esteira real conectada e confirmada; o modo demonstração não usa o
                rádio.
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
                  Serviço proprietário 0xFFF0, descoberto no teste real de 11/11/2026. Cada leitura,
                  escrita e notificação também vai para o registro em arquivo.
                </Text>
                <Text
                  style={[
                    styles.warning,
                    { color: theme.noticeWarning, borderColor: theme.noticeWarning },
                  ]}>
                  Experimento: escritas em FFF1/FFF3 podem alterar o estado do painel. Use com a
                  lona vazia e o Emergency Stop ao alcance.
                </Text>
              </View>

              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: theme.text }]}>Leituras do 0xFFF0</Text>
                <View style={styles.row}>
                  <ActionButton
                    variant="outline"
                    label="Ler FFF1"
                    onPress={() => read(PROPRIETARY_SERVICE, FFF1, 'FFF1')}
                    disabled={busy}
                    style={styles.rowButton}
                  />
                  <ActionButton
                    variant="outline"
                    label="Ler FFF2"
                    onPress={() => read(PROPRIETARY_SERVICE, FFF2, 'FFF2')}
                    disabled={busy}
                    style={styles.rowButton}
                  />
                  <ActionButton
                    variant="outline"
                    label="Ler FFF5"
                    onPress={() => read(PROPRIETARY_SERVICE, FFF5, 'FFF5')}
                    disabled={busy}
                    style={styles.rowButton}
                  />
                </View>
                <ActionButton
                  variant={subscribed ? 'primary' : 'outline'}
                  label={subscribed ? 'Cancelar assinatura do FFF4' : 'Assinar FFF4 (notificações)'}
                  onPress={toggleSubscribe}
                  disabled={busy}
                />
              </View>

              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: theme.text }]}>Escrita no 0xFFF0</Text>
                <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                  Escreva bytes em hexadecimal. O alvo padrão é o FFF3 (write-only); o FFF1 também
                  aceita escrita.
                </Text>
                <View style={styles.row}>
                  <ActionButton
                    variant={writeTo === 'fff3' ? 'primary' : 'outline'}
                    label="FFF3"
                    onPress={() => setWriteTo('fff3')}
                    style={styles.rowButton}
                  />
                  <ActionButton
                    variant={writeTo === 'fff1' ? 'primary' : 'outline'}
                    label="FFF1"
                    onPress={() => setWriteTo('fff1')}
                    style={styles.rowButton}
                  />
                </View>
                <TextInput
                  value={hexInput}
                  onChangeText={setHexInput}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  placeholder="00 01 F1"
                  placeholderTextColor={theme.textSecondary}
                  style={[styles.input, { borderColor: theme.border, color: theme.text }]}
                />
                <ActionButton
                  variant="outline"
                  label="Enviar"
                  onPress={write}
                  disabled={busy || hexInput.trim().length === 0}
                />
              </View>

              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: theme.text }]}>Outras leituras</Text>
                <ActionButton
                  variant="outline"
                  label="Ler CSC Feature (0x2A5C)"
                  onPress={() => read(CSC_SERVICE, CSC_FEATURE, 'CSC Feature')}
                  disabled={busy}
                />
                <ActionButton
                  variant="outline"
                  label="Ler característica 2B12 (custom)"
                  onPress={() => read(CUSTOM_SERVICE, CUSTOM_CHARACTERISTIC, '2B12')}
                  disabled={busy}
                />
                <ActionButton
                  variant="outline"
                  label="Ler Device Information (modelo, firmware, serial)"
                  onPress={readDeviceInformation}
                  disabled={busy}
                />
              </View>

              {busy ? (
                <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                  Aguarde a operação...
                </Text>
              ) : null}

              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: theme.text }]}>Resultados</Text>
                {results.length === 0 ? (
                  <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                    Nada ainda. Toque em uma leitura para começar.
                  </Text>
                ) : (
                  results.map((result) => (
                    <View key={result.id} style={[styles.result, { borderColor: theme.border }]}>
                      <Text
                        style={[
                          styles.resultLabel,
                          { color: result.kind === 'erro' ? theme.noticeError : theme.text },
                        ]}>
                        {formatClock(result.at)} {result.kind} {result.label}
                      </Text>
                      <Text style={[styles.mono, { color: theme.textSecondary }]} selectable>
                        {result.value}
                      </Text>
                    </View>
                  ))
                )}
              </View>
            </>
          )}
        </View>
      </ScrollView>
      {/* A tela cobre o painel: com a lona girando, Parar continua à vista. */}
      <BeltFooter />
    </SafeAreaView>
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
  row: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  rowButton: {
    flex: 1,
  },
  input: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontFamily: Fonts.mono,
    fontSize: 16,
    minHeight: 48,
  },
  result: {
    borderBottomWidth: 1,
    paddingVertical: Spacing.two,
    gap: Spacing.one,
  },
  resultLabel: {
    fontSize: 14,
    fontWeight: 600,
  },
  mono: {
    fontFamily: Fonts.mono,
    fontSize: 13,
    lineHeight: 18,
  },
});
