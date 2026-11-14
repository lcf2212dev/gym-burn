# Engenharia reversa do app oficial **Vision Fitness-Workout Tracker** (`com.johnsonfitness.visionapp` 2.0.0)

- **Data:** 2026-11-12
- **APK:** `com.johnsonfitness.visionapp` · `versionName 2.0.0` · `versionCode 49` · 47.973.342 bytes · 5 × `classes*.dex` · `minSdk 29` / `targetSdk 36` · launcher `SplashActivity`
- **Origem:** APK baixado do Google Play no celular do usuário e extraído com `adb pull` do `base.apk` (splits `arm64_v8a`, `pt`, `xxhdpi` não contêm código Java)
- **Corpus local:** `gymburn-re/apks/com.johnsonfitness.visionapp.apk`, decompilado com jadx 1.5.6 em `gymburn-re/decompiled/com.johnsonfitness.visionapp/` (17.693 `.java` + recursos em `gymburn-re/res/...`)
- **Objetivo:** ver se o app oficial da Vision/Johnson Health Tech (JHT) para esteira `VISION ID 1AB1` da T600X tem algo que ajude a **comandar velocidade/inclinação** — e o que ele revela sobre o `0xFFF0`.

> Convenção de caminhos neste documento: **`SRC/`** = `gymburn-re/decompiled/com.johnsonfitness.visionapp/sources/`. As linhas citadas são do código Java gerado pelo jadx.

---

## TL;DR (o que interessa para o nosso projeto)

1. **O app oficial NÃO controla a esteira — de propósito.** Ele tem a API completa do FTMS Control Point (`Request Control`, `Start/Resume`, `Stop/Pause`, `Set Target Speed/Inclination/Resistance/Power/HR`), mas **nenhuma tela chama essas funções**: é código morto herdado de uma biblioteca da JHT. O fluxo real é só **ler** o FTMS e gravar o treino; quem dá partida/ajusta é o **painel do console** (o próprio texto do app manda apertar GO/Start no equipamento).
2. **O `0xFFF0` do app é o serviço de "renomear dispositivo".** As constantes da biblioteca são `SERVICE_RENAME = 0000fff0-…` e `CHANGE_DEVICE_NAME = 0000fff3-…` — exatamente o serviço `0xFFF0`/char `FFF3` da nossa esteira. Isso **derruba a hipótese principal** que sustentava o "controle experimental 0xFFF0" (FFF3 como canal de comandos): o uso conhecido é **configuração/nome do módulo BLE**, não motor/inclinação. (As constantes não são usadas neste app, mas o nome é do próprio fabricante.)
3. **Referência oficial de parsing FTMS** — o app da JHT usa as mesmas unidades da spec (velocidade 0,01 km/h; inclinação 0,1 %; rampa 0,1°; distância 1 m; etc.) e **não corrige** nada. Ou seja: nas duas anomalias que medimos na T600X (`targetSpeedChanged` ×16 e inclinação do `0x2ACD` ×6,667), o app oficial também mostraria valores errados — a nossa correção continua necessária e está "certa pela spec".
4. **Pareamento por NFC:** o app registra `NDEF_DISCOVERED` para o scheme `vision` e lê da tag da máquina: `action`, `equipment-type`, `device-id` (nome BLE), `model-number`, `model-name` (tudo em `SRC/com/johnsonfitness/visionapp/RouterActivity.java:595-604`). É o "encoste o celular no console" oficial. Serve de **modelo** para um "tap-to-connect" no GymBurn (e testa se a T600X tem tag NFC).
5. **Conclusão prática:** os 4 apps baixados **não dão controle** (os 3 Netpulse também não — ver `docs/re/netpulse-apps.md`). Se controle existe em algum lugar, é **firmware/modo de serviço do console** ou um **app de técnico/OTA da JHT** — não no app de usuário. Próximos alvos sugeridos em §9.4 (o mais promissor: `JohnsonOTA`, `com.johnsonfitness.wave`).

---

## 1. Corpus e método

| Item | Valor |
| --- | --- |
| Package / versão | `com.johnsonfitness.visionapp` 2.0.0 (49) |
| Tamanho / dex | 47.973.342 B / `classes.dex`…`classes5.dex` |
| Label | "Vision Fitness" |
| minSdk / targetSdk | 29 / 36 |
| Java decompilado | 17.693 arquivos (`SRC/`) |
| Resources | `gymburn-re/res/com.johnsonfitness.visionapp/resources/res/` (strings.xml com 654 linhas) |

Ferramentas: `jadx 1.5.6` (local, `gymburn-re/tools/jadx/bin/jadx`), `aapt`/`aapt2` do Android SDK 36, `grep`/`rg` no código decompilado, `strings` nos `.dex`, e comparação com a spec FTMS 1.0 (tabela de op codes conferida no dissector do Wireshark `packet-btatt.c`, linhas 3914-3940 do `master` em 12/11/2026).

