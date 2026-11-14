# Engenharia reversa do **AFG Pro Fitness** (`com.xtremeprog.shell.treadmillv2`) — o app JHT que controla esteira

- **Data:** 2026-11-12
- **APK:** `com.xtremeprog.shell.treadmillv2` · `versionName 1.6.1` (versionCode 24022910) · 8.592.169 B · universal · `minSdk 15` / `targetSdk 33` · label **AFG Pro**
- **Assinatura:** `O=JohnsonFitness` (SHA-256 `18466a64deec8d1a5fd46c2e698fe57bbe72ce603cf3dbee99f9ed949e9be001`) — build oficial da JHT
- **Origem:** baixado do APKPure (`gymburn-re/apks/com.xtremeprog.shell.treadmillv2.apk`); o app também está na Play Store e **aparece disponível no Brasil** (a listagem BR mostra 1.6.1; a dos EUA mostra 1.5.8 — diferença de rollout, mesma base)
- **Instalado no celular** para o teste de campo: `adb install -r` em 2026-11-12 21:34:27 (pacote confirmado em `pm list packages`)
- **Decompilado:** jadx em `gymburn-re/decompiled/com.xtremeprog.shell.treadmillv2/` (963 `.java`)
- **Por que importa:** é o **primeiro app JHT encontrado que de fato comanda a esteira**, e ele usa **exatamente o mesmo serviço GATT `0xFFF0`** que a nossa T600X expõe (`FFF3` para escrita e `FFF4` para notificação).

---

## TL;DR

1. **O app oficial da Vision não tem versão regional**: a listagem dos EUA e a do Brasil mostram o **mesmo pacote e a mesma versão 2.0.0**; o código é global (`FLAVOR = "standard"`), e o único Remote Config do app tem `eula` e `force_update_current_version` — **nenhum flag de região/controle**. O código de controle morto não é “coisa do Brasil”.
2. **Mas a JHT tem outro app que controla**: o AFG Pro usa o **mesmo serviço `0xFFF0`/`FFF3`/`FFF4`** da T600X e implementa um **protocolo binário completo** (Gizwits “BLE Treadmill SDK”): frames com `55 AA`, sequência, lingo, comando, tamanho, **CRC16-CCITT** e payload.
3. **Hipótese forte:** o módulo BLE da T600X usa esse mesmo protocolo. O que testamos antes (escrever 1 byte solto no FFF3) não podia funcionar porque o firmware espera o **frame com CRC**. O próximo teste é enviar o frame de **“get machine info”** e ver se o `FFF4` responde com um frame `55 AA`.
4. **Nada foi enviado à esteira nesta análise.** O AFG Pro foi instalado e aberto no celular (sem equipamento por perto); ele ficou numa tela de espera de dispositivo.

---

## 1. Anatomia do app

- É o mesmo formato híbrido do app da Vision: interface para **console** (`AppsRunningActivity`, `Apps321Activity`, …) e para **celular** (`AppsRunningPhoneActivity`, `AppsModeChoosePhoneActivity`, …); o modo Phone é o que abre no nosso aparelho.
- Permissões: BLE (`BLUETOOTH_SCAN/CONNECT`, legadas `BLUETOOTH/ADMIN`), localização, internet, armazenamento, `SYSTEM_ALERT_WINDOW`, `RECEIVE_BOOT_COMPLETED` — típico de app feito para rodar em console Android.
- Logo do app: **AFG**; a JHT é dona da marca (mesma assinatura `O=JohnsonFitness`).

### Pacotes que interessam

