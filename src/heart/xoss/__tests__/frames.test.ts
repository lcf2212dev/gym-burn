import {
  alertQueryFrame,
  alertSetFrame,
  clockFrame,
  decodeAlert,
  decodeRecording,
  decodeRecordMode,
  decodeSpace,
  decodeSteps,
  fetchFrame,
  frame,
  parseFileList,
  recordingQueryFrame,
  recordingStartFrame,
  recordingStopFrame,
  recordModeFrame,
  sendFrame,
  spaceFrame,
  statusFrame,
  stepsQueryFrame,
  stepsSetFrame,
  transferAccepted,
  validFrame,
} from '../frames';

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
const bytes = (text: string) => Uint8Array.from(text.split(' '), (b) => parseInt(b, 16));

describe('quadros de comando (nota de protocolo de 22/11/2026)', () => {
  it('termina no XOR de tudo, e conteúdo vazio vira 00', () => {
    expect(hex(statusFrame())).toBe('ff 00 ff');
    expect(hex(frame(0xff, []))).toBe('ff 00 ff');
    expect(hex(spaceFrame())).toBe('09 00 09');
  });

  it('passos, alerta, gravação e modo', () => {
    expect(hex(stepsQueryFrame())).toBe('72 00 72');
    expect(hex(stepsSetFrame(true))).toBe('72 01 00 00 00 00 00 73');
    expect(hex(stepsSetFrame(false))).toBe('72 00 00 00 00 00 00 72');
    expect(hex(alertQueryFrame())).toBe('71 00 00 71');
    // Testado na cinta com 200: gravou, leu de volta e desligou.
    expect(hex(alertSetFrame(200))).toBe('71 01 c8 b8');
    expect(hex(alertSetFrame(null))).toBe('71 01 00 70');
    expect(hex(recordingQueryFrame())).toBe('75 00 75');
    expect(hex(recordingStartFrame())).toBe('75 01 74');
    expect(hex(recordingStopFrame())).toBe('75 02 77');
    expect(hex(recordModeFrame())).toBe('76 ff 89');
  });

  it('relógio em segundos, 4 bytes little-endian', () => {
    // 2026-11-22 23:18:40 UTC, o início do treino de teste.
    expect(hex(clockFrame(1795389520))).toBe('54 50 78 03 6b 14');
  });

  it('pedidos de arquivo com o nome em ASCII', () => {
    const fetch = fetchFrame('filelist.txt');
    expect(fetch[0]).toBe(0x05);
    expect(String.fromCharCode(...fetch.subarray(1, -1))).toBe('filelist.txt');
    expect(fetch.at(-1)).toBe(0x57);
    expect(sendFrame('user_profile.json')[0]).toBe(0x07);
    expect(validFrame(sendFrame('user_profile.json'))).toBe(true);
  });

  it('recusa quadro maior que 20 bytes', () => {
    expect(() => fetchFrame('um-nome-comprido-demais.fit')).toThrow('limite é 20');
  });
});

describe('respostas', () => {
  it('confere o XOR', () => {
    expect(validFrame(bytes('04 00 04'))).toBe(true);
    expect(validFrame(bytes('04 00 05'))).toBe(false);
    expect(validFrame(bytes('04'))).toBe(false);
  });

  it('passos: ligado, cadência e total little-endian', () => {
    // 72 01 4c 10 27 00 00: ligado, 76 passos/min, 10000 passos.
    const body = [0x72, 0x01, 0x4c, 0x10, 0x27, 0x00, 0x00];
    const reply = Uint8Array.from([...body, body.reduce((a, b) => a ^ b, 0)]);
    expect(decodeSteps(reply)).toEqual({ on: true, spm: 76, steps: 10000 });
    expect(decodeSteps(bytes('71 00 00 00 71'))).toBeNull();
  });

  it('alerta: 0 é desligado', () => {
    expect(decodeAlert(bytes('71 c8 00 00 b9'))).toBe(200);
    expect(decodeAlert(bytes('71 00 00 00 71'))).toBeNull();
  });

  it('gravação e modo', () => {
    expect(decodeRecording(bytes('75 ff 8a'))).toBe(false);
    expect(decodeRecording(bytes('75 01 74'))).toBe(true);
    expect(decodeRecording(bytes('75 04 71'))).toBeNull();
    expect(decodeRecordMode(bytes('76 00 76'))).toBe('manual');
    expect(decodeRecordMode(bytes('76 01 77'))).toBe('auto');
  });

  it('espaço em texto: kB livres e total', () => {
    const body = [0x0a, ...Array.from('970/972', (c) => c.charCodeAt(0))];
    const reply = Uint8Array.from([...body, 0x27]);
    expect(validFrame(reply)).toBe(true);
    expect(decodeSpace(reply)).toEqual({ freeKb: 970, totalKb: 972 });
  });

  it('fim de transferência: só 04 00 com XOR certo é aceito', () => {
    expect(transferAccepted(bytes('04 00 04'))).toBe(true);
    expect(transferAccepted(bytes('15 15'))).toBe(false);
    expect(transferAccepted(bytes('04 01 05'))).toBe(false);
  });

  it('lista de treinos: nome em UTC e tamanho, sem repetir', () => {
    const files = parseFileList('20261122231840.fit 986\n20261122231840.fit 986\n20261123101500.fit\n');
    expect(files).toEqual([
      { name: '20261122231840.fit', at: Date.UTC(2026, 10, 22, 23, 18, 40), size: 986 },
      { name: '20261123101500.fit', at: Date.UTC(2026, 10, 23, 10, 15, 0), size: null },
    ]);
    expect(parseFileList('')).toEqual([]);
  });
});