Nada foi instalado no celular nem executado; a análise é estática.

---

## 2. O que o app é (e o que não é)

É o app **de consumidor** da Vision Fitness, para:
- **detectar/emparelhar** com equipamentos de cardio da JHT (FTMS, 0x1826) e com **cintas de FC** (0x180D);
- **gravar o treino** feito no painel (tempo, distância, velocidade, inclinação, calorias, FC, MET, potência quando existir);
- **exportar** para Health Connect / Samsung Health;
- apoiar **musculação**: catálogo de exercícios por modelo (ex.: `V-KEY-SL-13`), séries/repetições, importação por QR.

Ele **não** é um console remoto: não inicia treino, não muda velocidade nem inclinação.

### 2.1 Telas (activities no manifest)

`SplashActivity`, `OnBoardingActivity`, `MainActivity`, `RouterActivity` (recebe NFC/QR/deep link), `ui.detectstatus.DetectStatusActivity` (conecta na máquina), `ui.readyToScanActivity.ReadyToScanActivity` (ponte do NFC → detecção), `ui.workout.cardio.WorkoutActivity` (treino em andamento, 1 layout por tipo de máquina), `ui.summary.cardio.SummaryActivity`, `QrScannerActivity`, `ui.setting.*`, `ui.training.strength.*` (musculação).

### 2.2 Permissões relevantes

`BLUETOOTH_CONNECT`, `BLUETOOTH_SCAN`, `BLUETOOTH_ADVERTISE` (+ `BLUETOOTH`/`BLUETOOTH_ADMIN` até API 30), `ACCESS_FINE_LOCATION`, `NFC`, `CAMERA`, `android.permission.health.WRITE_*` (Health Connect: HR, speed, distance, calories, steps, exercise, floors) e permissões do Samsung Health. `BLUETOOTH_ADVERTISE` está declarada mas **não há uso de advertising/servidor GATT** no app: nenhuma referência a `BluetoothLeAdvertiser`/`startAdvertising`, e a lib `ble_library` tem `BleServerManager` mas o app **nunca chama `useServer`** (só uso interno da própria lib) — sobra de template.

### 2.3 As três pilhas BLE dentro do APK

| Pacote | O que é | Evidência |
| --- | --- | --- |
| `com.johnsonfitness.ble` (64 classes) | cliente **FTMS da JHT**: `JhtConnectManager` (singleton), `FtmsManager`, `JhtBleScanner`, perfis/parsers (`profile/ftms/*`, `ftms/data/*`) | `SRC/com/johnsonfitness/ble/` |
| `com.johnsonfitness.ble_library` (95 classes) | **Android-BLE-Library da Nordic renomeada** (`BleManager`, `BleManagerHandler`, `BleManagerGattCallback`, `Request`/`ReadRequest`/`WriteRequest`, `ConnectionObserver`…) | nomes de classe/métodos idênticos à lib da Nordic; sem string "nordicsemi" (pacote renomeado) |
| `com.johnsonfitness.scanner` (18 classes) | **BluetoothLeScannerCompat da Nordic renomeada** (`BluetoothLeScannerCompat`, `ScanCallbackWrapperSet`, `ScannerService`, `PendingIntentReceiver`) | `SRC/com/johnsonfitness/scanner/` |

Também há `com.johnsonfitness.fitdisplay2` (13 classes utilitárias: Health Connect, Glide, tela) e `com.johnsonfitness.atsoul` (1 classe: só liga o Bluetooth pedindo permissão). Nada disso tem protocolo de controle.

---

## 3. Como o app encontra e conecta a esteira

### 3.1 Anúncio FTMS → tipo de máquina (`0x1826` service data, 3 bytes)

`FtmsUtil.getFtmsType()` (`SRC/com/johnsonfitness/ble/util/FtmsUtil.java:22-68`):
- considera FTMS se o scan record tem **service data do `0x1826` com exatamente 3 bytes**;
- `serviceData[0] == 0` → `UNSUPPORTED`;
- `serviceData[1]` é um campo de bits: **bit 0 → Treadmill**, bit 1 → CrossTrainer, bit 2 → StepClimber, bit 3 → StairClimber, bit 4 → Rower, bit 5 → IndoorBike (bit 0 ausente = Treadmill);
- se não houver service data, tenta achar `0x180D` (cinta de FC) na lista de serviços → `HearRate`; senão `UNKNOWN`.

**Ligação com a nossa esteira:** a unidade 1AB1 anuncia `serviceData 0x1826 = 01 01 00` (dossiê §2). Pela regra acima: `serviceData[0]=0x01` (≠0), `serviceData[1]=0x01` → bit 0 → **Treadmill**. Ou seja, o próprio firmware se declara esteira no service data — é o caminho pelo qual o app oficial filtra e tipa o equipamento. (Não precisamos disso para conectar — nós usamos o serviço 0x1826 — mas é um dado de identidade útil para o app mostrar o tipo.)

