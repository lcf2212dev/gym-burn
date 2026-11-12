import { memo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Neon, withAlpha } from '@/constants/theme';

export interface AmbientGlowProps {
  /** Duas cores de halo: a de cima (canto superior direito) e a de baixo. */
  colors?: readonly [string, string];
  /** 0 desliga, 1 é o padrão; use menos em telas densas. */
  intensity?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Fundo de ambiente: dois halos de neon muito discretos que tiram o preto
 * chapado do fundo sem competir com o conteúdo. O React Native não tem
 * gradiente radial sem dependência nativa, então o halo é a soma de muitas
 * camadas concêntricas com o mesmo alfa baixíssimo — visualmente contínuo, sem
 * os degraus de um punhado de círculos.
 *
 * É decorativo: `pointerEvents="none"` e nenhum efeito no layout.
 */
function AmbientGlowBase({
  colors = [Neon.cyan, Neon.cyan],
  intensity = 1,
  style,
}: AmbientGlowProps) {
  return (
    <View
      pointerEvents="none"
      // O halo é só decoração estática: rasterizar evita repintar 44 camadas
      // a cada leitura da esteira (o painel re-renderiza em tempo real).
      renderToHardwareTextureAndroid
      shouldRasterizeIOS
      style={[StyleSheet.absoluteFill, styles.clip, style]}>
      {/* Um foco frio no alto e outro no canto oposto: a tela ganha volume sem
          perder o carbono como fundo. */}
      <Halo color={colors[0]} size={820} x={-240} y={-560} intensity={intensity} />
      <Halo color={colors[1]} size={880} x={-140} y={420} intensity={intensity * 0.6} />
    </View>
  );
}

/** Quantidade de anéis do halo: mais camadas, transição mais suave. */
const LAYERS = 22;
/** Alfa de cada anel; a soma no centro é o brilho percebido (~0,13). */
const LAYER_ALPHA = 0.013;

function Halo({
  color,
  size,
  x,
  y,
  intensity,
}: {
  color: string;
  size: number;
  x: number;
  y: number;
  intensity: number;
}) {
  return (
    <View style={{ position: 'absolute', width: size, height: size, left: x, top: y }}>
      {Array.from({ length: LAYERS }, (_, index) => {
        const ratio = 1 - index / LAYERS;
        const layerSize = size * ratio;
        const offset = (size - layerSize) / 2;
        return (
          <View
            key={ratio}
            style={{
              position: 'absolute',
              width: layerSize,
              height: layerSize,
              left: offset,
              top: offset,
              borderRadius: layerSize / 2,
              backgroundColor: withAlpha(color, LAYER_ALPHA * intensity),
            }}
          />
        );
      })}
    </View>
  );
}

/** As props são primitivas e estáveis: o halo nunca precisa re-renderizar. */
export const AmbientGlow = memo(AmbientGlowBase);

const styles = StyleSheet.create({
  clip: {
    overflow: 'hidden',
  },
});
