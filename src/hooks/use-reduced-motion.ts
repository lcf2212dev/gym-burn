import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * `true` quando o sistema pede menos animação (acessibilidade).
 *
 * A tela de conexão usa isto para trocar o pulso do radar por anéis estáticos:
 * o desenho continua claro, mas sem movimento contínuo. Começa em `false`
 * porque a consulta é assíncrona; no pior caso a animação gira até a resposta.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (active) {
          setReduced(enabled);
        }
      })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return reduced;
}