### 3.2 Toque NFC (deep link `vision://…`) — o "protocolo de pareamento" do console

O app declara `intent-filter` de **`android.nfc.action.NDEF_DISCOVERED`** com `scheme = @string/app_scheme` (= **`vision`**), `host="*"`, `pathPattern=".*"` (manifest, linhas 277-287; `app_scheme` em `res/values/strings.xml:410`). Ao receber a tag, `RouterActivity.handleNfcUri()` (`SRC/com/johnsonfitness/visionapp/RouterActivity.java:595-620`) lê os parâmetros:

| Parâmetro da URI | Uso no app |
| --- | --- |
| `action` | ação do deep link (logada; ex.: abrir BLE) |
| `equipment-type` | tipo ("Treadmill", "CrossTrainer", …) — obrigatório no fluxo `nfc_open_ble` |
| `device-id` | **nome BLE** do equipamento (usado como substring na busca; ver abaixo) — obrigatório no fluxo `nfc_open_ble` |
| `model-number` / `model-name` | modelo; vão para o analytics/log e para a UI |

Com `routerType == nfc_open_ble` o app abre `ReadyToScanActivity` (`RouterActivity.java:403-411`), que por sua vez chama `DetectStatusActivity` passando esses extras (`ReadyToScanActivity.java:87-92`).

Na detecção, `DetectStatusActivity` chama `JhtConnectManager.connectNfc(deviceId, …)` (`SRC/.../ui/detectstatus/DetectStatusActivity.java:425`). O método (`JhtConnectManager.java:503-530`) **escaneia por FTMS e conecta no primeiro dispositivo cujo `BluetoothDevice.getName()` contém a string `device-id`**:

```java
String name = scanResult.getDevice().getName();
if (name != null && name.contains(str)) { … connectFtmsDevice(…) }
```

Ou seja: apesar do nome "device-id", é um **fragmento do nome BLE** (ex.: `"1AB1"` casaria com `VISION ID 1AB1`), não MAC. Para o GymBurn isso é replicável: um intent-filter igual (scheme `vision`) permitiria um "encoste no console → conecta sozinho", como o app oficial faz. **Só funciona se a T600X tiver tag NFC** — é um teste barato na próxima ida à academia (ler a tag com qualquer app de NFC; ver §9.4).

### 3.3 Conexão e inicialização do GATT

- `JhtConnectManager.connectFtms()` monta um `ConnectionObserver`, limpa callbacks antigos e conecta com **retry(3) a cada 100 ms, timeout 30 s, autoConnect desligado** (`JhtConnectManager.java:267-330` (retry/timeout na linha 327)).
- `FtmsManager.initialize()` (`SRC/com/johnsonfitness/ble/ftms/FtmsManager.java:146-280`) ao ficar pronto:
  - **lê** `0x2ACC` (Fitness Machine Feature: 2 × u32 = features e target setting features, exige 8 bytes — `FTMSFeatureDataCallback.java:26-30`);
  - lê as faixas: `0x2AD4` velocidade, `0x2AD5` inclinação, `0x2AD6` resistência, `0x2AD7` FC, `0x2AD8` potência;
  - **assina notificação** de `0x2ACD` (treadmill), `0x2ACE`, `0x2ACF`, `0x2AD0`, `0x2AD1`, `0x2AD2` (cada tipo de máquina), `0x2AD3` (training status) e `0x2ADA` (machine status);
  - **habilita indication** no `0x2AD9` (control point) — mas só para receber respostas, nunca escreve (ver §6);
  - **lê** `0x2A24` (Model Number, Device Information).

Depois disso a tela de treino só **grava** os dados; a conexão é mantida para o treino e depois encerrada.

---

## 4. Perfil GATT usado (o mesmo que já mapeamos; aqui pelo lado do cliente oficial)

| Característica | UUID | Operação no app |
| --- | --- | --- |
| Fitness Machine Feature | `0x2ACC` | read (8 bytes) |
| Supported Speed Range | `0x2AD4` | read |
| Supported Inclination Range | `0x2AD5` | read |
| Supported Resistance Level Range | `0x2AD6` | read |
| Supported Heart Rate Range | `0x2AD7` | read |
| Supported Power Range | `0x2AD8` | read |
| Treadmill Data | `0x2ACD` | notify |
| Cross Trainer Data | `0x2ACE` | notify |
| Step Climber Data | `0x2ACF` | notify |
| Stair Climber Data | `0x2AD0` | notify |
| Rower Data | `0x2AD1` | notify |
| Indoor Bike Data | `0x2AD2` | notify |
| Training Status | `0x2AD3` | notify |
| Fitness Machine Status | `0x2ADA` | notify |
| Fitness Machine Control Point | `0x2AD9` | **indication habilitada, nunca escrita** |
| Model Number (DIS `0x180A`) | `0x2A24` | read |
| Heart Rate Measurement | `0x2A37` | notify (fluxo separado, cinta de FC) |

