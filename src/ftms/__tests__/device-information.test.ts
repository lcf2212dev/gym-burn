import {
  DEVICE_INFORMATION_FIELDS,
  DEVICE_INFORMATION_SERVICE,
  decodeDeviceInformationText,
  shortUuid,
  uuid16,
} from '..';

const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

describe('decodeDeviceInformationText', () => {
  it('decodifica ASCII', () => {
    expect(decodeDeviceInformationText(ascii('T600X'))).toBe('T600X');
  });

  it('para no primeiro byte nulo (preenchimento de string em C)', () => {
    expect(decodeDeviceInformationText(Uint8Array.of(0x54, 0x36, 0x00, 0x00, 0x41))).toBe('T6');
  });

  it('tira os espaços do fim e preserva os do meio', () => {
    expect(decodeDeviceInformationText(ascii('Johnson Health   '))).toBe('Johnson Health');
  });

  it('um valor vazio ou só de nulos vira texto vazio', () => {
    expect(decodeDeviceInformationText(new Uint8Array())).toBe('');
    expect(decodeDeviceInformationText(Uint8Array.of(0, 0, 0))).toBe('');
  });

  it('escapa controle e não ASCII: o registro é uma linha por evento', () => {
    expect(decodeDeviceInformationText(Uint8Array.of(0x41, 0x0a, 0x0d, 0x42))).toBe('A\\x0A\\x0DB');
    expect(decodeDeviceInformationText(Uint8Array.of(0x4d, 0xc2, 0xae))).toBe('M\\xC2\\xAE');
  });

  it('escapa a própria barra invertida, para o escape não ser ambíguo', () => {
    expect(decodeDeviceInformationText(ascii('a\\b'))).toBe('a\\x5Cb');
  });

  it('escapa aspas e "=", para o valor não fechar o texto nem imitar a coluna hex=', () => {
    expect(decodeDeviceInformationText(ascii('T6"  hex=AA'))).toBe('T6\\x22  hex\\x3DAA');
  });
});

describe('DEVICE_INFORMATION_FIELDS', () => {
  it('são características do serviço 0x180A, sem repetição', () => {
    expect(shortUuid(DEVICE_INFORMATION_SERVICE)).toBe('0x180A');
    const uuids = DEVICE_INFORMATION_FIELDS.map((field) => field.uuid);
    expect(new Set(uuids).size).toBe(uuids.length);
  });

  it('o modelo é lido primeiro: se uma leitura travar, é o que não pode ter ficado de fora', () => {
    expect(DEVICE_INFORMATION_FIELDS[0]).toEqual({
      uuid: uuid16(0x2a24),
      name: 'Model Number',
      text: true,
    });
    const names = DEVICE_INFORMATION_FIELDS.map((field) => field.name);
    expect(names).toEqual(expect.arrayContaining(['Manufacturer Name', 'Serial Number']));
  });

  it('o System ID é binário, não texto', () => {
    const systemId = DEVICE_INFORMATION_FIELDS.find((field) => field.name === 'System ID');
    expect(systemId?.text).toBe(false);
  });
});
