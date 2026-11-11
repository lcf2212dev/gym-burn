import { BarlowCondensed_600SemiBold } from '@expo-google-fonts/barlow-condensed/600SemiBold';
import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';

import { createAppServices } from '@/app-services';
import { Colors } from '@/constants/theme';
import { GuideProvider } from '@/guide/guide-context';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { RecorderProvider } from '@/logging/recorder-context';
import { TreadmillProvider } from '@/treadmill/treadmill-context';

// A splash fica até a fonte dos números carregar (ou falhar).
SplashScreen.preventAutoHideAsync();

// Temas de navegação com o fundo do app, para não piscar branco entre telas.
const lightTheme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: Colors.light.background, text: Colors.light.text },
};
const darkTheme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: Colors.dark.background, text: Colors.dark.text },
};

export default function RootLayout() {
  const scheme = useColorScheme();
  // Um gravador, uma sessão e um roteiro durante toda a vida do app.
  const [services] = useState(createAppServices);
  // Importa só o peso usado, não a família inteira.
  const [fontsLoaded, fontError] = useFonts({ BarlowCondensed_600SemiBold });
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
    <RecorderProvider store={services.recorder}>
      <TreadmillProvider store={services.session}>
        <GuideProvider store={services.guide}>
          <ThemeProvider value={scheme === 'dark' ? darkTheme : lightTheme}>
            <StatusBar style="auto" />
            <Stack screenOptions={{ headerShown: false }} />
          </ThemeProvider>
        </GuideProvider>
      </TreadmillProvider>
    </RecorderProvider>
  );
}