Constantes em `SRC/com/johnsonfitness/ble/constant/ServCharsUUID.java`.

---

## 5. Como o app interpreta o FTMS — a referência do fabricante

### 5.1 Treadmill Data `0x2ACD`

Parser em `SRC/com/johnsonfitness/ble/ftms/data/impl/TreadmillDataCallback.java:35-142`. Segue a spec 1.0: **flags u16** e, na ordem, só os campos cujo bit está ligado. Unidades declaradas nas classes (`SRC/com/johnsonfitness/ble/profile/ftms/TreadmillDataType.java`):

| Campo (bit) | Formato | Resolução | Unidade |
| --- | --- | --- | --- |
| velocidade instantânea (0) | uint16 | 0,01 | km/h |
| velocidade média (1) | uint16 | 0,01 | km/h |
| distância total (2) | uint24 | 1 | m |
| **inclinação (3)** | **sint16** | **0,1** | **%** |
| ângulo de rampa (3) | sint16 | 0,1 | ° |
| ganho de elevação +/− (4) | uint16 | 0,1 | m |
| pace instantâneo/médio (5/6) | uint8 | 0,1 | *(o app rotula "Km/min" — rótulo duvidoso)* |
| energia total / por hora / por min (7) | u16 / u16 / u8 | 1 | kcal |
| FC (8) | uint8 | 1 | bpm |
| MET (9) | uint8 | 0,1 | meta |
| tempo decorrido (10) | uint16 | 1 | s |
| tempo restante (11) | uint16 | 1 | s |
| força na lona / potência (12) | sint16 | 1 | N / W |

**Comparação com a nossa coleta:** os 1.762 pacotes da T600X usam flags `0x078C` e 20 bytes (dossiê §6.1) — exatamente os campos distância + inclinação + rampa + energia + FC + MET + tempo decorrido. O parser do app oficial leria essa payload **igual ao nosso**; a diferença aparece nos *valores*: para a T600X o app oficial mostraria **20 %** de inclinação onde o painel mostra 3 % (fator 6,667) e **80 km/h** no aviso de alvo de velocidade (fator 16). Ou seja: **o firmware é que está fora da spec**, não o nosso parser — e nossa correção de exibição (`T600X_INCLINATION_READING_FACTOR`) é o que o app oficial *deveria* ter, mas não tem.

### 5.2 Fitness Machine Status `0x2ADA`

Parser em `SRC/com/johnsonfitness/ble/ftms/data/impl/MachineStatusDataCallback.java:23-95`; os op codes conferem com a spec (conferida no Wireshark `packet-btatt.c`):

| Op code | Evento | Parâmetro (formato) |
| --- | --- | --- |
| `0x01` | Reset | — |
| `0x02` | Stopped or Paused by User | u8: 1 = stop, 2 = pause |
| `0x03` | Stopped by Safety Key | — |
| `0x04` | Started or Resumed by User | — |
| `0x05` | **Target Speed Changed** | uint16/100 km/h |
| `0x06` | **Target Incline Changed** | sint16/10 % |
| `0x07` | Target Resistance Level Changed | u8 |
| `0x08` | Target Power Changed | sint16 |
| `0x09` | Target Heart Rate Changed | u8 |
| `0x0A`…`0x0E` | energia/passos/passadas/distância/tempo de treino alvo | u16/u24 |
| `0x11` | Indoor Bike Simulation Parameters | 3 × sint16/u8 |
| `0x12` | Wheel Circumference | u16 |
| `0x13` | Spin Down Status | u8 |
| `0x15` | Target Cadence Changed | u16 |
| `0xFF` | Control Permission Lost | — |

Isso valida o que já usamos (`src/ftms/machine-status.ts` tem exatamente esses op codes) e reforça que o "×16" da T600X é bug de serialização do firmware no **valor**, não op code errado.

### 5.3 Feature / Target Setting / faixas — como o app decide o que mostrar

- `FTMSFeatures` (`SRC/com/johnsonfitness/ble/profile/ftms/FTMSFeatureTypes.java:8-47`): bit 3 = **inclinação suportada**, bit 10 = FC, etc.
- `TargetSettingFeature` (mesmo arquivo, linhas 53-79): bit 0 = velocidade, bit 1 = inclinação, bit 4 = FC, …
- O app só **exibe inclinação** se `isSupportInclination()` = bit 3 do primeiro u32 estiver ligado (`JhtConnectManager.java:706-712`) e só lê as faixas de um alvo se o bit correspondente de Target Setting estiver ligado (`FtmsManager.java:157-179`).

