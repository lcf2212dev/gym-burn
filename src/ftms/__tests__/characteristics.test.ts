import { parseFtmsServiceData } from '../advertisement';
import { FtmsParseError, hexToBytes } from '../bytes';
import { parseFitnessMachineFeature } from '../feature';
import { parseMachineStatus } from '../machine-status';
import { parseSupportedInclinationRange, parseSupportedSpeedRange } from '../ranges';
import { parseTrainingStatus } from '../training-status';

describe('parseFitnessMachineFeature', () => {
  it('separa o que a esteira mede do que ela aceita como alvo', () => {
    // mede: vel. média, distância, inclinação, energia, FC, tempo decorrido
    // aceita: velocidade e inclinação
    const feature = parseFitnessMachineFeature(hexToBytes('0D 16 00 00 03 00 00 00'));
    expect(feature.machineFeaturesRaw).toBe(0x160d);
    expect(feature.targetSettingsRaw).toBe(0x03);
    expect(feature.machine).toMatchObject({
      averageSpeed: true,
      cadence: false,
      totalDistance: true,
      inclination: true,
      elevationGain: false,
      pace: false,
      expendedEnergy: true,
      heartRate: true,
      metabolicEquivalent: false,
      elapsedTime: true,
      remainingTime: false,
    });
    expect(feature.targets).toMatchObject({
      speed: true,
      inclination: true,
      resistance: false,
      power: false,
      heartRate: false,
    });
  });

  it('reconhece esteira que só transmite dados', () => {
    const feature = parseFitnessMachineFeature(hexToBytes('0D 16 00 00 00 00 00 00'));
    expect(feature.targets.speed).toBe(false);
    expect(feature.targets.inclination).toBe(false);
  });

  it('lê os bits mais altos de cada campo', () => {
    // bit 16 de cada campo: retenção de dados do usuário / cadência alvo
    const feature = parseFitnessMachineFeature(hexToBytes('00 00 01 00 00 00 01 00'));
    expect(feature.machine.userDataRetention).toBe(true);
    expect(feature.targets.cadence).toBe(true);
    expect(feature.machine.averageSpeed).toBe(false);
  });

  it('não confunde bits reservados com recursos, mesmo com o bit 31 ligado', () => {
    const feature = parseFitnessMachineFeature(hexToBytes('00 00 00 80 00 00 00 80'));
    expect(feature.machineFeaturesRaw).toBe(0x80000000);
    expect(Object.values(feature.machine)).not.toContain(true);
    expect(Object.values(feature.targets)).not.toContain(true);
  });

  it('assume nenhum alvo quando só o primeiro campo vem', () => {
    const feature = parseFitnessMachineFeature(hexToBytes('0D 16 00 00'));
    expect(feature.machine.totalDistance).toBe(true);
    expect(feature.targetSettingsRaw).toBe(0);
    expect(feature.targets.speed).toBe(false);
  });

  it('rejeita valor curto demais', () => {
    expect(() => parseFitnessMachineFeature(hexToBytes('0D 16 00'))).toThrow(FtmsParseError);
  });
});

describe('faixas suportadas', () => {
  it('lê a faixa de velocidade da T600X', () => {
    // 0,80 a 22,00 km/h em passos de 0,10
    expect(parseSupportedSpeedRange(hexToBytes('50 00 98 08 0A 00'))).toEqual({
      min: 0.8,
      max: 22,
      step: 0.1,
    });
  });

  it('lê a faixa de inclinação da T600X', () => {
    // 0 a 15,0 % em passos de 0,5
    expect(parseSupportedInclinationRange(hexToBytes('00 00 96 00 05 00'))).toEqual({
      min: 0,
      max: 15,
      step: 0.5,
    });
  });

  it('lê inclinação mínima negativa', () => {
    // -3,0 a 12,0 % em passos de 1,0
    expect(parseSupportedInclinationRange(hexToBytes('E2 FF 78 00 0A 00'))).toEqual({
      min: -3,
      max: 12,
      step: 1,
    });
  });

  it('rejeita valor curto demais', () => {
    expect(() => parseSupportedSpeedRange(hexToBytes('50 00 98 08'))).toThrow(FtmsParseError);
    expect(() => parseSupportedInclinationRange(hexToBytes('00 00'))).toThrow(FtmsParseError);
  });
});

