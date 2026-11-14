# Dossiê da esteira — coleta de 2026-11-12 (VISION ID 1AB1)

Este documento reúne **tudo o que foi possível extrair da esteira** no registro de 2026-11-12, com o
modo **Coleta** do app gravado **duas vezes** na mesma sessão (esteira conectada e app aberto). É
material de apoio para a engenharia reversa do protocolo proprietário (0xFFF0), que ainda não é
conhecido.

- **Unidade:** `VISION ID 1AB1` / MAC `A0:BB:3E:30:1A:B1` — **uma unidade diferente** da de
  11/11 (`VISION ID 1931` / `A0:BB:3E:40:19:31`).
- **Registro bruto:** `gymburn-logs/device/GymBurn/gym-burn-2026-11-12_16-08-29.txt`
  (258.400 bytes, 2.742 linhas, 16:08:29.750 → 16:38:26.618; puxado do celular por `adb`).
- **Celular/app:** Xiaomi 23049PCD8G, Android 15 (API 35); Gym Burn 1.0.0 (versionCode 1).
- **Análises de apoio (mesmo workspace, fora do git):**
  - `gymburn-logs/analise/gatt/identidade-e-gatt.md` — identidade, anúncio, GATT, as 27 leituras;
  - `gymburn-logs/analise/gatt/leituras.csv` e `gatt-bruto.txt`;
  - `gymburn-logs/analise/telemetria/telemetria-e-eventos.md` — stream 0x2ACD, eventos, escalas;
  - `gymburn-logs/analise/telemetria/treadmill-data.csv` (1.762 pacotes) e `resumo.json`;
  - `gymburn-logs/analise/telemetria/comandos-ftms.md` e `notificacoes-extras.md` — Control Point e
    auditoria das assinaturas extras;
  - `gymburn-logs/analise/historico/comparacao-unidades.md` — unidade de hoje × unidade de 11/11;
  - `gymburn-logs/analise/pesquisa/pesquisa-externa.md` — WiLinktech, TI, Telink, FTMS da linha T600;
  - `gymburn-logs/analise/pesquisa/proximos-experimentos.md` — roteiro priorizado da próxima ida.

**Convenções:** *[fato]* = observado no registro ou em documento externo citado; *[hipótese]* =
interpretação consistente com os dados, mas não provada; horários no fuso local (UTC-03:00).

---

## 0. Resumo executivo

1. **O que é:** console de esteira **Matrix/Vision da linha T600/T600X** (Johnson Health Tech),
   *[inferência a partir do nome “VISION”, da ficha 0,8–22 km/h e do modelo T600X adotado no projeto]*,
   com módulo BLE **WiLinktech WLT8258** (serial `WLT8258`, firmware do módulo `V10.23.17`, software
   `V100.0.0`; Device Information auto-declarado). O MAC não identifica o fabricante (ver §2.5).
2. **O que ela expõe:** 8 serviços / 39 características GATT. Além do FTMS padrão (0x1826), expõe
   **0x181C** (User Data, todo zerado), **0x1816** (CSC, vazio), **0xFFF0** (proprietário:
   `FFF1 read+write`, `FFF2 read`, `FFF3 write`, `FFF4 notify`, `FFF5 read`) e um serviço custom
   `00010203-…-0a0b0c0d1912` com a característica `…2b12` (lê `00`). O anúncio BLE só cita
   `[0x1826, 0x1816]`; os demais serviços só aparecem depois de conectar.
3. **O que funciona:** leitura de telemetria FTMS a ~1 Hz (Treadmill Data 0x2ACD, Training Status
   0x2AD3, Machine Status 0x2ADA). Velocidade, distância, tempo, energia, MET e FC são coerentes com
   o treino de 28 minutos que o usuário fez no painel (5,0 km/h, inclinação variando 1,5–6 %).
4. **O que não funciona:** **controle por FTMS**. `Target Setting Features = 0x10` (só frequência
   cardíaca): o próprio equipamento declara que não aceita alvo de velocidade nem de inclinação. O
   Control Point aceitou `Request Control` mas recusou **37 comandos** com `Control Not Permitted`
   (`0x05`) — mesmo resultado da unidade de 11/11. Caminho de controle: somente o 0xFFF0.
5. **O 0xFFF0 continua mudo** — 17 minutos de assinatura de `FFF4` (com a esteira andando, inclinação
   mudando e painel em uso) = **0 pacotes**; `FFF1`/`FFF2` leem `00`; `FFF5` recusa leitura
   (`ATT status=2`, Read Not Permitted). A hipótese da sonda (FFF4 espelhar o painel espontaneamente)
   **não se confirmou**: o canal parece ser **sob demanda** (só reage a escrita/handshake).
6. **Achado externo mais importante:** o conjunto `0xFFF0 + FFF1..FFF5` com essas propriedades é
   **exatamente o "SimpleGATTProfile" de demonstração da Texas Instruments** (SWRU301) — cujo demo
   copia Char3 (write) para Char4 (notify) a cada ~5 s. Isso dá uma **previsão testável** para a
   próxima ida: escrever em `FFF3` e esperar notificação em `FFF4`.
7. **Duas descobertas de protocolo tiradas desta coleta:**
   - **velocidade de alvo no 0x2ADA é ×16 fora da spec** (`raw/1600` = km/h; 8000 = 5,0 km/h);
   - **inclinação no 0x2ACD não usa a unidade de 0,1 % da spec**; os dados (e o MET calculado pelo
     firmware) indicam escala **≈ 0,015 %/unidade** (contador interno 0–1000 ↔ 0–15 %) *[hipótese
     forte]*. O app, que divide por 10, mostraria 10–40 % onde o painel mostrava 1,5–6 %.
8. **Próximo passo para controle:** escrever em `FFF1`/`FFF3` com `FFF4` assinado (e ler descritores
   `0x2901/0x2902`), conforme `proximos-experimentos.md` — receita resumida em §10.

---

## 1. O que foi coletado e como

### 1.1 A sessão

| Item | Valor |
| --- | --- |
| App aberto | 16:08:29.750 |
| Busca BLE | 16:08:37–16:08:50 (164 aparelhos, **1 com FTMS**: a esteira, RSSI **-43 dBm**) |
| Conexão | 16:08:50.319 → 16:08:52.634 (conectado, GATT descoberto, Device Information lido) |
| Lona começou a andar | 16:10:13 (rampa de 0,8 → 5,0 km/h em ~4 s) |
| Lona parou | 16:38:13 (desaceleração 5,0 → 3,0 → 0,8 km/h; “Parar” no app às 16:38:24) |
| Conexão caiu | 16:38:26.595 (escrita no Control Point falhou com `status=133`; “Conexão perdida”) |
| Pacotes 0x2ACD | **1.762** (16:08:53.448 → 16:38:20.736), flags `0x078C`, 20 bytes, ~1 Hz |
| Treino medido | **28 min** (tempo decorrido 1680 s), **2.329 m**, **276 kcal** |

### 1.2 As duas gravações do modo Coleta

O registro tem **duas** gravações de Coleta, como o usuário adiantou:

