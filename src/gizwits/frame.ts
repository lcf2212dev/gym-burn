/**
 * Protocolo binário do módulo BLE “Gizwits Treadmill SDK”, o mesmo que o app
 * AFG Pro Fitness usa no serviço proprietário 0xFFF0 da esteira.
 *
 * Frame escrito no FFF3 (e respondido no FFF4):
 *
 * ```
 * 0..1   55 AA        sincronismo
 * 2..3   sequência    uint16 little-endian
 * 4      lingo        1 = geral, 2 = remoto, 3 = configurações
 * 5      comando
 * 6..7   tamanho      uint16 little-endian do payload
 * 8..9   CRC16        CCITT-FALSE do payload, little-endian
 * 10..   payload
 * ```
 *
 * Fonte: engenharia reversa do AFG Pro (`docs/re/afg-pro-fitness.md`).
 */

export const GIZWITS_LINGO = {
  general: 1,
  // Os builders do AFG (`j0/a.java`) usam 3 para os comandos remotos
  // (start/pause/speed/incline/…); o enum `Message` diz 2, mas o frame real usa 3.
  remote: 3,
  settings: 4,
} as const;

export const GIZWITS_LINGO_NAMES: Record<number, string> = {
  [GIZWITS_LINGO.general]: 'geral',
  [GIZWITS_LINGO.remote]: 'remoto',
  [GIZWITS_LINGO.settings]: 'configurações',
};

/** Comandos que interessam ao teste e ao controle. */
export const GIZWITS_COMMANDS = {
  general: {
    getMachineInfo: 2,
    setUserData: 15,
    getWorkoutData: 18,
    stopWorkout: 20,
  },
  remote: {
    setCurrentUser: 1,
    startWorkout: 2,
    pauseWorkout: 3,
    changeWorkout: 4,
    setSpeed: 5,
    setIncline: 6,
    setResistance: 7,
    selectProgram: 10,
    keyPress: 11,
  },
} as const;

/** Nome legível de um comando do protocolo, para o registro e a Sonda. */
export function gizwitsCommandName(lingo: number, command: number): string | null {
  if (lingo === GIZWITS_LINGO.general) {
    switch (command) {
      case GIZWITS_COMMANDS.general.getMachineInfo:
        return 'machine info';
      case GIZWITS_COMMANDS.general.setUserData:
        return 'dados do usuário';
      case GIZWITS_COMMANDS.general.getWorkoutData:
        return 'dados do treino';
      case GIZWITS_COMMANDS.general.stopWorkout:
        return 'parar treino';
      default:
        return `geral ${command}`;
    }
  }
  if (lingo === GIZWITS_LINGO.remote) {
    switch (command) {
      case GIZWITS_COMMANDS.remote.setCurrentUser:
        return 'selecionar usuário';
      case GIZWITS_COMMANDS.remote.startWorkout:
        return 'iniciar treino';
      case GIZWITS_COMMANDS.remote.pauseWorkout:
        return 'pausar/continuar';
      case GIZWITS_COMMANDS.remote.changeWorkout:
        return 'alterar treino';
      case GIZWITS_COMMANDS.remote.setSpeed:
        return 'velocidade';
      case GIZWITS_COMMANDS.remote.setIncline:
        return 'inclinação';
      case GIZWITS_COMMANDS.remote.setResistance:
        return 'resistência';
      case GIZWITS_COMMANDS.remote.selectProgram:
        return 'selecionar programa';
      case GIZWITS_COMMANDS.remote.keyPress:
        return 'tecla do painel';
      default:
        return `remoto ${command}`;
    }
  }
  if (lingo === GIZWITS_LINGO.settings) {
    return `configurações ${command}`;
  }
  return null;
}

