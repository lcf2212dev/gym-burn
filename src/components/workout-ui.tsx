import { useRouter } from 'expo-router';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Lucide } from '@react-native-vector-icons/lucide';
import type { ReactNode } from 'react';
import { Colors, Glass, MaxContentWidth, Neon, TitleType } from '@/constants/theme';

const colors = Colors.dark;
/**
 * Página rolável das telas de treino. `footer` fica preso no rodapé, com
 * margem própria: é onde vai a ação principal, para a tela não terminar com o
 * conteúdo encostado na borda. Com `accessory`, o topo vira uma barra só:
 * voltar, título e o acessório à direita (o estado da cinta ou da esteira).
 */
export function WorkoutPage({
  title,
  children,
  back = true,
  footer,
  accessory,
}: {
  title: string;
  children: ReactNode;
  back?: boolean;
  footer?: ReactNode;
  accessory?: ReactNode;
}) {
  const router = useRouter();
  const leave = () => (router.canGoBack() ? router.back() : router.replace('/'));
  return (
    <SafeAreaView style={styles.page}>
      <ScrollView
        style={styles.fill}
        // Com rodapé fixo, a folga do fim da página é a dele.
        contentContainerStyle={[styles.scroll, !!footer && styles.scrollAboveFooter]}
        keyboardShouldPersistTaps="handled">
        {accessory ? (
          <View style={styles.bar}>
            {back && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Voltar"
                onPress={leave}
                style={styles.round}>
                <Lucide name="chevron-left" size={22} color={colors.text} />
              </Pressable>
            )}
            <Text accessibilityRole="header" style={styles.barTitle} numberOfLines={1}>
              {title}
            </Text>
            {accessory}
          </View>
        ) : (
          <>
            {back && (
              <Pressable accessibilityRole="button" onPress={leave} style={styles.link}>
                <Text style={styles.linkText}>‹ Voltar</Text>
              </Pressable>
            )}
            <Text accessibilityRole="header" style={styles.title}>
              {title}
            </Text>
          </>
        )}
        {children}
      </ScrollView>
      {!!footer && <View style={styles.footer}>{footer}</View>}
    </SafeAreaView>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={styles.group}>
      <Text style={styles.caption}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.textSecondary}
        style={styles.input}
        {...props}
      />
    </View>
  );
}

export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  fill: { flex: 1 },
  scrollAboveFooter: { paddingBottom: 16 },
  footer: {
    width: '100%',
    alignSelf: 'center',
    maxWidth: MaxContentWidth,
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 18,
    gap: 10,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  scroll: {
    width: '100%',
    alignSelf: 'center',
    maxWidth: MaxContentWidth,
    padding: 20,
    paddingBottom: 40,
    gap: 16,
  },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  round: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: Glass.card,
  },
  barTitle: { ...TitleType, flex: 1, fontSize: 28, lineHeight: 32, color: colors.text },
  title: { ...TitleType, fontSize: 38, color: colors.text },
  heading: { ...TitleType, fontSize: 25, color: colors.text },
  metric: { ...TitleType, fontSize: 36, color: Neon.volt },
  body: { color: colors.textSecondary, fontSize: 15, lineHeight: 22 },
  caption: { color: colors.text, fontSize: 15, fontWeight: '600' },
  error: { color: colors.noticeWarning, fontSize: 14, lineHeight: 20 },
  input: {
    backgroundColor: colors.backgroundElement,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    padding: 13,
    color: colors.text,
    fontSize: 18,
    minHeight: 50,
  },
  group: { gap: 8 },
  card: { gap: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  link: { alignSelf: 'flex-start', justifyContent: 'center', minHeight: 44, paddingHorizontal: 6 },
  linkText: { color: Neon.cyan, fontSize: 16 },
  option: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 12,
    padding: 12,
    minHeight: 46,
    justifyContent: 'center',
  },
  selected: { borderColor: Neon.volt, backgroundColor: '#202A14' },
});