describe('parseMachineStatus', () => {
  it('lê os eventos sem parâmetro', () => {
    expect(parseMachineStatus(hexToBytes('01'))).toEqual({ type: 'reset' });
    expect(parseMachineStatus(hexToBytes('03'))).toEqual({ type: 'stoppedBySafetyKey' });
    expect(parseMachineStatus(hexToBytes('04'))).toEqual({ type: 'startedOrResumedByUser' });
    expect(parseMachineStatus(hexToBytes('FF'))).toEqual({ type: 'controlPermissionLost' });
  });

  it('distingue parar de pausar', () => {
    expect(parseMachineStatus(hexToBytes('02 01'))).toEqual({
      type: 'stoppedOrPausedByUser',
      action: 'stop',
    });
    expect(parseMachineStatus(hexToBytes('02 02'))).toEqual({
      type: 'stoppedOrPausedByUser',
      action: 'pause',
    });
    expect(parseMachineStatus(hexToBytes('02'))).toEqual({
      type: 'stoppedOrPausedByUser',
      action: 'unknown',
    });
  });

  it('lê os novos alvos de velocidade e inclinação', () => {
    expect(parseMachineStatus(hexToBytes('05 1A 04'))).toEqual({
      type: 'targetSpeedChanged',
      speedKmh: 10.5,
    });
    expect(parseMachineStatus(hexToBytes('06 19 00'))).toEqual({
      type: 'targetInclineChanged',
      inclinationPercent: 2.5,
    });
    expect(parseMachineStatus(hexToBytes('06 F1 FF'))).toEqual({
      type: 'targetInclineChanged',
      inclinationPercent: -1.5,
    });
  });

  it('preserva eventos que o app não interpreta', () => {
    // 0x0E: tempo de treino alvo alterado
    expect(parseMachineStatus(hexToBytes('0E 08 07'))).toEqual({
      type: 'other',
      opCode: 0x0e,
      parameter: hexToBytes('08 07'),
    });
  });

  it('não inventa alvo quando o parâmetro vem cortado', () => {
    expect(parseMachineStatus(hexToBytes('05 1A'))).toEqual({
      type: 'other',
      opCode: 0x05,
      parameter: hexToBytes('1A'),
    });
  });

  it('rejeita valor vazio', () => {
    expect(() => parseMachineStatus(new Uint8Array())).toThrow(FtmsParseError);
  });
});

describe('parseTrainingStatus', () => {
  it('lê o estado sem texto', () => {
    expect(parseTrainingStatus(hexToBytes('00 0D'))).toEqual({
      code: 0x0d,
      name: 'manualMode',
      text: null,
    });
  });

  it('lê o texto livre em UTF-8', () => {
    // "Idle"
    expect(parseTrainingStatus(hexToBytes('01 01 49 64 6C 65'))).toEqual({
      code: 0x01,
      name: 'idle',
      text: 'Idle',
    });
    // "Aquecimento ✓" — inclui caractere de 3 octetos
    expect(
      parseTrainingStatus(hexToBytes('01 02 41 71 75 65 63 69 6D 65 6E 74 6F 20 E2 9C 93')).text,
    ).toBe('Aquecimento ✓');
  });

  it('marca códigos reservados', () => {
    expect(parseTrainingStatus(hexToBytes('00 42')).name).toBe('reserved');
  });

  it('rejeita valor curto demais', () => {
    expect(() => parseTrainingStatus(hexToBytes('00'))).toThrow(FtmsParseError);
  });
});

describe('parseFtmsServiceData', () => {
  it('reconhece uma esteira disponível', () => {
    const advertisement = parseFtmsServiceData(hexToBytes('01 01 00'));
    expect(advertisement?.available).toBe(true);
    expect(advertisement?.machineTypes.treadmill).toBe(true);
    expect(advertisement?.machineTypes.indoorBike).toBe(false);
  });

  it('reconhece outro tipo de equipamento', () => {
    // bit 5: bicicleta indoor, indisponível
    const advertisement = parseFtmsServiceData(hexToBytes('00 20 00'));
    expect(advertisement?.available).toBe(false);
    expect(advertisement?.machineTypes.treadmill).toBe(false);
    expect(advertisement?.machineTypes.indoorBike).toBe(true);
  });

  it('devolve null quando o dado vem incompleto', () => {
    expect(parseFtmsServiceData(hexToBytes('01 01'))).toBeNull();
  });
});