| Pacote/classe | Papel |
| --- | --- |
| `l0.b` | gerenciador BLE: escaneia (sem filtro de serviço), conecta, exige o serviço `FFF0` com as características `FFF3` (write) e `FFF4` (notify), assina o CCCD `2902` |
| `j0.a` | **monta os frames** do protocolo (`55 AA` + sequência + lingo + comando + tamanho + CRC + payload) |
| `k0.b` | **CRC16-CCITT-FALSE** do payload (init `0xFFFF`, tabela CCITT) |
| `m0.a` | handshake: ao conectar, pede **machine info** (`j0.a.i()` = lingo 1, cmd 2) |
| `i0.c`, `h0.*` | parse das respostas (machine info, erros/timeout, eventos de teclado, workout…) |
| `o0.c` | fachada de alto nível (start/pause/stop/speed/incline/resistance, usuário, programa) |
| `com.xtremeprog.sdk.ble.base.Message` | **enums do protocolo** (lingo, comandos, programas, unidades) |

Strings do SDK no APK: `Gizwits==BLe==TreadmillSDK`, `SDK_log:startWorkout`, `调节speed为`, `调节incline为`, etc. — é o SDK de esteira da Gizwits, usado pela JHT.

---

## 2. O protocolo (extraído do código)

### 2.1 Frame (escrita em `FFF3`, notificação em `FFF4`)

```
offset  bytes        campo
0..1    55 AA        sync (SyncWord = 0xAA55)
2..3    seq          uint16 LE, incrementa a cada comando
4       lingo        1 = general, 2 = remote, 3 = settings
5       cmd          comando dentro do lingo
6..7    len          uint16 LE = tamanho do payload
8..9    crc          CRC16-CCITT-FALSE(payload), uint16 LE
10..    payload      len bytes
```

Evidência: `j0/a.java` (`c(...)`: `bArr[0]=85; bArr[1]=-86; bArr[2..3]=seq; bArr[4]=lingo; bArr[5]=cmd; bArr[6..7]=len; bArr[8..9]=crc`), `k0/b.java` (CRC), `l0/b.java` (constantes dos UUIDs e envio fatiado em blocos de 20 bytes, juntando no `onCharacteristicWrite`).

### 2.2 Comandos

**General (lingo 1):**

| Cmd | Nome | Payload |
| --- | --- | --- |
| `2` | `BLE_GET_MACHINE_INFO` | vazio (frame de **10 bytes**) |
| `15` | `BLE_SET_USER_DATA` | dados do usuário (468/741 B) |
| `20` | `BLE_STOP_WORKOUT` | vazio |
| `22` | info de usuário (login) | 468/741 B |
| `23` | `set5k` / `24` `set_custom_program` / `25` `set_custom_HRP` | programas |

**Remote (lingo 2):**

| Cmd | Nome | Payload |
| --- | --- | --- |
| `1` | `BLE_SET_CURRENT_USER` | u8 índice do usuário |
| `2` | **`BLE_START_WORKOUT`** | 17 bytes (programa/usuário — classe `j0.d`) |
| `3` | **`BLE_PAUSE_WORKOUT`** | 1 byte: `0` = pausar, `1` = continuar |
| `4` | `BLE_CHANGE_WORKOUT` | 18 bytes (mudar parâmetros do treino) |
| `5` | **`BLE_SET_SPEED`** | `[u8 modo, uint16 velocidade×10, u8 extra]` |
| `6` | **`BLE_SET_INCLINE`** | `[uint16 inclinação×10, u8 extra]` |
| `7` | `BLE_SET_RESISTANCE` | `[u8 resistência, u8 extra]` |
| `10` | `BLE_SELECT_PROGRAM` | u16 programa |
| `11` | `BLE_KEY_PRESS` | tecla do painel |

- **Unidades:** velocidade em **×10** (`(int)Math.round(10.0 * km/h)` em `o0/b.java:1712`); inclinação em **×10** (ou ×5 conforme unidade do console, `o0/b.java:1686`).
- **Handshake:** ao conectar e assinar `FFF4`, o SDK manda `GET_MACHINE_INFO` (`m0/a.java:176`); a resposta (`i0/c.java`) é parseada em `MachineInfo` (marca, modelo, velocidades/inclinação min/max, versões, serial, MAC…) e só então a interface libera os controles.
- **Consulta de exemplo (get machine info)**, frame de 10 bytes para escrever no `FFF3`:
  `55 AA 00 00 01 02 00 00 00 00` (seq 0, lingo 1, cmd 2, len 0, CRC de payload vazio = 0).

