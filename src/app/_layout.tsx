import { BarlowCondensed_500Medium } from '@expo-google-fonts/barlow-condensed/500Medium';
import { BarlowCondensed_600SemiBold } from '@expo-google-fonts/barlow-condensed/600SemiBold';
import { BarlowCondensed_700Bold } from '@expo-google-fonts/barlow-condensed/700Bold';
import { useFonts } from 'expo-font';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useState } from 'react';

import { createAppServices } from '@/app-services';
import { Colors, Neon } from '@/constants/theme';
import { GuidanceSheet } from '@/components/cockpit/guidance-sheet';
import { WorkoutProvider } from '@/workouts/context';
import { TreadmillProvider } from '@/treadmill/treadmill-context';

// A splash fica até a fonte dos números carregar (ou falhar).
SplashScreen.preventAutoHideAsync();

// O app é escuro sempre: a janela nativa também, para não piscar branco antes
// do primeiro quadro (o SystemUI troca a cor de fundo da raiz em runtime).
void SystemUI.setBackgroundColorAsync(Colors.dark.background).catch(() => {});

// Tema de navegação com o fundo do app, para não piscar entre telas.
const navigationTheme = {
  ...DarkTheme,
  dark: true,
  colors: {
    ...DarkTheme.colors,
    primary: Neon.volt,
    background: Colors.dark.background,
    card: Colors.dark.background,
    text: Colors.dark.text,
    border: Colors.dark.border,
    notification: Neon.magenta,
  },
};

export default function RootLayout() {
  // Uma sessão durante toda a vida do app.
  const [services] = useState(createAppServices);
  // Importa só os pesos usados, não a família inteira.
  const [fontsLoaded, fontError] = useFonts({
    BarlowCondensed_500Medium,
    BarlowCondensed_600SemiBold,
    BarlowCondensed_700Bold,
  });
  const ready = fontsLoaded || fontError !== null;

  useEffect(() => {
    if (ready) {
      // Sem a fonte, os números caem na fonte do sistema; o app não trava por isso.
      SplashScreen.hideAsync();
    }
  }, [ready]);

  if (!ready) {
    return null;
  }

  return (
    <TreadmillProvider store={services.session}>
      {/* O esquema é fixo no escuro (ver `use-color-scheme`). */}
      <ThemeProvider value={navigationTheme}>
        <StatusBar style="light" />
        <WorkoutProvider store={services.session}>
          <Stack screenOptions={{ headerShown: false }} />
          <GuidanceSheet />
        </WorkoutProvider>
      </ThemeProvider>
    </TreadmillProvider>
  );
}
