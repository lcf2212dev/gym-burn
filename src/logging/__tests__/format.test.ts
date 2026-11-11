import {
  formatHeader,
  formatTraceLine,
  isLogFileName,
  logFileName,
  mirrorLabel,
} from '../format';

const START = new Date(2026, 10, 10, 21, 30, 5, 123); // hora local

describe('nome do arquivo', () => {
  it('usa a hora local, com zeros à esquerda', () => {
    expect(logFileName(START)).toBe('gym-burn-2026-11-10_21-30-05.txt');
    expect(logFileName(new Date(2027, 0, 2, 3, 4, 5))).toBe('gym-burn-2027-01-02_03-04-05.txt');
  });

  it('reconhece só nomes de registro', () => {
    expect(isLogFileName('gym-burn-2026-11-10_21-30-05.txt')).toBe(true);
    expect(isLogFileName('copia.json')).toBe(false);
    expect(isLogFileName('../gym-burn-2026-11-10_21-30-05.txt')).toBe(false);
    expect(isLogFileName('gym-burn-2026-11-10_21-30-05.txt.bak')).toBe(false);
  });
});

describe('linha do registro', () => {
  it('hora com milissegundos, tipo em coluna fixa e texto', () => {
    expect(formatTraceLine({ at: START.getTime(), kind: 'info', text: 'Conectado', hex: null })).toBe(
      '21:30:05.123 info   Conectado',
    );
  });

  it('o hexadecimal vai no fim, depois de "hex="', () => {
    expect(
      formatTraceLine({ at: START.getTime(), kind: 'rx', text: 'Treadmill Data', hex: '0C 00 2A' }),
    ).toBe('21:30:05.123 rx     Treadmill Data  hex=0C 00 2A');
  });

  it('o tipo mais longo ocupa a coluna inteira e o texto sempre começa na mesma posição', () => {
    const kinds = ['rx', 'tx', 'info', 'error', 'state', 'action', 'guide'] as const;
    const columns = kinds.map((kind) =>
      formatTraceLine({ at: START.getTime(), kind, text: '@', hex: null }).indexOf('@'),
    );
    expect(new Set(columns)).toEqual(new Set([20]));
  });

  it('mantém um evento em uma linha só', () => {
    const text = formatTraceLine({
      at: START.getTime(),
      kind: 'error',
      text: 'Falhou\n  at a (x.js:1)\r\n  at b (x.js:2)',
      hex: null,
    });
    expect(text).toBe('21:30:05.123 error  Falhou ⏎   at a (x.js:1) ⏎   at b (x.js:2)');
    expect(text).not.toMatch(/[\r\n]/);
  });

  it('zera os milissegundos à esquerda', () => {
    const at = new Date(2026, 0, 1, 1, 2, 3, 4).getTime();
    expect(formatTraceLine({ at, kind: 'tx', text: 'a', hex: null })).toMatch(/^01:02:03\.004 tx /);
  });
});

describe('cabeçalho', () => {
  const header = formatHeader(
    { app: 'Gym Burn 1.0.0', device: 'Google Pixel 7', system: 'Android 15 (API 35)' },
    START.getTime(),
  );
  const lines = header.split('\n');

  it('toda linha começa com "# " e não termina em quebra de linha', () => {
    expect(lines.every((line) => line.startsWith('# '))).toBe(true);
    expect(header.endsWith('\n')).toBe(false);
  });

  it('traz início, app, aparelho e sistema', () => {
    expect(lines[0]).toBe('# Gym Burn — registro de execução');
    expect(lines[1]).toMatch(/^# Início: 2026-11-10 21:30:05 \(UTC[+-]\d{2}:\d{2}\)$/);
    expect(lines).toContain('# App: Gym Burn 1.0.0');
    expect(lines).toContain('# Aparelho: Google Pixel 7');
    expect(lines).toContain('# Sistema: Android 15 (API 35)');
  });

  it('descreve o formato das linhas', () => {
    expect(header).toContain('HH:mm:ss.SSS TIPO texto [hex=BYTES]');
  });
});

describe('nome da pasta de cópia', () => {
  it('decodifica a URI do seletor do Android', () => {
    expect(
      mirrorLabel('content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FGymBurn'),
    ).toBe('Documents/GymBurn');
  });

  it('cartão de memória mostra o volume; a raiz tem nome próprio', () => {
    expect(mirrorLabel('content://x/tree/1A2B-3C4D%3AFotos')).toBe('1A2B-3C4D: Fotos');
    expect(mirrorLabel('content://x/tree/primary%3A')).toBe('Armazenamento interno');
  });

  it('ignora o trecho /document/ e devolve a URI quando não reconhece o formato', () => {
    expect(mirrorLabel('content://x/tree/primary%3ADownload/document/primary%3ADownload')).toBe('Download');
    expect(mirrorLabel('file:///sdcard/x')).toBe('file:///sdcard/x');
  });
});
