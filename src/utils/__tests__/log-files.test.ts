import { formatFileSize, logFileDate } from '../log-files';

describe('logFileDate', () => {
  it('lê a data e a hora do nome do arquivo', () => {
    expect(logFileDate({ name: 'gym-burn-2026-11-10_21-30-05.txt', modifiedAt: 0 })).toBe(
      '10/11/2026 21:30',
    );
  });

  it('usa a última modificação quando o nome não tem data', () => {
    const at = new Date(2026, 0, 2, 3, 4, 5).getTime();
    expect(logFileDate({ name: 'registro.txt', modifiedAt: at })).toBe('02/01/2026 03:04');
  });

  it('cai no nome quando não há data nenhuma', () => {
    expect(logFileDate({ name: 'registro.txt', modifiedAt: null })).toBe('registro.txt');
  });
});

describe('formatFileSize', () => {
  it('mostra KB abaixo de 1 MB e MB acima, com vírgula decimal', () => {
    expect(formatFileSize(0)).toBe('0 KB');
    expect(formatFileSize(512)).toBe('0,5 KB');
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(12 * 1024 + 300)).toBe('12 KB');
    expect(formatFileSize(1.4 * 1024 * 1024)).toBe('1,4 MB');
  });
});
