import { Lucide } from '@react-native-vector-icons/lucide';
import { Redirect, useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Card, Kicker } from '@/components/card';
import { StatusPill, type IconName } from '@/components/kit';
import { UiButton } from '@/components/ui-button';
import { styles, WorkoutPage } from '@/components/workout-ui';
import { ZoneGauge } from '@/components/zones/zone-gauge';
import { ZoneMeter } from '@/components/zones/zone-meter';
import {
  Colors,
  Metric,
  Neon,
  NumeralType,
  TitleType,
  ZoneColors,
  neonGlow,
  withAlpha,
} from '@/constants/theme';
import { useStrap } from '@/heart/strap-context';
import { useTreadmill } from '@/treadmill/treadmill-context';
import { preparePlan, readPlan } from '@/workouts/storage';
import { generatePlan } from '@/workouts/ai';
import { groupStages, structureFacts } from '@/workouts/briefing';
import { useWorkout, useWorkoutSession } from '@/workouts/context';
import { validLoad, type Plan } from '@/workouts/model';
import { aimBand, dailyTarget, heartProfile } from '@/workouts/physiology';
import { sessionMinutes, week, zoneIndexes, zones, zoneSpan } from '@/workouts/week';
import { formatDecimal, formatDuration, formatTrimmed } from '@/utils/format';

// A semana começa na segunda; o domingo, de descanso, fecha a lista.
const DAYS = [1, 2, 3, 4, 5, 6, 0];

