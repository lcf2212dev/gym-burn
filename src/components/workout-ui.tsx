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
import type { ReactNode } from 'react';
import { Colors, MaxContentWidth, Neon, TitleType } from '@/constants/theme';

const colors = Colors.dark;
export function WorkoutPage({
  title,
  children,
  back = true,
}: {
  title: string;
  children: ReactNode;
  back?: boolean;
}) {
  const router = useRouter();
  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {back && (
          <Pressable
            accessibilityRole="button"
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            style={styles.link}>
            <Text style={styles.linkText}>‹ Voltar</Text>
          </Pressable>
        )}
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        {children}
      </ScrollView>
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

export function WorkoutLinks() {
  const router = useRouter();
  return (
    <View style={styles.row}>
      {(['Perfil', 'Evolução'] as const).map((label) => (
        <Pressable
          key={label}
          accessibilityRole="button"
          style={styles.link}
          onPress={() => router.push(label === 'Perfil' ? '/perfil' : '/evolucao')}>
          <Text style={styles.linkText}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  scroll: {
    width: '100%',
    alignSelf: 'center',
    maxWidth: MaxContentWidth,
    padding: 20,
    paddingBottom: 40,
    gap: 16,
  },
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