**Ligação com a T600X:** feature lida foi `2C 3E 00 00` / targets `10 00 00 00` (dossiê §5.1). Bit 3 do primeiro u32 (`0x3E2C`) = 1 → o app oficial **mostraria** a inclinação (errada, ver §5.1). Bit 0/1 de targets = 0 → o app oficial **não habilitaria** nenhum ajuste de velocidade/inclinação — coerente com o comportamento que observamos (`Control Not Permitted`).

### 5.4 Ranges

`TargetSettingDataType` (`SRC/com/johnsonfitness/ble/profile/ftms/support/TargetSettingDataType.java`): velocidade 0,01 km/h, inclinação 0,1 %, resistência 0,1, potência 1 W, FC 1 bpm — mesma spec. Eles **acreditam** na faixa declarada (0–50 %/3 % na T600X) exatamente como nós acreditávamos antes de descobrir que é template de firmware; não há tratamento especial para a T600X.

---

## 6. Controle do equipamento: a API existe, mas é **código morto**

O app tem a implementação completa e correta do Control Point:

- `SRC/com/johnsonfitness/ble/ftms/data/FTMSControlPointData.java` — monta os payloads da spec:
  - `requestControl()` = `00`
  - `reset()` = `01`
  - `setTargetSpeed(i)` = `02` + uint16 (0,01 km/h)
  - `setTargetInclination(i)` = `03` + sint16 (0,1 %)
  - `setTargetResistance/Power/HeartRate`, `startOrResume()` = `07`, `pause()` = `08 02`, `stop()` = `08 01`
- `SRC/com/johnsonfitness/ble/JhtConnectManager.java:575-690` — expõe `requestControlPermission()`, `startOrResumeWorkout()`, `pauseWorkout()`, `stopWorkout()`, `setTargetSpeed/Inclination/Resistance/Power/HeartRate(...)` com *clamp* pela faixa lida.

**Porém:** busca por chamadas no app inteiro (17.693 `.java`) mostra **zero** usos desses métodos fora da própria classe:

```
$ grep -rn "requestControlPermission\|startOrResumeWorkout\|pauseWorkout\|stopWorkout\|setTargetSpeed(\|setTargetInclination(" SRC --include=*.java
→ só as definições em JhtConnectManager.java (nenhum caller em visionapp/)
```

E todas as 20 chamadas de `writeControlPoint(...)` estão **dentro** da própria `JhtConnectManager` (`grep -rn "writeControlPoint("` → só `JhtConnectManager.java`). Nenhuma outra classe escreve no `0x2AD9`; o máximo que o app faz é **habilitar indication** nele (`FtmsManager.java:261-269`). Em `DetectStatusActivity`/`WorkoutActivity` não há uma única escrita de comando.

**Texto do próprio app confirma o desenho** (`res/values/strings.xml:37,40`): `ConnectStartWorkoutContent` = *"Please select the desired workout and press the \"GO\" or \"Start\" button on the equipment's screen to start the workout."*; `ConnectEquipmentReady` = *"Equipment Is Ready"*. O app **espera** o usuário começar no painel; ele não comanda. E o layout do treino de esteira (`res/layout/workout_treadmill.xml`) **não tem um único `Button`**: só `TextView`s de métricas (`speed_view`, `incline_view`, `duration_view`, `calories_view`, `heart_rate_view`, `pace_view`, `connect_status_text`…) — não existe painel de controle nem escondido.

O parâmetro `action` da URI NFC também é só **logado** (`RouterActivity.java:597,617`); o único roteamento é para pareamento (`nfc_open_ble`) ou treino/musculação. Não há deep link de "start/pause/speed".

### 6.1 Por que isso é importante para nós

- Confirma que **a JHT escolheu não expor controle ao app de usuário**. Não é limitação do nosso app nem falta de descoberta de protocolo: o app oficial, com todo o acesso ao firmware, **também não controla**.
- O FTMS da T600X (target settings `0x10`) e o comportamento `Control Not Permitted` são consistentes com esse desenho.
- Reforça: o controle, se existir, está **fora do canal BLE de usuário** (painel, modo de serviço, porta CSAFE, ou um app de técnico/OTA — §9.4).

---

## 7. O `0xFFF0` segundo o app oficial: **serviço de renomear dispositivo**

A única menção ao `0xFFF0`/`FFF3` no APK está em `SRC/com/johnsonfitness/ble/constant/ServCharsUUID.java`:

```java
public static final String CHANGE_DEVICE_NAME = "0000fff3-0000-1000-8000-00805F9B34FB"; // linha 8
...
public static final String SERVICE_RENAME      = "0000fff0-0000-1000-8000-00805f9b34fb"; // linha 34
```

