/**
 * O `user_profile.json` da XOSS X2 Pro: peso em gramas, altura em milímetros,
 * nascimento em segundos desde 1970, FC máxima e de limiar em bpm, fuso em
 * segundos. De fábrica, 70 kg, 1,70 m e FC máxima 200. Código puro.
 *
 * A correção é textual, campo a campo, como em `tools/xoss/perfil.py`: o
 * resto do arquivo (gênero, LTHR, fuso, número de série) vai como a cinta
 * mandou. Cada chave tem de aparecer exatamente uma vez; senão o arquivo não
 * é o que o app conhece e nada é enviado.
 */

/** O que o app acerta na cinta. A idade sai do nascimento; o app só sabe a idade. */
export interface StrapProfile {
  weightG: number;
  heightMm: number;
  age: number;
  maxHr: number;
}

/** O valor inteiro de uma chave que aparece uma vez só; `null` se falta ou repete. */
function single(text: string, key: string): number | null {
  const pattern = new RegExp(`"${key}"\\s*:\\s*(-?\\d+)`, 'g');
  const matches = [...text.matchAll(pattern)];
  return matches.length === 1 ? Number(matches[0][1]) : null;
}

/** Idade completa em `nowMs` de quem nasceu em `birthdayS` (datas em UTC, como a cinta guarda). */
export function ageAt(birthdayS: number, nowMs: number): number {
  const birth = new Date(birthdayS * 1000);
  const now = new Date(nowMs);
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const before =
    now.getUTCMonth() < birth.getUTCMonth() ||
    (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() < birth.getUTCDate());
  if (before) age -= 1;
  return age;
}

/**
 * Um nascimento que dá exatamente `age` anos hoje: o dia de hoje, `age` anos
 * atrás, à meia-noite UTC. Em 29/2 vai 28/2, para a idade não ficar um ano
 * menor nos anos que não são bissextos.
 */
export function birthdayFor(age: number, nowMs: number): number {
  const now = new Date(nowMs);
  const day = now.getUTCMonth() === 1 && now.getUTCDate() === 29 ? 28 : now.getUTCDate();
  return Date.UTC(now.getUTCFullYear() - age, now.getUTCMonth(), day) / 1000;
}

/** O perfil que está na cinta; `null` se falta (ou repete) alguma das chaves. */
export function readStrapProfile(text: string, nowMs: number): StrapProfile | null {
  const weightG = single(text, 'weight');
  const heightMm = single(text, 'height');
  const birthday = single(text, 'birthday');
  const maxHr = single(text, 'MAXHR');
  if (weightG === null || heightMm === null || birthday === null || maxHr === null) {
    return null;
  }
  return { weightG, heightMm, age: ageAt(birthday, nowMs), maxHr };
}

/** Os dois perfis batem. A idade é comparada pela idade, não pela data: comparar a data reenviaria todo dia. */
export function sameStrapProfile(a: StrapProfile, b: StrapProfile): boolean {
  return a.weightG === b.weightG && a.heightMm === b.heightMm && a.age === b.age && a.maxHr === b.maxHr;
}

/**
 * O texto do perfil com peso, altura, nascimento, FC máxima e a hora da
 * atualização trocados. `null` (nada a enviar) se alguma dessas chaves faltar
 * ou aparecer mais de uma vez.
 */
export function patchStrapProfile(text: string, wanted: StrapProfile, nowMs: number): string | null {
  const values: [string, number][] = [
    ['updated_at', Math.floor(nowMs / 1000)],
    ['birthday', birthdayFor(wanted.age, nowMs)],
    ['weight', Math.round(wanted.weightG)],
    ['height', Math.round(wanted.heightMm)],
    ['MAXHR', Math.round(wanted.maxHr)],
  ];
  let patched = text;
  for (const [key, value] of values) {
    if (single(patched, key) === null) {
      return null;
    }
    patched = patched.replace(new RegExp(`("${key}"\\s*:\\s*)-?\\d+`), (_, head: string) => head + value);
  }
  return patched;
}

/**
 * O texto em UTF-8, sem depender de `TextEncoder` (mesmo motivo de
 * `utf8Decode`). O perfil da cinta é ASCII; o resto é só por garantia.
 */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000)
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
  }
  return Uint8Array.from(out);
}
