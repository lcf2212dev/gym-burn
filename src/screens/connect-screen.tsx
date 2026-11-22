import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { ScannedDevice } from '@/ble/transport';
import type { Notice } from '@/treadmill/types';

import { AmbientGlow } from '@/components/ambient-glow';
import { BrandMark } from '@/components/brand-mark';
import { Card } from '@/components/card';
import { DeviceRow } from '@/components/device-row';
import { IconBadge, StatusPill, type IconName } from '@/components/kit';
import { NoticeBanner } from '@/components/notice-banner';
import { Pill } from '@/components/pill';
import { SectionLabel } from '@/components/section-label';
import { Surface } from '@/components/surface';
import { UiButton } from '@/components/ui-button';
import {
  BodyType,
  Glass,
  LabelType,
  Metric,
  MaxContentWidth,
  Neon,
  Spacing,
  TitleType,
  withAlpha,
} from '@/constants/theme';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { looksLikeMatrixConsole } from '@/treadmill/t600x';
import { useTheme } from '@/hooks/use-theme';
import { useStrap } from '@/heart/strap-context';
import { useTreadmill, useTreadmillActions } from '@/treadmill/treadmill-context';
import { todayLine } from '@/workouts/briefing';
import { useWorkout } from '@/workouts/context';

/** Diâmetro do radar: cabe na largura de 360dp com o cartão e as margens. */
const RADAR_SIZE = 168;
/** Duração de uma onda do radar, do centro até a borda. */
const PULSE_MS = 2000;
/** Anéis estáticos, do externo para o interno (fração do diâmetro). */
const RADAR_RINGS = [1, 0.72, 0.46] as const;

/**
 * Abertura do app: procura esteiras sozinha, mostra as que aparecem e conecta
 * no toque. Nada aqui comanda a esteira — o painel continua sendo o comando, e
 * a tela diz isso em uma frase.
 *
 * O toque longo na marca abre a esteira simulada (atalho de demonstração, sem
 * texto na tela).
 */
