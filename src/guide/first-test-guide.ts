import type { TreadmillStore } from '@/treadmill/treadmill-context';
import type { TraceSink } from '@/treadmill/types';

import type { GuideStore } from './guide-context';
import {
  ANSWER_WORDS,
  EMERGENCY_WORDS,
  GUIDE_STEPS,
  STOP_ANSWER_WORDS,
  buildGuideSnapshot,
  commandBaseFor,
  describeGuideChanges,
  initialGuideState,
  nextGuideDeadline,
  observeSession,
  stopRecordFor,
  summarizeGuide,
  type GuideState,
} from './guide-logic';
import type { GuideActions, GuideSnapshot, GuideTextField } from './types';

export interface FirstTestGuideOptions {
  /** A sessão da esteira; o roteiro só a observa, nunca chama as ações dela. */
  session: TreadmillStore;
  /** Recebe as linhas `guide` do registro. Uma falha aqui nunca afeta o roteiro. */
  trace: TraceSink;
  now?: () => number;
}

const FIELD_NAMES: Record<GuideTextField, string> = {
  panelCode: 'Código que apareceu no painel',
  notes: 'Observações',
};

/**
 * Roteiro do primeiro teste na esteira real. Observa a sessão e as respostas
 * do usuário e grava no registro tudo o que muda, para reconstruir depois o
 * que aconteceu na academia.
 */
export class FirstTestGuide implements GuideStore {
  readonly actions: GuideActions;

