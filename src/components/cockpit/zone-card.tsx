import { Lucide } from '@react-native-vector-icons/lucide';
import { StyleSheet, Text, View } from 'react-native';
import { Card, Kicker } from '@/components/card';
import { Colors, LabelType, Metric, NumeralType, withAlpha } from '@/constants/theme';
import { useTreadmill } from '@/treadmill/treadmill-context';
import { useWorkout } from '@/workouts/context';
import { currentCue, validBpm } from '@/workouts/model';
import { dailyTarget, heartProfile } from '@/workouts/physiology';
import { summarize } from '@/workouts/prompts';
import { heartZones } from '@/workouts/week';

const INSIDE = '#3DE8A0';
const ABOVE = '#FF5B6B';
const NEUTRAL = '#9AA7B8';
// A cor de cada zona, da Z1 à Z5. Cada zona ocupa 10 pontos da FC máxima e a
// mesma altura no gráfico.
const ZONE_COLORS = ['#8FA3BF', Metric.incline, '#3DE8A0', '#FFC24B', '#FF5B6B'];
const ZONES = heartZones.map((zone, i) => ({ ...zone, color: ZONE_COLORS[i] }));
/** Altura mínima de cada zona no gráfico: cabem as duas linhas do rótulo. */
const ZONE_HEIGHT = 26;
const GUTTER = 108;
/** Sem plano, a linha do tempo mostra pelo menos os 45 minutos de um treino da semana. */
const FREE_MINUTES = 45;

/**
 * A frequência cardíaca do treino contra as cinco zonas: uma coluna por minuto
 * da sessão, preenchida à medida que as leituras chegam, com a faixa-alvo de
 * hoje em destaque. O sensor de mão só lê enquanto a pessoa segura, então nem
 * todo minuto tem leitura; os que já passaram sem ela ficam marcados na base.
 */
export function ZoneCard() {
  const profile = useWorkout((s) => s.profile);
  const active = useWorkout((s) => s.active);
  const history = useWorkout((s) => s.history);
  const coach = useWorkout((s) => s.coach);
  const samples = useTreadmill((s) => s.samples);
  const source = useTreadmill((s) => s.mode);
  if (!profile) return null;

  const hr = active?.hr ?? heartProfile(profile, history.filter((w) => w.source === source));
  const plan = active?.plan ?? null;
  const target = dailyTarget(plan, profile, hr);
  const elapsed = Math.floor((active?.totals.movingMs ?? 0) / 1000);
  const now = Math.floor(elapsed / 60);
  const beats = active?.beats ?? [];
  // A última leitura: a dos últimos 2 minutos, que está nas amostras, ou a do registro.
  const logged = beats.findLast(([, count]) => count > 0);
  const bpm =
    samples.findLast((s) => validBpm(s.heartRateBpm))?.heartRateBpm ??
    (logged ? Math.round(logged[0] / logged[1]) : null);

  const bpmAt = (percent: number) => Math.round((hr.max * percent) / 100);
  const floor = hr.max * 0.5;
  // Posição na escala de 50% a 100% da FC máxima.
  const at = (value: number) => Math.min(100, Math.max(0, ((value - floor) / (hr.max - floor)) * 100));
  const zoneOf = (value: number) =>
    ZONES.findLast((zone) => value >= (hr.max * zone.from) / 100) ?? ZONES[0];

  // A faixa-alvo é a dos blocos de esforço: no aquecimento e nas recuperações
  // ficar abaixo dela é o esperado, e a tela não deve sugerir que falta acelerar.
  const easy = !!plan && !!currentCue(plan, elapsed)?.stage.measure;
  const below = bpm !== null && bpm < target.low;
  const color =
    bpm === null || (below && easy)
      ? NEUTRAL
      : bpm > target.high
        ? ABOVE
        : below
          ? Metric.incline
          : INSIDE;
  const status =
    bpm === null
      ? 'Segure o sensor para ler'
      : bpm > target.high
        ? bpm - target.high + ' bpm acima do alvo'
        : below
          ? easy
            ? 'Etapa leve'
            : target.low - bpm + ' bpm abaixo do alvo'
          : 'No alvo';
  const share = active ? summarize(active).zoneSharePercent : null;

  const minutes = plan ? Math.ceil(plan.minutes) : Math.max(FREE_MINUTES, now + 1);
  const columns = Array.from({ length: minutes }, (_, minute) => {
    const [sum, count] = beats[minute] ?? [0, 0];
    return count ? Math.round(sum / count) : null;
  });
  const read = columns.filter((value) => value !== null).length;
  const top = [...ZONES].reverse();

  return (
    <Card padded={false} style={styles.card} accent={Metric.heart}>
      <View style={styles.header}>
        <View style={styles.flex}>
          <View style={styles.kicker}>
            <Lucide name="target" size={13} color={Metric.heart} />
            <Kicker color={Metric.heart}>Alvo de hoje · {target.objective}</Kicker>
          </View>
          <Text style={styles.range}>
            {target.low}–{target.high} <Text style={styles.unit}>BPM</Text>
          </Text>
        </View>
        <View style={styles.right}>
          <View
            style={styles.reading}
            accessible
            accessibilityLabel={'Última leitura: ' + (bpm ?? 'sem dados') + ' BPM. ' + status}>
            <Lucide name="heart-pulse" size={18} color={color} />
            <Text style={[styles.bpm, { color }]}>{bpm ?? '—'}</Text>
            <Text style={styles.unit}>BPM</Text>
          </View>
          <Text style={[styles.status, { color }]}>{status}</Text>
        </View>
      </View>

      <View style={styles.chart}>
        <View style={styles.gutter}>
          {top.map((zone) => (
            <View key={zone.id} style={styles.zoneLabel}>
              <Text style={[styles.zoneName, { color: zone.color }]} numberOfLines={1}>
                {zone.id} · {bpmAt(zone.from)}–{bpmAt(zone.from + 10)}
              </Text>
              <Text style={styles.tiny} numberOfLines={1}>
                {zone.name}
              </Text>
            </View>
          ))}
        </View>
        <View
          style={styles.plot}
          accessible
          accessibilityLabel={
            'Batimentos por zona ao longo de ' + minutes + ' minutos: ' + read + ' minutos com leitura'
          }>
          {top.map((zone) => (
            <View
              key={zone.id}
              style={[
                styles.zoneBand,
                {
                  backgroundColor: withAlpha(zone.color, 0.06),
                  borderColor: withAlpha(zone.color, 0.4),
                },
              ]}
            />
          ))}
          <View
            style={[
              styles.target,
              { bottom: `${at(target.low)}%`, height: `${at(target.high) - at(target.low)}%` },
            ]}>
            <Text style={styles.targetTag}>alvo</Text>
          </View>
          <View style={styles.columns}>
            {columns.map((value, minute) => (
              <View key={minute} style={styles.column}>
                {value !== null ? (
                  <View
                    style={[
                      styles.bar,
                      { height: `${Math.max(3, at(value))}%`, backgroundColor: zoneOf(value).color },
                    ]}
                  />
                ) : minute <= now && active ? (
                  // Minuto já feito sem leitura, ou o minuto em curso.
                  <View style={[styles.stub, minute === now && styles.cursor]} />
                ) : null}
              </View>
            ))}
          </View>
        </View>
      </View>
      <View style={styles.axis}>
        <Text style={styles.small}>0</Text>
        <Text style={styles.small}>
          {share
            ? 'No alvo em ' + share.inside + '% das leituras' + (plan ? ' de esforço' : '')
            : 'Uma coluna por minuto'}
        </Text>
        <Text style={styles.small}>{minutes} min</Text>
      </View>
      {!!coach && <Text style={styles.coach}>{coach}</Text>}
    </Card>
  );
}