| Gravação | “Coleta RE iniciada” | “Coleta RE ativa” | Encerrada |
| --- | --- | --- | --- |
| nº 1 | 16:09:16.111 | 16:09:18.196 — **6 assinaturas, 27 leituras** | **sem linha de encerramento**; assinaturas canceladas às 16:16:28.614 (usuário saiu da tela) |
| nº 2 | 16:17:12.203 | 16:17:14.270 — **6 assinaturas, 27 leituras** | 16:27:03.195 — “**0 notificações**, 27 leituras, **4 marcas**” |

O resultado das duas é **byte a byte o mesmo** nas 27 leituras; a única diferença é o Training Status
(`00 01` = Idle na nº 1; `00 0F` = Post-Workout na nº 2, com a lona andando — ver §7.5). A gravação
nº 1 não tem “encerrada” porque `src/app/coleta.tsx` só grava essa linha no botão **Parar**; sair da
tela apenas cancela as assinaturas (as marcas da nº 1, 4 delas às 16:11, ficaram registradas mesmo
assim). Na prática, **a nº 2 é a corrida válida** para o resumo do app; ambas servem como registro.

Marcas do usuário (as 8 do arquivo, 4 por gravação) e o dado que confirma cada uma estão na §7.4.

### 1.3 Artefatos brutos extraídos

- inventário GATT completo: 3 blocos (16:08:51.792, 16:09:16 e 16:17:12) — idênticos;
- 28 tentativas de leitura por gravação (27 OK + `FFF5` falhando);
- todas as notificações de 0x2ACD, 0x2AD3 e 0x2ADA;
- todos os `tx` do Control Point (76) e as respostas (73);
- 1 registro de anúncio completo da esteira e a varredura de 164 aparelhos da academia.

---

## 2. Identidade do equipamento

### 2.1 Anúncio BLE (scan)

| Campo | Valor |
| --- | --- |
| Nome | `VISION ID 1AB1` |
| Endereço | `A0:BB:3E:30:1A:B1` (público) |
| RSSI | −43 dBm |
| Serviços anunciados | `[0x1826, 0x1816]` (FTMS + Cycling Speed and Cadence) |
| Service Data 0x1826 | `01 01 00` → flags `0x01` = *Fitness Machine Available*; Fitness Machine Type `0x0001` = **bit 0 (treadmill)** |
| Manufacturer Data | company `0x000D` (**Texas Instruments**) = `A0 BB 3E 30 1A B1` (o próprio MAC) |
| Não anunciados | 0x180A, 0x181C, 0xFFF0 e o serviço custom — só aparecem após conectar |

Regra observada nas duas unidades conhecidas: **nome = `VISION ID ` + os dois últimos octetos do MAC**
(`…:1A:B1` → `1AB1`; em 11/11 `…:19:31` → `1931`). Serve para distinguir as esteiras da academia na
busca, mas **não** é serial nem código do painel.

### 2.2 Device Information (0x180A) — lido ao conectar e no Coleta

| Característica | Hex | Texto/valor decodificado |
| --- | --- | --- |
| Serial Number (0x2A25) | `57 4C 54 38 32 35 38 00 00 00` | **`WLT8258`** (+3 bytes nulos de preenchimento) |
| Firmware Revision (0x2A26) | `56 31 30 2E 32 33 2E 31 37 00` | **`V10.23.17`** |
| Software Revision (0x2A28) | `56 31 30 30 2E 30 2E 30 00 00` | **`V100.0.0`** |
| Model Number (0x2A24) | `30 30 30 30 30 30 00 00 00 00` | **`000000`** (placeholder, não é o modelo) |
| Manufacturer Name (0x2A29) | `57 69 4C 69 6E 6B 74 65 63 68` | **`WiLinktech`** |
| System ID (0x2A23) | `FA E4 E3 E2 E1 01 00 00` | 5 bytes LE fabricante `0xE1E2E3E4FA` + OUI `00-00-01` (Xerox no registro IEEE; **não é do fabricante** e não deriva do MAC) |
| Hardware Revision (0x2A27) | — | **não exposta** |
| PnP ID (0x2A50) | — | **não exposta** |

Consequências: sabemos o **módulo** (WiLinktech `WLT8258`) e o **firmware do módulo** (`V10.23.17`),
mas **não** há revisão de hardware do console nem número de série do console (a ficha completa da
máquina não vem por BLE).

### 2.3 GAP (0x1800)

| Característica | Hex | Decodificado |
| --- | --- | --- |
| Device Name (0x2A00) | `56 49 53 49 4F 4E 20 49 44 20 31 41 42 31 00 00` | `VISION ID 1AB1` |
| Appearance (0x2A01) | `00 00` | `0x0000` = Unknown |
| Peripheral Preferred Connection Parameters (0x2A04) | `06 00 0C 00 00 00 E8 03` | intervalo mín. 7,5 ms, máx. 15 ms, latência 0, supervision timeout 10 s |

### 2.4 Quem é o módulo (contexto externo, com fontes)

- **WiLinktech** = Wi-linktech Communication Technology (Shanghai) Co., Ltd. O catálogo tem o módulo
  **WLT8258** — BLE 5.0/Mesh, 512 kB flash, 64 kB SRAM, UART, comandos AT, **“transferência
  transparente”**: <http://www.wi-linktech.com/index.php/en/ProductList/WLT8258-90.html>.
- A empresa tem uma **solução para esteira/cadeira de massagem** que declara **chip TI dual-mode**,
  “transmissão transparente BT/BLE” e cita a **Johnson Health Tech** como cliente:
  <http://www.wi-linktech.com/index.php/Solution/chair-36.mhtml>.
- Isso explica o company ID **0x000D (Texas Instruments)** no anúncio — indício de linhagem TI, não
  prova (o company ID é escolhido pelo firmware).
- O `0xFFF0` com essas cinco características é o **SimpleGATTProfile de exemplo da TI** (SWRU301):
  Char1 read/write, Char2 read, Char3 write-only, Char4 notify, Char5 read **que exige link
  criptografado** — é literalmente o que o GATT da esteira mostra (detalhe em §8).
- O serviço custom `00010203-0405-0607-0809-0a0b0c0d…` usa o **base UUID da Telink** (SmartLight
  1910/1911/1912/1913/1914), mas com números próprios (`…1912`/`…2b12`). *[hipótese média]* o SoC
  pode ser um **Telink TLSR8258** (mesmo nome/specs do WLT8258), com firmware de linhagem TI.

**Síntese:** o rádio é um módulo de **transferência transparente** de terceiro (WiLinktech), com
firmware que copia reference designs da TI — ou seja, o **protocolo do console roda “por cima” de um
canal serial** e não há documentação pública dele. É exatamente o que a próxima ida precisa sondar.

### 2.5 O OUI A0:BB:3E não identifica o fabricante *[hipótese]*

O registro IEEE mostra `A0:BB:3E` como bloco **MA-L da “IEEE Registration Authority”**, subdividido em
16 blocos **MA-M** de empresas diferentes. O MAC de hoje cai em `A0BB3E3` (**WiteRiver Technology
LLC**), o de 11/11 em `A0BB3E4` (**COMSYS GmbH**) — nenhum é WiLinktech/Matrix/Vision. Hipótese mais
provável: os módulos receberam MACs de um **pool de blocos IEEE de terceiros** (prática comum em
módulos de baixo custo). Portanto: **use o Device Information e o nome, não o MAC, para identificar o
módulo**.

