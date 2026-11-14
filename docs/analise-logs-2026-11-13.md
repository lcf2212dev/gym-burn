# Análise dos logs da academia — 2026-11-13 (Gym Burn 1.3.4)

- **Registros:** `/sdcard/Documents/GymBurn/gym-burn-2026-11-13_16-11-16.txt` até `…16-45-31.txt` (copiados para `gymburn-logs/2026-11-13/GymBurn/`)
- **Aparelho:** Xiaomi 23049PCD8G · Bluetooth ligado
- **Esteira:** `VISION ID 1AB1` (`A0:BB:3E:30:1A:B1`) · módulo **WiLinktech WLT8258**, firmware **V10.23.17**, software **V100.0.0**
- **Resultado da visita:** **sem controle**. O teste automático do canal alternativo não recebeu nenhuma resposta e os controles FTMS continuaram recusados.

---

## TL;DR

1. O plano automático rodou em **todas as conexões** (10 vezes entre 16:11 e 16:45): escreveu o frame de *machine info* do AFG Pro no `FFF3` (`55 AA 00 00 01 02 00 00 00 00`) **sem nenhuma notificação no `FFF4`**.
2. Na variante seguinte (escrita no `FFF1`) o módulo **recusou a escrita de 10 bytes com GATT status 13** (`GATT_INVALID_ATTRIBUTE_LENGTH`) e o plano **abortou** — um bug nosso: as variantes seguintes (sequência, CRC invertido, ack) nunca rodaram.
3. O módulo é o **WLT8258, um módulo de transmissão transparente BLE↔UART** (datasheet da WiLinktech): o serviço `0xFFF0` é uma **ponte serial**, não o protocolo Gizwits do app AFG Pro. Os frames que escrevemos foram para o UART do console e não há evidência de que o console os entenda.
4. Os controles FTMS foram recusados como sempre: Start → `80 07 05`, Stop → `80 08 05` (`Control Not Permitted`).
5. Conclusão: **nesta unidade não há canal de controle BLE conhecido**. O caminho Gizwits não se aplica; para controlar seria preciso descobrir o protocolo UART console↔módulo (ou usar o painel).

---

## 1. Linha do tempo da visita

| Hora | O que aconteceu |
| --- | --- |
| 16:11:50 | Conectou em `VISION ID 1AB1`; GATT completo; `Esteira pronta` |
| 16:11:53 | Teste automático: `FFF3 ← 55 AA 00 00 01 02 00 00 00 00`; **nenhum `FFF4`** |
| 16:11:56 | Variante `FFF1` falhou (`status=13`) e o plano abortou |
| 16:12:38 | Reconectou (nova tentativa); mesmo resultado |
| 16:13:09 | Usuário tocou **Iniciar** → FTMS `Request Control` sem resposta; Start recusado `80 07 05` |
| 16:17, 16:21, 16:27, 16:30 | Mais conexões e testes automáticos; todos sem resposta no `FFF4` |
| 16:31 | Usuário abriu a Sonda: escreveu `00` no `FFF3` e no `FFF1` (aceitos), leu `FFF1=00`, `FFF2=00`; `FFF5` recusou leitura (`status=2`); assinou `FFF4` — **nenhuma notificação** |
| 16:22–16:37 | Mais comandos FTMS de Parar recusados (`80 08 05`) e falhas de conexão (`Device disconnected`, timeout de 15 s) |
| 16:41 | Timeout ao conectar (15 s) |
| 16:45 | Última conexão + teste automático; mesmo silêncio do `FFF4` |
| 16:49 | Tentativa de conexão com Bluetooth desligado |

## 2. Evidências do teste automático

Primeira tentativa (16:11):

```
16:11:53.091 info   Teste Gizwits: começando o plano automático
16:11:53.234 tx     Teste Gizwits (FFF3)  hex=55 AA 00 00 01 02 00 00 00 00
16:11:56.353 error  Teste Gizwits: falha ao escrever no FFF1:
  Error writing 0000fff1-… status=13
```

- Nenhuma linha `Teste Gizwits: notificação` existe em **nenhum** dos arquivos de 13/11.
- O `FFF4` foi assinado (pelo plano) e, na Sonda (16:31:37), a assinatura ficou ativa até o fim; mesmo assim **zero notificações**.
- `FFF5` recusa leitura apesar de anunciar `[read]` (`Error reading … status=2`).
- `FFF1` aceita **1 byte** (`00`), mas recusa **10 bytes** (`status=13`) — comportamento de um canal curto de configuração, não de um comando de esteira.

## 3. O que é o módulo (e por que o AFG não se aplica)

O Device Information da esteira lê:

