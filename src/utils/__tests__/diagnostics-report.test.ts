import type { TreadmillCapabilities } from '@/treadmill/types';

import { buildDiagnosticsReport, describeLogEntry, describeRange } from '../diagnostics-report';

const capabilities: TreadmillCapabilities = {
  feature: null,
  hasControlPoint: true,
  speedRange: { min: 0.8, max: 22, step: 0.1, source: 'assumed' },
  inclinationRange: { min: 0, max: 15, step: 0.5, source: 'device' },
  characteristics: [],
};

describe('describeRange', () => {
  it('descreve faixa, passo e origem', () => {
    expect(describeRange(capabilities.speedRange, 'km/h')).toBe(
      '0,8 a 22 km/h, passo 0,1 km/h, presumida pela ficha técnica da T600X',
    );
  });
});

describe('describeLogEntry', () => {
  it('junta hora, direção, rótulo e bytes', () => {
    const at = new Date(2026, 0, 1, 7, 8, 9).getTime();
    expect(describeLogEntry({ id: 1, at, kind: 'tx', label: 'Request Control', hex: '00' })).toBe(
      '07:08:09  enviado  Request Control  00',
    );
    expect(describeLogEntry({ id: 2, at, kind: 'info', label: 'Conectado', hex: null })).toBe(
      '07:08:09  info  Conectado',
    );
  });
});

describe('buildDiagnosticsReport', () => {
  it('põe o cabeçalho antes do registro, em ordem cronológica', () => {
    const at = new Date(2026, 0, 1, 7, 8, 9).getTime();
    const text = buildDiagnosticsReport({
      mode: 'ble',
      device: { id: 'AA:BB', name: 'T600X' },
      capabilities: {
        ...capabilities,
        feature: {
          machineFeaturesRaw: 0x1a,
          targetSettingsRaw: 0x3,
          machine: {} as never,
          targets: {} as never,
        },
      },
      log: [
        { id: 1, at, kind: 'rx', label: 'Primeiro', hex: null },
        { id: 2, at, kind: 'error', label: 'Segundo', hex: null },
      ],
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Esteira: T600X');
    expect(text).toContain('Modo: Bluetooth');
    expect(text).toContain('Machine Features: 0x0000001A');
    expect(text).toContain('Target Settings: 0x00000003');
    expect(lines.at(-2)).toContain('Primeiro');
    expect(lines.at(-1)).toContain('erro  Segundo');
  });
});