### 2.6 Como a academia pode ter várias unidades

Cada unidade tem nome/MAC próprios e o número sufixo do nome vem do MAC. Na próxima visita, anote o
nome (`VISION ID xxxx`) da esteira que você vai usar — no app, é o identificador que aparece no topo
do painel e é o mesmo que vai para o registro.

---

## 3. Mapa GATT completo (8 serviços, 39 características)

Inventário idêntico nas três descobertas (16:08:51.792, 16:09:16.124, 16:17:12.214) e idêntico ao da
unidade de 11/11.

| Serviço | Características (propriedades) | O que é / uso observado |
| --- | --- | --- |
| **0x1800** Generic Access | 0x2A00 [read notify], 0x2A01 [read], 0x2A04 [read] | nome, appearance, parâmetros de conexão. Notify de 0x2A00 **recusado** (§6.1) |
| **0x1801** Generic Attribute | 0x2A05 [indicate] | Service Changed — nunca usado |
| **0x180A** Device Information | 0x2A25, 0x2A26, 0x2A24, 0x2A28, 0x2A29, 0x2A23 [read] | identidade do módulo (§2.2). Sem 2A27/2A50 |
| **0x181C** User Data | 0x2A8A, 0x2A8E, 0x2A98, 0x2A85, 0x2A8C, 0x2AA2, 0x2AB5 [read] | perfil do usuário — **todo zerado** (§4.4) |
| **0x1826** Fitness Machine (FTMS) | **14** características (abaixo) | telemetria e controle — só 4 em uso |
| **custom** `00010203-0405-0607-0809-0a0b0c0d1912` | `00010203-0405-0607-0809-0a0b0c0d2b12` [read] | lê `00` (1 byte); sem documentação pública |
| **0xFFF0** proprietário | 0xFFF1 [read write], 0xFFF2 [read], 0xFFF3 [write], 0xFFF4 [notify], 0xFFF5 [read] | canal do fabricante; = SimpleGATTProfile TI (§8) |
| **0x1816** Cycling Speed and Cadence | 0x2A5B [notify], 0x2A5C [read] | CSC Feature = `00 00`; nunca notificou |

**0x1826 em detalhe (14 características):** 0x2ACC Fitness Machine Feature [read], 0x2ACD Treadmill
Data [notify], **0x2ACE** Cross Trainer Data [notify], **0x2AD0** Stair Climber Data [notify],
**0x2AD1** Rower Data [notify — listada **fora de ordem**, depois de 0x2ADA], **0x2AD2** Indoor Bike
Data [notify], 0x2AD3 Training Status [read notify], 0x2AD4 Supported Speed Range [read], 0x2AD5
Supported Inclination Range [read], 0x2AD6 Supported Resistance Level Range [read], 0x2AD7 Supported
Heart Rate Range [read], 0x2AD8 Supported Power Range [read], 0x2AD9 Fitness Machine Control Point
[write indicate], 0x2ADA Fitness Machine Status [notify]. É um **stack FTMS genérico por template**
(inclui dados de equipamentos que não são esteira; a única característica FTMS padrão ausente é
0x2ACF Step Climber). **Com tráfego real: só 0x2ACD, 0x2AD3, 0x2AD9 e 0x2ADA.**

---

## 4. As 27 leituras do modo Coleta (glossário do que a esteira entrega)

Leituras feitas pelo Coleta em 16:09:16.575–16:09:18.196 (idênticas na 2ª gravação; a única diferença
está anotada). Equivalem a um “retrato” completo do que a esteira expõe por leitura.

| # | Característica | Serviço | Hex bruto | Valor decodificado |
| --- | --- | --- | --- | --- |
| 1 | Serial Number | 0x180A | `57 4C 54 38 32 35 38 00 00 00` | `WLT8258` |
| 2 | Firmware Revision | 0x180A | `56 31 30 2E 32 33 2E 31 37 00` | `V10.23.17` |
| 3 | Model Number | 0x180A | `30 30 30 30 30 30 00 00 00 00` | `000000` (placeholder) |
| 4 | Software Revision | 0x180A | `56 31 30 30 2E 30 2E 30 00 00` | `V100.0.0` |
| 5 | Manufacturer Name | 0x180A | `57 69 4C 69 6E 6B 74 65 63 68` | `WiLinktech` |
| 6 | System ID | 0x180A | `FA E4 E3 E2 E1 01 00 00` | fabricante `0xE1E2E3E4FA`, OUI `00-00-01` |
| 7 | FFF1 (proprietário) | 0xFFF0 | `00` | `0x00` |
| 8 | FFF2 (proprietário) | 0xFFF0 | `00` | `0x00` |
| 9 | CSC Feature | 0x1816 | `00 00` | zero recursos CSC |
| 10 | Device Name | 0x1800 | `…31 41 42 31 00 00` | `VISION ID 1AB1` |
| 11 | Appearance | 0x1800 | `00 00` | Unknown |
| 12 | Peripheral Preferred Connection Parameters | 0x1800 | `06 00 0C 00 00 00 E8 03` | 7,5–15 ms / latência 0 / timeout 10 s |
| 13 | First Name | 0x181C | `00×10` | vazio |
| 14 | Height | 0x181C | `00 00` | 0 (perfil não preenchido) |
| 15 | Weight | 0x181C | `00 00` | 0 |
| 16 | Date of Birth | 0x181C | `00×4` | ano/mês/dia desconhecidos (0) |
| 17 | Gender | 0x181C | `00` | 0 (valor default do enum) |
| 18 | Language | 0x181C | `00 00` | vazio |
| 19 | Location Name | 0x181C | `00×10` | vazio |
| 20 | Fitness Machine Feature | 0x1826 | `2C 3E 00 00 10 00 00 00` | machine features `0x3E2C`; targets `0x10` (§5) |
| 21 | Training Status | 0x1826 | `00 01` | Idle. **Na 2ª gravação: `00 0F` = Post-Workout** |
| 22 | Supported Speed Range | 0x1826 | `50 00 98 08 0A 00` | 0,80–22,00 km/h, passo 0,10 |
| 23 | Supported Inclination Range | 0x1826 | `00 00 F4 01 1E 00` | 0,0–50,0 %, passo 3,0 % (implausível) |
| 24 | Supported Resistance Level Range | 0x1826 | `00 00 00 00 00 00` | faixa vazia |
| 25 | Supported Heart Rate Range | 0x1826 | `00 C8 01` | 0–200 bpm, passo 1 |
| 26 | Supported Power Range | 0x1826 | `32 00 88 13 0A 00` | 50–5000 W, passo 10 (suspeito) |
| 27 | 2B12 (custom) | custom | `00` | `0x00` |

A 28ª tentativa (leitura de **0xFFF5**) falha nas duas gravações com **`ATT status=2` (Read Not
Permitted)**, apesar de a característica ser declarada `read` no inventário.

### 4.1 O que a sessão normal já lê sozinha (fora do Coleta)

