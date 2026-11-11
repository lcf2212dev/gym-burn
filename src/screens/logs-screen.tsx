import { router } from 'expo-router';
import { useEffect } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { BeltFooter } from '@/components/belt-footer';
import { Fonts, MaxContentWidth, Spacing } from '@/constants/theme';
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
      <View style={[styles.topBar, { borderColor: theme.border }]}>
        <Text style={[styles.title, { color: theme.text }]} accessibilityRole="header">
          Registros
        </Text>
        <ActionButton variant="text" label="Voltar" onPress={goBack} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.content}>
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.text }]} accessibilityRole="header">
              Gravando agora
            </Text>
            {currentFileName ? (
              <>
                <Text style={[styles.mono, { color: theme.text }]} selectable>
                  {currentFileName}
                </Text>
                {currentFile ? (
                  <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                    {formatFileSize(currentFile.sizeBytes)}
                  </Text>
                ) : null}
              </>
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
            <Text
              accessibilityRole="alert"
              style={[styles.problem, { color: theme.noticeError, borderColor: theme.noticeError }]}>
              {problem}
            </Text>
          ) : null}

          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.text }]} accessibilityRole="header">
              Cópia fora do app
            </Text>
            {mirror ? (
              <>
                <Text style={[styles.value, { color: theme.text }]} selectable>
                  {mirror.label}
                </Text>
                <View style={styles.row}>
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
                    style={styles.rowButton}
                  />
                </View>
              </>
            ) : (
              <>
                <Text style={[styles.value, { color: theme.text }]}>Sem cópia fora do app</Text>
                <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                  Uma cópia dos registros numa pasta do celular pode ser lida pelo aplicativo
                  Arquivos ou por um computador ligado por USB.
                </Text>
                <ActionButton
                  variant="outline"
                  label="Escolher pasta para a cópia"
                  onPress={actions.chooseMirrorFolder}
                />
              </>
            )}
          </View>

          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.text }]} accessibilityRole="header">
              Arquivos
            </Text>
            {files.length === 0 ? (
              <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
                Nenhum registro guardado.
              </Text>
            ) : (
              <View style={[styles.list, { borderColor: theme.border }]}>
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
    <View style={[styles.file, { borderColor: theme.border }]}>
      <View style={styles.fileLine}>
        <Text style={[styles.value, { color: theme.text }]}>{logFileDate(file)}</Text>
        <Text style={[styles.paragraph, { color: theme.textSecondary }]}>
          {formatFileSize(file.sizeBytes)}
        </Text>
      </View>
      {file.current ? (
        <Text style={[styles.currentMark, { color: theme.noticeSuccess }]}>gravando agora</Text>
      ) : null}
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
            color={theme.noticeError}
            style={styles.rowButton}
          />
        )}
      </View>
    </View>
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
    paddingBottom: Spacing.five,
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
  value: {
    fontSize: 16,
    fontWeight: 600,
  },
  mono: {
    fontFamily: Fonts.mono,
    fontSize: 14,
    lineHeight: 20,
  },
  problem: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: 700,
    borderWidth: 2,
    borderRadius: 8,
    padding: Spacing.three,
  },
  row: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  rowButton: {
    flex: 1,
  },
  list: {
    borderTopWidth: 1,
  },
  file: {
    gap: Spacing.two,
    paddingVertical: Spacing.three,
    borderBottomWidth: 1,
  },
  fileLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  currentMark: {
    fontSize: 14,
    fontWeight: 700,
  },
});