export default function Training() {
  const router = useRouter();
  const profile = useWorkout((s) => s.profile);
  const history = useWorkout((s) => s.history);
  const session = useWorkoutSession();
  const source = useTreadmill((s) => (s.phase === 'connected' ? s.mode : 'ble'));
  const connected = useTreadmill((s) => s.phase === 'connected');
  // A leitura da cinta, quando ela está conectada: dá para conferir antes de subir na esteira.
  const strapBpm = useStrap((s) => (s.phase === 'connected' ? s.bpm : null));
  const [today] = useState(() => new Date().getDay());
  // O dia cujo treino será feito: começa em hoje, e a lista da semana deixa trocar.
  const [day, pick] = useState(today);
  const [plan, setPlan] = useState<Plan | null>(() => {
    // Um plano preparado antes do plano semanal não tem faixa própria, e um com
    // alvo entre o teto da caminhada e o começo da corrida é de antes desse teto:
    // nos dois casos vale gerar outro.
    const stored = readPlan(source, profile);
    const invalid = stored?.stages.some((s) => !validLoad(s.speed, s.incline));
    return stored?.zone && !invalid ? stored : null;
  });
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(1);
  const [error, setError] = useState('');
  if (!profile) return <Redirect href="/perfil" />;

  const recent = history.filter((w) => w.source === source);
  const hr = heartProfile(profile, recent);
  const target = plan && dailyTarget(plan, profile, hr);
  const aim = target && aimBand(target, target.objective);
  // Em dia de recuperação a faixa é teto: ninguém busca o alto dela.
  const chasing = !!target && !!aim && aim.low > target.low;
  const chosen = week[day].session;
  const work = plan?.stages.filter((s) => !s.measure) ?? [];
  // A faixa de uma intensidade em BPM, pela FC máxima da pessoa.
  const bandOf = (objective: keyof typeof zones) => {
    const [low, high] = zones[objective].map((p) => Math.round((hr.max * p) / 100));
    return { low, high };
  };
  // A recuperação é um teto ("até"); as outras faixas têm piso e teto.
  const rangeText = (objective: string | undefined, zone: { low: number; high: number }) =>
    objective === 'Recuperação' ? 'até ' + zone.high : zone.low + '–' + zone.high;

  async function generate() {
    if (!profile || !chosen) return;
    setBusy(true);
    setAttempt(1);
    setError('');
    try {
      const generated = await generatePlan(profile, chosen, recent, { onAttempt: setAttempt });
      preparePlan(source, profile, generated);
      setPlan(generated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao preparar o treino.');
    } finally {
      setBusy(false);
    }
  }

  function start() {
    if (!plan) return;
    try {
      if (connected) session.start(plan);
      router.dismissTo('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao iniciar o treino.');
    }
  }

  // A ação principal fica presa no rodapé, sempre à mão e com margem da borda.
  const footer = (
    <>
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {plan ? (
        <>
          <UiButton
            icon={connected ? 'play' : undefined}
            label={connected ? 'Iniciar treino guiado' : 'Conectar esteira para iniciar'}
            onPress={start}
          />
          <UiButton variant="ghost" label="Alterar seleção" onPress={() => setPlan(null)} />
        </>
      ) : (
        <>
          <UiButton
            icon="sparkles"
            label={
              !busy
                ? 'Gerar treino com IA'
                : attempt > 1
                  ? 'Preparando treino… tentativa ' + attempt
                  : 'Preparando treino…'
            }
            busy={busy}
            disabled={!chosen}
            onPress={generate}
          />
          <Text style={local.hint}>
            A IA analisa seu histórico e escolhe só a carga. Pode levar alguns minutos.
          </Text>
        </>
      )}
    </>
  );
  // No alto da tela, o que falta conferir antes de cada passo: a cinta ao
  // escolher o treino, a esteira na hora de iniciar.
  const accessory = plan ? (
    <StatusPill
      color={connected ? Neon.mint : Neon.amber}
      label={connected ? 'Esteira conectada' : 'Esteira desconectada'}
    />
  ) : (
    <StatusPill
      icon="heart"
      color={strapBpm !== null ? Metric.heart : Colors.dark.textSecondary}
      label={strapBpm !== null ? 'Cinta · ' + strapBpm + ' bpm' : 'Cinta'}
      onPress={() => router.push('/cinta')}
    />
  );
  // Os trechos leves do plano têm todos a mesma carga.
  const easy = plan?.stages.find((s) => s.measure);
  // O plano fala em "tiros" no VO₂máx e em "blocos" no limiar.
  const where = work.length > 1 ? (plan?.goal === 'VO₂máx' ? 'nos tiros' : 'nos blocos') : 'no esforço';
  const facts = chosen && structureFacts(chosen);
  const band = chosen && bandOf(chosen.objective);
  const span = chosen && zoneSpan(chosen.objective);
  const top = chosen ? ZoneColors[Math.max(...zoneIndexes(chosen.objective))] : Metric.heart;

  return (
    <WorkoutPage title="Treino do dia" footer={footer} accessory={accessory}>
      {plan && target ? (
        <>
          <Card hero accent={Metric.heart} style={local.hero}>
            <HeroHead icon="sparkles" kicker="Plano da DeepSeek" title={plan.goal} minutes={plan.minutes} />
            <ZoneGauge max={hr.max} band={target} aim={chasing ? aim : null}>
              <Kicker>
                {chasing ? 'Mira ' + where : plan.objective === 'Recuperação' ? 'Teto de hoje' : 'Faixa de hoje'}
              </Kicker>
              <Text style={[local.reading, neonGlow(ZoneColors[4], 20, 0.55)]}>
                {chasing && aim ? aim.low + '–' + aim.high : rangeText(plan.objective, target)}
              </Text>
              <Text style={local.small}>
                {chasing ? 'BPM · o alto da faixa ' + target.low + '–' + target.high : 'BPM'}
              </Text>
            </ZoneGauge>
            <Text style={local.note}>
              {chasing
                ? 'Com a cinta no peito o guia acompanha os batimentos o tempo todo; sem ela, pede as mãos no sensor a cada 3 minutos. Nos blocos de esforço o app ajusta a carga para manter os batimentos perto do teto da faixa.'
                : 'Com a cinta no peito o guia acompanha os batimentos o tempo todo; sem ela, pede as mãos no sensor a cada 3 minutos. O app alivia a carga se eles passarem do teto.'}
            </Text>
          </Card>
          {!connected && (
            <Text style={styles.body}>
              O plano de hoje está salvo neste celular. Abra-o no painel da esteira conectada para
              iniciar.
            </Text>
          )}
          {work[0] && (
            <View style={local.tiles}>
              <LoadTile
                icon="gauge"
                label="Velocidade"
                value={formatDecimal(work[0].speed, 1)}
                unit="km/h"
                color={Metric.speed}
                note={where + (easy ? ' · ' + formatDecimal(easy.speed, 1) + ' nos leves' : '')}
              />
              <LoadTile
                icon="trending-up"
                label="Inclinação"
                value={formatDecimal(work[0].incline, 1)}
                unit="%"
                color={Metric.incline}
                note={where + (easy ? ' · ' + formatTrimmed(easy.incline, 1) + '% nos leves' : '')}
              />
            </View>
          )}
          {!!plan.why && (
            <Card style={local.why}>
              <View style={local.kicker}>
                <Lucide name="sparkles" size={14} color={Neon.volt} />
                <Kicker>Por que essa carga</Kicker>
              </View>
              <Text style={local.whyText}>{plan.why}</Text>
            </Card>
          )}
          <Card style={local.stages}>
            <View style={local.between}>
              <Kicker>Etapas</Kicker>
              <Kicker>{plan.minutes} min</Kicker>
            </View>
            {/* A linha do tempo: a largura de cada trecho é a duração da etapa. */}
            <View style={local.strip} accessible={false}>
              {plan.stages.map((stage, i) => (
                <View
                  key={i}
                  style={[local.stripPart, { flex: stage.seconds }, !stage.measure && local.stripHard]}
                />
              ))}
            </View>
            <View>
              {groupStages(plan.stages).map((group, i) => (
                <View key={i} style={[local.stage, i > 0 && local.divider]}>
                  <Text style={[local.time, group.hard && local.strong]}>
                    {(group.count > 1 ? group.count + ' × ' : '') + formatDuration(group.seconds)}
                  </Text>
                  <Text style={[local.name, local.grow, group.hard && local.bold]} numberOfLines={1}>
                    {group.name}
                  </Text>
                  <Text style={[local.load, group.hard && local.loadHard]}>
                    {formatDecimal(group.speed, 1)} km/h · {formatDecimal(group.incline, 1)}%
                  </Text>
                </View>
              ))}
            </View>
          </Card>
        </>
      ) : (
        <>
          <Card hero accent={Metric.heart} style={local.hero}>
            <HeroHead
              icon="target"
              kicker={(day === today ? 'Hoje · ' : 'No lugar do treino de hoje · ') + week[day].day}
              title={chosen ? chosen.title : 'Descanso'}
              minutes={chosen ? sessionMinutes(chosen) : null}
            />
            {chosen && facts && band && span ? (
              <>
                <ZoneGauge max={hr.max} band={band}>
                  <Kicker>{facts.label}</Kicker>
                  <Text style={[local.reading, neonGlow(top, 20, 0.55)]}>
                    {rangeText(chosen.objective, band)}
                  </Text>
                  <Text style={local.small}>
                    BPM ·{' '}
                    {chosen.objective === 'Recuperação'
                      ? 'abaixo de ' + zones[chosen.objective][1] + '%'
                      : zones[chosen.objective].join('–') + '%'}{' '}
                    da FC máxima
                  </Text>
                </ZoneGauge>
                <View style={local.facts}>
                  <Fact value={span.ids} label={'Esforço ' + span.feel} color={top} />
                  {facts.facts.map(([value, label]) => (
                    <Fact key={label} value={value} label={label} divided />
                  ))}
                </View>
                <Text style={local.note}>{facts.note}</Text>
              </>
            ) : (
              <Text style={styles.body}>
                Domingo é o dia de descanso do seu plano. Se quiser treinar mesmo assim, toque em
                um dia da semana abaixo.
              </Text>
            )}
          </Card>
          <Card padded={false} style={local.week}>
            <View style={[local.between, local.weekHead]}>
              <Kicker>Plano semanal</Kicker>
              <Kicker>Zona</Kicker>
            </View>
            {DAYS.map((index) => {
              const entry = week[index];
              const selected = index === day;
              return (
                <Pressable
                  key={index}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected, disabled: busy || !entry.session }}
                  disabled={busy || !entry.session}
                  onPress={() => pick(index)}
                  style={[local.day, selected && local.daySelected]}>
                  <Text style={[local.dayName, selected && local.picked]}>{entry.day.slice(0, 3)}</Text>
                  <View style={local.grow}>
                    <Text style={[local.name, local.medium, !entry.session && local.muted]}>
                      {entry.session?.title ?? 'Descanso'}
                      {index === today ? ' · hoje' : ''}
                    </Text>
                    {!!entry.session && <Text style={local.side}>{entry.session.percent}</Text>}
                  </View>
                  <ZoneMeter lit={entry.session ? zoneIndexes(entry.session.objective) : []} />
                  <Text style={[local.zone, !entry.session && local.muted]}>
                    {entry.session ? zoneSpan(entry.session.objective).ids.replace('–Z', '–') : '—'}
                  </Text>
                </Pressable>
              );
            })}
          </Card>
          <Text style={[styles.body, local.centered]}>
            Cada treino tem 45 minutos. Para fazer hoje o treino de outro dia, toque nele.
          </Text>
        </>
      )}
      {!!error && (
        <UiButton variant="ghost" label="Abrir perfil" onPress={() => router.push('/perfil')} />
      )}
    </WorkoutPage>
  );
}

