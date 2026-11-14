# Engenharia reversa do **JohnsonOTA** (`com.johnsonfitness.wave` 1.2.0) — o app de firmware da JHT

- **Data:** 2026-11-12 (dia seguinte à análise dos apps de usuário)
- **APK:** `com.johnsonfitness.wave` · `versionName 1.2.0` · `versionCode 4` · base 8.533.603 B (XAPK 9.410.342 B, com splits `arm64-v8a`, `en`, `xhdpi`) · `minSdk 26` / `targetSdk 35`
- **Origem:** baixado como XAPK do APKPure (o Google Play **bloqueia o app no Brasil**: “Este item não está disponível em seu país”), verificado com `apksigner` (assinatura **Google Play / Source Stamp**, cert SHA-256 `2e6ce5835f6dfcd2f98f6017d59d31cca1236c5d4175536178319191ee183041` → é build genuíno da Play) e instalado no celular com `adb install-multiple`
- **Status no aparelho:** instalado (`versionName=1.2.0`, `lastUpdateTime=2026-11-12 20:00:06`), mas ao abrir o Google Play mostra a sobreposição “app não reconhecido — baixe no Google Play” (por ter sido instalado fora da loja). **A análise abaixo é estática, do APK; o app não foi executado.**
- **Decompilado:** jadx 1.5.6 em `gymburn-re/decompiled/com.johnsonfitness.wave/` (8.138 `.java` + 387 classes do app) e recursos em `gymburn-re/res/com.johnsonfitness.wave/`

> Convenção: **`SRC/`** = `gymburn-re/decompiled/com.johnsonfitness.wave/sources/`. Linhas do Java gerado pelo jadx.

---

## TL;DR — o que este app revelou

1. **A JHT estendeu o FTMS com opcodes proprietários.** O Control Point (`0x2AD9`) aceita (nessa família de firmware) os opcodes **126 = `RESET_CONSOLE_RESOURCE`** e **127 = `SET_AP_MODE`** (este último marcado *@Deprecated*). Isso não existe na spec do SIG — é canal do fabricante, e **a nossa T600X pode aceitar `0x7E`** (é testável e barato).
2. **A atualização é feita por Wi-Fi, não por BLE.** O app manda o console entrar em **modo AP** (via `0x7E` no Control Point), espera o delay que o console responde, reconecta o BLE, e então **entra num Wi-Fi aberto cujo SSID é o nome BLE do equipamento** (ex.: `BFX_T6_2024`, `VISION ID 1AB1`) e conversa com um **servidor HTTP em `http://10.10.10.1:88/`**: `GET /Now`, `POST /upload` (octet-stream). O progresso/resultado da gravação volta pelo **BLE**, nos opcodes proprietários **253 (`UPGRADE_RESULT`)** e **254 (`UPGRADE_PROGRESS`)** do `0x2ADA`.
3. **O firmware baixado é analisável.** O pacote (`https://ota.jhtfitness.com/Bowflex/T6/T6_S1.17-092714.bin`) é um contêiner JSON com **dois** binários: o **console** (ESP32-S3, projeto `BFX_T6`) e a **placa inferior/motor** (ESP32-S2, projeto `T6_LB`). Nos strings do console aparecem o handler do FTMS Control Point (“Machine Control Point: **Device Update**”, “Device update **not permitted - workout not idle**”), o servidor HTTP de OTA (`httpd_register_uri_handler` de `/Now` e `/upload`) e o protocolo da placa inferior (`CMD_W_MOTOR_RPM_TARGET`, `CMD_W_INCLINE_COUNT_TARGER`, `CMD_R_MOTOR_RPM_NOW`, …).
4. **A lista de firmwares vem do Firebase Remote Config** (projeto `johnsonwave-f4458`, chave `consoleConf`) e aponta para o CDN `ota.jhtfitness.com`. Obtivemos a config (leitura pública, sem dados de usuário): em produção só há **`T6` (Bowflex) e `IC4-02` (Schwinn)**. **A T600X não está na lista** — e o modelo BLE dela lê `000000` no `0x2A24`, então o app não a reconheceria/atualizaria.
5. **O que isso muda para nós:** (a) passamos a ter **um comando proprietário real do firmware** para testar na T600X (`0x7E`/`0x7F` no Control Point), o primeiro que não é “spec genérica”; (b) se ele for aceito, o console entra em **AP mode** e ganhamos uma porta HTTP de diagnóstico (`/Now`); (c) **nada disso é controle de motor** — o OTA só reinicia/grava firmware. Riscos e testes em §8.