/** CRC16-CCITT-FALSE (init 0xFFFF, polinômio 0x1021), como em `k0/b.java` do AFG Pro. */
export function crc16Ccitt(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export interface GizwitsFrame {
  sequence: number;
  lingo: number;
  command: number;
  payload: Uint8Array;
}

/**
 * Monta um frame completo. A sequência padrão é 0; o firmware não parece exigir
 * um contador avançando (o app AFG usa um, mas o teste é uma mensagem por link).
 */
export function encodeGizwitsFrame(
  lingo: number,
  command: number,
  payload: Uint8Array = new Uint8Array(0),
  sequence = 0,
): Uint8Array {
  const frame = new Uint8Array(payload.length + 10);
  frame[0] = 0x55;
  frame[1] = 0xaa;
  frame[2] = sequence & 0xff;
  frame[3] = (sequence >> 8) & 0xff;
  frame[4] = lingo & 0xff;
  frame[5] = command & 0xff;
  frame[6] = payload.length & 0xff;
  frame[7] = (payload.length >> 8) & 0xff;
  // O app AFG manda CRC 0 quando não há payload (k0/b.a devolve 0 para len 0);
  // é o caso do pedido de machine info.
  const crc = payload.length === 0 ? 0 : crc16Ccitt(payload);
  frame[8] = crc & 0xff;
  frame[9] = (crc >> 8) & 0xff;
  frame.set(payload, 10);
  return frame;
}

/**
 * Pedido de “machine info” (lingo geral, comando 2, sem payload) — o handshake
 * que o app AFG Pro manda assim que assina o FFF4. É só leitura.
 *
 * Bytes: `55 AA 00 00 01 02 00 00 00 00`.
 */
export const GIZWITS_MACHINE_INFO_REQUEST = encodeGizwitsFrame(
  GIZWITS_LINGO.general,
  GIZWITS_COMMANDS.general.getMachineInfo,
);

/** O frame começa com `55 AA`? */
export function isGizwitsFrame(bytes: Uint8Array): boolean {
  return bytes.length >= 10 && bytes[0] === 0x55 && bytes[1] === 0xaa;
}

/** Lê o cabeçalho de um frame recebido. Devolve `null` se não for um frame válido. */
export function parseGizwitsFrame(bytes: Uint8Array): GizwitsFrame | null {
  if (!isGizwitsFrame(bytes)) return null;
  const payloadLength = bytes[6] | (bytes[7] << 8);
  if (bytes.length < 10 + payloadLength) return null;
  return {
    sequence: bytes[2] | (bytes[3] << 8),
    lingo: bytes[4],
    command: bytes[5],
    payload: bytes.slice(10, 10 + payloadLength),
  };
}

// --- Comandos de controle (canal remoto, lingo 3) ---------------------------
//
// Payloads extraídos de `j0/a.java` do AFG Pro. Velocidade e inclinação vão
// multiplicadas por 10 (0,1 km/h e 0,1 %). O `mode` da velocidade é 0 no
// métrico (o app AFG usa 1 no imperial).

function u16le(value: number): [number, number] {
  const safe = Math.max(0, Math.min(0xffff, Math.round(value)));
  return [safe & 0xff, (safe >> 8) & 0xff];
}

export interface GizwitsStartWorkoutOptions {
  /** 0 = manual (RProgramType_Manual). */
  program?: number;
  /** Tempo alvo do treino em segundos. */
  timeSeconds?: number;
  /** Peso/idade vão zerados pelo próprio app AFG (o `o0.d` devolve 0). */
  weight?: number;
  age?: number;
  /** 0 = métrico (km/h); 1 = imperial (mph). */
  unitsMode?: number;
  speedKmh: number;
  inclinePercent?: number;
  resistance?: number;
  target?: number;
  level?: number;
}

/** Frame de “start workout” (lingo remoto, cmd 2, payload de 17 bytes). */
export function encodeGizwitsStartWorkout(options: GizwitsStartWorkoutOptions): Uint8Array {
  const program = options.program ?? 0;
  const timeSeconds = options.timeSeconds ?? 1800;
  const weight = options.weight ?? 0;
  const age = options.age ?? 0;
  const unitsMode = options.unitsMode ?? 0;
  const speed = Math.round(options.speedKmh * 10);
  const incline = Math.round((options.inclinePercent ?? 0) * 10);
  const resistance = options.resistance ?? 0;
  const target = options.target ?? 0;
  const level = options.level ?? 0;
  const payload = new Uint8Array(17);
  payload.set(u16le(program), 0);
  payload.set(u16le(timeSeconds), 2);
  payload.set(u16le(weight), 4);
  payload.set(u16le(age), 6);
  payload[8] = unitsMode & 0xff;
  payload.set(u16le(speed), 9);
  payload.set(u16le(incline), 11);
  payload[13] = resistance & 0xff;
  payload.set(u16le(target), 14);
  payload[16] = level & 0xff;
  return encodeGizwitsFrame(GIZWITS_LINGO.remote, GIZWITS_COMMANDS.remote.startWorkout, payload);
}

/** Frame de velocidade (lingo remoto, cmd 5): [mode, velocidade×10 LE, extra]. */
export function encodeGizwitsSetSpeed(speedKmh: number, unitsMode = 0): Uint8Array {
  const payload = new Uint8Array(4);
  payload[0] = unitsMode & 0xff;
  payload.set(u16le(speedKmh * 10), 1);
  payload[3] = 0;
  return encodeGizwitsFrame(GIZWITS_LINGO.remote, GIZWITS_COMMANDS.remote.setSpeed, payload);
}

/** Frame de inclinação (lingo remoto, cmd 6): [inclinação×10 LE, extra]. */
export function encodeGizwitsSetIncline(inclinePercent: number): Uint8Array {
  const payload = new Uint8Array(3);
  payload.set(u16le(inclinePercent * 10), 0);
  payload[2] = 0;
  return encodeGizwitsFrame(GIZWITS_LINGO.remote, GIZWITS_COMMANDS.remote.setIncline, payload);
}

/** Frame de pausar (payload 0) ou continuar (payload 1). */
export function encodeGizwitsPause(continueWorkout = false): Uint8Array {
  return encodeGizwitsFrame(
    GIZWITS_LINGO.remote,
    GIZWITS_COMMANDS.remote.pauseWorkout,
    Uint8Array.of(continueWorkout ? 1 : 0),
  );
}

/** Frame de parar treino (lingo geral, cmd 20, sem payload). */
export function encodeGizwitsStop(): Uint8Array {
  return encodeGizwitsFrame(GIZWITS_LINGO.general, GIZWITS_COMMANDS.general.stopWorkout);
}