Ao conectar, o app lê automaticamente 0x180A (6 campos), 0x2ACC, 0x2AD4, 0x2AD5 e 0x2AD3. Ou seja,
**firmware/serial/modelo/fabricante já vêm em qualquer conexão** — o Coleta acrescenta as leituras dos
serviços proprietários e o dump do GATT.

---

## 5. Decodificação do perfil FTMS

### 5.1 Fitness Machine Feature (0x2ACC) = `2C 3E 00 00 | 10 00 00 00`

**Fitness Machine Features = `0x3E2C`** — bits ligados: 2, 3, 5, 9, 10, 11, 12, 13:

| O que declara medir | Coerente com o dado real? |
| --- | --- |
| bit 2 Total Distance | sim (0x2ACD envia) |
| bit 3 Inclination | sim (0x2ACD envia) |
| bit 5 Pace | **declarado e nunca emitido** (nenhum pacote traz ritmo) |
| bit 9 Expended Energy | sim |
| bit 10 Heart Rate | sim |
| bit 11 Metabolic Equivalent | sim |
| bit 12 Elapsed Time | sim |
| bit 13 Remaining Time | **declarado e nunca emitido** |

Sem Power Measurement (bit 14) e sem Force on Belt and Power Output (bit 15) — mas existe Supported
Power Range (0x2AD8): incoerência interna do template.

**Target Setting Features = `0x10`** — só o **bit 4 (Heart Rate Target Setting)**. Bits 0 (velocidade)
e 1 (inclinação) **zerados**: a esteira **declara** que não aceita alvo de velocidade/inclinação. É a
explicação direta de todos os `Control Not Permitted` (§5.3).

### 5.2 Faixas de suporte (e o que é template)

| Característica | Valor | Veredito |
| --- | --- | --- |
| Supported Speed Range | 0,80–22,00 km/h, passo 0,10 | **bate com a ficha do T600/T600X** (0,8–22 / 0,1) |
| Supported Inclination Range | 0,0–50,0 %, passo 3,0 % | **implausível** (ficha 0–15 %, 0,5 %); idêntica na unidade de 11/11 → constante de firmware |
| Supported Resistance Level Range | 0 a 0 | faixa inválida (template) |
| Supported Heart Rate Range | 0–200 bpm, passo 1 | plausível |
| Supported Power Range | 50–5000 W, passo 10 | suspeita; não mede potência |

Ou seja: **as faixas do FTMS não são confiáveis** nesta esteira — exceto a de velocidade. Use a ficha
da T600X e o painel como referência.

### 5.3 Control Point (0x2AD9) — o que a esteira aceita e recusa

Foram **76 escritas** (todas no 0x2AD9; nenhum outro canal foi escrito) e **73 respostas**:

| Comando | Escritas (`tx`) | Resposta da esteira | Observação |
| --- | --- | --- | --- |
| Request Control (`00`) | 38 | **36× Success (`80 00 01`)**; 2 sem resposta (1 timeout de 10 s) | concede o controle — mas não adianta (abaixo) |
| Start or Resume (`07`) | 2 | **2× Control Not Permitted (`80 07 05`)** | recusado |
| Stop or Pause (`08 02`) | 4 | **3× Control Not Permitted (`80 08 05`)** + 1 timeout de 10 s | recusado |
| Set Target Speed (`02 xx xx`) | 20 | **20× Control Not Permitted (`80 02 05`)** | recusado |
| Set Target Inclination (`03 xx xx`) | 12 | **12× Control Not Permitted (`80 03 05`)** | recusado |

- Os comandos do app estão **corretos pela spec** (ex.: `02 FE 01` = 5,10 km/h; `03 78 00` = 12,0 %);
  o firmware recusa de qualquer forma.
- Latência de resposta mediana: **117 ms** (105–145 ms). O timeout do app é de 10 s.
- No fim (16:38:26.585) a escrita de `Request Control` falhou com **`status=133`** e a conexão caiu
  ~10 ms depois — o erro é consequência da queda do link (a lona já estava parando desde 16:38:13),
  não causa.
- O app **repete** cada comando: se a resposta é “Control Not Permitted”, ele derruba o controle, pede
  `Request Control` de novo e repete o comando uma vez. Por isso as 76 escritas correspondem a **20
  pedidos lógicos** do usuário; o placar do próprio app em 16:38:24 registra
  `start 1/0/1/0, pause 2/0/1/1, stop 1/0/0/0, speed 10/0/10/0, inclination 6/0/6/0`
  (pedidos/aceitos/recusados/sem resposta).
- **Nenhuma escrita nos serviços proprietários foi feita nesta coleta** — o 0xFFF0 segue **não testado
  no sentido console**.

---

## 6. Telemetria da sessão (Treadmill Data 0x2ACD)

### 6.1 Formato

- **1.762 pacotes**, todos com **flags `0x078C`** e **20 bytes**, sem `more_data`, sem truncamento,
  sem bytes sobrando. Bits ligados: total distance, inclination, expended energy, heart rate, metabolic
  equivalent, elapsed time. Cadência: Δt mediano **0,999 s** (mín. 0,298 s; máx. 4,51 s na transição de
  início da lona).
- Layout (FTMS 1.0, §4.19) usado: flags (u16) → velocidade instantânea (u16/100 km/h) → distância total
  (u24 m) → inclinação (s16/10 %) + ângulo de rampa (s16/10°) → energia total/hora (u16 kcal) + por
  minuto (u8) → FC (u8 bpm) → MET (u8/10) → tempo decorrido (u16 s).

### 6.2 O treino capturado

| Início | Fim | km/h | Pacotes | Duração |
| --- | --- | --- | --- | --- |
| 16:08:53 | 16:10:08 | 0,0 | 76 | 75 s (antes de começar) |
| 16:10:13 | 16:10:16 | 0,8 | 5 | 3,3 s (rampa de partida) |
| 16:10:17 | 16:11:00 | 5,0 | 44 | 43 s |
| 16:11:01 / 16:11:22 | 16:11:33 | 5,1 | 13 | ~11 s (teste +0,1 km/h no painel) |
| 16:11:34 | 16:20:33 | 5,0 | 537 | 539 s |
| 16:20:34 | 16:20:39 | 5,2 | 6 | 5 s (teste +0,1 no painel) |
| 16:20:40 | 16:38:13 | 5,0 | 1054 | 1053 s |
| 16:38:14 | 16:38:18 | 3,0 | 5 | 4 s (frenagem) |
| 16:38:19 | 16:38:20 | 0,8 | 2 | 1 s (fim) |

- **Distância total: 2.329 m**; **tempo decorrido: 1.680 s (28 min)**; **energia: 276 kcal**; energia/h
  até 607; energia/min até 10.
- **MET** do próprio firmware: 1,0 com a lona parada; **4,0** a 5,0 km/h com 1,5 %; 4,2 (2,0 %);
  4,4 (2,5 %); 4,6 (3,0 %); 5,2 (4,5 %); **5,9 (6,0 %)**.
- **FC:** `0` em 91 % dos pacotes e rajadas de 5–15 s a cada poucos minutos (110–169 bpm; média das
  amostras válidas 143,7). *[hipótese]* o `0` significa “sem contato com os sensores do painel”, não
  “FC zero” — o firmware não usa o valor “não disponível” da spec (0xFF).
