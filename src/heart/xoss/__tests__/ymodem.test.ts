import {
  ACK,
  C,
  CAN,
  crc16Arc,
  encodeBlock,
  EOT,
  MAX_TRIES,
  NAK,
  parseHeader,
  YmodemReceiver,
  YmodemSender,
  type YmodemStep,
} from '../ymodem';

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));
/** O que um passo manda, em listas de bytes. */
const sent = (step: YmodemStep) => step.send.map((item) => Array.from(item));

/** Um bloco em pedaços de 20 bytes, como chegam as notificações. */
function chunks(block: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < block.length; i += 20) out.push(block.subarray(i, i + 20));
  return out;
}

/** Entrega um bloco pedaço a pedaço e devolve o último passo. */
function feed(receiver: YmodemReceiver, block: Uint8Array): YmodemStep {
  const steps = chunks(block).map((chunk) => receiver.push(chunk));
  // Os pedaços do meio só pedem para esperar.
  steps.slice(0, -1).forEach((step) => expect(step.send).toEqual([]));
  return steps.at(-1)!;
}

describe('CRC-16/ARC e blocos', () => {
  it('bate com o valor de conferência e com o cliente de referência', () => {
    expect(crc16Arc(ascii('123456789'))).toBe(0xbb3d);
    const payload = [...ascii('filelist.txt 41'), ...new Array(128 - 15).fill(0)];
    // Calculado com `crc16_arc` de tools/xoss/xoss.py.
    expect(crc16Arc(payload)).toBe(0x7904);
  });

  it('monta o bloco com número, complemento, 128 bytes e CRC big-endian', () => {
    const block = encodeBlock(0, ascii('filelist.txt 41'));
    expect(block).toHaveLength(133);
    expect(Array.from(block.subarray(0, 3))).toEqual([0x01, 0x00, 0xff]);
    expect(Array.from(block.subarray(131))).toEqual([0x79, 0x04]);
  });

  it('lê "nome tamanho" do bloco zero (espaço ou NUL)', () => {
    expect(parseHeader(ascii('user_profile.json 123'))).toEqual({ name: 'user_profile.json', size: 123 });
    expect(parseHeader([...ascii('a.fit'), 0, ...ascii('77'), 0, 0])).toEqual({ name: 'a.fit', size: 77 });
    expect(parseHeader([0, 0, 0])).toEqual({ name: '', size: null });
  });
});

describe('receptor', () => {
  const file = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);
  const header = () => encodeBlock(0, ascii(`teste.fit ${file.length}`));
  const block = (n: number) => encodeBlock(n, file.subarray((n - 1) * 128, n * 128));

  function start() {
    const receiver = new YmodemReceiver();
    expect(sent(receiver.start())).toEqual([[C]]);
    return receiver;
  }

  it('baixa o arquivo inteiro em pedaços de 20 bytes e corta no tamanho', () => {
    const receiver = start();
    expect(sent(feed(receiver, header()))).toEqual([[ACK], [C]]);
    expect(receiver).toMatchObject({ name: 'teste.fit', size: 300 });
    for (const n of [1, 2, 3]) expect(sent(feed(receiver, block(n)))).toEqual([[ACK]]);
    const eot = receiver.push([EOT]);
    expect(sent(eot)).toEqual([[NAK]]);
    const done = receiver.push([EOT]);
    expect(done).toMatchObject({ done: true, error: null });
    expect(sent(done)).toEqual([[ACK]]);
    expect(receiver.result()).toEqual(file);
  });

  it('bloco zero repetido antes do primeiro bloco de dados: ACK e C de novo, sem anexar', () => {
    const receiver = start();
    feed(receiver, header());
    expect(sent(feed(receiver, header()))).toEqual([[ACK], [C]]);
    for (const n of [1, 2, 3]) feed(receiver, block(n));
    receiver.push([EOT]);
    receiver.push([EOT]);
    expect(receiver.result()).toEqual(file);
  });

  it('bloco de número repetido (ACK perdido): ACK sem anexar', () => {
    const receiver = start();
    feed(receiver, header());
    feed(receiver, block(1));
    expect(sent(feed(receiver, block(1)))).toEqual([[ACK]]);
    feed(receiver, block(2));
    feed(receiver, block(3));
    receiver.push([EOT]);
    receiver.push([EOT]);
    expect(receiver.result()).toEqual(file);
  });

  it('CRC ruim: espera o silêncio, pede de novo com NAK e segue', () => {
    const receiver = start();
    feed(receiver, header());
    const bad = block(1);
    bad[131] ^= 0xff;
    // O bloco ruim só se revela inteiro, e não ganha resposta na hora.
    expect(chunks(bad).flatMap((chunk) => receiver.push(chunk).send)).toEqual([]);
    // O que ainda chegar dele é descartado, e o silêncio recomeça a contar.
    const drained = receiver.push([0x42]);
    expect(drained.send).toEqual([]);
    expect(sent(receiver.timeout())).toEqual([[NAK]]);
    for (const n of [1, 2, 3]) expect(sent(feed(receiver, block(n)))).toEqual([[ACK]]);
    receiver.push([EOT]);
    expect(receiver.push([EOT]).done).toBe(true);
    expect(receiver.result()).toEqual(file);
  });

  it('prazo sem bloco: NAK, e depois de 5 seguidos desiste com CAN', () => {
    const receiver = start();
    feed(receiver, header());
    for (let i = 0; i < 5; i++) expect(sent(receiver.timeout())).toEqual([[NAK]]);
    const gaveUp = receiver.timeout();
    expect(gaveUp.error).not.toBeNull();
    expect(sent(gaveUp)).toEqual([[CAN]]);
  });

  it('sem o bloco zero desiste com CAN', () => {
    const receiver = start();
    const step = receiver.timeout();
    expect(step.error).not.toBeNull();
    expect(sent(step)).toEqual([[CAN]]);
  });

  it('sem o segundo EOT confirma assim mesmo: os dados estão completos', () => {
    const receiver = start();
    feed(receiver, header());
    for (const n of [1, 2, 3]) feed(receiver, block(n));
    receiver.push([EOT]);
    const step = receiver.timeout();
    expect(step.done).toBe(true);
    expect(sent(step)).toEqual([[ACK]]);
  });

  it('EOT antes do tamanho anunciado: o arquivo incompleto é recusado', () => {
    const receiver = start();
    feed(receiver, header());
    feed(receiver, block(1));
    expect(sent(receiver.push([EOT]))).toEqual([[NAK]]);
    const step = receiver.push([EOT]);
    expect(step).toMatchObject({ done: false, error: 'Arquivo incompleto.' });
    // Fecha a conversa com a cinta assim mesmo.
    expect(sent(step)).toEqual([[ACK]]);
  });

  it('arquivo vazio: EOT logo depois do bloco zero', () => {
    const receiver = start();
    feed(receiver, encodeBlock(0, ascii('filelist.txt 0')));
    receiver.push([EOT]);
    expect(receiver.push([EOT]).done).toBe(true);
    expect(receiver.result()).toEqual(new Uint8Array(0));
  });

  it('CAN da cinta encerra sem responder', () => {
    const receiver = start();
    feed(receiver, header());
    const step = receiver.push([CAN]);
    expect(step.error).not.toBeNull();
    expect(step.send).toEqual([]);
  });
});