### 2.3 Comparação com a T600X

A T600X expõe **o mesmo conjunto** (dossiê §8): serviço `0xFFF0`, `FFF1 read/write`, `FFF2 read`, `FFF3 write`, `FFF4 notify`, `FFF5 read` — o perfil Gizwits/TI. O app Vision chamava `FFF0/FFF3` de serviço de **renomeação**, mas aquilo era a biblioteca da JHT; o AFG Pro usa as **mesmas características como canal de comando**. Nossa sonda anterior escreveu bytes soltos no `FFF3` e nunca viu o `FFF4` responder: **faltava o frame com sync/CRC**.

---

## 3. O teste na T600X — automático no GymBurn 1.3.3

A partir da 1.3.3 o GymBurn **faz o plano inteiro sozinho**, sem abrir a Sonda nem digitar
hexadecimal. Depois da confirmação da esteira:

1. Assina o `FFF4` e envia o pedido de **machine info** (`55 AA 00 00 01 02 00 00 00 00`) no `FFF3`.
2. **Se responder** (`55 AA`): marca o canal como compatível e segue com testes seguros, com a lona
   parada: consultar dados do treino, parar treino (já parado) e pausar (já parado). Nada que ligue
   ou acelere a lona.
3. **Se não responder**: tenta, na ordem, machine info no **FFF1**, machine info com **sequência 1**,
   pausar com **CRC invertido** e um **ack** do canal remoto. Qualquer resposta `55 AA` confirma o
   protocolo e identifica a variante que funciona.
4. **Se a lona estiver andando**: o plano espera; a faixa discreta no topo pede “No painel, pare a
   esteira…” e o teste recomeça sozinho quando ela parar.
5. O cartão **“Teste automático do canal alternativo”** mostra o resumo; a Sonda (toque longo na
   versão) mostra cada tentativa, o hex de cada resposta e o botão **Refazer teste**.

### Controle de verdade quando o canal responde

Se o plano confirma o protocolo, o GymBurn **liga sozinho** o controle pelo canal alternativo (sem
configuração): os botões do painel passam a enviar os frames do AFG Pro, com estas travas:

- **Iniciar** só com a esteira parada e sem bloqueio de partida; manda `start workout` (programa
  manual, 0,8 km/h, 20 min) ou `continuar` se ela estava pausada. Se a velocidade não subir em 8 s,
  avisa para conferir o painel.
- **Pausar** só com a lona andando; manda `pause` (`0`) e confere a velocidade em 6 s.
- **Parar** manda `stop workout` e confere em 8 s; se a lona continuar andando, manda usar o
  Emergency Stop.
- **Velocidade** só com a lona andando e leitura > 0; calcula o alvo a partir da velocidade medida,
  manda `set speed` (×10, modo métrico) e confere em 4 s.
- **Inclinação** calcula o alvo a partir da inclinação corrigida, manda `set incline` (×10) e confere
  em 6 s.
- Nenhum comando é enviado sem a esteira confirmada e conectada; o canal não tem ACK por comando,
  então a confirmação é sempre pela telemetria (e a mensagem de falha manda usar o painel).

Segurança: o plano em si só envia leitura + parada/pausa com a lona parada. Os comandos de
movimento só saem depois de um toque explícito no painel e com as travas acima. Testar com a lona
vazia e o Emergency Stop à mão.

**Alternativa já instalada:** o **AFG Pro** está no celular; na esteira, abrir e ver se ele encontra/conecta a T600X e libera os controles. O app tem interface de console (`PROGRAM SELECTION`, START), e em modo celular fica “esperando dispositivo por 90 s”. **Cuidado:** ele **comanda de verdade** (start, velocidade, inclinação) — teste com a lona vazia e o Emergency Stop à mão.

