import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Keyboard, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { Card, Kicker } from '@/components/card';
import { Divider, IconKicker, ListRow, StatusPill } from '@/components/kit';
import { UiButton } from '@/components/ui-button';
import { Field, styles, WorkoutPage } from '@/components/workout-ui';
import { Colors, Metric, Neon, NumeralType, TitleType, ZoneColors, neonGlow } from '@/constants/theme';
import { useStrap } from '@/heart/strap-context';
import { hasApiKey, saveApiKey } from '@/workouts/ai';
import { validProfile } from '@/workouts/model';
import { heartProfile } from '@/workouts/physiology';
import { useWorkout, useWorkoutSession } from '@/workouts/context';

export default function ProfileScreen() {
  const router = useRouter();
  const profile = useWorkout((s) => s.profile);
  const history = useWorkout((s) => s.history);
  const session = useWorkoutSession();
  const strap = useStrap((s) => s.saved);
  const [age, setAge] = useState(profile?.age.toString() ?? '');
  const [weight, setWeight] = useState(profile?.weightKg.toString().replace('.', ',') ?? '');
  const [height, setHeight] = useState(profile?.heightCm.toString() ?? '');
  const [key, setKey] = useState('');
  const [configured, setConfigured] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    hasApiKey()
      .then(setConfigured)
      .catch(() => setError('Falha ao abrir o armazenamento seguro.'));
  }, []);
  // As demonstrações têm histórico próprio e não entram na frequência real.
  const hr = profile && heartProfile(profile, history.filter((w) => w.source === 'ble'));
  function save() {
    const p = {
      age: Number(age),
      weightKg: Number(weight.replace(',', '.')),
      heightCm: Number(height.replace(',', '.')),
    };
    if (!validProfile(p)) {
      setError('Confira idade em anos, peso em kg e altura em cm.');
      return;
    }
    try {
      session.setProfile(p);
      Keyboard.dismiss();
      if (router.canGoBack()) router.back();
      else router.replace('/');
    } catch {
      setError('Falha ao salvar o perfil no aparelho.');
    }
  }
  function erase() {
    Alert.alert(
      'Apagar perfil e treinos?',
      'Perfil, histórico de treinos, medidas de prontidão, plano do dia e diário da IA serão apagados deste celular. A chave da DeepSeek e a cinta pareada continuam salvas.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Apagar tudo',
          style: 'destructive',
          onPress: () => {
            try {
              session.reset();
              setAge('');
              setWeight('');
              setHeight('');
              setError('');
            } catch {
              setError('Falha ao apagar os dados neste aparelho.');
            }
          },
        },
      ],
    );
  }
  async function configure() {
    setBusy(true);
    try {
      await saveApiKey(key);
      setKey('');
      setConfigured(true);
      setEditing(false);
      setError('');
      Keyboard.dismiss();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar a chave.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <WorkoutPage
      title="Meu perfil"
      back={!!profile}
      accessory={<StatusPill icon="lock" color={Neon.mint} label="Neste celular" />}
      footer={
        <>
          {!!error && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
          <UiButton icon="check" label="Salvar perfil" onPress={save} />
        </>
      }>
      <Card hero accent={Neon.cyan} style={local.hero}>
        <IconKicker icon="user" color={Neon.cyan}>
          Seus dados
        </IconKicker>
        <View style={local.fields}>
          <Stat label="Idade" unit="anos" keyboardType="number-pad" value={age} onChangeText={setAge} maxLength={3} />
          <Stat label="Peso" unit="kg" keyboardType="decimal-pad" value={weight} onChangeText={setWeight} maxLength={6} />
          <Stat label="Altura" unit="cm" keyboardType="decimal-pad" value={height} onChangeText={setHeight} maxLength={6} />
        </View>
        <Text style={local.note}>
          Seu perfil fica neste celular. Ao usar a IA, a DeepSeek recebe sua idade e o resumo dos
          treinos, com as frequências de repouso e máxima estimadas. Durante o treino guiado, a IA
          recebe BPM, velocidade, inclinação e cadência recentes para rever a carga. Peso e altura
          não vão para a IA. Com uma cinta XOSS X2 Pro, peso, altura, idade e FC máxima são
          gravados na cinta. A prontidão do dia (HRV) fica só no celular.
        </Text>
      </Card>
      {hr && (
        <Card accent={Metric.heart} style={local.card}>
          <IconKicker icon="heart-pulse" color={Metric.heart}>
            Frequência cardíaca
          </IconKicker>
          <View style={local.rates}>
            <Rate
              label="Repouso"
              value={hr.rest ? String(hr.rest) : '—'}
              color={Colors.dark.text}
              note={
                !hr.rest
                  ? 'Ainda não medida. Com a cinta, fique parado na esteira 1 minuto antes de ligar a lona; sem ela, o guia lê no primeiro minuto do treino.'
                  : hr.restSource === 'parado'
                    ? 'A menor das últimas medidas: esta foi feita parado, com a cinta, antes de a lona andar.'
                    : 'A menor das últimas medidas: esta saiu do primeiro minuto andando, menos 15 de quem já está andando.'
              }
            />
            <View style={local.rule} />
            <Rate
              label="Máxima"
              value={String(hr.max)}
              color={Metric.heart}
              note={
                hr.maxSource === 'IA'
                  ? 'Prevista pela IA nas últimas avaliações.'
                  : 'Estimada pela idade até a primeira avaliação da IA.'
              }
            />
          </View>
          {/* As cinco zonas da pessoa, de 10 em 10 pontos da FC máxima. */}
          <View style={local.zones} accessible accessibilityLabel="Zonas de frequência cardíaca">
            {ZoneColors.map((color, zone) => (
              <View key={zone} style={local.zone}>
                <View style={[local.zoneBar, { backgroundColor: color }]} />
                <Text style={local.zoneName}>Z{zone + 1}</Text>
                <Text style={local.zoneRange}>
                  {Math.round((hr.max * (50 + zone * 10)) / 100)}–{Math.round((hr.max * (60 + zone * 10)) / 100)}
                </Text>
              </View>
            ))}
          </View>
        </Card>
      )}
      <Card style={local.list}>
        <ListRow
          icon="heart"
          color={Metric.heart}
          title="Cinta de batimentos"
          sub={strap ? (strap.name ?? 'Cinta') + ' · pareada' : 'Nenhuma pareada: valem os do sensor de mão'}
          onPress={() => router.push('/cinta')}
        />
        <Divider />
        {configured && !editing ? (
          <ListRow
            icon="key-round"
            color={Neon.volt}
            title="Chave da DeepSeek"
            sub="Configurada neste aparelho"
            right={<Text style={local.action}>Trocar</Text>}
            onPress={() => setEditing(true)}
          />
        ) : (
          <View style={local.key}>
            <Field
              label="Chave pessoal da DeepSeek"
              value={key}
              onChangeText={setKey}
              secureTextEntry
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="sk-…"
            />
            <UiButton
              label="Salvar chave"
              variant="outline"
              color={Neon.volt}
              onPress={configure}
              busy={busy}
              disabled={!key.trim()}
            />
          </View>
        )}
        <Divider />
        <ListRow
          icon="terminal"
          color={Neon.violet}
          title="Diagnóstico da IA"
          sub="Cenários e diário das chamadas"
          onPress={() => router.push('/diagnostico')}
        />
        {!!profile && (
          <>
            <Divider />
            <ListRow
              icon="trash-2"
              color={Neon.red}
              title="Apagar perfil e treinos"
              sub="Histórico, prontidão, plano do dia e diário da IA. A chave continua salva."
              onPress={erase}
            />
          </>
        )}
      </Card>
    </WorkoutPage>
  );
}

/** Um dado do perfil num bloco: o rótulo, o número para digitar e a unidade. */
function Stat({ label, unit, ...props }: TextInputProps & { label: string; unit: string }) {
  return (
    <View style={local.field}>
      {/* A unidade vai no rótulo: o número fica com a largura toda do bloco. */}
      <Kicker>
        {label} · {unit}
      </Kicker>
      <TextInput
        accessibilityLabel={label + ' em ' + unit}
        placeholder="—"
        placeholderTextColor={Colors.dark.textMuted}
        style={local.input}
        {...props}
      />
    </View>
  );
}

function Rate({ label, value, color, note }: { label: string; value: string; color: string; note: string }) {
  return (
    <View style={local.rate} accessible accessibilityLabel={label + ': ' + value + ' BPM. ' + note}>
      <Kicker>{label}</Kicker>
      <View style={local.fieldValue}>
        <Text style={[local.rateValue, { color }, neonGlow(color, 18, 0.35)]}>{value}</Text>
        <Text style={local.unit}>BPM</Text>
      </View>
      <Text style={local.rateNote}>{note}</Text>
    </View>
  );
}

const local = StyleSheet.create({
  hero: { padding: 18, gap: 12 },
  card: { gap: 12 },
  list: { gap: 8 },
  fields: { flexDirection: 'row', gap: 8 },
  field: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 2,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.dark.borderStrong,
    backgroundColor: Colors.dark.surfaceSunken,
  },
  fieldValue: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  input: { ...NumeralType, minHeight: 44, padding: 0, fontSize: 28, color: Colors.dark.text },
  unit: { fontSize: 12, color: Colors.dark.textSecondary },
  note: { fontSize: 13, lineHeight: 19, color: Colors.dark.textSecondary },
  rates: { flexDirection: 'row', gap: 14 },
  rate: { flex: 1, gap: 1 },
  rateValue: { ...NumeralType, fontSize: 44, lineHeight: 46 },
  rateNote: { fontSize: 12, lineHeight: 16, color: Colors.dark.textSecondary },
  rule: { width: 1, backgroundColor: Colors.dark.border },
  zones: { flexDirection: 'row', gap: 2 },
  zone: { flex: 1, alignItems: 'center', gap: 3 },
  zoneBar: { alignSelf: 'stretch', height: 10, borderRadius: 3 },
  zoneName: { ...NumeralType, fontSize: 12, lineHeight: 14, color: Colors.dark.textSecondary },
  zoneRange: { ...NumeralType, fontSize: 11, lineHeight: 12, color: Colors.dark.textMuted },
  key: { gap: 10, paddingVertical: 4 },
  action: { ...TitleType, fontSize: 14, letterSpacing: 1, textTransform: 'uppercase', color: Neon.volt },
});