/** O alto do cartão principal: de onde vem o treino, o nome dele e a duração. */
function HeroHead({
  icon,
  kicker,
  title,
  minutes,
}: {
  icon: IconName;
  kicker: string;
  title: string;
  minutes: number | null;
}) {
  return (
    <View style={local.heroHead}>
      <View style={local.grow}>
        <View style={local.kicker}>
          <Lucide name={icon} size={13} color={Metric.heart} />
          <Kicker color={Metric.heart}>{kicker}</Kicker>
        </View>
        <Text style={local.title} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.6}>
          {title}
        </Text>
      </View>
      {minutes !== null && (
        <View style={local.minutes}>
          <Lucide name="clock" size={14} color={Colors.dark.textSecondary} />
          <Text style={local.minutesText}>{minutes} min</Text>
        </View>
      )}
    </View>
  );
}

function Fact({
  value,
  label,
  color = Colors.dark.text,
  divided = false,
}: {
  value: string;
  label: string;
  color?: string;
  divided?: boolean;
}) {
  return (
    <View
      style={[local.fact, divided && local.factDivided]}
      accessible
      accessibilityLabel={label + ': ' + value}>
      <Text style={[local.factValue, { color }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={local.side}>{label}</Text>
    </View>
  );
}

/** A carga que o guia vai pedir nos blocos de esforço, na cor da grandeza. */
function LoadTile({
  icon,
  label,
  value,
  unit,
  color,
  note,
}: {
  icon: IconName;
  label: string;
  value: string;
  unit: string;
  color: string;
  note: ReactNode;
}) {
  return (
    <Card accent={color} style={local.tile}>
      <View style={local.kicker}>
        <Lucide name={icon} size={13} color={color} />
        <Kicker>{label}</Kicker>
      </View>
      <View style={local.tileValue} accessible accessibilityLabel={label + ' ' + value + ' ' + unit}>
        <Text style={[local.tileNumber, { color }, neonGlow(color, 18, 0.35)]}>{value}</Text>
        <Text style={local.tileUnit}>{unit}</Text>
      </View>
      <Text style={local.side}>{note}</Text>
    </Card>
  );
}

const local = StyleSheet.create({
  grow: { flex: 1, gap: 2 },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  kicker: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  hint: { fontSize: 12, lineHeight: 16, textAlign: 'center', color: Colors.dark.textSecondary },
  centered: { textAlign: 'center', fontSize: 13, lineHeight: 18 },
  hero: { padding: 18, gap: 12 },
  heroHead: { flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
  title: { ...TitleType, fontSize: 42, lineHeight: 44, color: Colors.dark.text },
  minutes: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingBottom: 7 },
  minutesText: { ...NumeralType, fontSize: 20, color: Colors.dark.text },
  reading: { ...NumeralType, fontSize: 56, lineHeight: 60, color: Colors.dark.text },
  small: { fontSize: 12, lineHeight: 16, color: Colors.dark.textSecondary },
  note: { fontSize: 13, lineHeight: 19, color: Colors.dark.textSecondary },
  facts: { flexDirection: 'row' },
  fact: { flex: 1, gap: 2 },
  factDivided: { borderLeftWidth: 1, borderColor: Colors.dark.border, paddingLeft: 14 },
  factValue: { ...NumeralType, fontSize: 24, lineHeight: 27 },
  side: { fontSize: 12, lineHeight: 16, color: Colors.dark.textSecondary },
  week: { padding: 8, gap: 2 },
  weekHead: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6 },
  day: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  daySelected: { borderColor: withAlpha(Neon.volt, 0.45), backgroundColor: withAlpha(Neon.volt, 0.08) },
  dayName: {
    width: 30,
    fontFamily: NumeralType.fontFamily,
    fontSize: 13,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: Colors.dark.textSecondary,
  },
  picked: { color: Neon.volt },
  name: { fontSize: 15, lineHeight: 20, color: Colors.dark.text },
  medium: { fontWeight: '500' },
  bold: { fontWeight: '700' },
  muted: { color: Colors.dark.textSecondary },
  zone: { ...NumeralType, width: 38, textAlign: 'right', fontSize: 15, color: Colors.dark.text },
  tiles: { flexDirection: 'row', gap: 10 },
  tile: { flex: 1, padding: 14, gap: 6 },
  tileValue: { flexDirection: 'row', alignItems: 'baseline', gap: 5 },
  tileNumber: { ...NumeralType, fontSize: 44, lineHeight: 46 },
  tileUnit: { ...NumeralType, fontSize: 17, color: Colors.dark.textSecondary },
  why: { gap: 8 },
  whyText: { fontSize: 14, lineHeight: 21, color: Colors.dark.text },
  stages: { gap: 10, paddingBottom: 6 },
  strip: { flexDirection: 'row', gap: 2 },
  stripPart: { height: 10, borderRadius: 3, backgroundColor: Colors.dark.borderStrong },
  stripHard: { backgroundColor: Neon.volt },
  stage: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  divider: { borderTopWidth: 1, borderColor: Colors.dark.border },
  time: { ...NumeralType, width: 66, fontSize: 17, color: Colors.dark.textSecondary },
  strong: { color: Colors.dark.text },
  load: { ...NumeralType, fontSize: 16, color: Colors.dark.textSecondary },
  loadHard: { color: Neon.volt },
});