**Não fazer:** mandar start/workout sem antes confirmar o machine info; e nunca confundir com firmware (o AFG Pro é de treino, não de OTA).

---

## 3.1 Resultado do teste na T600X (13/11/2026)

O plano automático do GymBurn 1.3.4 rodou em todas as conexões da visita e o resultado foi negativo:

- `FFF3 ← 55 AA 00 00 01 02 00 00 00 00` foi **aceito** (sem erro de escrita);
- **nenhuma notificação** chegou no `FFF4` em nenhuma das ~10 tentativas (o `FFF4` estava assinado);
- a variante no `FFF1` foi **recusada pelo módulo** (`GATT status 13`, comprimento inválido) e, por um bug, abortou o plano antes das outras variantes;
- `FFF1 = 00` e `FFF2 = 00`; `FFF5` recusa leitura (`status 2`); `FFF1` aceita 1 byte, mas não 10;
- o módulo é um **WLT8258 da WiLinktech**, módulo de **transmissão transparente** UART↔BLE (datasheet: serviço `0xFFF0` é “透传 Service”), não um controlador Gizwits.

**Atualização:** o próprio app **AFG Pro foi testado na T600X** pelo usuário e **não funcionou** (não controlou). Isso reforça a conclusão abaixo.

**Conclusão:** o protocolo do AFG não é o da T600X. O caminho para controle, se existir, é o protocolo UART entre o console e o módulo (desconhecido) ou outro app/protocolo JHT — não este. O plano do GymBurn 1.3.5 agora continua após falhas de variante e tenta `AA 55`, CRC normal etc.; a próxima aposta é testar o **AFG Pro na T600X** e capturar o tráfego BLE com HCI snoop para ver se algum app oficial escreve no `FFF0`.

## 4. Resposta à pergunta “é por estar no Brasil?”

**Não.** A listagem da Play Store dos EUA e a do Brasil do app da Vision mostram o **mesmo pacote (`com.johnsonfitness.visionapp`) e a mesma versão 2.0.0**; o APK é um build global (`FLAVOR = standard`), e o Remote Config do app só tem `eula` e `force_update_current_version` (nenhum flag de região/controle). O código de controle é morto no app de consumidor **no mundo inteiro** — é herança da biblioteca da JHT.

O que existe de diferente é **outro app** (AFG Pro), de outra marca da JHT, que implementa o controle de verdade pelo mesmo canal `0xFFF0` — e ele está disponível aqui também.

---

## 5. Evidências e artefatos

| # | Fato | Onde |
| --- | --- | --- |
| 1 | Serviço `FFF0`, write `FFF3`, notify `FFF4`, CCCD `2902` | `l0/b.java` (constantes `B`, `C`, `D`, `E`) |
| 2 | Frame `55 AA` + seq + lingo + cmd + len + CRC + payload | `j0/a.java` (`c(...)`) |
| 3 | CRC16-CCITT-FALSE (init `0xFFFF`) | `k0/b.java` |
| 4 | Handshake pede machine info após conectar | `m0/a.java:176` |
| 5 | Comandos/lingos/unidades | `com/xtremeprog/sdk/ble/base/Message.java`; `o0/c.java:1109-1211`; `o0/b.java:1686-1712` |
| 6 | Unidades: velocidade ×10; inclinação ×10 (ou ×5) | `o0/b.java:1686` (`Z0`) e `:1712` (`b1`) |
| 7 | App instalado, assinatura JohnsonFitness | `adb install` 21:34; `apksigner verify` |
| 8 | Vision app: mesma versão EUA/Brasil; Remote Config sem flags | Play listings; `BuildConfig.java`; `util/RemoteConfigUtils.java` |
| 9 | APK + decompilado | `gymburn-re/apks/com.xtremeprog.shell.treadmillv2.apk`; `gymburn-re/decompiled/com.xtremeprog.shell.treadmillv2/` |
