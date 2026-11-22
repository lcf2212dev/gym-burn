import { Redirect, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';

import { DashboardScreen } from '@/screens/dashboard-screen';
import { PreviewTreadmill } from '@/treadmill/preview-store';
import { TreadmillProvider, useTreadmill, useTreadmillActions } from '@/treadmill/treadmill-context';
import { useWorkout, useWorkoutSession, WorkoutPreviewProvider } from '@/workouts/context';
import { metabolicCost, type Profile } from '@/workouts/model';
import { energyKcal, heartProfile } from '@/workouts/physiology';
import { PREVIEW_SECONDS, previewWorkout } from '@/workouts/preview';

/**
 * O painel do treino com dados simulados: um VO₂máx parado no meio do segundo
 * tiro, na faixa de batimentos da pessoa. Serve para ver a tela sem esteira,
 * sem cinta e sem pedir plano à IA; nada daqui é gravado.
 */
export default function Preview() {
  const profile = useWorkout((s) => s.profile);
  if (!profile) return <Redirect href="/perfil" />;
  return <Panel profile={profile} />;
}

function Panel({ profile }: { profile: Profile }) {
  const router = useRouter();
  const session = useWorkoutSession();
  const base = useTreadmill((s) => s);
  const actions = useTreadmillActions();
  const [frame] = useState(() => {
    const now = Date.now();
    const state = session.snapshot();
    // A faixa é a da pessoa: a FC máxima vem do histórico da esteira de verdade.
    const hr = heartProfile(profile, state.history.filter((w) => w.source === 'ble'));
    const { active, samples } = previewWorkout(profile, hr, now);
    const last = samples[samples.length - 1];
    const store = new PreviewTreadmill(
      {
        ...base,
        mode: 'demo',
        phase: 'connected',
        device: { id: 'previa', name: 'Esteira simulada' },
        metrics: {
          ...base.metrics,
          speedKmh: last.speedKmh,
          inclinationPercent: last.inclinationPercent,
          heartRateBpm: last.heartRateBpm,
          heartRateSource: 'strap',
          elapsedTimeS: PREVIEW_SECONDS,
          distanceM: active.totals.distanceM,
          totalEnergyKcal: energyKcal(active),
          // 1 MET é 1 kcal por quilo por hora.
          energyPerHourKcal: Math.round(
            metabolicCost(last.speedKmh ?? 0, last.inclinationPercent ?? 0) * profile.weightKg,
          ),
          updatedAt: now,
        },
        samples,
        status: { ...base.status, stoppedBySafetyKey: false },
        link: { ...base.link, lastPacketAt: now },
        notice: null,
      },
      // "Desconectar" fecha a prévia: não há esteira para desconectar.
      { ...actions, disconnect: () => (router.canGoBack() ? router.back() : router.replace('/')) },
    );
    const workout = {
      ...state,
      active,
      coach: 'Prévia com dados simulados',
      guidance: null,
      minimizedCue: null,
      error: '',
    };
    return { store, workout };
  });
  useEffect(() => frame.store.keepAlive(), [frame]);
  return (
    <TreadmillProvider store={frame.store}>
      <WorkoutPreviewProvider state={frame.workout}>
        <DashboardScreen />
      </WorkoutPreviewProvider>
    </TreadmillProvider>
  );
}