---

## 1. O que o app é

App **de técnico** (não de usuário final): conecta por BLE no equipamento (FTMS `0x1826`), lê o Device Information (`0x180A`), compara a versão de software com a lista do fabricante, baixa o pacote de firmware, coloca o console em modo AP, entra no Wi-Fi do console, envia o pacote por HTTP e acompanha a gravação pelo BLE.

Telas/pacotes principais (`SRC/com/johnsonfitness/wave/`):

| Peça | Papel |
| --- | --- |
| `ui/controller/HomeFragment` + `HomeViewModel` | escaneia FTMS, lista aparelhos, guarda `BleDeviceInfo` |
| `ui/controller/BleDeviceInfoFragment` | mostra modelo/serial/firmware lidos do equipamento |
| `ui/controller/upgrade/CheckUpgradeFragment` | compara `softwareRevision` (lido via BLE) com a lista de suporte e decide se há update |
| `ui/controller/upgrade/NewVersionDescFragment` | release notes + botão de atualizar |
| `ui/controller/upgrade/UpgradeCheckFileFragment` | baixa/valida (MD5) o arquivo de firmware |
| `ui/controller/upgrade/UpgradeConnectWifiFragment` | **manda `0x7E`**, espera delay, escaneia o BLE de novo, conecta no Wi-Fi do equipamento e testa `GET /Now` |
| `ui/controller/upgrade/UpgradeUploadFragment` | `POST /upload` + progresso/resultado do BLE |
| `data/repository/FtmsRepository` | BLE: conecta, lê DIS, pede `Request Control`, envia `0x7E` |
| `data/repository/ConsoleUpgradeRepository` | HTTP do console: `GET /Now`, `POST /upload` |
| `util/firebase/FRCManager` | Firebase Remote Config (`consoleConf`, `agreeVersion`, `forceUpdate`) |
| `data/model/db/SupportItem` | item da lista: `modelNumber`, `softwareVersion`, `minVersion`, `downloadUrl`, `md5`, `desc` |

O app também tem telas de home/scan/settings e um módulo de WebView (`WebActivity`) — irrelevantes para o protocolo.

---

## 2. As extensões proprietárias do FTMS (o achado principal)

### 2.1 Control Point (`0x2AD9`) — opcodes além da spec

`SRC/com/johnsonfitness/ble/profile/ftms/ControlPointDataType.java`:

| Opcode | Nome | Payload | Observação |
| --- | --- | --- | --- |
| `0x00` | `REQUEST_CONTROL` | — | spec |
| `0x01` | `RESET` | — | spec |
| `0x02`/`0x03`/`0x04`/`0x05`/`0x06` | target speed/inclination/resistance/power/HR | — | spec |
| `0x07`/`0x08` | start/resume, stop or pause | — | spec |
| **`0x7E` (126)** | **`RESET_CONSOLE_RESOURCE`** | **nenhum** | **proprietário JHT**: “Device Update” — reinicia o console para o modo AP de atualização |
| **`0x7F` (127)** | **`SET_AP_MODE`** | **nenhum** | **proprietário JHT, `@Deprecated`** — modo AP (caminho antigo) |

`FTMSControlPointData.resetConsoleResource()` = `Data.opCode((byte) 126)`; `setAPMode()` = `0x7F` (marcado deprecated) — `SRC/com/johnsonfitness/ble/ftms/data/FTMSControlPointData.java:41-49`.

