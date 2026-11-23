import { FACTORY_PROFILE } from '../__fakes__/fake-xoss-strap';
import {
  ageAt,
  birthdayFor,
  patchStrapProfile,
  readStrapProfile,
  sameStrapProfile,
  utf8Encode,
} from '../profile';

const NOW = Date.UTC(2026, 10, 22, 21, 0, 0);
/** O perfil do usuário gravado em 22/11/2026. */
const USER = { weightG: 82500, heightMm: 1760, age: 41, maxHr: 179 };

describe('perfil da cinta', () => {
  it('lê o de fábrica: 70 kg, 1,70 m, FC máxima 200', () => {
    // Nascimento 01/01/1984: 42 anos em 22/11/2026.
    expect(readStrapProfile(FACTORY_PROFILE, NOW)).toEqual({
      weightG: 70000,
      heightMm: 1700,
      age: 42,
      maxHr: 200,
    });
  });

  it('a idade sai do nascimento, em UTC, contando o aniversário', () => {
    const birthday = Date.UTC(1985, 10, 23) / 1000;
    expect(ageAt(birthday, NOW)).toBe(40);
    expect(ageAt(birthday, Date.UTC(2026, 10, 23))).toBe(41);
    expect(ageAt(birthdayFor(41, NOW), NOW)).toBe(41);
    // Em 29/2 o nascimento vai para 28/2: a idade não fica um ano menor.
    const leap = Date.UTC(2028, 1, 29, 12);
    expect(ageAt(birthdayFor(30, leap), leap)).toBe(30);
  });

  it('compara pela idade, não pela data', () => {
    const a = { ...USER };
    expect(sameStrapProfile(a, { ...USER })).toBe(true);
    expect(sameStrapProfile(a, { ...USER, age: 42 })).toBe(false);
    expect(sameStrapProfile(a, { ...USER, maxHr: 180 })).toBe(false);
  });

  it('corrige campo a campo e deixa gênero, LTHR, fuso e série como estão', () => {
    const patched = patchStrapProfile(FACTORY_PROFILE, USER, NOW)!;
    expect(readStrapProfile(patched, NOW)).toEqual(USER);
    expect(patched).toContain('"gender":1');
    expect(patched).toContain('"LTHR":170');
    expect(patched).toContain('"time_zone":-10800');
    expect(patched).toContain('"sn":"000001"');
    expect(patched).toContain(`"updated_at":${Math.floor(NOW / 1000)}`);
  });

  it('com chave faltando ou repetida não corrige nem lê', () => {
    const missing = FACTORY_PROFILE.replace('"MAXHR":200,', '');
    expect(readStrapProfile(missing, NOW)).toBeNull();
    expect(patchStrapProfile(missing, USER, NOW)).toBeNull();
    const noUpdate = FACTORY_PROFILE.replace('"updated_at":1763800000,', '');
    expect(patchStrapProfile(noUpdate, USER, NOW)).toBeNull();
    const twice = FACTORY_PROFILE.replace('}', ',"weight":1}');
    expect(readStrapProfile(twice, NOW)).toBeNull();
    expect(patchStrapProfile(twice, USER, NOW)).toBeNull();
  });

  it('codifica em UTF-8', () => {
    expect(Array.from(utf8Encode('{"a":1}'))).toEqual([123, 34, 97, 34, 58, 49, 125]);
    expect(Array.from(utf8Encode('é'))).toEqual([0xc3, 0xa9]);
  });
});
