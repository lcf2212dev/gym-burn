import { router } from 'expo-router';
import { useEffect } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { AmbientGlow } from '@/components/ambient-glow';
import { BeltFooter } from '@/components/belt-footer';
import { Pill } from '@/components/pill';
import { ScreenHeader } from '@/components/screen-header';
import { SectionLabel } from '@/components/section-label';
import { Surface } from '@/components/surface';
import { Fonts, MaxContentWidth, Neon, Spacing, TitleType } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useRecorder, useRecorderActions } from '@/logging/recorder-context';
import type { LogFile } from '@/logging/types';
import { formatFileSize, logFileDate } from '@/utils/log-files';

function goBack() {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace('/');
  }
}

/** Os registros guardados no celular: o atual, a pasta de cópia e os arquivos antigos. */
export function LogsScreen() {
  const theme = useTheme();
  const currentFileName = useRecorder((s) => s.currentFileName);
  const files = useRecorder((s) => s.files);
  const mirror = useRecorder((s) => s.mirror);
  const problem = useRecorder((s) => s.problem);
  const actions = useRecorderActions();
  const { refresh } = actions;

  // Os tamanhos mudam enquanto o app grava: relê a lista ao abrir a tela.
  useEffect(() => {
    refresh();
  }, [refresh]);

  const currentFile = files.find((file) => file.current) ?? null;
  const hasOthers = files.some((file) => !file.current);

  const removeOthers = () => {
    Alert.alert('Apagar os registros antigos?', 'O registro em gravação agora fica.', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Apagar', style: 'destructive', onPress: actions.removeOthers },
    ]);
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      {/* Halo ciano único: profundidade no carbono sem uma segunda temperatura de cor. */}
      <AmbientGlow intensity={0.45} />

      <ScreenHeader
        title="Registros"
        right={<ActionButton variant="text" label="Voltar" onPress={goBack} />}
        accent={Neon.cyan}
      />

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.content}>
          <View style={styles.section}>
            {/* O SectionLabel não recebe role; o wrapper mantém o cabeçalho para o leitor de tela. */}
            <View accessible accessibilityRole="header" accessibilityLabel="Gravando agora">
              <SectionLabel label="Gravando agora" accent={Neon.cyan} />
            </View>
            {currentFileName ? (
              <Surface style={styles.fileCard}>
                <Text style={[styles.mono, { color: theme.text }]} selectable>
                  {currentFileName}
                </Text>
                {currentFile ? (
                  <Text style={[styles.fileSize, { color: theme.textSecondary }]}>
                    {formatFileSize(currentFile.sizeBytes)}
                  </Text>
                ) : null}
              </Surface>
            ) : (
              <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                Nenhum arquivo em gravação.
              </Text>
            )}
            <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
              Tudo o que o app envia e recebe fica salvo neste celular, em texto. Os registros
              incluem o nome dos aparelhos Bluetooth que estavam por perto.
            </Text>
          </View>

          {problem ? (
            <Surface accent={Neon.red}>
              <Text accessibilityRole="alert" style={[styles.problem, { color: theme.text }]}>
                {problem}
              </Text>
            </Surface>
          ) : null}

          <View style={styles.section}>
            <View accessible accessibilityRole="header" accessibilityLabel="Cópia fora do app">
              <SectionLabel label="Cópia fora do app" accent={Neon.cyan} />
            </View>
            {mirror ? (
              <Surface style={styles.mirrorCard}>
                <Text
                  style={[styles.mirrorValue, TitleType, { color: theme.text }]}
                  selectable>
                  {mirror.label}
                </Text>
                <View style={[styles.row, styles.rowTight]}>
                  <ActionButton
                    variant="outline"
                    label="Trocar pasta"
                    onPress={actions.chooseMirrorFolder}
                    style={styles.rowButton}
                  />
                  <ActionButton
                    variant="outline"
                    label="Parar de copiar"
                    onPress={actions.stopMirroring}
                    style={[styles.rowButton, styles.rowButtonWide]}
                  />
                </View>
              </Surface>
            ) : (
              <Surface style={styles.mirrorCard}>
                <Text style={[styles.mirrorValue, TitleType, { color: theme.text }]}>
                  Sem cópia fora do app
                </Text>
                <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                  Uma cópia dos registros numa pasta do celular pode ser lida pelo aplicativo
                  Arquivos ou por um computador ligado por USB.
                </Text>
                <ActionButton
                  variant="outline"
                  label="Escolher pasta para a cópia"
                  onPress={actions.chooseMirrorFolder}
                />
              </Surface>
            )}
          </View>

          <View style={styles.section}>
            <View accessible accessibilityRole="header" accessibilityLabel="Arquivos">
              <SectionLabel label="Arquivos" accent={Neon.cyan} />
            </View>
            {files.length === 0 ? (
              <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                Nenhum registro guardado.
              </Text>
            ) : (
              <View style={styles.list}>
                {files.map((file) => (
                  <FileRow key={file.name} file={file} />
                ))}
              </View>
            )}
            <ActionButton
              variant="outline"
              label="Apagar os antigos"
              onPress={removeOthers}
              disabled={!hasOthers}
            />
          </View>
        </View>
      </ScrollView>
      {/* Esta tela cobre o painel: com a lona girando, Parar tem que continuar à vista. */}
      <BeltFooter />
    </SafeAreaView>
  );
}

