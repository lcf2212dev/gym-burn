import { Lucide } from '@react-native-vector-icons/lucide';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Card, Kicker } from '@/components/card';
import { ZoneGauge } from '@/components/zones/zone-gauge';
import { Colors, Metric, Neon, NumeralType, ZoneColors, neonGlow, withAlpha } from '@/constants/theme';
import { useTreadmill } from '@/treadmill/treadmill-context';
import { heartStatus, type HeartTone } from '@/workouts/briefing';
import { useWorkout } from '@/workouts/context';
import { currentCue, validBpm } from '@/workouts/model';
import { aimBand, dailyTarget, heartProfile } from '@/workouts/physiology';
import { summarize } from '@/workouts/prompts';
import { heartZones } from '@/workouts/week';

/** A cor da leitura: verde no alvo, ciano abaixo dele, vermelho acima. */
const TONES: Record<HeartTone, string> = {
  neutral: Colors.dark.textSecondary,
  inside: Neon.mint,
  below: Metric.incline,
  above: ZoneColors[4],
};
/** Sem plano, a linha do tempo mostra pelo menos os 45 minutos de um treino da semana. */
const FREE_MINUTES = 45;

/**
 * A frequência cardíaca do treino contra a faixa do dia: a última leitura, o
 * que ela diz do alvo e a média de cada minuto da sessão. O sensor de mão só
 * lê enquanto a pessoa segura, então nem todo minuto tem leitura.
 */
function useHeart() {
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
  // A faixa-alvo é a dos blocos de esforço: no aquecimento e nas recuperações
  // ficar abaixo dela é o esperado, e a tela não deve sugerir que falta acelerar.
  const easy = !!plan && !!currentCue(plan, elapsed)?.stage.measure;
  const aim = aimBand(target, target.objective);
  // Nos blocos de esforço do treino guiado o alvo é o alto da faixa.
  const chasing = !!plan && aim.low > target.low;
  const status = heartStatus({ bpm, target, aimLow: aim.low, chasing, easy });
  const share = active ? summarize(active).zoneSharePercent : null;
  const minutes = plan ? Math.ceil(plan.minutes) : Math.max(FREE_MINUTES, now + 1);
  const columns = Array.from({ length: minutes }, (_, minute) => {
    const [sum, count] = beats[minute] ?? [0, 0];
    return count ? Math.round(sum / count) : null;
  });
  return { hr, plan, target, aim, chasing, bpm, status, share, minutes, columns, now, active, coach };
}

/**
 * O medidor do treino: a leitura de agora no centro, a seta sobre o arco das
 * zonas e a faixa do dia acesa, com a mira num vermelho mais vivo.
 */
export function ZoneCard() {
  const heart = useHeart();
  const strap = useTreadmill((s) => s.metrics.heartRateSource === 'strap');
  // Numa tela baixa o arco encolhe, para o painel inteiro caber sem rolar.
  const compact = useWindowDimensions().height < 900;
  if (!heart) return null;
  const { hr, target, aim, chasing, bpm, status } = heart;
  const color = TONES[status.tone];
  return (
    <Card padded={false} style={styles.gauge} accent={Metric.heart}>
      <ZoneGauge
        max={hr.max}
        band={target}
        aim={chasing ? aim : null}
        bpm={bpm}
        tone={color}
        maxWidth={compact ? 310 : 360}
        caption={
          'Faixa ' +
          target.low +
          '–' +
          target.high +
          (chasing ? ' · mira ' + aim.low + '–' + aim.high : '')
        }>
        <View
          style={styles.center}
          accessible
          accessibilityLabel={'Última leitura: ' + (bpm ?? 'sem dados') + ' BPM. ' + status.text}>
          <View style={styles.kicker}>
            <Lucide name="heart-pulse" size={13} color={Metric.heart} />
            {/* O rótulo diz de onde vem o número: da cinta no peito ou do sensor de mão.
                É curto para não encostar nos rótulos das zonas, dentro do arco. */}
            <Kicker>{strap ? 'Cinta' : 'Sensor'}</Kicker>
          </View>
          <View style={styles.reading}>
            <Text style={[styles.bpm, neonGlow(ZoneColors[4], 26, 0.55)]}>{bpm ?? '—'}</Text>
            <Text style={styles.unit}>BPM</Text>
          </View>
          <Text style={[styles.status, { color }]}>{status.text}</Text>
        </View>
      </ZoneGauge>
    </Card>
  );
}

/**
 * Uma coluna por minuto da sessão, na cor da zona em que a média do minuto
 * caiu, com a faixa do dia ao fundo. Os minutos já feitos sem leitura ficam
 * marcados na base. O cartão cresce até o fim da tela.
 */
export function MinuteChart() {
  const heart = useHeart();
  if (!heart) return null;
  const { hr, plan, target, share, minutes, columns, now, active, coach } = heart;
  const floor = hr.max * 0.5;
  // Posição na escala de 50% a 100% da FC máxima.
  const at = (value: number) => Math.min(100, Math.max(0, ((value - floor) / (hr.max - floor)) * 100));
  const zoneOf = (value: number) =>
    Math.max(0, heartZones.findLastIndex((zone) => value >= (hr.max * zone.from) / 100));
  const read = columns.filter((value) => value !== null).length;
  return (
    <Card padded={false} style={styles.chart}>
      <View style={styles.header}>
        <Kicker>Batimentos por minuto</Kicker>
        <Text style={styles.small}>
          {share
            ? 'no alvo em ' + share.inside + '% ' + (plan ? 'do esforço' : 'das leituras')
            : 'uma coluna por minuto'}
        </Text>
      </View>
      <View
        style={styles.plot}
        accessible
        accessibilityLabel={
          'Batimentos por zona ao longo de ' + minutes + ' minutos: ' + read + ' minutos com leitura'
        }>
        <View
          style={[
            styles.target,
            { bottom: `${at(target.low)}%`, height: `${at(target.high) - at(target.low)}%` },
          ]}
        />
        <View style={styles.columns}>
          {columns.map((value, minute) => (
            <View key={minute} style={styles.column}>
              {value !== null ? (
                <View
                  style={[
                    styles.bar,
                    { height: `${Math.max(3, at(value))}%`, backgroundColor: ZoneColors[zoneOf(value)] },
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
      <View style={styles.header}>
        <Text style={styles.small}>0</Text>
        {/* O que o guia acabou de decidir vai no eixo, entre os dois extremos. */}
        {!!coach && (
          <Text style={styles.coach} numberOfLines={1}>
            {coach}
          </Text>
        )}
        <Text style={styles.small}>{minutes} min</Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  gauge: { paddingHorizontal: 8, paddingTop: 2, paddingBottom: 8 },
  center: { alignItems: 'center' },
  kicker: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  reading: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  bpm: { ...NumeralType, fontSize: 86, lineHeight: 86, color: Colors.dark.text },
  unit: { ...NumeralType, fontSize: 18, lineHeight: 20, paddingBottom: 14, color: Colors.dark.textSecondary },
  status: { fontSize: 14, lineHeight: 18, fontWeight: '600' },
  // O cartão cresce até o fim da tela, e o gráfico leva a altura que sobrar.
  chart: { flexGrow: 1, paddingHorizontal: 16, paddingVertical: 10, gap: 6 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  small: { fontSize: 12, lineHeight: 16, color: Colors.dark.textSecondary },
  plot: { flexGrow: 1, minHeight: 72 },
  target: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderRadius: 2,
    backgroundColor: withAlpha(Metric.heart, 0.22),
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
  coach: { flex: 1, textAlign: 'center', fontSize: 12, lineHeight: 16, color: Colors.dark.text },
});
