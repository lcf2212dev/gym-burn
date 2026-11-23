import { Lucide } from '@react-native-vector-icons/lucide';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Card, Kicker } from '@/components/card';
import { IconBadge, Rings, StatusPill } from '@/components/kit';
import { UiButton } from '@/components/ui-button';
import { styles, WorkoutPage } from '@/components/workout-ui';
import { Colors, Metric, Neon, NumeralType, TitleType, neonGlow } from '@/constants/theme';
import { useStrap, useStrapActions, useStrapCadence, useStrapHold } from '@/heart/strap-context';
import type { StrapPhase, XossStatus } from '@/heart/strap-session';

const STATUS: Record<StrapPhase, string> = {
  idle: 'Em espera.',
  searching: 'Procurando a cinta por perto…',
  connecting: 'Conectando…',
  connected: 'Conectada.',
};
/** O estado no alto da tela: o texto curto e a cor de cada fase. */
const PILL: Record<StrapPhase, [string, string]> = {
  idle: ['Em espera', Colors.dark.textSecondary],
  searching: ['Procurando', Neon.cyan],
  connecting: ['Conectando', Neon.cyan],
  connected: ['Conectada', Neon.mint],
};
/** O que muda no treino com a cinta em uso. */
const WITH_STRAP = [
  'O guia deixa de pedir as mãos no sensor.',
  'A carga é revista a cada 30 s, pela mediana do último minuto de leituras.',
  'Se a conexão cair, voltam a valer os batimentos do sensor de mão da esteira.',
];
/** Um traçado de pulso, só de enfeite, atrás da leitura. */
const TRACE =
  'M0 34 H96 l8 -6 l8 6 h10 l7 -26 l10 44 l8 -26 l6 8 H214 l8 -6 l8 6 h10 l7 -26 l10 44 l8 -26 l6 8 H336';

/**
 * Pareamento da cinta de batimentos. A pessoa escolhe a cinta uma vez; daí em
 * diante o app conecta sozinho quando procura ou usa uma esteira. Com a tela
 * aberta a cinta fica conectada, para dar para conferir a leitura.
 */