- **Ângulo de rampa:** **constante `5` (0,5°) nos 1.762 pacotes**, mesmo quando a inclinação mudou de
  1,5 % para 6 %. *[fato]* campo morto do firmware; não use.
- **Velocidade × distância:** integral da velocidade = 2.335,8 m contra 2.329 m informados (100,29 %) —
  o stream é internamente coerente.

---

## 7. Descobertas de engenharia reversa

### 7.1 Velocidade no `targetSpeedChanged` (0x2ADA, opcode 0x05) é ×16 fora da spec

Os 10 avisos de mudança de alvo de velocidade, comparados com a velocidade real do 0x2ACD:

| Hora do aviso | Parâmetro (raw) | `/100` (spec, o que o app mostra) | **`/1600` (real)** | 0x2ACD depois |
| --- | --- | --- | --- | --- |
| 16:10:16.970 | 8000 | 80,0 km/h | **5,0 km/h** | 5,00 em 16:10:17.312 |
| 16:11:01.173 | 8160 | 81,6 | **5,1** | 5,10 em 16:11:01.315 |
| 16:11:02.379 | 8000 | 80,0 | **5,0** | 5,00 em 16:11:02.501 |
| 16:11:21.504 | 8160 | 81,6 | **5,1** | 5,10 em 16:11:22.315 |
| 16:11:34.083 | 8000 | 80,0 | **5,0** | 5,00 em 16:11:34.308 |
| 16:20:33.999 | 8160 | 81,6 | **5,1** | 5,20 em 16:20:34.496 |
| 16:20:34.331 | 8320 | 83,2 | **5,2** | 5,20 em 16:20:34.496 |
| 16:20:39.786 | 8160 | 81,6 | **5,1** | 5,00 em 16:20:40.511 |
| 16:20:40.138 | 8000 | 80,0 | **5,0** | 5,00 em 16:20:40.511 |
| 16:38:19.447 | 1280 | 12,8 | **0,8** | 0,80 em 16:38:19.754 |

*[fato]* `km/h = raw / 1600` em **8 dos 10** pares com razão **exatamente 16,000**; nos outros 2
(15,69 e 16,32) o stream de 1 Hz não viu o degrau intermediário (ex.: dois eventos de +0,1 km/h em
0,33 s). Equivale a `raw = valor_padrão_do_FTMS << 4` (500 → 8000). *[hipótese]* bug de
serialização/fixed-point do firmware. **Não se sabe** se o Control Point (se algum dia aceitar)
espera a mesma escala ×16.
O app dividiu por 100 e mostrou “80 km/h”, depois descartou o alvo ~3,3 s depois pela heurística
`speedTargetLostTrack`.

### 7.2 Inclinação: o 0x2ACD e o 0x2ADA discordam por um fator 6,667

O mesmo equipamento informa inclinação de duas formas incompatíveis:

- **0x2ADA** `targetInclineChanged` (opcode 0x06): parâmetros 15/20/25/30/45/60 → **1,5/2,0/2,5/3,0/
  4,5/6,0 %** na unidade padrão (0,1 %) — e as mudanças vêm **de 0,5 % em 0,5 %**, coerente com a ficha;
- **0x2ACD** `inclination`: raw 100/133/166/200/300/400 → se dividir por 10 (spec) daria **10/13,3/16,6/
  20/30/40 %**, **implausível** (ficha 0–15 %).

*[fato]* A razão é **exata**: `raw_0x2ACD = trunc(percentual × 66,667)` (1,5→100; 2,0→133; 2,5→166;
3,0→200; 4,5→300; 6,0→400), e a mudança no 0x2ACD ocorre **0,11–0,85 s depois** do aviso, com o
mesmo degrau. *[fato]* Prova independente pelo próprio firmware: o **MET** enviado no 0x2ACD bate com a
hipótese de 1,5–6,0 % (erro ≤ 0,1 MET) e não com 10–40 % (3–15 METs de diferença) — pela equação da
ACSM para caminhada a 5 km/h.

*[hipótese forte]* o campo de inclinação do 0x2ACD carrega um **contador interno 0–1000 mapeado para
0–15 %** (`percentual = raw × 0,015`), ou seja, **o firmware “pensa” em 1,5–6 %**, e a escala cheia
seria 1000 = 15 %. **Teste que falta:** subir a inclinação até o máximo no painel e ver se o raw chega
a 1000 (esperado: 33 por 0,5 %). O parser do app está **correto pela spec** — o problema é do
firmware; na prática o app mostraria 10–40 % onde o painel mostra 1,5–6 %.

### 7.3 O console roda um programa com segmentos de 2 minutos

*[fato]* Há 12 avisos de `targetInclineChanged` em intervalos de **120,0 s cravados**
(16:12:12.927, 16:14:12.904, …, 16:34:12.894; média 119,997 s), com **valores variando** e mudança
correspondente no 0x2ACD ~0,3–0,8 s depois. Sequência: **3,0 → 4,5 → 1,5 → 4,5 → 1,5 → 6,0 → 1,5 →
4,5 → 1,5 → 4,5 → 3,0 → 1,5 %**; não há evento às 16:36:12 (o valor repetido de 1,5 % não é
notificado) e o ciclo começa 120 s após o início da lona (16:10:12,9). A velocidade permaneceu 5,0
km/h (o programa só mexe na inclinação).

*[hipótese]* era um **programa do console com segmentos de 2 min**, com timer do firmware ancorado no
início do treino. **Como confirmar:** repetir a coleta em modo manual (quick start) — se o padrão de
2 min desaparecer, é programa; em modo manual, cada toque de inclinação no painel deve gerar um `06`.

### 7.4 Marcas do usuário × dados do painel

As marcas são anotações retroativas (o toque no app vem 2–5 s depois); todas caem em cima de um
evento do 0x2ADA e da mudança do 0x2ACD:

| Marca | Hora | Rótulo | Evento 0x2ADA | 0x2ACD |
| --- | --- | --- | --- | --- |
| +2:08 | 16:11:24.370 | Aumentei a velocidade | `05 E0 1F` = 8160 (16:11:21.504) | 5,0 → 5,1 |
| +2:20 | 16:11:35.827 | Diminuí a velocidade | `05 40 1F` = 8000 (16:11:34.083) | 5,1 → 5,0 |
| +2:28 | 16:11:44.371 | Subi a inclinação | `06 14 00` = 20 (16:11:41.738) | raw 100 → 133 |
| +2:32 | 16:11:47.888 | Desci a inclinação | `06 0F 00` = 15 (16:11:45.721) | raw 133 → 100 |
| +3:23 | 16:20:35.477 | Aumentei a velocidade | `05 E0 1F` + `05 80 20` (16:20:33.999/.34.331) | 5,0 → 5,2 |
| +3:29 | 16:20:40.959 | Diminuí a velocidade | `05 E0 1F` + `05 40 1F` (16:20:39.786/.40.138) | 5,2 → 5,0 |
| +3:35 | 16:20:46.810 | Subi a inclinação | `06 14 00` + `06 19 00` (16:20:45.709/.46.046) | raw 100 → 166 |
| +3:39 | 16:20:50.803 | Desci a inclinação | `06 14 00` + `06 0F 00` (16:20:49.501/.49.852) | raw 166 → 133 → 100 |

