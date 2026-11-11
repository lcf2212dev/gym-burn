import { FtmsParseError, hexToBytes } from '../bytes';
import { parseTreadmillData } from '../treadmill-data';

describe('parseTreadmillData', () => {
  it('lê o registro mínimo: só a velocidade instantânea', () => {
    // flags 0x0000, 10,50 km/h = 1050 = 0x041A
    expect(parseTreadmillData(hexToBytes('00 00 1A 04'))).toEqual({
      flags: 0,
      moreData: false,
      instantaneousSpeedKmh: 10.5,
      truncated: false,
      trailingBytes: 0,
    });
  });

  it('lê um registro típico de esteira', () => {
    // flags 0x058C: distância, inclinação, energia, frequência cardíaca, tempo decorrido
    const data = parseTreadmillData(
      hexToBytes('8C 05 20 03 D2 04 00 19 00 0E 00 96 00 58 02 0A 8E F2 02'),
    );
    expect(data).toEqual({
      flags: 0x058c,
      moreData: false,
      instantaneousSpeedKmh: 8,
      totalDistanceM: 1234,
      inclinationPercent: 2.5,
      rampAngleDeg: 1.4,
      totalEnergyKcal: 150,
      energyPerHourKcal: 600,
      energyPerMinuteKcal: 10,
      heartRateBpm: 142,
      elapsedTimeS: 754,
      truncated: false,
      trailingBytes: 0,
    });
  });

  it('lê todos os campos de uma vez', () => {
    // flags 0x1FFE: tudo presente, ritmo com 2 octetos
    const data = parseTreadmillData(
      hexToBytes(
        'FE 1F' + // flags
          'E8 03' + // velocidade 10,00
          '84 03' + // velocidade média 9,00
          '10 27 00' + // distância 10000 m
          '32 00 1D 00' + // inclinação 5,0 %, rampa 2,9°
          'FA 00 0A 00' + // ganho +25,0 m, -1,0 m
          'B4 00' + // ritmo instantâneo 180
          'C8 00' + // ritmo médio 200
          '2C 01 84 03 0F' + // energia 300, 900/h, 15/min
          '96' + // FC 150
          '69' + // 10,5 METs
          '10 0E' + // decorrido 3600 s
          '58 02' + // restante 600 s
          '0A 00 C8 00', // força 10 N, potência 200 W
      ),
    );
    expect(data).toEqual({
      flags: 0x1ffe,
      moreData: false,
      instantaneousSpeedKmh: 10,
      averageSpeedKmh: 9,
      totalDistanceM: 10000,
      inclinationPercent: 5,
      rampAngleDeg: 2.9,
      positiveElevationGainM: 25,
      negativeElevationGainM: 1,
      instantaneousPaceRaw: 180,
      averagePaceRaw: 200,
      paceFieldWidth: 2,
      totalEnergyKcal: 300,
      energyPerHourKcal: 900,
      energyPerMinuteKcal: 15,
      heartRateBpm: 150,
      metabolicEquivalent: 10.5,
      elapsedTimeS: 3600,
      remainingTimeS: 600,
      forceOnBeltN: 10,
      powerOutputW: 200,
      truncated: false,
      trailingBytes: 0,
    });
  });

  it('lê inclinação negativa', () => {
    // -1,5 % = -15 = 0xFFF1; rampa -0,9° = -9 = 0xFFF7
    const data = parseTreadmillData(hexToBytes('08 00 00 00 F1 FF F7 FF'));
    expect(data.inclinationPercent).toBe(-1.5);
    expect(data.rampAngleDeg).toBe(-0.9);
  });

  it('trata os valores especiais "dado não disponível" como ausentes', () => {
    // inclinação, rampa, energia total, por hora e por minuto indisponíveis
    const data = parseTreadmillData(hexToBytes('88 00 00 00 FF 7F FF 7F FF FF FF FF FF'));
    expect(data).toEqual({
      flags: 0x0088,
      moreData: false,
      instantaneousSpeedKmh: 0,
      truncated: false,
      trailingBytes: 0,
    });
  });

  it('não espera velocidade instantânea quando More Data está ligado', () => {
    // flags 0x0401: More Data + tempo decorrido (60 s)
    expect(parseTreadmillData(hexToBytes('01 04 3C 00'))).toEqual({
      flags: 0x0401,
      moreData: true,
      elapsedTimeS: 60,
      truncated: false,
      trailingBytes: 0,
    });
  });

  describe('largura dos campos de ritmo', () => {
    it('detecta 2 octetos (GSS atual)', () => {
      // 12 km/h; 500 m em 150 s; média 155 s
      const data = parseTreadmillData(hexToBytes('60 00 B0 04 96 00 9B 00'));
      expect(data.paceFieldWidth).toBe(2);
      expect(data.instantaneousPaceRaw).toBe(150);
      expect(data.averagePaceRaw).toBe(155);
      expect(data.truncated).toBe(false);
      expect(data.trailingBytes).toBe(0);
    });

    it('detecta 1 octeto (definição original de 2017)', () => {
      const data = parseTreadmillData(hexToBytes('60 00 B0 04 02 03'));
      expect(data.paceFieldWidth).toBe(1);
      expect(data.instantaneousPaceRaw).toBe(2);
      expect(data.averagePaceRaw).toBe(3);
      expect(data.truncated).toBe(false);
      expect(data.trailingBytes).toBe(0);
    });

    it('não desalinha os campos seguintes com ritmo de 1 octeto', () => {
      // ritmo instantâneo (1 octeto) seguido de FC e tempo decorrido
      const data = parseTreadmillData(hexToBytes('20 05 B0 04 02 8E F2 02'));
      expect(data.paceFieldWidth).toBe(1);
      expect(data.instantaneousPaceRaw).toBe(2);
      expect(data.heartRateBpm).toBe(142);
      expect(data.elapsedTimeS).toBe(754);
    });

    it('não desalinha os campos seguintes com ritmo de 2 octetos', () => {
      const data = parseTreadmillData(hexToBytes('20 05 B0 04 96 00 8E F2 02'));
      expect(data.paceFieldWidth).toBe(2);
      expect(data.instantaneousPaceRaw).toBe(150);
      expect(data.heartRateBpm).toBe(142);
      expect(data.elapsedTimeS).toBe(754);
    });

    it('não informa largura quando não há campo de ritmo', () => {
      expect(parseTreadmillData(hexToBytes('00 00 1A 04')).paceFieldWidth).toBeUndefined();
    });
  });

  it('mantém os campos já lidos quando o payload vem cortado', () => {
    // flags 0x058C, mas o payload acaba no meio da distância
    const data = parseTreadmillData(hexToBytes('8C 05 20 03 D2'));
    expect(data.truncated).toBe(true);
    expect(data.instantaneousSpeedKmh).toBe(8);
    expect(data.totalDistanceM).toBeUndefined();
    expect(data.heartRateBpm).toBeUndefined();
  });

  it('conta os bytes que sobram depois do último campo', () => {
    const data = parseTreadmillData(hexToBytes('00 00 1A 04 AA BB'));
    expect(data.instantaneousSpeedKmh).toBe(10.5);
    expect(data.trailingBytes).toBe(2);
    expect(data.truncated).toBe(false);
  });

  it('rejeita payload sem o campo Flags', () => {
    expect(() => parseTreadmillData(hexToBytes('00'))).toThrow(FtmsParseError);
    expect(() => parseTreadmillData(new Uint8Array())).toThrow(FtmsParseError);
  });
});