export function ConnectScreen() {
  const router = useRouter();
  const theme = useTheme();
  const scan = useTreadmill((s) => s.scan);
  const devices = useTreadmill((s) => s.devices);
  const phase = useTreadmill((s) => s.phase);
  const device = useTreadmill((s) => s.device);
  const notice = useTreadmill((s) => s.notice);
  const actions = useTreadmillActions();

  // Só interessa o que pode ser esteira: quem anuncia o perfil FTMS ou se
  // apresenta como console Matrix/Vision. Todo celular, fone e relógio por
  // perto também anuncia BLE; mostrar tudo enterraria a esteira na lista.
  const candidates = devices.filter(
    (found) => found.advertisesFtms || looksLikeMatrixConsole(found.name),
  );

  // A sessão ordena a lista pelo RSSI a cada anúncio, e o sinal oscila: o item
  // fugiria debaixo do dedo. Aqui a ordem é estável (FTMS primeiro, depois id),
  // então o alvo do toque não se mexe enquanto o usuário decide.
  const visibleDevices = [...candidates].sort(compareDevices);

  // A busca começa uma única vez ao abrir; depois disso quem decide é o botão
  // "Procurar de novo" (ou o toque longo, no modo demonstração).
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;
    if (scan === 'idle' && phase === 'idle') {
      actions.startScan();
    }
  }, [actions, phase, scan]);

  // O dia de abertura da tela, para a linha do treino de hoje no rodapé.
  const [today] = useState(() => new Date().getDay());
  const version = Constants.expoConfig?.version ?? null;
  const footnote = (version ? 'versão ' + version : 'gym burn') + ' · somente leitura';
  const scanning = scan !== 'idle';
  const connecting = phase === 'connecting';
  const connectingName = device?.name ?? null;
  const hasFtms = visibleDevices.some((found) => found.advertisesFtms);

  // O aviso informativo da busca ("nenhuma esteira") é repetido pelo estado
  // vazio abaixo; a faixa fica para erro, atenção e sucesso.
  const bannerNotice: Notice | null = notice && notice.kind !== 'info' ? notice : null;

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safe, { backgroundColor: theme.background }]}>
      <AmbientGlow colors={[Neon.cyan, Neon.violet]} intensity={0.6} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        <View style={styles.content}>
          <View style={styles.header}>
            <View style={styles.brand}>
              <Pressable
                onLongPress={actions.openDemo}
                delayLongPress={700}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Gym Burn"
                accessibilityHint="Toque longo abre o modo demonstração">
                <BrandMark size="md" subtitle="monitor de esteira" />
              </Pressable>
              <StatusPill
                icon="bluetooth"
                color={connecting ? Neon.volt : scanning ? Neon.cyan : theme.textSecondary}
                label={connecting ? 'Conectando' : scanning ? 'Procurando' : 'Busca parada'}
              />
            </View>
            <Text style={[styles.title, TitleType, { color: theme.text }]} accessibilityRole="header">
              Encontre sua esteira
            </Text>
            <Text style={[styles.subtitle, BodyType, { color: theme.textSecondary }]}>
              O app lê a esteira. Quem comanda é você, no painel.
            </Text>
          </View>

          <NoticeBanner notice={bannerNotice} onDismiss={actions.dismissNotice} />

          {connecting ? (
            <ScanStage
              title={connectingName ?? 'Conectando'}
              detail="Conectando e lendo os dados da esteira. Mantenha o celular perto do painel."
              color={Neon.volt}
              active
            />
          ) : visibleDevices.length === 0 ? (
            <ScanStage
              title={scan === 'starting' ? 'Preparando o Bluetooth' : scanning ? 'Procurando esteiras' : 'Nenhuma esteira por perto'}
              detail={
                scanning
                  ? 'Deixe o celular perto do painel. A esteira precisa estar no modo APP.'
                  : 'Confira se o painel está no modo APP e se o Bluetooth do celular está ligado.'
              }
              color={Neon.cyan}
              active={scanning}
              action={scanning ? undefined : { label: 'Procurar de novo', onPress: actions.startScan }}
            />
          ) : (
            <Card accent={Neon.cyan} style={styles.devices}>
              <SectionLabel
                label="Esteiras encontradas"
                accent={Neon.cyan}
                right={scanning ? <Pill label="Procurando" tone="cyan" dot size="sm" /> : null}
              />
              <View style={styles.listStatus}>
                {/* Radar compacto: a busca continua mesmo com a lista na tela. */}
                {scanning ? <Radar color={Neon.cyan} active size={44} /> : null}
                <Text
                  style={[styles.listHint, BodyType, { color: theme.textSecondary }]}
                  accessibilityLiveRegion="polite">
                  {visibleDevices.length === 1
                    ? '1 esteira por perto. Toque no nome dela para conectar.'
                    : `${visibleDevices.length} esteiras por perto. Toque no nome da sua para conectar.`}
                </Text>
              </View>
              <View style={styles.list}>
                {visibleDevices.map((found) => (
                  <DeviceRow
                    key={found.id}
                    device={found}
                    connecting={connecting && found.id === device?.id}
                    disabled={connecting}
                    onConnect={actions.connect}
                  />
                ))}
              </View>
              {hasFtms ? null : (
                <Text style={[styles.warning, BodyType, { color: theme.noticeWarning }]}>
                  Nenhuma delas anuncia FTMS. Confirme se o painel está no modo APP.
                </Text>
              )}
              {scanning ? null : (
                <UiButton
                  variant="ghost"
                  label="Procurar de novo"
                  onPress={actions.startScan}
                  style={styles.rescan}
                />
              )}
            </Card>
          )}
          <Shortcuts />

          <Text style={[styles.footnote, LabelType, { color: theme.textMuted }]}>{footnote}</Text>
        </View>
      </ScrollView>
      {/* A ação principal fica presa no rodapé, com o treino de hoje embaixo. */}
      <View style={[styles.actions, { borderColor: theme.border }]}>
        <UiButton icon="target" label="Treino do dia" onPress={() => router.push('/treino')} />
        <Text style={[styles.today, { color: theme.textSecondary }]}>{todayLine(today)}</Text>
      </View>
    </SafeAreaView>
  );
}

/**
 * Os atalhos da tela inicial, cada um com o resumo do que há lá dentro: o
 * perfil, o último nível da IA, a cinta e a prévia do painel.
 */