```
Fabricante: WiLinktech
Serial:     WLT8258
Firmware:   V10.23.17
Software:   V100.0.0
```

A WiLinktech descreve o **WLT8258** como *módulo de transmissão transparente BLE 5.0 com UART* (datasheet de 2020): a aplicação fala com o módulo por BLE e o módulo **repassa os bytes para o UART** do produto; no sentido inverso, o que chega pelo UART vira notificação BLE. O serviço `0xFFF0` do datasheet é exatamente “透传 Service” (serviço de passagem), com características de escrita/notificação — não há comandos de motor definidos no módulo.

O app **AFG Pro** usa um protocolo próprio (Gizwits “BLE Treadmill SDK”) porque o módulo/console dos produtos AFG fala esse protocolo. A T600X usa outro firmware/console; os frames Gizwits escritos no `FFF3` foram apenas bytes enviados ao UART do console — que não respondeu.

## 4. Por que os controles FTMS continuaram recusados

- `Fitness Machine Feature` = `2C 3E 00 00 10 00 00 00` → **Target Setting Features = 0x10** (só frequência cardíaca).
- `Start or Resume` → `80 07 05`; `Stop or Pause` → `80 08 05` (`Control Not Permitted`).
- Isso confirma o que já sabíamos desde 11/11: **o FTMS desta unidade é somente leitura para velocidade/inclinação**.

## 5. Correções e próximos passos

### Já corrigido no app (1.3.7)

- O plano **continua após falha de uma variante**: erro de escrita marca a tentativa como `error` e segue para a próxima (antes o erro no `FFF1` abortava tudo).
- O plano agora **lê e registra** `FFF1`, `FFF2` e `FFF5` antes dos testes.
- Novas variantes seguras: sincronismo `AA 55` e pausa com CRC normal.
- O `FFF4` é registrado explicitamente quando a assinatura é ativada.
- O cartão de resultado mostra o resumo de tentativas e, quando nada responde, sugere o app AFG Pro instalado.
- A **varredura automática de bytes seguros** (FFF3/FFF1: 00, 01, 55, AA e `AT\r\n`), a mesma da Sonda, agora roda sozinha no fim do plano — **sem abrir a Sonda**.

### Próxima ida à academia (em ordem)

1. ~~**Testar o app AFG Pro** na T600X~~ — **testado pelo usuário: não funcionou**. Isso fecha a última hipótese de app JHT controlando esta unidade; o BLE da T600X não expõe controle conhecido.
2. **Se ainda quisermos evidência definitiva**, capturar o tráfego BLE com HCI snoop:
   - já deixei a opção ligada no celular (`settings secure bluetooth_hci_log=1`);
   - na academia, usar o app oficial (Vision/AFG) na esteira;
   - no fim, conectar o celular ao computador e rodar `adb bugreport` (o `btsnoop_hci.log` vai dentro do relatório) — com ele vemos **exatamente** o que o app oficial escreve/lê no `FFF0`.
3. Se o AFG responder, replicar o protocolo dele no GymBurn usando o snoop como referência.
4. Se nada responder por BLE, o controle só será possível pelo **painel** (ou por acesso ao UART do console, que exige abrir o equipamento — fora do escopo seguro). Com o AFG Pro também falhando, a recomendação é tratar o app como **monitoramento + copiloto** e usar o painel para comandar.

**Nada de firmware**: em nenhum momento o app baixou, gravou ou tentou atualizar firmware; o teste é só leitura/escrita no módulo.

## 6. Pareamento no Bluetooth do celular

O usuário relatou que a esteira aparecia na lista de Bluetooth do Android, mas **rejeitava na hora**
ao tocar para parear. Isso é esperado: a T600X é um periférico **BLE sem pareamento/bonding** para
esse perfil; quem conecta é o app, direto por GATT, sem passar pela tela de Bluetooth do sistema.
Os logs mostram o app conectando com sucesso várias vezes (16:11, 16:12, 16:17, 16:21, 16:27,
16:30 e 16:45), então a rejeição do pareamento **não foi a causa** da falha de controle.

A dica “não pareie pela tela de Bluetooth do celular; o app conecta direto” foi adicionada à tela de
conexão na versão 1.3.6.

## 7. Outros achados operacionais

- O plano antigo demorava ~3 s na primeira tentativa; o novo leva ~20 s no total (variações). Se a lona começar a andar no meio, ele **aborta com segurança** e espera a lona parar.
- Houve falhas de conexão no fim da visita (timeout de 15 s, `Device disconnected`, Bluetooth desligado) — vale conferir o modo APP do painel e manter o celular perto.
- O `FFF4` assinado no plano não recebeu **nada**; o canal parece mudo sem um comando específico do console.
