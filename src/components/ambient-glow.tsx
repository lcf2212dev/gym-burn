import { memo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Neon, withAlpha } from '@/constants/theme';

export interface AmbientGlowProps {
  /** Dois halos: o de cima (canto superior) e o de baixo (canto oposto). */
  colors?: readonly [string, string];
  /** 0 desliga, 1 é o padrão; use menos em telas densas. */
  intensity?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Fundo de ambiente: halos de neon muito discretos que tiram o preto chapado
 * sem competir com o conteúdo. O React Native não tem gradiente radial sem
 * dependência nativa, então cada halo é a soma de camadas concêntricas com o
 * mesmo alfa baixíssimo — visualmente contínuo, sem os degraus de um punhado de
 * círculos.
 *
 * É decorativo: `pointerEvents="none"`, nenhum efeito no layout e rasterizado
 * para não repintar quando a tela anima.
 */
function AmbientGlowBase({ colors = [Neon.cyan, Neon.volt], intensity = 1, style }: AmbientGlowProps) {
  return (
    <View
      pointerEvents="none"
      renderToHardwareTextureAndroid
      shouldRasterizeIOS
      style={[StyleSheet.absoluteFill, styles.clip, style]}>
      {/* Foco frio atrás do topo (marca e título) e um segundo, mais discreto,
          embaixo — a tela ganha profundidade e continua carbono. */}
      <Halo color={colors[0]} size={780} x={-250} y={-460} intensity={intensity * 1.1} />
      <Halo color={colors[1]} size={860} x={-190} y={430} intensity={intensity * 0.62} />
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