Nas marcas de velocidade o usuário apertou o botão **duas vezes** (~0,33 s entre eventos) e registrou
uma marca — o dado é mais fino que a anotação. Nenhum comando do app foi aceito no período; portanto
**as mudanças vieram do painel**.

### 7.5 Training Status é “pegajoso”

*[fato]* Só houve 4 mensagens de 0x2AD3: `00 01` (Idle) na conexão; `00 0E` (preWorkout) às 16:10:09.9;
`00 0F` (postWorkout) às 16:10:13.069 e 13.494 — e a leitura do Coleta às 16:17:13 devolveu `00 0F`
“Post-Workout” com a pessoa andando a 5 km/h. *[hipótese]* o firmware mantém o último estado de
transição e usa pre/post-workout de forma imprópria; **não use Training Status para saber se a lona
está andando** (para isso, o 0x2ACD).

### 7.6 Fitness Machine Status (0x2ADA) — inventário de 34 eventos

| Opcode | Eventos | Significado |
| --- | --- | --- |
| `02 02` Stopped or Paused by User | 4, em 1,07 s (16:10:12.8–13.9) | rajada no início da lona; **não houve `04` (startedOrResumed) em nenhum momento** |
| `05` Target Speed Changed | 10 | ver §7.1 (escala ×16) |
| `06` Target Incline Changed | 20 | 12 do programa de 2 min + 6 toques do usuário + 2 `00 00` duplicados no fim |

Também **não houve evento de parada** quando a lona realmente desacelerou no fim (16:38:13–19) — só
os `06 00 00` de inclinação. O canal 0x2ADA reflete mudanças de alvo feitas **no painel/programa**,
não o estado físico da lona.

### 7.7 O que a esteira **não** faz (confirmado nesta coleta)

- não aceita controle por FTMS (37 recusas; Target Settings 0x10);
- **não** notifica em `FFF4` espontaneamente (17 min, 0 pacotes) — nem com a esteira andando;
- **não** notifica em `0x2A5B` (CSC vazio);
- não preenche UDS (0x181C todo zero) nem expõe HW revision;
- não emite Pace nem Remaining Time, apesar de declarar as duas no Feature;
- não usa o campo de ângulo de rampa (constante 0,5°);
- não atualiza o Training Status durante o treino.

---

## 8. O canal proprietário 0xFFF0 — o que sabemos e o que falta

### 8.1 Estado observado

| Característica | Propriedade | Leitura/observação |
| --- | --- | --- |
| FFF1 | read + write | lê `00` |
| FFF2 | read | lê `00` |
| FFF3 | write (sem read) | nunca escrito |
| FFF4 | notify | assinado ~17 min; **0 pacotes** |
| FFF5 | read | **leitura recusada: `ATT status=2` (Read Not Permitted)** |

O `0x2A5B` (CSC) também foi assinado por 17 min → 0 pacotes; o serviço custom `2b12` lê `00`.
Nada foi escrito no 0xFFF0 nesta coleta, então **o protocolo do fabricante continua 100 % desconhecido**.

### 8.2 O que a pesquisa externa sugere

*[fato]* O conjunto `0xFFF0` + `FFF1..FFF5` com **exatamente essas propriedades** é o
**SimpleGATTProfile** de demonstração da Texas Instruments (guia SWRU301, §4.5): Char1 read/write,
Char2 read-only, Char3 write-only, Char4 notify, Char5 read **que exige link criptografado**. O próprio
guia diz que esses UUIDs “não seguem nenhuma especificação do Bluetooth SIG”. No demo da TI, a
aplicação copia o valor escrito em Char3 para Char4 e notifica.

*[hipótese forte]* o firmware da esteira **reaproveitou esse perfil** e (muito provavelmente) religou
FFF1/FFF3 na UART/console e FFF4 como canal de resposta. O `status=2` do FFF5 é consistente com a
característica protegida do perfil original. Mas atenção: **outros fabricantes usam 0xFFF0 com
semântica diferente** (ex.: RF-star CC2540 usa 0xFFF0 para IO programável; HM-10 usa 0xFFE0/FFE1 como
serial) — **o UUID sozinho não define a função**; é preciso testar.

### 8.3 Serviços acessórios

- **0x181C User Data Service:** 7 características read-only, todas zeradas — o console não guarda
  perfil de usuário; não é caminho de controle.
- **0x1816 CSC:** “casca” de template (Cycling Speed and Cadence num equipamento de corrida): Feature
  `0000` e nenhuma notificação.
- **custom `…1912` / `2b12`:** base UUID de família Telink, 1 byte read-only = `00`; sem documentação
  pública. Vale reler em estados diferentes do painel (é barato), sem expectativa.

### 8.4 O que o app oficial da Vision diz do 0xFFF0

*[fato, análise estática do APK oficial]* A biblioteca BLE da própria Johnson Health Tech no app
`com.johnsonfitness.visionapp` 2.0.0 nomeia o serviço **0xFFF0 como `SERVICE_RENAME`** e a
característica **0xFFF3 como `CHANGE_DEVICE_NAME`** (constantes em
`ServCharsUUID.java:34` e `:8` do decompilado). Elas **não são usadas** no app de consumidor —
sobraram da biblioteca da JHT, provavelmente do app de provisionamento/técnico que grava o nome BLE
do módulo (o formato `VISION ID xxxx` que vemos no anúncio é típico desse tipo de renomeação).

*[fato]* O mesmo app tem a implementação **completa** do Control Point do FTMS (`00` request control,
`07` start/resume, `08 01` stop, `08 02` pause, `02` set target speed, `03` set target inclination),
**mas nenhuma tela ou serviço a chama** — é código morto (`requestControlPermission`,
`startOrResumeWorkout`, `setTargetSpeed`…: 0 callers nos 17.693 `.java`). O fluxo oficial é só
**leitura**: o app espera o usuário usar o painel e o próprio texto diz "press the GO or Start button
on the equipment's screen to start the workout".

*[consequência]* A hipótese "FFF3 = canal de comando do motor" **perde sustentação**: o uso
conhecido do serviço, segundo o fabricante, é **configuração/renomeação**. Não prova que o módulo
(WiLinktech WLT8258) não tenha comandos nos outros chars do `0xFFF0`, mas muda a expectativa e o
risco: no melhor caso, escrever no FFF3 **renomeia o módulo BLE**; no pior, mexe em configuração de
fábrica.

Doc completo da análise dos 4 apps oficiais (Vision + ViewFit/Matrix, que não têm BLE algum):
[`docs/re/vision-fitness-app.md`](re/vision-fitness-app.md) e [`docs/re/netpulse-apps.md`](re/netpulse-apps.md).

### 8.5 O app de firmware (JohnsonOTA) e os opcodes proprietários do FTMS

*[fato, análise estática + consulta pública]* O app oficial de atualização de firmware da JHT
(`com.johnsonfitness.wave` 1.2.0, "JohnsonOTA") usa o **mesmo serviço FTMS `0x1826`** e revela
extensões que não existem na spec do SIG:

- **Control Point `0x2AD9`:** `0x7E` (126) = `RESET_CONSOLE_RESOURCE` ("Device Update") e `0x7F`
  (127) = `SET_AP_MODE` (deprecated). O app envia `0x7E` para colocar o console em modo de
  atualização; a resposta de sucesso traz **o delay** que o console pede antes de reiniciar
  (`80 7E 01 <segundos>`).
- **Machine Status `0x2ADA`:** `0xFE` (254) = progresso do upgrade (`u8` %) e `0xFD` (253) =
  resultado (`1` sucesso, `2` erro de arquivo, `3` falha de escrita, `4` timeout).
- **Atualização por Wi-Fi do console:** o app entra num **AP sem senha com SSID = nome BLE do
  equipamento** e fala HTTP com `http://10.10.10.1:88/` (`GET /Now` com `Referer /OTA`,
  `POST /upload` octet-stream).
- A lista de firmware vem do **Firebase Remote Config** (`consoleConf`) e do CDN público
  `https://ota.jhtfitness.com/`; em produção só há Bowflex `T6` e Schwinn `IC4-02` — **a T600X não
  está na lista** (modelo BLE dela lê `000000`), então este app não a atualizaria.

*[o que fazer]* Testar **`0x7E` na T600X** com o console ocioso e a lona vazia: resposta `80 7E 01
<delay>` = extensão existe (console reinicia em AP); `80 7E 05` = bloqueado; `80 7E 02` = não
suportado. Se existir, dá para ler `GET /Now` no AP (diagnóstico de versão). **Nunca** chamar
`POST /upload` — grava firmware. Detalhes/riscos: [`docs/re/johnsonota.md`](re/johnsonota.md).

---

## 9. Comparação com a unidade de 11/11 (VISION ID 1931)

**São duas unidades físicas diferentes do mesmo modelo/console e da mesma família de firmware:**

| Item | 11/11 (`VISION ID 1931`) | 12/11 (`VISION ID 1AB1`) |
| --- | --- | --- |
| MAC | `A0:BB:3E:40:19:31` | `A0:BB:3E:30:1A:B1` |
| Anúncio | serviços `[0x1826,0x1816]`, serviceData `01 01 00`, manufacturer `0x000D` = MAC | **idêntico** |
| GATT | 8 serviços / 39 características (incl. 0xFFF0, 0x1816, 0x181C, custom) | **idêntico** |
| FTMS Feature | `0x3E2C` / targets `0x10` | **idêntico** |
| Faixas | 0,8–22 km/h; inclinação 0–50 %/3 % | **idênticas** (é constante de firmware) |
| Controle | Request Control Success; todo comando → `Control Not Permitted` | **idêntico** |
| Defeito de escala `targetSpeedChanged` | `05 40 1F` lido como “80 km/h” | **idêntico** (é ×16: 5,0 km/h) |
| Device Information | **não lida** (APK anterior) — lacuna | `WiLinktech` / `WLT8258` / `V10.23.17` / `V100.0.0` |
| 0xFFF4 / 0x2A5B | não assinados / sem dado | assinados 17 min, **0 pacotes** |
| MAC no registro IEEE | bloco `A0BB3E4` (COMSYS GmbH) | bloco `A0BB3E3` (WiteRiver LLC) |

**Conclusões:** (a) o comportamento FTMS/leitura é da **linha**, não de uma unidade; (b) a unidade de
11/11 não teve Device Information lido, então **não se pode afirmar que o firmware dela é `V10.23.17`**
— na próxima conexão em qualquer `VISION ID`, a leitura de 0x180A é gratuita e resolve; (c) o canal
0xFFF0 é a única diferença de potencial ainda não testada nas duas.

*Nota prática de análise:* o registro de 11/11 16:53 contém **1 byte NUL** dentro do nome de um
aparelho vizinho (`relógio clara`), e por isso `grep`/`file` o classificam como binário. Use **`grep -a`**
em todos os registros — não é corrupção nem truncamento (o arquivo é UTF-8 válido e termina com
newline).

---

## 10. Lacunas e próximos experimentos (para a engenharia reversa)

### 10.1 Perguntas em aberto

1. Qual a **escala cheia do contador de inclinação** do 0x2ACD (1000 = 15 %?) — teste no máximo.
2. O **Control Point**, se algum dia aceitar, espera velocidade em 0,01 km/h (spec) ou na escala ×16?
3. O **0xFFF0** transporta o protocolo do console? Quais bytes? Há eco/ASCII/AT?
4. O `FFF5` só responde após **pareamento/bonding** (link criptografado)?
5. O console roda **programa próprio** durante o modo APP (os 2 min) ou é timer de firmware?
6. O **app oficial** chega a falar no 0xFFF0? *[parcialmente respondida em 8.4]* A análise estática mostra que ele chama o 0xFFF0 de serviço de rename e nunca escreve no Control Point; falta confirmar em rádio (HCI snoop log) que ele não toca no 0xFFF0 ao conectar.
7. Por que a conexão caiu no fim (status=133)? O supervision timeout era 10 s (PPCP) — houve queda
   por distância/desligamento do console? Repetir e observar.
8. Revisão de hardware do console (não exposta) — só abrindo/etiqueta ou via documentação de serviço.

### 10.2 Ordem recomendada para a próxima ida (detalhes em `proximos-experimentos.md`)

| # | Experimento | Tipo | Valor |
| --- | --- | --- | --- |
| E1 | Ler descritores `0x2901`/`0x2902` do 0xFFF0 (nRF Connect ou Sonda) | leitura | decisivo: é o demo TI copiado? |
| E2 | Parear e reler `FFF5` (e `FFF1`/`FFF2`/`2b12`) | leitura | destrava o Char5 do perfil TI |
| E3 | Assinar `FFF4` e **estimular o painel** de forma roteirizada (Start, ±vel, ±incl, Stop, chave) | leitura | 17 min passivos deram 0; falta estímulo |
| E4 | Escrever 1 byte em **FFF3** (00 → 01 → 0A → FF) com FFF4 assinado, 10 s entre bytes | escrita | **previsão do demo TI: notify em ~5 s** |
| E5 | Escrever 1 byte em **FFF1** e reler FFF1/FFF2 | escrita | candidato a comando |
| E6 | Se houver sinal: sondar eco, `AT\r\n`, `AT+VERSION?\r\n`, opcodes | escrita | achar o protocolo |
| E7 | Capturar HCI snoop log do **app oficial** | captura | protocolo “de graça” |
| E8 | Ver se o console expõe **Bluetooth clássico/SPP** | descoberta | caminho alternativo de serial |
| E9 | Plano C: RS-485 console↔MCB | hardware | só se o BLE falhar |
| E10 | Enviar **opcode vendor `0x7E`** no Control Point (lona vazia, console ocioso) e ler a indicação — **implementado na Sonda (build 1.2.0)** | escrita | `80 7E 01 <delay>` = extensão existe; `05` = bloqueado; `02` = não suportado |
| E11 | Se E10 aceitar: esperar o delay, reconectar BLE e entrar no **Wi-Fi AP** (SSID = nome BLE); `GET /Now` e sondar caminhos **sem `/upload`** | leitura | diagnóstico de versão/endpoints; **nunca** gravar firmware |