- `SERVICE_RENAME` = **serviço de renomeação** (0xFFF0), `CHANGE_DEVICE_NAME` = **característica para trocar o nome do dispositivo** (0xFFF3).
- Essas constantes **não são usadas** neste app (grep: só aparecem na declaração). São sobra da biblioteca BLE da JHT — provavelmente de um app de provisionamento/técnico que define o nome BLE do módulo (o nosso `VISION ID 1AB1` tem cara de nome gravado de fábrica por esse serviço).
- As demais características do serviço na nossa unidade (FFF1 read+write, FFF2 read, FFFF4 notify, FFF5 read protegida) batem com o **SimpleGATTProfile da TI**, que é só o "envelope" do serviço; o nome do char FFF3 dado pela JHT é a melhor pista de semântica que temos.

**Impacto no "controle experimental 0xFFF0" do GymBurn:** a hipótese "FFF3 = canal de comandos do motor" perde sustentação — o uso documentado (pelo próprio fabricante) é **configuração**. Isso **não prova** que o serviço não tenha outros comandos (o módulo é de terceiro — WiLinktech WLT8258 — e pode implementar comandos próprios nos outros chars), mas muda a expectativa e o risco: escrita no FFF3, no melhor caso, **renomeia o módulo**; no pior, mexe em configuração de fábrica. Recomendação em §9.3.

> A unidade de 11/11 e a de 12/11 têm o mesmo GATT/`0xFFF0`; a de 12/11 respondeu `0x2A5B`/`FFF4` zerados por 17 min. Não há nenhum indício, em nenhum dos dois apps oficiais analisados, de tráfego de motor pelo 0xFFF0.

---

## 8. Outros achados (menos relevantes, mas registrados)

| Achado | Detalhe | Utilidade |
| --- | --- | --- |
| QR de musculação | `QrScannerActivity` + JSON de treino (`res/raw/execisedata.json` com modelos `V-KEY-SL-*` etc.) | nenhuma para esteira |
| URLs | `https://develop.vision.jhtfitness.com/privacy/en` e `/terms/en` (`AboutActivity.java:31-32`) | nenhuma |
| Health Connect | grava HR/velocidade/distância/calorias/passos/pisos; `health_data_insert.sql` | ideia para exportar treino do GymBurn (futuro) |
| Analytics | GTM (`GTMTracker`) com `connectSuccess(tipo, modelNumber)` | nenhuma |
| Vídeo | SDK AliVideo (`licensekey` no manifest, `assets/cert`) para tutoriais | nenhuma |
| Nome do modelo | lido de `0x2A24` e enviado ao GTM; na T600X lê `000000` (dossiê §4) | identidade; inútil para controle |

---

## 9. Conclusões e o que fazer com isso

### 9.1 O que este RE **confirma**

1. O FTMS da T600X é **somente leitura** por desenho do firmware; o app oficial só lê.
2. As escalas que corrigimos no GymBurn (×16 no alvo de velocidade, ×6,667 na inclinação do `0x2ACD`) são **anomalias do firmware**: o app oficial lê "cru" pela spec e também exibiria errado. Nossa correção está certa.
3. O service data de 3 bytes do `0x1826` diz o tipo de máquina; a T600X anuncia `01 01 00` = **Treadmill**.
4. Nada nos apps oficiais de usuário (nem Vision, nem ViewFit/Matrix) escreve comandos de motor.

### 9.2 O que **despriorizar**

- ~~"Descobrir o protocolo de comando do 0xFFF0"~~ → o `0xFFF0` é o serviço de **rename/config** do módulo (evidência JHT). Não é o caminho natural para motor.
- ~~"O app oficial deve ter o protocolo de controle escondido"~~ → ele tem a API FTMS de controle, mas **não a chama** (código morto); não há wrapper proprietário escondido.

### 9.3 Ações recomendadas no GymBurn (curto prazo, sem hardware novo)

1. **Honestidade na UI**: no cartão "Controle experimental (0xFFF0)" e em `docs/controle-experimental.md`, registrar que o app oficial da JHT chama o `0xFFF0` de **serviço de renomeação** e que a hipótese de canal de comando está **enfraquecida**; manter a varredura **como experimento**, com aviso de que escrita no FFF3 pode **renomear o módulo BLE** (não é comando de motor).
2. **Não investir mais em presets de velocidade/inclinação no FFF3** até haver evidência de comando; se for testar, testar primeiro **leitura** (FFF1/FFF2/FFF5) em estados diferentes do painel e **nunca** payload longo.
3. **Opcional e barato: "tap-to-connect" NFC** igual ao oficial — registrar `NDEF_DISCOVERED` para o scheme `vision` e usar `device-id` (nome BLE) para conectar direto; mesmo sem a tag, um filtro por nome já acelera a conexão. (Só vale se a T600X tiver tag; testar na academia.)
4. **Opcional: exibir "modelo" e "tipo"** lendo `0x2A24` e o service data `0x1826` ao conectar (identidade melhor; útil com várias unidades no salão).
5. Atualizar o dossiê/README com o link deste documento (feito).