O app usa **só o 126** (`FtmsRepository.resetConsoleAndAp()` → `writeControlPoint(resetConsoleResource())`, `SRC/.../data/repository/FtmsRepository.java:670-672`; chamado por `UpgradeViewModel.resetConsoleAndAp()` quando o usuário toca o botão, `SRC/.../ui/controller/upgrade/UpgradeViewModel.java:448-453`).

### 2.2 Como ler a resposta do Control Point (inclusive o delay do 126)

O parser de indicações (`SRC/com/johnsonfitness/ble/ftms/data/impl/ControlPointDataCallback.java:23-70`):

- `byte0` deve ser `0x80` (response code) — senão descarta;
- `byte1` = opcode original; `byte2` = resultado (`1` sucesso, `2` op não suportada, `3` parâmetro inválido, `4` operação falhou, `5` not permitted);
- resultado ≠ 1 → `onFTMSRequestError(opcode, result)`;
- **sucesso com opcode 126** → `byte3` = **delay em segundos** (`u8`), entregue como `DelaySecond(delay)`;
- sucesso com opcode 127 → sucesso simples (conecta Wi-Fi na hora);
- sucesso com opcode 19 (spin-down) → dois `u16` extras.

Formato então: **`80 7E 01 <segundos>`** para o 126; **`80 7F 01`** para o 127. O app espera o delay e só então re-escaneia/reconecta o BLE (`handleDelay` → `delay(delaySecond*1000)` → `startScanWithTimeout`, `SRC/.../ui/controller/upgrade/UpgradeConnectWifiFragment.java:~735-780`).

### 2.3 Machine Status (`0x2ADA`) — opcodes proprietários de upgrade

`SRC/com/johnsonfitness/ble/profile/ftms/MachineStatusDataType.java:34-40`:

| Opcode | Nome | Payload |
| --- | --- | --- |
| **`0xFE` (254)** | **`UPGRADE_PROGRESS`** | `u8` = progresso em % |
| **`0xFD` (253)** | **`UPGRADE_RESULT`** | `u8`: `0` idle, `1` sucesso, `2` erro de arquivo, `3` falha de escrita, `4` timeout |

Parser: `SRC/com/johnsonfitness/ble/ftms/data/impl/MachineStatusDataCallback.java:97-100`. O app mostra o progresso e trata o resultado (`UpgradeUploadFragment`: `result==1` → sucesso; `2/3/4` → diálogo de erro; `4` tem mensagem específica de conexão).

### 2.4 Strings do firmware do console que confirmam

No binário do console (Bowflex T6, §5) aparecem:

```
Machine Control Point: Request Control / Reset Control
Machine Control Point: Target_Speed %d / Target_Inclination %d / Target_Resistance %d
Machine Control Point: Start_Or_Resume / Stop / Pause
Machine Control Point: Device Update
  -> "Device update success - workout stopped"
  -> "Device update not permitted - workout not idle"
FTMS_Machine_Status_Notify_Report ... OP Code:0x%02x
OTA Progress: %d%%
Web_OTA_Progress
```

Ou seja: **o 0x7E é o “Device Update”**, recusado quando o treino não está ocioso (resposta `0x05`), e o progresso do OTA é reportado no `0x2ADA` com opcode `0xFE`. Isso encaixa exatamente com o que o app faz.

---

## 3. O canal Wi-Fi de atualização (HTTP em `10.10.10.1:88`)

`SRC/com/johnsonfitness/wave/data/repository/ConsoleUpgradeRepository.java`:

```java
HOST = "http://10.10.10.1:88/"
NOW_PATH = "Now"; OTA_PATH = "OTA"; UPLOAD_PATH = "upload";
```

