import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { AmbientGlow } from '@/components/ambient-glow';
import { BeltFooter } from '@/components/belt-footer';
import { ScreenHeader } from '@/components/screen-header';
import { SectionLabel } from '@/components/section-label';
import { Surface } from '@/components/surface';
import {
  Fonts,
  LabelType,
  MaxContentWidth,
  MinTouchTarget,
  Neon,
  Radius,
  Spacing,
  TitleType,
} from '@/constants/theme';
import {
  DEVICE_INFORMATION_SERVICE,
  VENDOR_CONTROL_OPCODES,
  decodeDeviceInformationText,
  hexToBytes,
  uuid16,
} from '@/ftms';
import { useTheme } from '@/hooks/use-theme';
import { useRecorder, useRecorderActions } from '@/logging/recorder-context';
import { useProbe, useTreadmill, useTreadmillActions } from '@/treadmill/treadmill-context';
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

// Cada tipo de resultado tem uma cor fixa: erro, leitura, notificação e escrita.
const RESULT_COLORS: Record<ResultKind, string> = {
  erro: Neon.red,
  leitura: Neon.cyan,
  'notificação': Neon.volt,
  escrita: Neon.amber,
};

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
  const belt = useTreadmill((s) => s.belt);
  const speedKmh = useTreadmill((s) => s.metrics.speedKmh);
  const hasControlPoint = useTreadmill((s) => s.capabilities?.hasControlPoint ?? false);
  const sessionBusy = useTreadmill((s) => s.busy);
  const vendorOpcodeProbe = useTreadmill((s) => s.vendorOpcodeProbe);
  const gizwitsProbe = useTreadmill((s) => s.gizwitsProbe);
  const recorderFileName = useRecorder((snapshot) => snapshot.currentFileName);
  const recorderActions = useRecorderActions();
  const connected = mode === 'ble' && phase === 'connected';

  const [results, setResults] = useState<ProbeResult[]>([]);
  const [hexInput, setHexInput] = useState('00');
  const [writeTo, setWriteTo] = useState<'fff1' | 'fff3'>('fff3');
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const vendor = useTreadmill((s) => s.vendor);
  const actions = useTreadmillActions();

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

  // Teste dos op codes vendor do FTMS (0x7E/0x7F). Confirmação explícita porque o
  // 0x7E reinicia o console; o texto deixa claro que firmware não é enviado por aqui.
  const confirmVendorOpcode = (info: (typeof VENDOR_CONTROL_OPCODES)[number]) => {
    Alert.alert(
      `Enviar ${info.short} no Control Point?`,
      `${info.description}\n\nO console pode reiniciar e a conexão cair. Só faça isto com a lona ` +
        'PARADA e vazia, sem ninguém em cima.\n\n' +
        'Isto NÃO atualiza firmware: o GymBurn não tem cliente HTTP do console e nunca envia ' +
        'firmware. É apenas um byte no Control Point do FTMS.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: `Enviar ${info.short}`,
          style: 'destructive',
          onPress: () => actions.sendVendorOpcode(info.opCode),
        },
      ],
    );
  };

  // Por que o teste está bloqueado agora (null = liberado). O servidor de sessão
  // repete estas regras; aqui é só para a tela explicar antes do toque.
  const vendorOpcodeBlockedReason = (() => {
    if (mode !== 'ble' || phase !== 'connected') {
      return 'Conecte na esteira real (BLE) para o teste.';
    }
    if (!hasControlPoint) {
      return 'Esta conexão não expõe o Control Point do FTMS.';
    }
    if (!identityConfirmed) {
      return 'Confirme “É esta esteira” no painel antes do teste.';
    }
    if (vendor.enabled) {
      return 'Desative o controle experimental (0xFFF0) para testar o Control Point.';
    }
    if (sessionBusy) {
      return 'Há um comando em andamento; espere terminar.';
    }
    if (speedKmh === null) {
      return 'Ainda não recebi a velocidade da esteira; espere a telemetria mostrar 0,0 km/h.';
    }
    if (belt === 'running' || speedKmh > 0.5) {
      return 'Pare a lona e espere a esteira ficar ociosa antes do teste.';
    }
    return null;
  })();

  const vendorOpcodeProbeText = (probe: NonNullable<typeof vendorOpcodeProbe>): string => {
    if (probe.status === 'pending') return 'aguardando a resposta do console…';
    if (probe.status === 'blocked') return `não enviado: ${probe.detail ?? 'bloqueado'}.`;
    if (probe.status === 'timeout') return 'sem resposta do console (pode ter reiniciado).';
    if (probe.status === 'failed') return probe.detail ?? 'falhou.';
    const result =
      probe.resultCode === null
        ? 'resposta'
        : `${probe.resultCode === 1 ? 'Success' : `resultado ${probe.resultCode}`}`;
    const parameter = probe.parameterHex ? ` · parâmetro ${probe.parameterHex}` : '';
    return `${result}${parameter}`;
  };

  // Teste automático do protocolo Gizwits (mesmo do app AFG Pro) no 0xFFF0.
  // O painel dispara sozinho ao conectar; aqui ficam o detalhe e o refazer.
  const gizwitsSection = (
    <View style={styles.section}>
      <SectionLabel label="Teste automático (canal alternativo Gizwits)" accent={Neon.violet} />
      <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
        Ao conectar, o app assina o FFF4 e pede “machine info” no FFF3 com o frame
        55 AA 00 00 01 02 00 00 00 00. Se a esteira responder com um frame 55 AA, o
        protocolo do canal alternativo é compatível. É só leitura: não liga nem
        ajusta a lona.
      </Text>
      <Text style={[styles.mono, { color: theme.text }]}>
        Estado: {gizwitsProbe.status}
        {gizwitsProbe.replyBytes > 0 ? ` — ${gizwitsProbe.replyBytes} byte(s)` : ''}
        {gizwitsProbe.replyCommand ? ` — ${gizwitsProbe.replyCommand}` : ''}
      </Text>
      {gizwitsProbe.attempts.map((attempt) => (
        <Text key={attempt.name} style={[styles.mono, { color: theme.textSecondary }]}>
          {attempt.status === 'reply' ? '✓' : attempt.status === 'timeout' ? '·' : '…'}{' '}
          {attempt.label}: {attempt.status}
          {attempt.replyHex ? ` (${attempt.replyHex})` : ''}
        </Text>
      ))}
      {gizwitsProbe.replyHex ? (
        <Text style={[styles.mono, { color: theme.textSecondary }]}>1ª resposta: {gizwitsProbe.replyHex}</Text>
      ) : null}
      {gizwitsProbe.detail ? (
        <Text style={[styles.paragraph, { color: theme.textSecondary }]}>{gizwitsProbe.detail}</Text>
      ) : null}
      {gizwitsProbe.hint ? (
        <Text style={[styles.paragraph, { color: theme.text }]}>{gizwitsProbe.hint}</Text>
      ) : null}
      <ActionButton
        variant="outline"
        color={Neon.violet}
        label="Refazer teste"
        onPress={actions.runGizwitsProbe}
        disabled={!identityConfirmed || gizwitsProbe.status === 'running'}
        labelStyle={styles.wideButtonLabel}
      />
    </View>
  );

  // Registro em arquivo: fica escondido atrás da Sonda (toque longo na versão),
  // mas continua sendo o que permite analisar uma ida à academia depois.
  const recorderSection = (
    <View style={styles.section}>
      <SectionLabel label="Registro da sessão" accent={Neon.cyan} />
      <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
        Tudo o que o app faz fica gravado num arquivo de texto no celular. Compartilhe o arquivo
        para analisar depois.
      </Text>
      {recorderFileName ? (
        <Text style={[styles.mono, { color: theme.textSecondary }]}>{recorderFileName}</Text>
      ) : null}
      <ActionButton
        variant="outline"
        color={Neon.cyan}
        label="Compartilhar registro"
        onPress={() => recorderFileName && recorderActions.share(recorderFileName)}
        disabled={!recorderFileName}
        labelStyle={styles.wideButtonLabel}
      />
    </View>
  );

  // Teste dos op codes vendor do FTMS, visível também sem conexão (os botões ficam
  // desabilitados com a explicação do motivo).
  const vendorOpcodeSection = (
  <View style={styles.section}>
    <SectionLabel label="Opcodes vendor do FTMS (experimental)" accent={Neon.red} />
    <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
      O app de firmware da JHT mostrou que o Control Point do FTMS (0x2AD9) aceita
      opcodes fora da especificação: 0x7E (“Device Update”, reinicia o console em modo de
      atualização) e 0x7F (“Set AP Mode”, obsoleto). Nesta T600X todos os comandos da
      spec são recusados; este teste é para descobrir se as extensões do fabricante
      existem. A resposta (Success, Control Not Permitted, Op Code Not Supported) aparece
      abaixo e fica no registro.
    </Text>
    <Surface accent={theme.noticeWarning}>
      <Text style={[styles.warningText, { color: theme.text }]}>
        Isto NÃO atualiza firmware: o app não tem cliente HTTP do console e nunca chama
        /upload. O 0x7E pode reiniciar o console e derrubar a conexão — envie só com a
        lona vazia e o console ocioso.
      </Text>
    </Surface>
    {VENDOR_CONTROL_OPCODES.map((info) => (
      <ActionButton
        key={info.short}
        variant="outline"
        color={Neon.red}
        label={`Enviar ${info.short} — ${info.label}`}
        onPress={() => confirmVendorOpcode(info)}
        disabled={busy || vendorOpcodeBlockedReason !== null}
        labelStyle={styles.wideButtonLabel}
      />
    ))}
    {vendorOpcodeBlockedReason ? (
      <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
        {vendorOpcodeBlockedReason}
      </Text>
    ) : null}
    {vendorOpcodeProbe ? (
      <Surface
        accent={
          vendorOpcodeProbe.status === 'answered' &&
          vendorOpcodeProbe.resultCode === 1
            ? Neon.volt
            : vendorOpcodeProbe.status === 'pending'
              ? Neon.cyan
              : theme.noticeWarning
        }
        style={styles.result}>
        <Text style={[styles.resultLabel, { color: theme.text }]}>
          {formatClock(vendorOpcodeProbe.at)} {vendorOpcodeProbe.label}
        </Text>
        <Text style={[styles.mono, { color: theme.textSecondary }]}>
          {vendorOpcodeProbeText(vendorOpcodeProbe)}
        </Text>
      </Surface>
    ) : null}
  </View>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <AmbientGlow intensity={0.5} />
      <ScreenHeader
        title="Sonda BLE"
        accent={Neon.amber}
        right={<ActionButton variant="text" label="Voltar" onPress={goBack} />}
      />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.content}>
          {connected && !identityConfirmed ? (
            <Surface accent={Neon.amber} tone="raised" style={styles.blockCard}>
              <Text style={[styles.blockTitle, TitleType, { color: theme.text }]}>
                Confirme a esteira
              </Text>
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
            </Surface>
          ) : !connected ? (
            <>
              <Surface accent={Neon.amber} tone="raised" style={styles.blockCard}>
                <Text style={[styles.blockTitle, TitleType, { color: theme.text }]}>
                  Conecte na esteira
                </Text>
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
              </Surface>
              {vendorOpcodeSection}
              {recorderSection}
            </>
          ) : (
            <>
              {/* Abertura: o serviço que a sonda ataca, e o aviso de escrita no mesmo cartão. */}
              <Surface tone="raised" style={styles.hero}>
                <Text style={[styles.heroTitle, TitleType, { color: theme.text }]}>
                  {device?.name ?? 'Esteira conectada'}
                </Text>
                <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                  Serviço proprietário 0xFFF0, descoberto no teste real de 11/11/2026. Cada leitura,
                  escrita e notificação também vai para o registro em arquivo.
                </Text>
                <Surface accent={theme.noticeWarning}>
                  <Text style={[styles.warningText, { color: theme.text }]}>
                    Experimento: escritas em FFF1/FFF3 podem alterar o estado do painel. Use com a
                    lona vazia e o Emergency Stop ao alcance.
                  </Text>
                </Surface>
              </Surface>

              <View style={styles.section}>
                <SectionLabel label="Leituras do 0xFFF0" accent={Neon.cyan} />
                <View style={styles.row}>
                  <ActionButton
                    variant="outline"
                    label="Ler FFF1"
                    color={Neon.cyan}
                    onPress={() => read(PROPRIETARY_SERVICE, FFF1, 'FFF1')}
                    disabled={busy}
                    labelStyle={styles.rowButtonLabel}
                    style={styles.rowButton}
                  />
                  <ActionButton
                    variant="outline"
                    label="Ler FFF2"
                    color={Neon.cyan}
                    onPress={() => read(PROPRIETARY_SERVICE, FFF2, 'FFF2')}
                    disabled={busy}
                    labelStyle={styles.rowButtonLabel}
                    style={styles.rowButton}
                  />
                  <ActionButton
                    variant="outline"
                    label="Ler FFF5"
                    color={Neon.cyan}
                    onPress={() => read(PROPRIETARY_SERVICE, FFF5, 'FFF5')}
                    disabled={busy}
                    labelStyle={styles.rowButtonLabel}
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
                <SectionLabel label="Escrita no 0xFFF0" accent={Neon.amber} />
                <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                  Escreva bytes em hexadecimal. O alvo padrão é o FFF3 (write-only); o FFF1 também
                  aceita escrita.
                </Text>
                <View
                  style={[
                    styles.segment,
                    { backgroundColor: theme.surfaceSunken, borderColor: theme.border },
                  ]}>
                  <ActionButton
                    variant={writeTo === 'fff3' ? 'primary' : 'outline'}
                    color={theme.textSecondary}
                    label="FFF3"
                    onPress={() => setWriteTo('fff3')}
                    style={styles.segmentButton}
                  />
                  <ActionButton
                    variant={writeTo === 'fff1' ? 'primary' : 'outline'}
                    color={theme.textSecondary}
                    label="FFF1"
                    onPress={() => setWriteTo('fff1')}
                    style={styles.segmentButton}
                  />
                </View>
                <TextInput
                  value={hexInput}
                  onChangeText={setHexInput}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  placeholder="00 01 F1"
                  placeholderTextColor={theme.textSecondary}
                  style={[
                    styles.input,
                    {
                      backgroundColor: theme.surfaceSunken,
                      borderColor: theme.border,
                      color: theme.text,
                    },
                  ]}
                />
                <ActionButton
                  variant="outline"
                  color={Neon.amber}
                  label="Enviar"
                  onPress={write}
                  disabled={busy || hexInput.trim().length === 0}
                />
              </View>

              <View style={styles.section}>
                <SectionLabel label="Varredura segura do 0xFFF0" accent={Neon.amber} />
                <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                  Escreve 1 byte por vez (e “AT”) nas características de escrita, com o FFF4
                  assinado, para ver se o canal responde. Não envia comando de controle: a lona
                  precisa estar parada e o Emergency Stop ao alcance.
                </Text>
                {vendor.discovery ? (
                  <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                    {vendor.discovery.running
                      ? `Varredura em andamento: ${vendor.discovery.index}/${vendor.discovery.total}.`
                      : `Varredura concluída: ${vendor.discovery.observations.length} bytes testados.`}
                  </Text>
                ) : null}
                <ActionButton
                  variant="outline"
                  color={Neon.amber}
                  label={
                    vendor.discovery?.running
                      ? 'Cancelar varredura'
                      : 'Iniciar varredura segura (10 bytes)'
                  }
                  onPress={() =>
                    vendor.discovery?.running
                      ? actions.cancelVendorDiscovery()
                      : actions.runVendorDiscovery()
                  }
                  disabled={busy || !vendor.available}
                />
                {vendor.discovery?.observations.map((observation) => (
                  <Surface
                    key={observation.at}
                    accent={observation.replies.length > 0 ? Neon.volt : Neon.cyan}
                    style={styles.result}>
                    <Text style={[styles.resultLabel, { color: theme.text }]}>
                      {formatClock(observation.at)} {observation.label} → {observation.hex || '—'}
                    </Text>
                    <Text style={[styles.mono, { color: theme.textSecondary }]}>
                      FFF4: {observation.replies.length > 0 ? observation.replies.join(', ') : 'nada'} ·
                      FFF1: {observation.fff1Before ?? '?'} → {observation.fff1After ?? '?'} · FFF2:{' '}
                      {observation.fff2Before ?? '?'} → {observation.fff2After ?? '?'} · vel:{' '}
                      {observation.speedBefore ?? '?'} → {observation.speedAfter ?? '?'} · incl:{' '}
                      {observation.inclinationBefore ?? '?'} → {observation.inclinationAfter ?? '?'}
                      {observation.error ? ` · erro: ${observation.error}` : ''}
                    </Text>
                  </Surface>
                ))}
              </View>

              {vendorOpcodeSection}
              {recorderSection}
              {gizwitsSection}

              <View style={styles.section}>
                <SectionLabel label="Outras leituras" accent={Neon.violet} />
                <ActionButton
                  variant="outline"
                  label="Ler CSC Feature (0x2A5C)"
                  color={Neon.cyan}
                  onPress={() => read(CSC_SERVICE, CSC_FEATURE, 'CSC Feature')}
                  disabled={busy}
                  labelStyle={styles.wideButtonLabel}
                />
                <ActionButton
                  variant="outline"
                  label="Ler característica 2B12 (custom)"
                  color={Neon.cyan}
                  onPress={() => read(CUSTOM_SERVICE, CUSTOM_CHARACTERISTIC, '2B12')}
                  disabled={busy}
                  labelStyle={styles.wideButtonLabel}
                />
                <ActionButton
                  variant="outline"
                  label="Ler Device Information (modelo, firmware, serial)"
                  color={Neon.cyan}
                  onPress={readDeviceInformation}
                  disabled={busy}
                  labelStyle={styles.wideButtonLabel}
                />
              </View>

              {busy ? (
                <View style={styles.busyRow}>
                  <ActivityIndicator size="small" color={Neon.cyan} />
                  <Text style={[styles.busyText, { color: theme.textSecondary }]}>
                    Aguarde a operação...
                  </Text>
                </View>
              ) : null}

              <View style={styles.section}>
                <SectionLabel label="Resultados" accent={Neon.volt} />
                {results.length === 0 ? (
                  <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                    Nada ainda. Toque em uma leitura para começar.
                  </Text>
                ) : (
                  results.map((result) => (
                    <Surface
                      key={result.id}
                      accent={RESULT_COLORS[result.kind]}
                      style={styles.result}>
                      <Text
                        style={[styles.resultLabel, { color: RESULT_COLORS[result.kind] }]}>
                        {formatClock(result.at)} {result.kind} {result.label}
                      </Text>
                      <Text style={[styles.mono, { color: theme.text }]} selectable>
                        {result.value}
                      </Text>
                    </Surface>
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
  scroll: {
    flexGrow: 1,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.five,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    gap: Spacing.four,
  },
  blockCard: {
    gap: Spacing.three,
  },
  blockTitle: {
    fontSize: 22,
    lineHeight: 26,
  },
  hero: {
    gap: 12,
  },
  heroTitle: {
    fontSize: 26,
    lineHeight: 30,
  },
  paragraph: {
    fontSize: 15,
    lineHeight: 22,
  },
  warningText: {
    fontSize: 14,
    lineHeight: 20,
  },
  section: {
    gap: Spacing.two,
  },
  row: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  rowButton: {
    flex: 1,
  },
  rowButtonLabel: {
    fontSize: 18,
    lineHeight: 22,
    letterSpacing: 0.2,
  },
  // Alvo da escrita: um trilho escuro com o botão ativo preenchido de volt.
  segment: {
    flexDirection: 'row',
    gap: Spacing.one,
    padding: Spacing.one,
    borderWidth: 1,
    borderRadius: Radius.lg,
  },
  segmentButton: {
    flex: 1,
  },
  input: {
    borderWidth: 1,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    minHeight: MinTouchTarget,
    fontFamily: Fonts.mono,
    fontSize: 18,
    letterSpacing: 1.2,
  },
  fieldLabel: {
    ...LabelType,
  },
  actionField: {
    gap: Spacing.one,
  },
  wideButtonLabel: {
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: 0.2,
  },
  busyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  busyText: {
    fontSize: 15,
    lineHeight: 22,
  },
  result: {
    gap: Spacing.one,
  },
  resultLabel: {
    ...LabelType,
    flexShrink: 1,
  },
  mono: {
    fontFamily: Fonts.mono,
    fontSize: 13,
    lineHeight: 19,
    flexShrink: 1,
  },
});
