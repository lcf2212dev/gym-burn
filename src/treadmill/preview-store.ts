import type { TreadmillStore } from './treadmill-context';
import type { TreadmillActions, TreadmillSnapshot } from './types';

/**
 * Uma esteira parada no tempo, para a prévia do painel: entrega sempre o mesmo
 * estado e só renova o horário do último pacote, para o painel não achar que a
 * esteira emudeceu.
 */
export class PreviewTreadmill implements TreadmillStore {
  private readonly listeners = new Set<() => void>();

  constructor(
    private snapshot: TreadmillSnapshot,
    readonly actions: TreadmillActions,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  /** Mantém o enlace vivo, uma vez por segundo; devolve a função que para. */
  keepAlive() {
    const timer = setInterval(() => {
      this.snapshot = { ...this.snapshot, link: { ...this.snapshot.link, lastPacketAt: Date.now() } };
      this.listeners.forEach((listener) => listener());
    }, 1000);
    return () => clearInterval(timer);
  }
}