const styles = StyleSheet.create({
  // O cartão cresce até o fim da tela, e o gráfico leva a altura que sobrar.
  card: { flexGrow: 1, paddingHorizontal: 16, paddingVertical: 11, gap: 7 },
  header: { flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
  flex: { flex: 1, gap: 2 },
  kicker: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  right: { alignItems: 'flex-end' },
  range: { ...NumeralType, fontSize: 24, lineHeight: 27, color: Colors.dark.text },
  reading: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  bpm: { ...NumeralType, fontSize: 34, lineHeight: 36 },
  unit: { fontSize: 11, color: Colors.dark.textSecondary },
  status: { fontSize: 12, fontWeight: '600' },
  chart: {
    flexGrow: 1,
    flexDirection: 'row',
    minHeight: ZONE_HEIGHT * ZONES.length,
    marginTop: 2,
  },
  gutter: { width: GUTTER },
  zoneLabel: { flex: 1, justifyContent: 'center' },
  zoneName: { ...LabelType, fontSize: 11, letterSpacing: 0.6 },
  tiny: { fontSize: 10, color: Colors.dark.textSecondary },
  plot: { flex: 1 },
  // A linha de cima de cada zona é a fronteira com a zona seguinte.
  zoneBand: { flex: 1, borderTopWidth: 1 },
  target: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderWidth: 1,
    borderRadius: 3,
    borderColor: withAlpha('#FFFFFF', 0.55),
    backgroundColor: withAlpha('#FFFFFF', 0.07),
    alignItems: 'flex-end',
  },
  targetTag: {
    ...LabelType,
    fontSize: 9,
    letterSpacing: 0.8,
    color: withAlpha('#FFFFFF', 0.75),
    paddingHorizontal: 4,
  },
  columns: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 1,
    borderBottomWidth: 1,
    borderColor: Colors.dark.borderStrong,
  },
  column: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  bar: { borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  stub: { height: 3, backgroundColor: withAlpha('#FFFFFF', 0.18) },
  cursor: { height: 9, backgroundColor: Colors.dark.text },
  axis: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingLeft: GUTTER,
  },
  small: { fontSize: 11, color: Colors.dark.textSecondary },
  coach: { fontSize: 13, color: Colors.dark.text },
});