| Requisição | Método/URL | Detalhe |
| --- | --- | --- |
| checar/health | `GET http://10.10.10.1:88/Now` com header **`Referer: http://10.10.10.1:88/OTA`** | resposta JSON `OTAResponse`: `{OTAsubtype, address, version, date, time}` (`data/model/OTAResponse.java`) |
| enviar firmware | `POST http://10.10.10.1:88/upload` | corpo `application/octet-stream` (o arquivo .bin), progresso por `ProgressRequestBody` |

**Rede:** o app conecta no Wi-Fi cujo **SSID = nome BLE do equipamento** (`BleDeviceInfo.deviceName`, lido do `0x2A00`) e **senha = string vazia** (`wifiConnectionManager.connectToWifi(deviceName, "", …)`, `SRC/.../ui/controller/upgrade/UpgradeViewModel.java:456-467`; `WifiConnectionManager` usa `WifiNetworkSpecifier` no Android ≥29). Na prática o Android mostra o popup “Join” de rede local sem internet — o app instrui o usuário (“You’ll see a pop-up to join Wi-Fi”, strings `wifi_popup_notice`/`wifi_join_instruction`). *(Observação: `setWpa2Passphrase("")` seria inválido pela API; o comportamento real do AP — aberto/WPA2 — não foi verificado em hardware.)*

**Sequência completa do update** (montada do código):

1. BLE conecta; lê `0x2A00` (nome), `0x2A24` (modelo), `0x2A25` (serial), `0x2A26`/`0x2A28` (firmware/software), `0x2A23`, `0x2A29`, `0x2A27` (`FtmsRepository.readDevice()`).
2. `Request Control` (`0x2A19`? não — `0x00` no CP) — `FtmsRepository.requestControlPermission()`.
3. Compara `softwareRevision` com `SupportItem.softwareVersion` do modelo (via Remote Config/DB).
4. Se há update: baixa o `.bin` do `downloadUrl`, valida MD5 (`Utils.getMD5`), mostra release notes (`desc`).
5. Usuário confirma → **CP `0x7E`**. Console responde `80 7E 01 <delay>` (ou `80 7E 05` se não estiver ocioso → diálogo “Standby Mode”).
6. App espera `<delay>` s, re-escaneia o BLE por **MAC** (timeout `RESET_CONSOLE_TIMEOUT = 60 s`), reconecta; espera mais **7 s** (`delay(7000L)`).
7. Entra no Wi-Fi `SSID = nome BLE` (rede do console).
8. `GET /Now` com `Referer /OTA` → confere versão/subtype.
9. `POST /upload` (arquivo `.bin`).
10. Console grava e reporta **`0x2ADA` `0xFE` (progresso %)** e **`0xFD` (resultado)**; app mostra sucesso/erro e desconecta.

---

## 4. Lado nuvem: Firebase Remote Config + CDN de firmware

- Projeto Firebase: **`johnsonwave-f4458`**, app id `1:998587232403:android:de0638edb3830752359d66` (strings `google_app_id`/`project_id`/`google_api_key` em `res/values/strings.xml`).
- Chaves: `consoleConf`, `consoleConf_dev`, `consoleConf_stage`, `agreeVersion*`, `forceUpdate*` (`SRC/.../util/firebase/FRCManager.java:44-46`).
- `consoleConf` é um JSON `SupportResponse { supportList: SupportItem[] }` (modelos `SupportItem`/`SupportResponse`). O app baixa no início (`HomeViewModel.getConsoleConf()`), grava no Room e casa por `modelNumber`.
- **Conseguimos ler a config** com uma chamada pública à API do Remote Config (usando app id/API key/cert do próprio APK; instância aleatória, sem dados de usuário). Produção (`consoleConf`):

| modelNumber | minVersion | softwareVersion | downloadUrl | md5 |
| --- | --- | --- | --- | --- |
| `T6` | `S1.17` | `S1.17` | `https://ota.jhtfitness.com/Bowflex/T6/T6_S1.17-092714.bin` | `5993562ec43b197363e9bfd624505583` |
| `IC4-02` | `S1.05` | `S1.10` | `https://ota.jhtfitness.com/SCHWINN/IC4-02/IC4_02_S1.10-052809.bin` | `e6402a1517ed395370576aac4de9bf4b` |