function FileRow({ file }: { file: LogFile }) {
  const theme = useTheme();
  const { share, remove } = useRecorderActions();

  const confirmRemove = () => {
    Alert.alert('Apagar este registro?', logFileDate(file), [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Apagar', style: 'destructive', onPress: () => remove(file.name) },
    ]);
  };

  return (
    <Surface plain style={styles.file}>
      <View style={styles.fileLine}>
        <Text style={[styles.fileDate, TitleType, { color: theme.text }]} numberOfLines={1}>
          {logFileDate(file)}
        </Text>
        <Text style={[styles.fileSize, { color: theme.textSecondary }]}>
          {formatFileSize(file.sizeBytes)}
        </Text>
      </View>
      {file.current ? <Pill label="gravando agora" tone="mint" dot /> : null}
      <View style={styles.row}>
        <ActionButton
          variant="outline"
          label="Compartilhar"
          onPress={() => share(file.name)}
          style={styles.rowButton}
        />
        {/* O arquivo em gravação não pode ser apagado. */}
        {file.current ? null : (
          <ActionButton
            variant="outline"
            label="Apagar"
            onPress={confirmRemove}
            color={Neon.red}
            style={styles.rowButton}
          />
        )}
      </View>
    </Surface>
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
    // O último cartão não pode encostar no BeltFooter fixo.
    paddingBottom: Spacing.five,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    gap: Spacing.four,
  },
  section: {
    gap: 12,
  },
  fileCard: {
    gap: Spacing.one,
  },
  mono: {
    fontFamily: Fonts.mono,
    fontSize: 14,
    lineHeight: 21,
  },
  paragraph: {
    fontSize: 16,
    lineHeight: 24,
  },
  problem: {
    fontSize: 17,
    lineHeight: 25,
    fontWeight: '600',
  },
  mirrorCard: {
    gap: 12,
  },
  mirrorValue: {
    fontSize: 20,
    lineHeight: 24,
  },
  row: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  rowTight: {
    gap: Spacing.two,
  },
  rowButton: {
    flex: 1,
  },
  // "Parar de copiar" é mais comprido: ganha um pouco mais de largura na linha.
  rowButtonWide: {
    flex: 1.2,
  },
  list: {
    gap: 12,
  },
  file: {
    gap: 12,
  },
  fileLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  fileDate: {
    flexShrink: 1,
    fontSize: 18,
    lineHeight: 22,
  },
  fileSize: {
    fontFamily: Fonts.mono,
    fontSize: 12,
    lineHeight: 18,
  },
});