describe('emissor', () => {
  const data = Uint8Array.from({ length: 200 }, (_, i) => i & 0xff);

  it('espera o C, manda o bloco zero, os blocos com ACK e os dois EOT', () => {
    const sender = new YmodemSender('user_profile.json', data);
    expect(sender.start().send).toEqual([]);
    const header = sender.push([C]);
    expect(sent(header)).toEqual([Array.from(encodeBlock(0, ascii('user_profile.json 200')))]);
    expect(sender.push([ACK]).send).toEqual([]);
    expect(sent(sender.push([C]))).toEqual([Array.from(encodeBlock(1, data.subarray(0, 128)))]);
    expect(sent(sender.push([ACK]))).toEqual([Array.from(encodeBlock(2, data.subarray(128)))]);
    expect(sent(sender.push([ACK]))).toEqual([[EOT]]);
    expect(sent(sender.push([NAK]))).toEqual([[EOT]]);
    expect(sender.push([ACK])).toMatchObject({ done: true, error: null });
  });

  it('o ACK e o C do bloco zero podem chegar juntos', () => {
    const sender = new YmodemSender('a', data);
    sender.push([C]);
    expect(sent(sender.push([ACK, C]))[0][1]).toBe(1);
  });

  it('bloco sem ACK vai de novo, até 3 vezes, e depois cancela', () => {
    const sender = new YmodemSender('a', data);
    sender.push([C]);
    sender.push([ACK, C]);
    // A primeira ida, a segunda pelo prazo e a terceira pelo NAK: são as 3 tentativas.
    const again = sender.timeout();
    expect(sent(again)[0][1]).toBe(1);
    expect(sent(sender.push([NAK]))[0][1]).toBe(1);
    expect(MAX_TRIES).toBe(3);
    const gaveUp = sender.timeout();
    expect(gaveUp.error).toContain('sem ACK');
    expect(sent(gaveUp)).toEqual([[CAN]]);
  });

  it('sem o C inicial cancela', () => {
    const sender = new YmodemSender('a', data);
    const step = sender.timeout();
    expect(step.error).not.toBeNull();
    expect(sent(step)).toEqual([[CAN]]);
  });

  it('sem NAK depois do primeiro EOT, manda o segundo assim mesmo', () => {
    const sender = new YmodemSender('a', Uint8Array.of(1));
    sender.push([C]);
    sender.push([ACK, C]);
    expect(sent(sender.push([ACK]))).toEqual([[EOT]]);
    expect(sent(sender.timeout())).toEqual([[EOT]]);
    expect(sender.push([ACK]).done).toBe(true);
  });

  it('o receptor e o emissor se entendem', () => {
    const payload = Uint8Array.from({ length: 1000 }, (_, i) => (i * 13) & 0xff);
    const sender = new YmodemSender('x.bin', payload);
    const receiver = new YmodemReceiver();
    let toSender: number[] = Array.from(receiver.start().send[0]);
    let done = false;
    for (let round = 0; round < 100 && !done; round++) {
      const fromSender = sender.push(toSender);
      toSender = [];
      for (const item of fromSender.send) {
        for (const chunk of chunks(item)) {
          const step = receiver.push(chunk);
          step.send.forEach((reply) => toSender.push(...reply));
          done ||= step.done;
        }
      }
    }
    expect(done).toBe(true);
    expect(receiver.result()).toEqual(payload);
  });
});