### 9.4 Próximos alvos para **controle de verdade** (ordem de custo/benefício)

| # | Alvo | Por quê | Como |
| --- | --- | --- | --- |
| 1 | **Menu de serviço do console** | consoles JHT costumam ter modo técnico (teste de motor/inclinação) e às vezes opções de "controle externo"/CSAFE; pode existir um ajuste que habilite FTMS control ou que já comande via painel | explorar Settings do T600X (segurar teclas, códigos); fotografar telas |
| 2 | **`JohnsonOTA` (`com.johnsonfitness.wave`)** da JHT | **feito em 12/11** — ver [`johnsonota.md`](johnsonota.md): revelou os **opcodes vendor do FTMS** (`0x7E` reset/AP, `0x7F` set AP, `0xFD`/`0xFE` de upgrade) e o **OTA por Wi-Fi AP** (`10.10.10.1:88`, `/Now`, `/upload`). Não usa o 0xFFF0 para controle. | próximo passo: **testar `0x7E` na T600X** (§6.2 do doc do JohnsonOTA) |
| 3 | **Tag NFC do console** | ler a tag com app de NFC: ver se existe, e qual URI `vision://…` ela carrega (device-id/nome, model-number). Confirma o fluxo de pareamento e o "estado pronto" do console | celular com NFC; app tipo "NFC Tools" |
| 4 | **Porta CSAFE / controle externo** | se o console tem CSAFE (RJ45/DB9), é o caminho clássico de comando de esteira comercial; exigiria hardware (ex.: ESP32 UART↔CSAFE) | inspecionar traseira do console; manual de serviço T600X |
| 5 | **Firmware do console** | só com acesso a imagem/OTA; não recomendado (risco de brick) | — |

