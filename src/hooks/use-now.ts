import { useEffect, useState } from 'react';

/**
 * Relógio que avança a cada `intervalMs`. Começa em `null` e só passa a ter
 * valor no primeiro tique: `Date.now()` não pode ser chamado na renderização.
 */
export function useNow(intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