- `consoleConf_dev`/`_stage` têm entradas de teste (`T6` S1.23, `TEST-001`, `TEST1`, …). Artefato: `gymburn-re/ota-re/consoleConf-frc.json`.
- CDN: **`ota.jhtfitness.com`** é um bucket S3 via CloudFront; o arquivo do T6 baixa sem autenticação (2.419.168 B, MD5 igual ao da config). Listagem de diretório é negada (`AccessDenied`), mas os caminhos do JSON funcionam.
- **A T600X não aparece em nenhuma lista** e o modelo lido do `0x2A24` na unidade é `000000` (dossiê §4) — então este app **não atualizaria a nossa esteira** hoje. (Isso não impede o teste do `0x7E` — §8.)

---

## 5. Bônus: o firmware em si (contêiner + imagens ESP32)

Baixamos `T6_S1.17-092714.bin` (Bowflex T6 — **outro produto**, não a T600X) para entender o formato do pacote e o que o console implementa:

- **Contêiner:** começa com JSON em texto (`{"Number of files": 2, "Files": [...]}`), uma área de 1.024 B, e os binários em offsets fixos:

| Item | Tipo | Offset | Tamanho |
| --- | --- | --- | --- |
| `BFX_T6.bin` | Console | 1024 | 2.064.128 |
| `USB_T6_LB_S1.15-092217.bin` | LowBoard | 2.065.152 | 354.016 |