**Não repetir** (já refutado com dados): controle por FTMS; assinar 0x2A5B esperando telemetria;
escrever no 0x181C; confiar no Training Status/inclinação do 0x2ACD sem corrigir escala.
**Segurança:** lona vazia, Emergency Stop ao alcance; uma pessoa no app e outra olhando o painel
quando houver escrita; 1 byte por vez em FFF1/FFF3.

### 10.3 Melhorias sugeridas no app (não implementadas nesta análise)

1. Ler `Target Setting Features` e mostrar “esta esteira não aceita controle por FTMS” em vez de
   tentar ~40 comandos por sessão (evita recusas e a queda de conexão observada).
2. Corrigir os rótulos de características: o app chama 0x2A8E de “Weight”, mas o SIG define
   **0x2A8E = Height**; **0x2A98 = Weight** e **0x2AB5 = Location Name** estão sem nome no app.
3. Tratar as escalas não conformes: `0x2ADA/0x05` → km/h = raw/1600; inclinação do `0x2ACD` →
   raw × 0,015 (com detecção por equipamento, não global). Hoje o app mostra 80 km/h e 10–40 %.
4. No modo Coleta: registrar o **1º pacote de cada assinatura extra** e **reler** FFF1/FFF2/FFF5/2b12
   no fim; corrigir o fato de sair da tela deixar a coleta sem linha “encerrada” (e permitir iniciar
   outra sem avisar).
5. Registrar **descritores (0x2900/0x2901), CCCD, MTU/PHY, intervalo de conexão e bonding** — hoje o
   registro não permite explicar por que o notify de 0x2A00 falha.
6. Sanitizar bytes de controle (NUL etc.) nos nomes de aparelhos gravados no registro (evita arquivo
   “binário” e `grep` silencioso).
7. Na Sonda: leitura de descritores, escrita hexadecimal em FFF1/FFF3 com confirmação, e estado de
   pareamento — conforme `proximos-experimentos.md` §6.

> **Atualização (implementado em 12/11):** o caminho de controle pelo 0xFFF0 já existe no app —
> mapeamento de payloads, três presets candidatos, varredura segura e ativação no painel. Ver
> [`docs/controle-experimental.md`](controle-experimental.md). Continua valendo o aviso: o protocolo
> do fabricante é desconhecido e os comandos só serão confirmados em campo.
>
> **Atualização 2 (RE dos apps oficiais, 12/11):** o app oficial da Vision chama o 0xFFF0 de
> `SERVICE_RENAME`/`CHANGE_DEVICE_NAME` (§8.4) e nunca comanda a esteira; os apps Netpulse
> (ViewFit/Matrix) não têm BLE. Ou seja, **não há protocolo de controle a copiar dos apps** — o
> caminho do 0xFFF0 deve ser tratado como experimento de **baixa probabilidade** e o foco de
> controle passa a ser console/modo de serviço, app de técnico/OTA (JohnsonOTA) ou CSAFE. Detalhes
> em [`docs/re/vision-fitness-app.md`](re/vision-fitness-app.md) §9.4.

---

## 11. Anexos

### 11.1 Onde está cada evidência

| Evidência | Caminho |
| --- | --- |
| Registro bruto de hoje (258 KB) | `gymburn-logs/device/GymBurn/gym-burn-2026-11-12_16-08-29.txt` |
| Registros antigos (10 e 11/11) | `gymburn-logs/device/GymBurn/` (25 arquivos; a pasta tem 29, contando os 4 de hoje) |
| Identidade + GATT + leituras (881 linhas) | `gymburn-logs/analise/gatt/identidade-e-gatt.md` |
| Leituras em CSV (56 tentativas) | `gymburn-logs/analise/gatt/leituras.csv` |
| Inventário bruto destacado | `gymburn-logs/analise/gatt/gatt-bruto.txt` |
| Telemetria, eventos e escalas | `gymburn-logs/analise/telemetria/telemetria-e-eventos.md` |
| 1.762 pacotes 0x2ACD decodificados | `gymburn-logs/analise/telemetria/treadmill-data.csv` |
| Resumo numérico da telemetria | `gymburn-logs/analise/telemetria/resumo.json` |
| Script de decodificação | `gymburn-logs/analise/telemetria/decode_coleta.py` |
| Control Point completo | `gymburn-logs/analise/telemetria/comandos-ftms.md` |
| Auditoria das assinaturas extras | `gymburn-logs/analise/telemetria/notificacoes-extras.md` |
| Comparação com 11/11 | `gymburn-logs/analise/historico/comparacao-unidades.md` |
| Pesquisa externa (WiLinktech/TI/Telink/Matrix) | `gymburn-logs/analise/pesquisa/pesquisa-externa.md` |
| Próximos experimentos | `gymburn-logs/analise/pesquisa/proximos-experimentos.md` |
| RE do app oficial da Vision (2.0.0) | `docs/re/vision-fitness-app.md` |
| RE dos apps Netpulse (ViewFit/Matrix) | `docs/re/netpulse-apps.md` |
| RE do app de firmware JohnsonOTA + pacote JHT | `docs/re/johnsonota.md` |
| Artefatos do JohnsonOTA (APK, decompilado, firmware T6, config FRC) | `gymburn-re/apks/`, `gymburn-re/decompiled/com.johnsonfitness.wave/`, `gymburn-re/ota-re/` |
| APKs + decompilado jadx (local, fora do git) | `gymburn-re/apks/`, `gymburn-re/decompiled/` |

### 11.2 Como repetir a coleta (e não perder a gravação)

1. Painel no **modo APP** (segure a tecla BT/✓ por ~5 s) e conecte pelo app; confirme **“É esta
   esteira”**.
2. Abra **Coleta** e toque em **Iniciar coleta** **uma vez** — deixe a tela aberta (ela mantém a tela
   ligada). Se sair da tela, o app cancela as assinaturas e **não** grava a linha “encerrada” (foi o
   que aconteceu com a 1ª gravação).
3. Use a esteira pelo painel e marque os eventos no app; anote também o valor mostrado no painel
   (velocidade e inclinação) em alguns instantes — é a referência que falta para fechar a escala da
   inclinação.
4. Ao terminar, toque em **Parar coleta** e **Compartilhar registro** (ou copie
   `/sdcard/Documents/GymBurn/` por USB; o app espelha os registros nessa pasta).
5. Anote o **nome BLE da unidade** (`VISION ID xxxx`) usada — na academia há mais de uma.

### 11.3 Decodificação oficial usada

FTMS 1.0 (Bluetooth SIG): serviço 0x1826, Treadmill Data 0x2ACD, Fitness Machine Feature 0x2ACC,
Supported Ranges 0x2AD4–0x2AD8, Control Point 0x2AD9, Machine Status 0x2ADA, Training Status 0x2AD3.
O subconjunto usado pelo app está descrito em `docs/protocolo-ftms.md`; as definições de GAP/Device
Information/User Data/CSC vêm dos XMLs `org.bluetooth.characteristic.*` do SIG.