function Shortcuts() {
  const router = useRouter();
  const theme = useTheme();
  const profile = useWorkout((s) => s.profile);
  const history = useWorkout((s) => s.history);
  const strap = useStrap((s) => s.saved);
  const bpm = useStrap((s) => (s.phase === 'connected' ? s.bpm : null));
  const real = history.filter((w) => w.source === 'ble');
  const level = real.find((w) => w.estimate && w.estimate.level !== 'Dados insuficientes')?.estimate
    ?.level;
  const items: {
    icon: IconName;
    label: string;
    sub: string;
    color: string;
    href: '/perfil' | '/evolucao' | '/cinta' | '/previa';
  }[] = [
    {
      icon: 'user',
      label: 'Perfil',
      sub: profile
        ? profile.age + ' anos · ' + String(profile.weightKg).replace('.', ',') + ' kg'
        : 'Informe seus dados',
      color: Neon.cyan,
      href: '/perfil',
    },
    {
      icon: 'trending-up',
      label: 'Evolução',
      sub:
        level ??
        (real.length ? real.length + (real.length === 1 ? ' treino' : ' treinos') : 'Nenhum treino ainda'),
      color: Neon.violet,
      href: '/evolucao',
    },
    {
      icon: 'heart',
      label: 'Cinta',
      sub: strap ? (bpm !== null ? bpm + ' bpm agora' : (strap.name ?? 'Pareada')) : 'Nenhuma pareada',
      color: Metric.heart,
      href: '/cinta',
    },
    { icon: 'eye', label: 'Prévia', sub: 'Painel simulado', color: Neon.amber, href: '/previa' },
  ];
  return (
    <View style={styles.shortcuts}>
      {items.map((item) => (
        <Pressable
          key={item.href}
          accessibilityRole="button"
          accessibilityLabel={item.label + '. ' + item.sub}
          onPress={() => router.push(item.href)}
          style={({ pressed }) => [styles.shortcut, pressed && styles.pressed]}>
          <IconBadge icon={item.icon} color={item.color} size={36} />
          <View style={styles.shortcutText}>
            <Text style={[styles.shortcutLabel, TitleType, { color: theme.text }]}>{item.label}</Text>
            <Text style={[styles.shortcutSub, { color: theme.textSecondary }]} numberOfLines={1}>
              {item.sub}
            </Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

interface ScanStageProps {
  title: string;
  detail: string;
  color: string;
  active: boolean;
  action?: { label: string; onPress: () => void };
}

/**
 * Ordem estável de exibição: quem anuncia FTMS primeiro (é a esteira) e, dentro
 * de cada grupo, por endereço. Não usa o RSSI de propósito.
 */
function compareDevices(a: ScannedDevice, b: ScannedDevice): number {
  if (a.advertisesFtms !== b.advertisesFtms) {
    return a.advertisesFtms ? -1 : 1;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

/**
 * O palco da busca: radar, o que está acontecendo e, se parado, o botão. Ocupa
 * a altura que sobra da tela, com o conteúdo no centro.
 */
function ScanStage({ title, detail, color, active, action }: ScanStageProps) {
  const theme = useTheme();

  return (
    <Surface tone="hero" glow={active ? color : null} style={styles.stage}>
      <Radar color={color} active={active} size={RADAR_SIZE} />
      <Text
        style={[styles.stageTitle, TitleType, { color: theme.text }]}
        accessibilityRole="header"
        accessibilityLiveRegion="polite">
        {title}
      </Text>
      <Text style={[styles.stageDetail, BodyType, { color: theme.textSecondary }]}>{detail}</Text>
      {action ? (
        <UiButton
          label={action.label}
          onPress={action.onPress}
          style={styles.stageAction}
          accessibilityLabel="Procurar esteiras de novo"
        />
      ) : null}
    </Surface>
  );
}

/**
 * Radar desenhado só com Views: anéis concêntricos, eixos e duas ondas que
 * nascem no centro e morrem na borda. A onda anima escala e opacidade — as duas
 * propriedades que o driver nativo do Animated aceita sem passar pelo JS.
 */
function Radar({ color, active, size }: { color: string; active: boolean; size: number }) {
  const reducedMotion = useReducedMotion();
  // `useState` com inicializador guarda o valor animado sem ler ref na renderização
  // (o lint do React Compiler recusa `useRef(...).current` aqui).
  const [first] = useState(() => new Animated.Value(0));
  const [second] = useState(() => new Animated.Value(0));
  const animating = active && !reducedMotion;

  useEffect(() => {
    first.setValue(0);
    second.setValue(0);
    if (!animating) {
      return;
    }
    const pulse = (value: Animated.Value) =>
      Animated.loop(
        Animated.timing(value, {
          toValue: 1,
          duration: PULSE_MS,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      );
    const outer = pulse(first);
    const inner = pulse(second);
    outer.start();
    const timer = setTimeout(() => inner.start(), PULSE_MS / 2);
    return () => {
      clearTimeout(timer);
      outer.stop();
      inner.stop();
      first.setValue(0);
      second.setValue(0);
    };
  }, [animating, first, second]);

  const waveStyle = (value: Animated.Value) => ({
    opacity: value.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
    transform: [
      { scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.24, 1] }) },
    ],
  });

  const coreSize = size * 0.44;

  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={[styles.radar, { width: size, height: size }]}>
      {RADAR_RINGS.map((ratio) => {
        const ringSize = size * ratio;
        return (
          <View
            key={ratio}
            style={{
              position: 'absolute',
              width: ringSize,
              height: ringSize,
              left: (size - ringSize) / 2,
              top: (size - ringSize) / 2,
              borderRadius: ringSize / 2,
              borderWidth: 1,
              borderColor: withAlpha(color, 0.1 + (1 - ratio) * 0.16),
            }}
          />
        );
      })}
      {/* Eixos: dão a leitura de instrumento sem poluir. */}
      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: size / 2 - 0.5,
          height: 1,
          backgroundColor: withAlpha(color, 0.07),
        }}
      />
      <View
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: size / 2 - 0.5,
          width: 1,
          backgroundColor: withAlpha(color, 0.07),
        }}
      />
      {animating ? (
        <>
          <Animated.View
            style={[
              styles.wave,
              { width: size, height: size, borderRadius: size / 2, borderColor: color },
              waveStyle(first),
            ]}
          />
          <Animated.View
            style={[
              styles.wave,
              { width: size, height: size, borderRadius: size / 2, borderColor: color },
              waveStyle(second),
            ]}
          />
        </>
      ) : null}
      <View
        style={{
          position: 'absolute',
          width: coreSize,
          height: coreSize,
          left: (size - coreSize) / 2,
          top: (size - coreSize) / 2,
          borderRadius: coreSize / 2,
          backgroundColor: withAlpha(color, 0.05),
          borderWidth: 1,
          borderColor: withAlpha(color, 0.14),
        }}
      />
      <View
        style={{
          position: 'absolute',
          width: 8,
          height: 8,
          left: size / 2 - 4,
          top: size / 2 - 4,
          borderRadius: 4,
          backgroundColor: color,
          boxShadow: `0px 0px 12px 2px ${withAlpha(color, 0.6)}`,
        }}
      />
    </View>
  );
}

/** Anel da onda: só o contorno; a escala cresce do centro para a borda. */
const styles = StyleSheet.create({
  safe: {
    flex: 1,
  },
  // A mesma folga do painel do treino até a área segura de baixo.
  scroll: {
    flexGrow: 1,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
  },
  content: {
    flexGrow: 1,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    gap: Spacing.four,
  },
  header: {
    gap: Spacing.two,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  shortcuts: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  shortcut: {
    flexBasis: '47%',
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 60,
    padding: Spacing.three,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: withAlpha('#FFFFFF', 0.07),
    backgroundColor: Glass.card,
  },
  pressed: { opacity: 0.7 },
  shortcutText: { flex: 1, gap: 1 },
  shortcutLabel: { fontSize: 17, lineHeight: 20, letterSpacing: 0.4 },
  shortcutSub: { fontSize: 12, lineHeight: 16 },
  actions: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 16,
    gap: 10,
    borderTopWidth: 1,
  },
  today: { fontSize: 12, lineHeight: 16, textAlign: 'center' },
  title: {
    fontSize: 40,
    lineHeight: 44,
    marginTop: Spacing.two,
  },
  subtitle: {
    maxWidth: 340,
  },
  stage: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.five,
  },
  footnote: {
    fontSize: 10,
    lineHeight: 13,
    textAlign: 'center',
  },
  stageTitle: {
    fontSize: 28,
    lineHeight: 32,
    textAlign: 'center',
  },
  stageDetail: {
    maxWidth: 280,
    textAlign: 'center',
  },
  stageAction: {
    marginTop: Spacing.two,
    minWidth: 220,
  },
  radar: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  wave: {
    position: 'absolute',
    left: 0,
    top: 0,
    borderWidth: 1.5,
  },
  devices: {
    gap: Spacing.two,
  },
  listStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    minHeight: 44,
  },
  listHint: {
    flex: 1,
    flexShrink: 1,
  },
  list: {
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  warning: {
    paddingHorizontal: Spacing.one,
  },
  rescan: {
    marginTop: Spacing.two,
  },
});