> O **JohnsonOTA** está na Play Store em [play.google.com/store/apps/details?id=com.johnsonfitness.wave](https://play.google.com/store/apps/details?id=com.johnsonfitness.wave) — mas **bloqueado no Brasil** (“não disponível no seu país”). O APK foi obtido do APKPure (build genuíno, assinado pela Play) e instalado por sideload; **a análise dele já foi feita em 12/11** — ver [`johnsonota.md`](johnsonota.md). Ao abrir, o Google Play mostra o aviso de “app não reconhecido” (sideload), então o app não roda neste aparelho; a análise foi estática. **Não** acionar atualização de firmware em equipamento alheio.

**O que não vale mais a pena:** continuar procurando protocolo de motor nos 4 APKs baixados (Vision + 3 Netpulse). Nenhum tem escrita de comando.

---

## 10. Como reproduzir

```bash
cd /home/leandro/Development/projects/gym-burn/gymburn-re

# 1) APK (já extraído do celular; repo local)
adb -s <serial> shell pm path com.johnsonfitness.visionapp
adb -s <serial> pull /data/app/.../base.apk apks/com.johnsonfitness.visionapp.apk

# 2) decompilar (memória: ~6-16 GB)
JAVA_OPTS="-Xmx16g" ./tools/jadx/bin/jadx \
  -d decompiled/com.johnsonfitness.visionapp --no-res -j 6 \
  apks/com.johnsonfitness.visionapp.apk

# 3) recursos (manifest/strings)
~/Android/Sdk/build-tools/36.0.0/aapt dump badging  apks/com.johnsonfitness.visionapp.apk
~/Android/Sdk/build-tools/36.0.0/aapt dump permissions apks/com.johnsonfitness.visionapp.apk
./tools/jadx/bin/jadx -d res/com.johnsonfitness.visionapp --no-src apks/com.johnsonfitness.visionapp.apk

# 4) conferir as afirmações deste doc
SRC=decompiled/com.johnsonfitness.visionapp/sources
grep -rn "SERVICE_RENAME\|CHANGE_DEVICE_NAME" $SRC
grep -rn "writeControlPoint(" $SRC | grep -v FtmsManager
grep -rn "requestControlPermission\|startOrResumeWorkout\|setTargetSpeed(" $SRC
grep -rn "handleNfcUri\|queryParameter" $SRC/com/johnsonfitness/visionapp/RouterActivity.java
sed -n '22,58p' $SRC/com/johnsonfitness/ble/util/FtmsUtil.java       # tipo por service data
sed -n '146,268p' $SRC/com/johnsonfitness/ble/ftms/FtmsManager.java   # initialize()
sed -n '575,690p' $SRC/com/johnsonfitness/ble/JhtConnectManager.java # API de controle (sem callers)
```

---

## Anexo A — Evidências (arquivo:linha)

| # | Fato | Arquivo:linha |
| --- | --- | --- |
| 1 | `0xFFF0` = **`SERVICE_RENAME`** | `SRC/com/johnsonfitness/ble/constant/ServCharsUUID.java:34` |
| 2 | `0xFFF3` = **`CHANGE_DEVICE_NAME`** | `SRC/com/johnsonfitness/ble/constant/ServCharsUUID.java:8` |
| 3 | Constantes do 0xFFF0 **não usadas** em nenhum outro lugar | `grep -rn "SERVICE_RENAME\|CHANGE_DEVICE_NAME" SRC` → só declaração |
| 4 | API de controle FTMS (request/start/pause/stop/targets) | `SRC/com/johnsonfitness/ble/JhtConnectManager.java:575-690` |
| 5 | Payloads do Control Point pela spec | `SRC/com/johnsonfitness/ble/ftms/data/FTMSControlPointData.java:9-47` |
| 6 | **Nenhum caller** da API de controle no app | `grep -rn "requestControlPermission\|startOrResumeWorkout\|setTargetSpeed(" SRC` → só definições |
| 7 | `writeControlPoint` só existe na própria JhtConnectManager (20 chamadas) | `grep -rn "writeControlPoint(" SRC` |
| 8 | App só habilita **indication** no 0x2AD9 | `SRC/com/johnsonfitness/ble/ftms/FtmsManager.java:261-269` |
| 9 | Leitura de features/ranges/model e assinaturas no connect | `SRC/com/johnsonfitness/ble/ftms/FtmsManager.java:146-280` |
| 10 | Feature = 2 × u32 (features + target settings) | `SRC/com/johnsonfitness/ble/ftms/data/impl/FTMSFeatureDataCallback.java:26-30` |
| 11 | Gate de exibição de inclinação = feature bit 3 | `SRC/com/johnsonfitness/ble/JhtConnectManager.java:706-712` |
| 12 | Parser do Treadmill Data (flags/ordem/formatos) | `SRC/com/johnsonfitness/ble/ftms/data/impl/TreadmillDataCallback.java:35-142` |
| 13 | Unidades: velocidade 0,01 km/h; inclinação 0,1 %; rampa 0,1° | `SRC/com/johnsonfitness/ble/profile/ftms/TreadmillDataType.java` |
| 14 | Op codes do Machine Status 0x2ADA (+ parâmetros) | `SRC/com/johnsonfitness/ble/ftms/data/impl/MachineStatusDataCallback.java:23-95` |
| 15 | Ranges do Target Setting (0,01/0,1/1) | `SRC/com/johnsonfitness/ble/profile/ftms/support/TargetSettingDataType.java` |
| 16 | Tipo de máquina por service data de 3 bytes | `SRC/com/johnsonfitness/ble/util/FtmsUtil.java:22-68` |
| 17 | Filtro de scan FTMS = serviço 0x1826 (+ endereço opcional) | `SRC/com/johnsonfitness/ble/JhtBleScanner.java:33-38` |
| 18 | Conexão: retry 3 / 100 ms / timeout 30 s / autoConnect off | `SRC/com/johnsonfitness/ble/JhtConnectManager.java:267-330` (linha 327) |
| 19 | NFC `NDEF_DISCOVERED`, scheme `vision`, host `*` | manifest, linhas 277-287; `res/values/strings.xml:410` |
| 20 | Leitura dos parâmetros da URI NFC | `SRC/com/johnsonfitness/visionapp/RouterActivity.java:595-620` |
| 21 | NFC → `ReadyToScanActivity` → `DetectStatusActivity` | `RouterActivity.java:403-411`; `ReadyToScanActivity.java:87-92` |
| 22 | Conexão pós-NFC casa por **substring do nome BLE** | `SRC/com/johnsonfitness/ble/JhtConnectManager.java:503-530` |
| 23 | Texto "apertar GO/Start no equipamento" | `res/values/strings.xml:37,40` (`ConnectEquipmentReady`, `ConnectStartWorkoutContent`) |
| 24 | Manifest: permissões BLE/NFC (sem advertising usado) | `aapt dump permissions` |
| 25 | Spec FTMS de op codes do 0x2ADA (conferência externa) | Wireshark `epan/dissectors/packet-btatt.c` (`fitness_machine_status_opcode_vals`) |
| 26 | Layout do treino de esteira **sem nenhum botão** (só métricas) | `res/layout/workout_treadmill.xml` |

## Anexo B — O que **não** foi possível determinar

- Se o console exige algum **estado especial** para liberar controle FTMS (não há evidência; `Request Control` é aceito, comandos recusados com `0x05` mesmo com a lona andando).
- Semântica exata de `FFF1/FFF2/FFF4/FFF5` do módulo WiLinktech (`0xFFF0`) — o app oficial só nomeia `FFF0/FFF3` como rename.
- Se a T600X tem tag NFC e qual URI carrega (teste físico pendente).
- Se um menu de serviço do console expõe comandos de motor (próximo alvo); o `JohnsonOTA` **não** expõe — ele só faz atualização de firmware (ver [`johnsonota.md`](johnsonota.md)).
