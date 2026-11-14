import { bytesToHex } from '@/ftms';

import type {
  VendorAction,
  VendorFormat,
  VendorMapping,
  VendorValueEncoding,
} from './types';
import { VENDOR_ACTION_LABELS } from './types';

/** Token de um byte em hexadecimal. */
const HEX_BYTE = /^[0-9a-fA-F]{2}$/;

/** Marcador que o template usa no lugar do número do alvo. */
export const VENDOR_VALUE_TOKEN = '%v';

/** Caracteres imprimíveis e de controle aceitos no formato ASCII. */
const ASCII_CONTROL = new Set([0x09, 0x0a, 0x0d]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function u16Le(raw: number): number[] {
  const value = clamp(Math.round(raw), 0, 0xffff);
  return [value & 0xff, (value >> 8) & 0xff];
}

function s16Le(raw: number): number[] {
  const value = clamp(Math.round(raw), -0x8000, 0x7fff) & 0xffff;
  return [value & 0xff, (value >> 8) & 0xff];
}

/**
 * Converte o número do alvo nos bytes que entram no lugar de `%v`, no formato hex.
 * As escalas vêm da engenharia reversa: FTMS manda km/h×100 e %×10; o canal
 * proprietário desta esteira também mostrou alvos de velocidade em ×16 (raw/1600).
 */
export function encodeVendorValue(value: number, encoding: VendorValueEncoding): number[] {
  switch (encoding) {
    case 'u16le-x100':
      return u16Le(value * 100);
    case 'u16le-x1600':
      return u16Le(value * 1600);
    case 's16le-x10':
      return s16Le(value * 10);
    case 'u8':
      return [clamp(Math.round(value), 0, 0xff)];
    case 'ascii1':
      throw new Error('A codificação de texto só vale no formato ASCII.');
  }
}

/** Número do alvo em texto, para os templates do formato ASCII. */
export function formatVendorValue(value: number, encoding: VendorValueEncoding): string {
  if (!Number.isFinite(value)) {
    throw new Error('Valor de alvo inválido.');
  }
  return encoding === 'ascii1' ? value.toFixed(1) : String(Math.round(value));
}

/** Decodifica `\r`, `\n`, `\t` e `\\` de um template ASCII. */
function decodeAsciiEscapes(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = text[i + 1];
    if (next === 'r') out += '\r';
    else if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === '\\') out += '\\';
    else throw new Error(`Escape desconhecido no template ASCII: \\${next ?? ''}`);
    i++;
  }
  return out;
}

function buildAsciiPayload(template: string): Uint8Array {
  const text = decodeAsciiEscapes(template);
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x7e || (code < 0x20 && !ASCII_CONTROL.has(code))) {
      throw new Error(`O template ASCII só aceita texto imprimível e \\r, \\n, \\t.`);
    }
    bytes.push(code);
  }
  return Uint8Array.from(bytes);
}

function buildHexPayload(template: string): Uint8Array {
  const bytes: number[] = [];
  for (const token of template.trim().split(/\s+/)) {
    if (token === '') continue;
    if (!HEX_BYTE.test(token)) {
      throw new Error(`"${token}" não é um byte hexadecimal (use algo como "02 FE 01").`);
    }
    bytes.push(parseInt(token, 16));
  }
  return Uint8Array.from(bytes);
}

/** Payload literal de um template, sem valor de alvo (para a varredura da Sonda). */
export function buildLiteralPayload(format: VendorFormat, template: string): Uint8Array {
  return format === 'ascii' ? buildAsciiPayload(template) : buildHexPayload(template);
}

/**
 * Monta o payload de uma ação: aplica o valor do alvo no `%v` e converte o
 * template para bytes. Lança erro com texto pronto para a tela quando o
 * template é inválido ou falta o valor.
 */
export function buildVendorPayload(
  mapping: VendorMapping,
  action: VendorAction,
  value: number | null,
): Uint8Array {
  const template = mapping.actions[action];
  if (template === undefined || template.trim() === '') {
    throw new Error(`O comando "${VENDOR_ACTION_LABELS[action]}" não está mapeado.`);
  }
  const needsValue = template.includes(VENDOR_VALUE_TOKEN);
  if (needsValue && (value === null || !Number.isFinite(value))) {
    throw new Error(`O comando "${VENDOR_ACTION_LABELS[action]}" precisa de um valor de alvo.`);
  }
  const encoding = action.startsWith('speed') ? mapping.speedEncoding : mapping.inclineEncoding;
  if (!needsValue) {
    return buildLiteralPayload(mapping.format, template);
  }
  if (mapping.format === 'hex') {
    if (encoding === 'ascii1') {
      throw new Error('O formato hex não aceita a codificação de texto como valor.');
    }
    const encoded = bytesToHex(encodeVendorValue(value as number, encoding));
    return buildLiteralPayload(mapping.format, template.split(VENDOR_VALUE_TOKEN).join(encoded));
  }
  if (encoding !== 'ascii1') {
    throw new Error('No formato ASCII, use a codificação de texto (1 decimal) para o valor.');
  }
  const formatted = formatVendorValue(value as number, encoding);
  return buildLiteralPayload(mapping.format, template.split(VENDOR_VALUE_TOKEN).join(formatted));
}