- Ambos são **imagens de aplicação ESP-IDF**: console = **ESP32-S3** (`BFX_T6`, versão `S1.17-092714`, compilado 27/09/2025); placa inferior = **ESP32-S2** (`T6_LB`, `S1.15-092217`).
- Strings do console relevantes:
  - FTMS Control Point (Request/Reset/Target/Start/Stop/Pause/**Device Update**) e as regras “device update success - workout stopped / not permitted - workout not idle”;
  - servidor HTTP de OTA: `OTA Web Now httpd_register_uri_handler`, `OTA Web upload httpd_register_uri_handler`, `OTA Progress: %d%%`, `Web_OTA_Progress`; Wi-Fi AP (`esp_wifi_set_mode(WIFI_MODE_AP)`, `esp_netif_dhcps_start`), configuração de SSID/senha (`SET_WIFI_SSID`, `SET_WIFI_PASSWORD`);
  - placa inferior por **I2C**: comandos `CMD_W_MOTOR_RPM_TARGET`, `CMD_W_INCLINE_COUNT_TARGER`, `CMD_R_MOTOR_RPM_NOW`, `CMD_R_INCLINE_COUNT_NOW`, `CMD_R_SAFETY_KEY`, `CMD_R_SOFTWARE_VERSION`, `CMD_LB_CMD_W_OTA`/`_REPLY`, etc.; verificação `ota imge crc pass/fail` e `esp_ota_set_boot_partition`;
  - “WLT7150 Upgrade Start/Done” (a placa também atualiza o módulo BLE WiLinktech — família do nosso `WLT8258`).
- **O que isso prova:** a arquitetura JHT é “console (ESP32) faz a UI, o BLE, o Wi-Fi/OTA e conversa com a placa do motor”; o app de usuário só fala FTMS com o console. Para a T600X — que tem módulo BLE WiLinktech separado e console de LED — a arquitetura pode ser outra, mas **as extensões de opcode do FTMS são da plataforma JHT** e a suspeita de que a T600X compartilhe parte disso é razoável.

Artefatos: `gymburn-re/ota-re/Bowflex_T6_S1.17/` (pacote + imagens extraídas) e `gymburn-re/ota-re/t6_*_strings.txt`. **Nada foi gravado em hardware nenhum.**

---

## 6. O que isso muda para o nosso plano (GymBurn/T600X)

### 6.1 O que ganhamos

- Um **primeiro comando proprietário real** do ecossistema FTMS JHT: `0x7E`/`0x7F` no Control Point. Nossa T600X recusou comandos da **spec** com `0x05`, mas **nunca testamos opcodes vendor**. Se `0x7E` for aceito (resposta `80 7E 01 <delay>`), o firmware **permite comando não-spec** — o que muda a pergunta de “o FTMS é read-only?” para “**quais opcodes vendor ele implementa?**”.
- Um **canal HTTP** que se abre no console em AP mode (`10.10.10.1:88`), útil para **diagnóstico** (`/Now` devolve versão/subtype/data).
- Conhecimento do formato do pacote de update (`JSON + Console + LowBoard`, imagens ESP32) — caso um dia faça sentido analisar/atualizar firmware (não recomendado agora).

### 6.2 Experimento de campo novo (o próximo passo natural)

Na T600X, **com o console ocioso e a lona vazia**:

1. Conectar pelo GymBurn e assinar a indicação do Control Point.
2. Enviar `Request Control` (`00`) e depois **`7E`**; registrar a indicação (`80 7E xx [delay]`). Se `0x7E` não for reconhecido, testar também **`7F`** (é o caminho antigo, deprecated — pode ser o que essa geração de firmware conhece).
   - Se `80 7E 05` (`Control Not Permitted`) → opcode reconhecido mas bloqueado (como os da spec) ou não suportado nessa variante;
   - se `80 7E 02` (`Op Not Supported`) → firmware não tem a extensão;
   - se `80 7E 01 <delay>` → **existe**! O console vai reiniciar/sumir do BLE por `<delay>` s.
3. Se reiniciar: escanear o BLE (o nome `VISION ID xxxx` pode voltar), e **procurar um Wi-Fi aberto com SSID = nome BLE**; entrar e fazer **apenas leituras**: `GET http://10.10.10.1:88/Now` (com `Referer: /OTA`), `GET /`, `OPTIONS`, e enumerar caminhos óbvios com cautela.
4. **Nunca** chamar `POST /upload` no equipamento da academia — isso **grava firmware**; payload errado/incompatível = risco de brick do console. Sem autorização do dono, nem pensar.
5. Registrar tudo no log do GymBurn (a Sonda já assina o Control Point e registra indicações; falta um botão para enviar opcode vendor).
6. Se der certo, dá para perguntar ao firmware, com cuidado, sobre outros opcodes vendor (por exemplo, `0x7D`, `0x7F`) — **um byte por vez**, observando as respostas, sem gravar nada.

**O que já podemos implementar no app (baixo risco):** um campo “opcode vendor” na Sonda que escreve no `0x2AD9` e mostra a resposta; e, se houver AP, um botão “ler /Now do console” (Wi-Fi) para diagnóstico. Isso não comanda motor — serve para descobrir o que existe.

### 6.3 Implementado no GymBurn em 12/11/2026 (build 1.2.0)

A Sonda ganhou a seção **“Opcodes vendor do FTMS (experimental)”** com os botões **Enviar
`0x7E`** e **Enviar `0x7F`**. Regras de segurança implementadas no app:

- só libera com conexão BLE real, Control Point presente, esteira confirmada (“É esta esteira”), o
  controle experimental 0xFFF0 desligado, nenhum comando em andamento e **lona parada**
  (velocidade medida ≤ 0,5 km/h). A sessão repete todas as checagens, não só a tela;
- antes de cada envio há um **diálogo de confirmação** deixando explícito que o console pode
  reiniciar e que **nada ali atualiza firmware** (o app não tem cliente HTTP do console nem
  implementa `/upload`);
- a resposta do Control Point é decodificada e mostrada (`Success`/`Control Not Permitted`/`Op Code
  Not Supported`…), com o parâmetro em hexadecimal (ex.: o **delay** do `0x7E`), e tudo vai para o
  registro da sessão;
- depois de um reinício/queda, o resultado continua no estado da sessão para ser lido (a Sonda
  mostra o último teste mesmo desconectada).

Testes automatizados cobrem: bloqueio com a lona andando, envio com a esteira parada
(pedindo `Request Control` antes), leitura do parâmetro/delay, recusa do firmware, modo
demonstração e op code inválido.

### 6.4 O que não muda

- Nada aqui dá controle de velocidade/inclinação: o OTA só reinicia/grava firmware. O caminho de controle continua **desconhecido** e fora do FTMS de usuário.
- Continua valendo: **não escrever no FFF3/0xFFF0** além do experimento já planejado (serviço de rename/config), e não usar firmware de outro modelo.

### 6.4 Riscos

| Ação | Risco |
| --- | --- |
| Enviar `0x7E` na T600X | reinicia/derruba a conexão do console; só com lona vazia e ninguém em cima |
| `POST /upload` | **grava firmware**; risco de brick — proibido no equipamento da academia |
| Entrar no AP do console | leitura é inofensiva; cuidado para não derrubar o console de outro usuário |
| Analisar firmware de outro modelo (T6) | OK para estudo; **não** gravar em hardware |

---

## 7. Evidências (arquivo:linha)

| # | Fato | Onde |
| --- | --- | --- |
| 1 | Opcode 126 `RESET_CONSOLE_RESOURCE` e 127 `SET_AP_MODE` (deprecated) | `SRC/com/johnsonfitness/ble/profile/ftms/ControlPointDataType.java:9,18` |
| 2 | `resetConsoleResource()` = `0x7E`; `setAPMode()` = `0x7F` | `SRC/com/johnsonfitness/ble/ftms/data/FTMSControlPointData.java:41-49` |
| 3 | App chama `resetConsoleAndAp()` ao confirmar | `SRC/.../data/repository/FtmsRepository.java:670-672`; `SRC/.../ui/controller/upgrade/UpgradeViewModel.java:448-453` |
| 4 | Resposta do CP: `80 <op> <result>`; sucesso com 126 traz delay em `u8` | `SRC/.../ble/ftms/data/impl/ControlPointDataCallback.java:23-70` |
| 5 | Machine Status 254 = progresso (u8 %), 253 = resultado (0 idle/1 sucesso/2 file/3 write/4 timeout) | `SRC/.../ble/profile/ftms/MachineStatusDataType.java:34-40`; parser em `MachineStatusDataCallback.java:97-100` |
| 6 | HTTP do console: `10.10.10.1:88`, `Now`, `OTA`, `upload` | `SRC/.../data/repository/ConsoleUpgradeRepository.java:38-41,151,223` |
| 7 | Wi-Fi: SSID = nome BLE, senha vazia | `SRC/.../ui/controller/upgrade/UpgradeViewModel.java:456-467`; `SRC/.../util/wifi/WifiConnectionManager.java:121` |
| 8 | Espera delay do 126, re-escaneia por MAC (timeout 60 s), espera 7 s e conecta Wi-Fi | `SRC/.../ui/controller/upgrade/UpgradeConnectWifiFragment.java:~735-780,~342-380`; `SRC/.../data/Constant.java:11` |
| 9 | `GET /Now` com `Referer /OTA`; `POST /upload` octet-stream | `SRC/.../ConsoleUpgradeRepository.java:151,223`; `data/remote/CommonService.java` |
| 10 | Comparação de versão + match por modelo + MD5 do arquivo | `SRC/.../ui/controller/upgrade/UpgradeViewModel.java:332-380`; `CheckUpgradeFragment.java:432-441`; `Util/Utils` |
| 11 | Remote Config key `consoleConf`; projeto Firebase | `SRC/.../util/firebase/FRCManager.java:44-46`; `res/values/strings.xml` (`google_app_id`, `project_id`) |
| 12 | Lista de suporte de produção (T6, IC4-02) e URLs do CDN | `gymburn-re/ota-re/consoleConf-frc.json` (obtido via API pública do FRC) |
| 13 | Pacote de firmware = JSON + Console ESP32-S3 + LowBoard ESP32-S2; strings do FTMS/OTA/I2C | `gymburn-re/ota-re/Bowflex_T6_S1.17/`; `t6_console_strings.txt` |
| 14 | Play bloqueia o app no Brasil; APK do APKPure assinado com Google Play/Source Stamp; instalado via `adb install-multiple` | capturas + `apksigner verify --print-certs` + `aapt dump badging` |
| 15 | App instalado 1.2.0 em 2026-11-12 20:00:06; ao abrir, Play mostra “app não reconhecido” | `dumpsys package com.johnsonfitness.wave`; screenshot `/tmp/jota_run1.png` |

---

## 8. Como reproduzir

```bash
cd /home/leandro/Development/projects/gym-burn/gymburn-re

# APK (XAPK do APKPure; Google Play bloqueia no BR) + instalação no celular
ls apks/com.johnsonfitness.wave.xapk
unzip -q apks/com.johnsonfitness.wave.xapk -d /tmp/jota_x
adb -s 96171e68 install-multiple -r /tmp/jota_x/com.johnsonfitness.wave.apk \
  /tmp/jota_x/config.en.apk /tmp/jota_x/config.xhdpi.apk /tmp/jota_x/config.arm64_v8a.apk

# decompilado (já feito)
JAVA_OPTS="-Xmx8g" ./tools/jadx/bin/jadx -d decompiled/com.johnsonfitness.wave --no-res -j 4 apks/com.johnsonfitness.wave.apk

SRC=decompiled/com.johnsonfitness.wave/sources
grep -rn "RESET_CONSOLE_RESOURCE\|SET_AP_MODE" $SRC/com/johnsonfitness/ble
grep -rn "10.10.10.1\|NOW_PATH\|UPLOAD_PATH" $SRC/com/johnsonfitness/wave
sed -n '23,70p' $SRC/com/johnsonfitness/ble/ftms/data/impl/ControlPointDataCallback.java
sed -n '34,40p' $SRC/com/johnsonfitness/ble/profile/ftms/MachineStatusDataType.java
grep -rn "KEY_CONSOLE_CONF" $SRC/com/johnsonfitness/wave/util/firebase/FRCManager.java

# firmware (público no CDN; só análise, NUNCA gravar)
cd ota-re/Bowflex_T6_S1.17
curl -sL -O https://ota.jhtfitness.com/Bowflex/T6/T6_S1.17-092714.bin
md5sum T6_S1.17-092714.bin   # 5993562ec43b197363e9bfd624505583
python3 - <<'PY'
data=open('T6_S1.17-092714.bin','rb').read()
open('BFX_T6_console.bin','wb').write(data[1024:1024+2064128])
open('USB_T6_lowboard.bin','wb').write(data[2065152:2065152+354016])
PY
strings -a -n5 BFX_T6_console.bin | grep -iE "Machine Control Point|Device update|OTA Web|CMD_W_|CMD_R_"
```

---

## 9. Artefatos locais (fora do git)

| Artefato | Caminho |
| --- | --- |
| XAPK + base APK | `gymburn-re/apks/com.johnsonfitness.wave.{xapk,apk}` |
| Decompilado jadx | `gymburn-re/decompiled/com.johnsonfitness.wave/` |
| Recursos (manifest/strings) | `gymburn-re/res/com.johnsonfitness.wave/` |
| Config do Firebase Remote Config (leitura pública) | `gymburn-re/ota-re/consoleConf-frc.json` |
| Pacote de firmware + imagens extraídas | `gymburn-re/ota-re/Bowflex_T6_S1.17/` |
| Strings do firmware (console/lowboard) | `gymburn-re/ota-re/t6_{console,lb}_strings.txt` |

> Tamanho total de `gymburn-re/`: ~2,0 GB (APKs + decompilados). Continua **não versionado**; se quiser, adicionamos ao `.gitignore` (ou commitamos só `docs/`).