  private readonly session: TreadmillStore;
  private readonly sink: TraceSink;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private state: GuideState = initialGuideState();
  private snapshot: GuideSnapshot;
  // Último valor de cada campo de texto que foi para o registro.
  private tracedText: Record<GuideTextField, string> = { panelCode: '', notes: '' };
  private unsubscribe: (() => void) | null;
  // Acorda o roteiro quando um prazo vence sem a sessão mudar (a esteira que para de mandar dados).
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor({ session, trace, now = Date.now }: FirstTestGuideOptions) {
    this.session = session;
    this.sink = trace;
    this.now = now;
    this.snapshot = buildGuideSnapshot(this.state, session.getSnapshot(), null, now());
    this.unsubscribe = session.subscribe(this.handleSession);

    this.actions = {
      start: () => {
        const s = this.session.getSnapshot();
        this.tracedText = { panelCode: '', notes: '' };
        this.trace(
          `Roteiro iniciado (modo ${s.mode}, conexão ${s.phase}, esteira ${s.device?.name ?? 'nenhuma'})`,
        );
        // Comandos enviados antes do roteiro não contam para as verificações.
        this.refresh({ ...initialGuideState(), active: true, commandBase: commandBaseFor(s) }, true);
      },
      stop: () => {
        if (!this.state.active) {
          return;
        }
        this.commitText('panelCode');
        this.commitText('notes');
        for (const line of summarizeGuide(this.snapshot)) {
          this.trace(`Resumo: ${line}`);
        }
        this.trace('Roteiro encerrado');
        this.refresh({ ...this.state, active: false });
      },
      acknowledge: (step) => {
        if (!this.state.active || this.state.acknowledged[step]) {
          return;
        }
        if (step === 'appMode') {
          // "Feito" fecha o passo e o campo do código some antes de perder o foco.
          this.commitText('panelCode');
        }
        const title = GUIDE_STEPS.find((definition) => definition.id === step)?.title ?? step;
        this.trace(`Usuário tocou em Feito: ${title}`);
        this.refresh({ ...this.state, acknowledged: { ...this.state.acknowledged, [step]: true } });
      },
      setPanelCode: (code) => {
        if (this.state.active) {
          this.refresh({ ...this.state, panelCode: code });
        }
      },
      answerBluetoothIndicator: (answer) => {
        if (!this.state.active) {
          return;
        }
        this.trace(`Indicador Bluetooth do painel acendeu: ${ANSWER_WORDS[answer]}`);
        this.refresh({ ...this.state, bluetoothIndicator: answer });
      },
      reportStop: (answer) => {
        // Sem pergunta pendente nem resposta a corrigir, não há o que responder.
        if (!this.state.active || (!this.state.stopAwaitingAnswer && this.state.stopAnswer === null)) {
          return;
        }
        this.trace(`Parar, resposta do usuário: a lona parou sozinha? ${STOP_ANSWER_WORDS[answer]}`);
        this.refresh({
          ...this.state,
          stopAwaitingAnswer: false,
          stopAnswer: answer,
          stop: stopRecordFor(answer),
        });
      },
      reportEmergencyStop: (result) => {
        if (!this.state.active) {
          return;
        }
        this.trace(`Emergency Stop, resposta do usuário: ${EMERGENCY_WORDS[result]}`);
        this.refresh({ ...this.state, emergencyStop: result, emergencyCause: 'manual' });
      },
      setNotes: (text) => {
        if (this.state.active) {
          this.refresh({ ...this.state, notes: text });
        }
      },
      commitText: (field) => {
        if (this.state.active) {
          this.commitText(field);
        }
      },
      markShared: () => {
        if (!this.state.active) {
          return;
        }
        this.commitText('panelCode');
        this.commitText('notes');
        this.trace('Usuário tocou em Compartilhar registro');
        this.refresh({ ...this.state, shared: true });
      },
      noteEarlyShare: () => {
        if (!this.state.active) {
          return;
        }
        this.commitText('panelCode');
        this.commitText('notes');
        const step = this.snapshot.currentStepNumber;
        this.trace(
          `Usuário compartilhou o registro antes do fim do roteiro (${step === null ? 'roteiro concluído' : `passo ${step}`})`,
        );
      },
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): GuideSnapshot => this.snapshot;

  /** Para de observar a sessão. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearDeadline();
  }

  private handleSession = (): void => {
    // A sessão chama os ouvintes no meio dos comandos dela (o Parar, por exemplo): nada do
    // roteiro pode escapar para lá.
    try {
      this.refresh(this.state);
    } catch (error) {
      this.trace(`O roteiro falhou ao observar a sessão: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  private clearDeadline(): void {
    if (this.deadlineTimer !== null) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  }

  private scheduleDeadline(): void {
    this.clearDeadline();
    if (this.unsubscribe === null) {
      return;
    }
    const now = this.now();
    const deadline = nextGuideDeadline(this.state, now);
    if (deadline === null) {
      return;
    }
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null;
      this.handleSession();
    }, deadline - now);
  }

  private commitText(field: GuideTextField): void {
    const value = this.state[field];
    if (value === this.tracedText[field]) {
      return;
    }
    this.tracedText[field] = value;
    this.trace(`${FIELD_NAMES[field]}: ${value === '' ? '(apagado)' : `"${value}"`}`);
  }

  /** Aplica o estado, observa a sessão, registra o que mudou e avisa os ouvintes. */
  private refresh(state: GuideState, fromScratch = false): void {
    const session = this.session.getSnapshot();
    const before = this.state;
    const now = this.now();
    this.state = observeSession(state, session, now);
    this.scheduleDeadline();
    const previous = this.snapshot;
    const next = buildGuideSnapshot(this.state, session, previous, now);
    if (next.active) {
      for (const line of describeGuideChanges(fromScratch ? null : previous, next, session)) {
        this.trace(line);
      }
      // A vigia não aparece inteira no snapshot; no registro ela explica por que o roteiro
      // concluiu (ou não) o Emergency Stop.
      if (
        !fromScratch &&
        (before.emergencyWatch !== this.state.emergencyWatch ||
          before.emergencyObservation !== this.state.emergencyObservation)
      ) {
        this.trace(
          `Vigia do Emergency Stop: ${before.emergencyWatch} → ${this.state.emergencyWatch}, observação ${this.state.emergencyObservation ?? 'nenhuma'}` +
            ` (lona ${session.belt}, conexão ${session.phase}, velocidade ${session.metrics.speedKmh ?? '—'} km/h)`,
        );
      }
    }
    if (next === previous) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private trace(text: string): void {
    try {
      this.sink({ at: this.now(), kind: 'guide', text, hex: null });
    } catch {
      // O registro é acessório: uma falha ao gravar não pode afetar o roteiro.
    }
  }
}