export default function StrapScreen() {
  useStrapHold();
  // Na X2 Pro, a cadência aparece ao vivo no diagnóstico mesmo sem treino.
  useStrapCadence();
  const saved = useStrap((s) => s.saved);
  const phase = useStrap((s) => s.phase);
  const bpm = useStrap((s) => s.bpm);
  const battery = useStrap((s) => s.battery);
  const xoss = useStrap((s) => s.xoss);
  const pairing = useStrap((s) => s.pairing);
  const candidates = useStrap((s) => s.candidates);
  const error = useStrap((s) => s.error);
  const actions = useStrapActions();

  const paired = saved !== null;
  useEffect(() => {
    if (!paired) actions.startPairing();
    return actions.stopPairing;
  }, [actions, paired]);

  const connected = phase === 'connected';
  const [label, color] = paired
    ? PILL[phase]
    : pairing
      ? PILL.searching
      : PILL.idle;
  const footer = saved ? (
    <>
      {phase === 'idle' && <UiButton variant="outline" color={Neon.cyan} label="Procurar a cinta" onPress={actions.retry} />}
      <UiButton variant="ghost" icon="x" label="Esquecer cinta" onPress={actions.forget} />
    </>
  ) : pairing ? undefined : (
    <UiButton
      variant="outline"
      color={Neon.cyan}
      icon="refresh-cw"
      label="Procurar de novo"
      onPress={actions.startPairing}
    />
  );

  return (
    <WorkoutPage title="Cinta" accessory={<StatusPill label={label} color={color} />} footer={footer}>
      {saved ? (
        <>
          <Card hero accent={Metric.heart} style={local.hero}>
            <View style={local.head}>
              <Kicker color={Metric.heart}>Cinta pareada</Kicker>
              <Text style={local.name} numberOfLines={1}>
                {saved.name ?? 'Cinta pareada'}
              </Text>
            </View>
            <View style={local.dial}>
              <Svg style={local.trace} width="100%" height={60} viewBox="0 0 336 60" preserveAspectRatio="none">
                <Path d={TRACE} stroke={Metric.heart} strokeOpacity={connected ? 0.55 : 0.2} strokeWidth={2} fill="none" />
              </Svg>
              <Rings size={224} color={Metric.heart}>
                <View style={local.kicker}>
                  <Lucide name="heart-pulse" size={13} color={Metric.heart} />
                  <Kicker>Agora</Kicker>
                </View>
                <View
                  style={local.reading}
                  accessible
                  accessibilityLiveRegion="polite"
                  accessibilityLabel={
                    connected && bpm !== null ? bpm + ' batimentos por minuto' : 'Sem leitura'
                  }>
                  {connected && bpm !== null ? (
                    <Text style={[local.bpm, neonGlow(Metric.heart, 26, 0.6)]}>{bpm}</Text>
                  ) : (
                    <Text style={[local.bpm, local.noBpm]}>—</Text>
                  )}
                  <Text style={local.unit}>BPM</Text>
                </View>
              </Rings>
            </View>
            {connected ? (
              <View style={local.facts}>
                <Fact icon="battery" value={battery !== null ? battery + '%' : '—'} label="Bateria" />
                <View style={local.rule} />
                <Fact icon="timer" value="1 por segundo" label="Leitura" />
              </View>
            ) : (
              <Text style={[styles.body, local.centered]} accessibilityLiveRegion="polite">
                {STATUS[phase]}
              </Text>
            )}
            {connected && bpm === null && (
              <Text style={styles.body}>
                A cinta conectou, mas ainda não mandou leitura. Ajuste-a no peito e umedeça os
                eletrodos.
              </Text>
            )}
          </Card>
          {connected && xoss && <XossDiagnostics xoss={xoss} battery={battery} />}
          <Card style={local.list}>
            <Kicker>Com a cinta no peito</Kicker>
            {WITH_STRAP.map((line) => (
              <View key={line} style={local.bullet}>
                <Lucide name="check" size={15} color={Neon.mint} style={local.check} />
                <Text style={local.bulletText}>{line}</Text>
              </View>
            ))}
          </Card>
        </>
      ) : (
        <>
          <Card hero accent={Metric.heart} style={[local.hero, local.search]}>
            <Rings size={150} color={Metric.heart}>
              <View style={[local.beacon, pairing && local.beaconOn]} />
            </Rings>
            <View style={local.searchText}>
              <Kicker color={Metric.heart}>Pareamento</Kicker>
              <Text style={local.title} accessibilityLiveRegion="polite">
                {pairing ? 'Procurando cintas…' : candidates.length ? 'Cintas encontradas' : 'Nenhuma cinta por perto'}
              </Text>
              <Text style={[styles.body, local.centered]}>
                Vista a cinta antes de procurar: a maioria só liga o Bluetooth em contato com a
                pele.
              </Text>
            </View>
          </Card>
          <Card style={local.list}>
            {!!candidates.length && <Kicker>Cintas encontradas</Kicker>}
            {candidates.map((found) => (
              <Pressable
                key={found.id}
                accessibilityRole="button"
                accessibilityLabel={'Parear com ' + (found.name ?? 'monitor sem nome')}
                style={({ pressed }) => [local.candidate, pressed && local.pressed]}
                onPress={() => actions.choose(found.id)}>
                <IconBadge icon="heart" color={Metric.heart} />
                <Text style={local.candidateName} numberOfLines={1}>
                  {found.name ?? 'Monitor sem nome'}
                </Text>
                <Text style={local.cta}>Parear</Text>
                <Lucide name="chevron-right" size={16} color={Neon.volt} />
              </Pressable>
            ))}
            <Text style={local.note}>
              Serve qualquer monitor que use o perfil padrão de frequência cardíaca do Bluetooth.
              Sem a cinta, ou se a conexão dela cair, valem os batimentos do sensor de mão da
              esteira.
            </Text>
          </Card>
        </>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
    </WorkoutPage>
  );
}

/**
 * O protocolo da XOSS X2 Pro, para conferir no aparelho sem treino: o que a
 * cinta respondeu por último a cada consulta.
 */
function XossDiagnostics({ xoss, battery }: { xoss: XossStatus; battery: number | null }) {
  const rows: [string, string][] = [
    ['Modelo', xoss.model],
    [
      'Cadência ao vivo',
      xoss.cadence ? xoss.cadence.spm + ' passos/min · ' + xoss.cadence.steps + ' passos' : '—',
    ],
    ['Memória livre', xoss.space ? xoss.space.freeKb + ' de ' + xoss.space.totalKb + ' kB' : '—'],
    [
      'Gravação',
      xoss.recording === null
        ? '—'
        : xoss.recording
          ? xoss.ownRecording
            ? 'Em curso, do app'
            : 'Em curso, fora do app'
          : 'Nenhuma',
    ],
    [
      'Alerta de FC',
      xoss.alertBpm === undefined ? '—' : xoss.alertBpm !== null ? xoss.alertBpm + ' BPM' : 'Desligado',
    ],
    ['Bateria', battery !== null ? battery + '%' : '—'],
    [
      'Último download',
      xoss.lastDownload
        ? xoss.lastDownload.file +
          ' · ' +
          (xoss.lastDownload.ok ? xoss.lastDownload.bytes + ' bytes' : 'falhou') +
          ' em ' +
          (xoss.lastDownload.ms / 1000).toFixed(1).replace('.', ',') +
          ' s'
        : '—',
    ],
  ];
  return (
    <Card style={local.list}>
      <Kicker>Protocolo da X2 Pro{xoss.transferring ? ' · transferindo' : ''}</Kicker>
      {rows.map(([label, value]) => (
        <View key={label} style={local.row} accessible accessibilityLabel={label + ': ' + value}>
          <Text style={local.factLabel}>{label}</Text>
          <Text style={local.rowValue}>{value}</Text>
        </View>
      ))}
    </Card>
  );
}

function Fact({ icon, value, label }: { icon: 'battery' | 'timer'; value: string; label: string }) {
  return (
    <View style={local.fact} accessible accessibilityLabel={label + ': ' + value}>
      <View style={local.kicker}>
        <Lucide name={icon} size={14} color={Colors.dark.textSecondary} />
        <Text style={local.factValue}>{value}</Text>
      </View>
      <Text style={local.factLabel}>{label}</Text>
    </View>
  );
}

const local = StyleSheet.create({
  hero: { padding: 18, gap: 14 },
  head: { gap: 2 },
  name: { ...TitleType, fontSize: 30, lineHeight: 34, color: Colors.dark.text },
  dial: { alignItems: 'center', justifyContent: 'center' },
  trace: { position: 'absolute', left: 0, right: 0, bottom: 20 },
  kicker: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  reading: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  bpm: { ...NumeralType, fontSize: 100, lineHeight: 100, color: Colors.dark.text },
  // Sem leitura, um traço apagado no lugar do número.
  noBpm: { color: Colors.dark.textMuted },
  unit: { ...NumeralType, fontSize: 18, lineHeight: 20, paddingBottom: 18, color: Colors.dark.textSecondary },
  facts: { flexDirection: 'row', alignItems: 'center' },
  fact: { flex: 1, alignItems: 'center', gap: 2 },
  factValue: { ...NumeralType, fontSize: 22, lineHeight: 26, color: Colors.dark.text },
  factLabel: { fontSize: 12, lineHeight: 16, color: Colors.dark.textSecondary },
  rule: { width: 1, height: 34, backgroundColor: Colors.dark.border },
  row: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  rowValue: { flexShrink: 1, fontSize: 14, lineHeight: 20, color: Colors.dark.text, textAlign: 'right' },
  centered: { textAlign: 'center' },
  list: { gap: 10 },
  bullet: { flexDirection: 'row', gap: 10 },
  check: { marginTop: 3 },
  bulletText: { flex: 1, fontSize: 14, lineHeight: 20, color: Colors.dark.text },
  search: { alignItems: 'center', paddingVertical: 22, gap: 16 },
  beacon: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.dark.textSecondary },
  beaconOn: { backgroundColor: Metric.heart },
  searchText: { alignItems: 'center', gap: 4 },
  title: { ...TitleType, fontSize: 28, lineHeight: 32, color: Colors.dark.text, textAlign: 'center' },
  candidate: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 62,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.dark.border,
  },
  pressed: { opacity: 0.7 },
  candidateName: { flex: 1, fontSize: 16, lineHeight: 20, fontWeight: '500', color: Colors.dark.text },
  cta: { ...TitleType, fontSize: 15, letterSpacing: 1, textTransform: 'uppercase', color: Neon.volt },
  note: { fontSize: 13, lineHeight: 19, color: Colors.dark.textSecondary },
});
