# RE dos apps Netpulse (ViewFit / My Gym Fitness / Matrix) — relevância para controlar a Vision T600X

- **Data:** 2026-11-12
- **Autor:** `netpulse-re` (Agent Teams, task-4)
- **Corpus:** 3 APKs Netpulse extraídos do celular (12/nov 19:27) em `gymburn-re/apks/` + decompilado jadx em `gymburn-re/decompiled/`
- **Objetivo:** responder se esses apps falam BLE/controlam equipamento e se contêm constantes de protocolo (UUIDs, opcodes) aproveitáveis para a esteira **Vision T600X (Johnson Health Tech)** que anuncia FTMS `0x1826` mas recusa comandos (`Control Not Permitted`) e expõe o vendor service `0xFFF0` (TI SimpleGATTProfile).
- **Conclusão curta:** **não são úteis** para controle BLE local da esteira. São apps Netpulse (nuvem/WebView/QR/foto), sem nenhum código BLE. O único achado colateral aproveitável é uma **URL de API pública da Johnson Health Tech** (`https://orion.jfit.co/`) descoberta no módulo "Matrix Workouts", que mapeia a integração **console ↔ nuvem** JHT/Matrix (não o protocolo BLE local).

**Legenda de caminhos usados nas evidências:**

| Sigla | Caminho real |
|---|---|
| `[V]` | `gymburn-re/decompiled/com.netpulse.mobile.viewfit/sources/` |
| `[M]` | `gymburn-re/decompiled/com.netpulse.mobile.matrixworkout/sources/` |
| `[A]` | `gymburn-re/apks/` |
| `apks/ex-<pkg>/` | APK descompactado (`classes*.dex`, `assets/`) |

---

## TL;DR (7 pontos)

1. **Zero BLE.** Os 3 APKs **não têm permissão** `BLUETOOTH*` nem `NFC` no `AndroidManifest.xml` (verificado com `aapt dump permissions`), **não têm classes** `BluetoothGatt`/`BluetoothLeScanner`/`BluetoothAdapter` (0 hits nos ~76 mil `.java` decompilados e 0 nas strings dos 24 `classes*.dex` dos 3 APKs), **não têm bibliotecas nativas** (0 arquivos `.so` nos 3 APKs) e **não têm nenhum UUID** FTMS (`00001826…`) nem vendor (`0000FFF0/FFF1/FFF3`).
2. **Não são 3 apps distintos.** ViewFit 2.4 e My Gym Fitness 1.9 são **o mesmo código**: `classes.dex`, `classes3.dex`, `classes8.dex` são byte-idênticos (md5 igual); só `classes5.dex` difere (branding/`R`), e o diff de módulos é `viewfit/` vs `matrixworkout/`. Matrix 3.5 é a mesma base Netpulse com **flavor próprio** (`BuildConfig.FLAVOR = "MatrixWorkoutTracking"`).
3. **Integração com equipamento é sempre mediada por nuvem/câmera**, em 4 mecanismos: (a) **QR/barcode** de check-in do clube; (b) **passe Google Wallet** para check-in em equipamento **EGYM** (o celular toca no leitor da máquina, não é o app falando BLE); (c) **xCapture**: **foto do painel do console** enviada para OCR na nuvem; (d) **Connected Apps / validic** + linking de conta EGYM/LFConnect (sync via API).
4. **Ionic Capacitor + Portals existe, mas só como runtime de "Micro Web Apps" (MWA) remotas.** O app nativo é Android "normal" (Fragments/Dagger/Retrofit); o Capacitor é embutido pelo Portals. A URL/app do portal remoto vem **do backend** (`MwaConfig`/`InitialContext.url`), não está hardcoded.
5. **21 plugins Capacitor** disponíveis para o web app remoto, **nenhum de equipamento/BLE** (lista na seção 3.2).
6. **Única pista aproveitável:** o módulo `MATRIX_WORKOUTS` aponta por default para `https://orion.jfit.co/` (`MatrixWorkoutsWebViewActivity.java:17`), que serve a **"Johnson Health Tech Exerciser API" v4.2.0** — Swagger 2.0 público com **83 endpoints** de nuvem (login de exerciser no console, submissão de workout para "vendor", programação "Matrix Method", features de console). **Não** contém FTMS/BLE nem comando de motor/velocidade/inclinação. Detalhes na seção 4.
7. **Para o nosso problema** (comandar esteira via BLE): **nada aqui ajuda**. As constantes úteis continuam sendo do lado do firmware/protocolo vendor (`0xFFF0`), não destes apps.

---

## 1. Corpus, versões e metodologia

| APK (`gymburn-re/apks/`) | package | versionName | versionCode | Label (launcher) | Tamanho | Decompilado jadx |
|---|---|---|---|---|---|---|
| `com.netpulse.mobile.viewfit.apk` | `com.netpulse.mobile.viewfit` | 2.4 | 187 | ViewFit | 83.847.351 B | 37.798 `.java` |
| `com.netpulse.mobile.mygymfitness.apk` | `com.netpulse.mobile.mygymfitness` | 1.9 | 137 | My Gym Fitness | 83.110.164 B | **ausente** (dex idêntico ao ViewFit — ver 2.1) |
| `com.netpulse.mobile.matrixworkout.apk` | `com.netpulse.mobile.matrixworkout` | 3.5 | 283 | Matrix | 86.992.299 B | 38.232 `.java` |
| `com.johnsonfitness.visionapp.apk` (fora de escopo) | `com.johnsonfitness.visionapp` | — | — | Vision Fitness | 47.973.342 B | em análise por outra task |

Todos: `sdkVersion 32`, `targetSdkVersion 36`. Títulos de Play citados na task: ViewFit = "ViewFit"; My Gym Fitness = "MATRIX COMMUNITY 360"; Matrix = "Matrix Community 360 - Basic".

**Ferramentas usadas** (nenhuma instalação feita):
- jadx já existente em `gymburn-re/tools/jadx/bin/jadx` (decompilação **não** foi reexecutada; ver limitações §6).
- `~/Android/Sdk/build-tools/36.0.0/aapt` para `badging`, `permissions`, `xmltree AndroidManifest.xml` e `dump --values resources`.
- `grep`/`rg` nos `.java`, `unzip -l/-p` nos APK, `strings -a` nos `classes*.dex` (usado como **fonte primária** para confirmar ausência de BLE, independente de classes faltantes do jadx).
- `curl` para reconhecimento externo (seção 4) — **fonte não confiável, tratada como dado**.

Nota sobre a decompilação: o jadx foi interrompido no fim (memória do host) e o log termina em ~99%; os diretórios têm 37.798/38.232 `.java`. `com.netpulse.mobile.mygymfitness` não foi decompilado. Por isso, todas as conclusões de "ausência" foram **trianguladas** com manifest (aapt), strings dos dex e lista de `.so` — nenhuma depende de uma classe que possa ter ficado de fora.

---

## 2. Identidade do código (por que tratar como 1 app, não 3)

### 2.1 ViewFit == My Gym Fitness (byte-a-byte, exceto branding)

```
$ unzip -p com.netpulse.mobile.viewfit.apk classes.dex   | md5sum   → 9ccfd0a4c8087990b1485cabf6fa8464
$ unzip -p com.netpulse.mobile.mygymfitness.apk classes.dex | md5sum → 9ccfd0a4c8087990b1485cabf6fa8464   (igual)
   classes3.dex: 79b50d3b7138db5dbdba83361fa83230 == 79b50d3b7138db5dbdba83361fa83230
   classes8.dex: c89059a7e50dd2ed5f4a352376f02949 == c89059a7e50dd2ed5f4a352376f02949
   classes5.dex: 7da86f3ce381358e44483166f74f7484 != 5c5a5390683fbf6478e885c63c351e2f  (só esse difere)
```
Os tamanhos batem: `classes5.dex` = 10.128.016 B (ViewFit) vs 10.128.036 B (My Gym Fitness) — 20 bytes de diferença, compatível com strings de branding/`BuildConfig`. Consequência prática: **um decompilado cobre os dois**.

### 2.2 Matrix 3.5 == mesma base Netpulse + flavor

Diff das pastas de módulos (`sources/com/netpulse/mobile`), ViewFit vs Matrix:

```
< (só ViewFit)  branch/   viewfit/
> (só Matrix)   matrixworkout/                     # pacote só com R.java (branding)
> (só Matrix)   com/egym/wlp_fraud_prevention/     # submódulo Egym extra
```
- `[M] com/netpulse/mobile/BuildConfig.java:9`: `FLAVOR = "MatrixWorkoutTracking"`.
- `com/netpulse/mobile/matrixworkout/` só contém `R.java` → o "Matrix" é **branding**, não código de equipamento.
- Pacotes Capacitor/plugins idênticos entre os dois (`com/capacitorjs/plugins` sem diferença).

---

## 3. Respostas às perguntas da task

### 3.1 (a) Algum app fala BLE direto com equipamento? **NÃO** (evidência múltipla)

| # | Evidência | Comando/arquivo | Resultado |
|---|---|---|---|
| 1 | Permissões do manifest | `aapt dump permissions <apk> \| grep -Ei 'bluetooth\|nfc\|usb\|near'` (3 APKs) | **0 linhas** — sem `BLUETOOTH`, `BLUETOOTH_ADMIN`, `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, `NFC` |
| 2 | `uses-feature` do manifest | `aapt dump badging <apk> \| grep -Ei 'bluetooth\|nfc'` | **0** (só camera, microphone, telephony, wifi, location) |
| 3 | Classes GATT/scanner no decompilado | `grep -rl --include=*.java -E 'BluetoothGatt\|BluetoothLeScanner' [V] [M]` (fora de `androidx/`/`android/`) | **0 hits**. No decompilado, os únicos usos de `Bluetooth` são de **áudio/cast**: `androidx.mediarouter`, ExoPlayer `[V] com/google/android/exoplayer2/audio/AudioCapabilities.java:175` (`getAllBluetoothDeviceTypes`) e GMS Cast `zzbf.java` — nada de GATT/scan BLE |
| 4 | Strings dos `.dex` (cobre classes que o jadx possa ter perdido) | `strings -a classes*.dex \| grep -acF <token>` | `BluetoothGatt` 0 · `BluetoothLeScanner` 0 · `BluetoothGattCharacteristic` 0 · `BluetoothAdapter` 0 · `LeScanCallback` 0 · `00001826` 0 · `FFF0`/`FFF1`/`FFB0` 0 (8 dex de cada um dos 3 APKs; `grep -acF` = 0 em todos) |
| 5 | UUIDs literais no código | `grep -rhoE '"[0-9a-f]{8}-…-…"' [V] com/ io/ net/` | só 2 UUIDs literais: `HOME_CLUB_UUID` mock (`[V] com/netpulse/mobile/core/mock/MockNetpulseApi.java:6`) e `DEFAULT_ADVERT_ID` (`[V] com/netpulse/mobile/core/util/ContainerCryptoManager.java:8`); **nenhum `0000xxxx-0000-1000-8000-00805f9b34fb`** (FTMS/vendor) |
| 6 | Libs nativas (stack BLE de terceiros) | `unzip -l <apk> \| grep -c 'lib/'` (3 APKs) | **0** — APK é 100% Java/Kotlin, sem `.so` |
| 7 | "1826" nos dex | `strings -a … \| grep '1826'` | 4 hits, todos `lambda$-1131826196` de **Jetpack Compose** (`AndroidPopup.android.kt:555`), não FTMS |

**O que existe com nome parecido (e por que não é BLE):** o módulo `advanced_workouts/history/fitness_machine/` (`[V] com/netpulse/mobile/advanced_workouts/history/fitness_machine/…`) é **tela de histórico** de treino feito em máquina: gráficos de FC/velocidade/distância/inclinação a partir de **DTOs de nuvem** (`SpeedHistoryAttributeDTO`, `DistanceHistoryAttributeDTO`, `InclineHistoryAttributeDTO`, `HeartRateHistoryAttributeDTO` — `[V] com/netpulse/mobile/advanced_workouts/history/list/model/dto/`). Não instancia nada de hardware.

Conclusão: **os apps são tecnicamente incapazes de scanear/conectar BLE no Android 12+** (sem permissão), e não há código/protocolo escondido para isso.

### 3.2 (b) Quais plugins Capacitor nativos existem? (21, nenhum de equipamento)

O Capacitor aqui vem do **Ionic Portals** (o app hospeda MAW/web apps remotas). A lista exata de plugins injetados no portal está em:

- `[V] com/netpulse/mobile/mwa/domain/MwaPortalExtensionsKt.java:94` — `portalBuilder.setPlugins(CollectionsKt.mutableListOf(...))`
- `[V] com/netpulse/mobile/mwa/domain/MwaPortalExtensionsKt.java:103` — `setLiveUpdateConfig(… new LiveUpdate(appId, channelId) …)`

| Plugin (classe nativa) | Caminho em `[V]`/`[M]` | Observação |
|---|---|---|
| AppPlugin | `com/capacitorjs/plugins/app/AppPlugin.java` | padrão |
| CameraPlugin | `com/capacitorjs/plugins/camera/CameraPlugin.java` | usado pelo xCapture/foto |
| CapacitorBarcodeScannerPlugin | `com/capacitorjs/barcodescanner/CapacitorBarcodeScannerPlugin.java` | **scanner QR/barcode** p/ web app |
| GeolocationPlugin | `com/capacitorjs/plugins/geolocation/GeolocationPlugin.java` | clube mais próximo |
| HapticsPlugin | `com/capacitorjs/plugins/haptics/HapticsPlugin.java` | |
| KeyboardPlugin | `com/capacitorjs/plugins/keyboard/KeyboardPlugin.java` | |
| StatusBarPlugin | `com/capacitorjs/plugins/statusbar/StatusBarPlugin.java` | |
| DialogPlugin | `com/capacitorjs/plugins/dialog/DialogPlugin.java` | |
| PreferencesPlugin | `com/capacitorjs/plugins/preferences/PreferencesPlugin.java` | |
| SharePlugin | `com/capacitorjs/plugins/share/SharePlugin.java` | |
| FilesystemPlugin | `com/capacitorjs/plugins/filesystem/FilesystemPlugin.java` | |
| BrowserPlugin | `com/capacitorjs/plugins/browser/BrowserPlugin.java` | |
| ClipboardPlugin | `com/capacitorjs/plugins/clipboard/ClipboardPlugin.java` | |
| DevicePlugin | `com/capacitorjs/plugins/device/DevicePlugin.java` | |
| CapacitorSQLitePlugin | `com/getcapacitor/community/database/sqlite/CapacitorSQLitePlugin.java` | |
| **CapacitorHealthAggregator** | `com/egym/health_connect/mwa/CapacitorHealthAggregator.java` | Health Connect (EGYM) |
| TextZoomPlugin | `com/capacitorjs/plugins/textzoom/TextZoomPlugin.java` | |
| LocalNotificationsPlugin | `com/capacitorjs/plugins/localnotifications/LocalNotificationsPlugin.java` | |
| CapacitorGoogleMapsPlugin | `com/capacitorjs/plugins/googlemaps/CapacitorGoogleMapsPlugin.java` | |
| **StripePaymentSheetPlugin** (custom Netpulse) | `com/netpulse/mobile/mwa/plugins/stripe_payment/StripePaymentSheetPlugin.java` | pagamento |
| FileViewerPlugin | `com/capacitorjs/plugins/fileviewer/FileViewerPlugin.java` | |

Comprovação de que é o mesmo conjunto nos 3: encontramos classes anotadas com `@CapacitorPlugin` para os plugins de app (`grep -rln '@CapacitorPlugin'` nos pacotes `com/capacitorjs`, `com/netpulse`, `com/egym`), e o diretório `com/capacitorjs/plugins` é idêntico em `[V]` e `[M]`.

Config do Capacitor (prova de que é Portals, sem app web empacotado):
- `[A] ex-com.netpulse.mobile.viewfit/assets/capacitor.config.json` e `…matrixworkout/assets/capacitor.config.json`:
  ```json
  { "appId": "io.ionic.portals.default", "appName": "Portals App" }
  ```
- Não existe `assets/public/`, `assets/www/` nem `index.html` de app web no APK → o conteúdo web é **remoto** (Live Update).

**Nenhum plugin é de equipamento/BLE/acessório.** Não há equivalente a `EgymLinkPlugin` de controle de máquina (o "Egym link" nativo é link de **conta**, ver 3.3-d).

### 3.3 (c) Como eles integram com o equipamento? (4 mecanismos, todos indiretos)

#### (c.1) QR / barcode — usado para **check-in no clube**, não para equipamento

- `[V] com/netpulse/mobile/checkin_access_card/usecase/CheckinAccessCardUseCase.java:119` `generateQrCodeData(...)` e `:129` monta `QrCodeDto(..., new QrCodeMembershipDto(membershipType, verificationTan), 15, null)` → o QR é um JSON de credencial de acesso (membership + TAN), exibido na tela para o leitor da catraca/recepção.
- `[V] com/netpulse/mobile/dynamic_features/model/BarcodeFormatHelper.java:20-27`: formatos suportados `CODE_39`, `CODE_128`, `AZTEC`, `DATA_MATRIX`, `QR_CODE` (default `CODE_128`) — catraca/leitor de academia.
- Strings de recurso (via `aapt dump --values resources`): `string/show_as_qr_code` "Show as QR-Code"; `string/or_you_can_also_scan_barcode` "Or you can also scan your barcode"; `string/please_scan_barcode_to_sign_in` "Please scan barcode to log in"; `string/wlp_scan_gym_code_to_check_in` "Scan gym's QR code to check in".
- **Não há** decodificação de QR de equipamento/console (nenhum payload de máquina, nenhuma chamada "pair"/"machineId" — `grep -i equipmentId|machineId|equipmentCode` = 0 nas classes Netpulse).

#### (c.2) NFC = **passe Google Wallet** para check-in em equipamento **EGYM** (celular toca na máquina)

- `[V] com/netpulse/mobile/nfc_pass/data/NfcPassApi.java:15`:
  `@GET("/np/exercisers/{userId}/google/pay/egym-equipment-checkin")`
- `[V] com/netpulse/mobile/nfc_pass/domain/usecases/GetSavedNfcPassUseCase.java:22` lê `userCredentials.getGoogleWalletUrl()`; `…/GenerateNfcPassUseCase.java` gera o passe.
- Recursos: `string/add_to_google_wallet`, `string/view_in_google_wallet`, `string/generate_your_nfc_pass_S` ("Generate your EGYM pass and add it to your %s") — evidência de que o "NFC" é **Google Wallet**, não `NfcAdapter` no app (manifest não tem permissão `NFC`).
- Consequência: para equipamento **EGYM**, a "comunicação" é o **leitor NFC da máquina** ler o passe do celular; o app só **gera** o passe via nuvem. Para a Vision T600X (sem leitor EGYM), isso não se aplica.

#### (c.3) xCapture — **foto do painel do console** → OCR na nuvem (funciona com qualquer máquina, inclusive Vision/Matrix)

- Recurso `string/take_a_picture_of_the_control_panel` (via aapt, `0x7f130ff1`):
  > "Make sure you capture the full control panel as you finish the workout: Time, Calories, and/or Distance numbers must be in focus."
- `[V] com/netpulse/mobile/advanced_workouts/xcapture/select/presenter/XCaptureSelectTypePresenter.java:91-99` → `sendData(args.getFilePath(), machineType)` → `uploadXCaptureUseCase.uploadXCapture(new UploadXCaptureTaskArguments(filePath, machineType), …)`.
- `[V] com/netpulse/mobile/workouts/task/UploadXcaptureUseCase.java:130` → `workoutClient.addXCapture(new XCaptureParameters(file, machineType, null))`.
- `[V] com/netpulse/mobile/advanced_workouts/client/AdvancedWorkoutsApi.java:28` → `boolean addXCapture(XCaptureParameters …)` (endpoint de nuvem).
- Tipos de máquina oferecidos ao usuário na tela: `[V] com/netpulse/mobile/advanced_workouts/xcapture/select/view/XCaptureSelectTypeView.java:57` (Bike, Elliptical, Recumbent, Stepper, **Treadmill**, Rower).
- Taxonomia de máquinas: `[V] com/netpulse/mobile/core/model/WorkoutMachineType.java:11` `TREADMILL("Treadmill", …)`; `:17` `SELF_POWER_TREADMILL("Self-Powered Treadmill", …)` (13 valores: BIKE, ELLIPTICAL, RECUMBENT_BIKE, STEPPER, TREADMILL, ARC_TRAINER, CLIMBMILL, FLEXSTRIDER, POWERMILL, HEART_RATE_MONITOR, SELF_POWER_TREADMILL, SPIN_BIKE, ROWER).
- **Importante:** é entrada de dados **manual/foto**; não há aquisição automática do console.

#### (c.4) Nuvem: Connected Apps (validic) + linking EGYM/LFConnect + Matrix Sprint 8

- `[V] com/netpulse/mobile/connected_apps/model/ConnectableApp.java`: campos `name`, `linkUrl`, `unlinkUrl`, `serverCode`, `status`, `lastSyncTime`, `validicAccountExists` → integração via agregador **Validic** (nuvem).
- Strings (aapt): "Connected Apps"; "Login into Life Fitness cardio equipment · Easily save your cardio workout results"; "EGYM Smart Strength machines offer a guided, safe, and personalized workout experience…"; "All EGYM Smart Strength equipment exercises will be tracked automatically. No manual tracking required."
- SDK nativo **EGYM** embarcado (`[V] com/egym/…`: `egym_id`, `gameday`, `health_connect`, `wlp_check_in`, `partner_access_code`, …) com endpoints em `mobile-api.egym.com` — é **conta/check-in/dados**, não controle de máquina (0 classes BLE, ver 3.1).
- **Matrix:** dados de treino importados da nuvem incluem programa "Sprint 8": `[V] com/netpulse/mobile/advanced_workouts/converter/WorkoutsDTOConverterHelper.java:765` `parseMatrixSprint8(MatrixSprint8DTO)` (campos `sprintScores`, `totalSweatScore`, `programLevel` → `MatrixSprint8AttributeDTO`) e `:563` `attributes.getMatrixSprint8()`. Ou seja: o console Matrix manda o treino para a nuvem e o app **lê**; o app não conversa com o console.

#### (c.5) MWA — "Micro Web App" remota via Ionic Portals (o "portal" da task)

- `[V] com/netpulse/mobile/mwa/domain/MwaPortalExtensionsKt.java:64`: `PortalManager.newPortal(config.getInitialContext().getStartingRoute())` + `setStartDir(...)` + `setPlugins(...)` + `setLiveUpdateConfig(...)`.
- `[V] com/netpulse/mobile/mwa/domain/MwaPortalExtensionsKt.java:76`: start dir = `liveUpdateConfig.getAppId() + "-" + liveUpdateConfig.getChannelId()`; fallback `:80` lê `R.array.mwa_partners` (array **vazio** nos 3 APKs: `Count=0` no `aapt dump --values resources`) → `:89` `setStartDir(str)`; se vazio, `"build"`.
- A config vem do backend: `[V] com/netpulse/mobile/mwa/domain/usecase/GetMwaConfigUseCase.java:511` `new MwaConfig(registrationKey, initialContext, new LiveUpdateConfig(enabled, appId, channelId, method), null, 8, null)`; `InitialContext` tem `[V] com/netpulse/mobile/mwa/domain/model/InitialContext.java:52` `startingRoute` e `:53` `url` (a URL do web app é **servida pela API**, não hardcoded).
- APIs de apoio: `[V] com/netpulse/mobile/mwa/data/network/MicroWebAppApi.java:20` `@GET("/np/micro-web-app/v1.0/exercisers/{userId}/tokens/{partner}")`, `:25` `…/profile`, `:30` `@GET("/np/exerciser/{userId}/externalAccount/{partnerAlias}/token")`.
- **Nada disso é controle de equipamento**; é o app do clube sendo servido como web app dentro do app nativo.

### 3.4 (d) Alguma constante de protocolo/UUID/opcode útil para controlar a esteira? **NÃO**

Varredura dedicada (nenhum resultado para o alvo):

| O que procuramos | Onde | Resultado |
|---|---|---|
| UUIDs FTMS (`00001826`, `0x1826`) | `[V]`/`[M]` sources + strings dos 16 dex | 0 |
| Vendor service `0xFFF0`/`0xFFF1`/`0xFFF3`/`0xFFB0` | idem | 0 |
| Opcodes/comandos de motor, velocidade, inclinação | idem | 0 (só **nomes** de atributos de histórico) |
| Protocolo Matrix/JHT binário | idem | 0 |
| `com.johnsonfitness.*` | `[V]`/`[M]` sources | 0 |

O que **existe** e pode servir de contexto (não é protocolo de controle):

| Constante / estrutura | Evidência | Utilidade p/ nós |
|---|---|---|
| `WorkoutMachineType` (13 códigos, incl. `Treadmill`, `Self-Powered Treadmill`) | `[V] …/core/model/WorkoutMachineType.java:11,17` | só taxonomia de UI |
| Atributos históricos: `Speed…`, `Distance…`, `Incline…`, `HeartRate…`, `MatrixSprint8…AttributeDTO` | `[V] …/advanced_workouts/history/list/model/dto/` | formato de dados que a nuvem guarda do treino |
| `BarcodeFormatHelper` (Code_39/128, Aztec, DataMatrix, QR; default Code_128) | `[V] …/dynamic_features/model/BarcodeFormatHelper.java:20-27` | formato de barcode de catraca/check-in |
| JSON do QR de acesso: `membershipType` + `verificationTAN` | `[V] …/checkin_access_card/usecase/QrCodeMembershipDto.java` | credencial de acesso ao clube |
| `xCapture`: `machineType` + arquivo de foto | `[V] …/workouts/task/request/XCaptureParameters.java` | nada de controle |
| URLs: `https://api.netpulse.com` (API do app), `https://orion.jfit.co/` (portal Matrix/JHT), `https://mobile-api.int.api.egym.com` (EGYM) | `[V]` (strings de código/recurso; ver §4 e §3.3) | mapa de nuvem, não BLE |
| Autenticação de nuvem: API key/JWT/`session_auth` no Swagger JHT (§4) | recon externo | não dá acesso local |

**Conclusão (d):** não existe nenhum segredo de protocolo nesses APKs — nem UUID, nem opcode, nem sequência de handshake. O FTMS/vendor da esteira é território de firmware (como já registrado no dossiê), não destes apps.

### 3.5 (e) Contêm `com.johnsonfitness.*` ou FTMS? **NÃO**

- `com.johnsonfitness` como pacote ou string: **0** em `[V]` e `[M]` (`find -type d -name 'johnsonfitness*'`, `grep`, `strings`).
- O app "Vision Fitness" (`com.johnsonfitness.visionapp`) é um **APK separado** (47,97 MB, label "Vision Fitness"), fora deste corpus — é o app **vendor** da esteira e sim o lugar provável de achar protocolo (em análise por outra task).
- Únicas pegadas JHT/Matrix no Matrix 3.5 são **assets de ícone/launcher**: `strings` do dex → `ic_launcher_matrixfitness`, `ic_launcher_matrixfitnessaustralia`, `ic_launcher_johnsonfitnesswellnessstore`; recursos "Matrix", "MatrixWorkoutTracking". Nenhuma lib.
- FTMS: 0 (ver 3.4).

---

## 4. Achado colateral (o único potencialmente aproveitável): eAPI "Johnson Health Tech Exerciser API"

### 4.1 Como apareceu

No app Matrix 3.5 (e também no ViewFit) há o módulo `MATRIX_WORKOUTS`, que nada mais é que um **WebView** para um portal remoto:

- `[V] com/netpulse/mobile/matrix_workouts/MatrixWorkoutsWebViewActivity.java:17`
  `private static final String DEFAULT_URL = "https://orion.jfit.co/";`
- `:37` `return baseWebViewFeature == null ? DEFAULT_URL : baseWebViewFeature.url();` (a URL pode ser sobrescrita pela config de features do clube)
- Feature correspondente: `[V] com/netpulse/mobile/core/model/features/FeatureType.java:88` `MATRIX_WORKOUTS = "matrixWorkoutsWebView"` (e `:89` `MICRO_WEB_APP = "microWebApp"`, `:105` `NFC_WALLET = "nfcWallet"`).

### 4.2 O que é o endpoint (recon externo — **dado não confiável**, não verificado como usado pela T600X)

```
GET https://orion.jfit.co/            → 200, HTML "Johnson Health Tech Exerciser API" (links /docs e /spec.json)
GET https://orion.jfit.co/spec.json   → 200, Swagger 2.0, 179.073 B
    info: { title: "Johnson Health Tech Exerciser API", version: "4.2.0",
            description: "Universal API for Johnson Health Tech Exercisers" }
    basePath: "/", schemes: ["https"], produces: application/json
    securityDefinitions: api_key_auth (header `x-api-key`), jump_auth (header `Authorization`, bearer: JUMP ID/JWT), session_auth
    paths: 83 endpoints
```

Endpoints que interessam ao contexto de **equipamento/console** (nenhum expõe controle de motor):

| Método | Path | Summary (do spec) | Observação |
|---|---|---|---|
| POST | `/exerciser/login` | login de exerciser | console/máquina autentica o usuário |
| POST | `/np/login`, `/np/validate` | login Netpulse | ponte Netpulse ↔ JHT |
| GET | `/console/features/guest` | "Get guest user features" | escopo `console:read` → features do **console** |
| POST | `/workout` | "Save and send a workout to a vendor" | console/parceiro **envia** treino |
| GET | `/exerciser/workouts`, `/exerciser/{id}/workouts` | histórico | leitura de treinos |
| — | `/matrix_method/program` (GET/POST/PATCH/DELETE) | "Matrix Method program for the authenticated user" | programação **Matrix Method** (intervalos) |
| GET | `/launch_app` | "Retrieves the launch app information" | console decide app/experiência |
| POST | `/exerciser/{exerciser_id}/jump` | "Saves JUMP ID to exerciser" | "JUMP" = produto/console JHT |
| GET | `/clubs/{club_id}/vendors` | vendors do clube | integrações por academia |
| GET | `/vendors/brandapi/images` | imagens de product type | catálogo de máquinas |

Detalhe interessante (mostra onde fica o BLE **do console**): no spec há metadata de usuário do console com
`bluetoothmacaddress: { "user_ble_audio_mac_address": "", "user_ble_hr_mac_address": "", "user_ant_hr_device_id": "" }` e `phoenix_user_settings` (`max_hr`, `ftp`, `user_haptics_on`, `user_led_style`). Ou seja: **o pareamento BLE (fone/HR/ANT+) é do console JHT** (plataforma "phoenix"), configurado por metadata de usuário — **não** é o celular controlando a máquina, e a API não tem endpoint de comando de belt/speed/incline.

### 4.3 Como classificar esse achado

- **Fato (verificado por HTTP):** `https://orion.jfit.co/` responde e serve a spec "Johnson Health Tech Exerciser API" 4.2.0; a URL está hardcoded como default do módulo Matrix Workouts no APK (`MatrixWorkoutsWebViewActivity.java:17`).
- **Especulação (marcada):** é plausível que consoles JHT/Matrix (família da Vision T600X) usem essa API para login/treinos/nuvem e que a T600X apareça como "vendor"/product type; **não verificado**, e mesmo se verdadeiro **não** fornece controle BLE local.
- **Utilidade para o objetivo atual:** baixa para *controle*, média para *entender a integração de nuvem* (o que o console fala, quais dados existem). Requer `x-api-key`/JWT que **não temos** (não testamos chamadas autenticadas — fora do escopo).

---

## 5. Veredito de utilidade para o nosso caso

| Pergunta | Resposta | Útil para controlar a T600X? |
|---|---|---|
| (a) BLE direto com equipamento? | **Não** (0 permissões, 0 classes GATT, 0 `.so`, 0 UUIDs) | ❌ |
| (b) Plugins Capacitor nativos? | 21 plugins (lista §3.2), **nenhum** de equipamento; custom só Stripe | ❌ |
| (c) Como integram? | QR/barcode de check-in · Google Wallet NFC (EGYM) · foto do painel (xCapture) · nuvem (Validic/EGYM/LFConnect/Matrix Sprint 8) · MWA remota via Portals | ❌ (mostra que o ecossistema é nuvem-first) |
| (d) Constantes de protocolo/UUID/opcode? | **Nenhuma** úteis; só taxonomia de máquinas e DTOs de histórico | ❌ |
| (e) `com.johnsonfitness.*`/FTMS? | **Não** (só ícones JHT/Matrix no flavor Matrix) | ❌ |
| Colateral: `orion.jfit.co` (eAPI JHT) | API de nuvem JHT 4.2.0, 83 endpoints, sem controle de motor | ⚠️ contexto de nuvem, **não** controle local |

**Recomendação:** não investir mais nesses 3 APKs para o objetivo FTMS/`0xFFF0`. O caminho continua sendo (i) firmware/vendor protocol da T600X e (ii) o app vendor `com.johnsonfitness.visionapp` (task separada). Se o time quiser explorar a nuvem JHT, `https://orion.jfit.co/spec.json` é o mapa (mas exige credencial e não resolve controle local).

---

## 6. Limitações / o que não foi feito

- **jadx não foi reexecutado** (decompilado existente, interrompido a ~99%). `com.netpulse.mobile.mygymfitness` **não** tem sources; a equivalência com ViewFit foi provada por **md5 dos dex** (§2.1), não por comparação de `.java`.
- Todas as afirmações de ausência (BLE/FTMS/UUID) foram confirmadas **independentemente do decompilado**: manifest (aapt), strings dos `classes*.dex` dos 3 APKs e lista de `.so`. A ausência de permissão BLE no manifest já é, por si, impeditiva no Android 12+.
- Não executamos os apps nem capturamos tráfego de rede deles; a seção 4 é reconhecimento **externo** (HTTP público), marcado como tal.
- Não tentamos autenticar na eAPI JHT (sem credenciais) — nenhuma chamada autenticada foi feita.
- Não alteramos APKs, decompilados, `src/` nem docs existentes; único arquivo escrito: este.

---

## 7. Anexos — comandos reproduzíveis

```bash
cd gymburn-re/apks
AAPT=~/Android/Sdk/build-tools/36.0.0/aapt

# Identidade e permissões (ausência de BLUETOOTH/NFC)
$AAPT dump badging com.netpulse.mobile.viewfit.apk | head -3
$AAPT dump permissions com.netpulse.mobile.viewfit.apk | grep -Ei 'bluetooth|nfc|usb|near'   # vazio
$AAPT dump badging com.netpulse.mobile.matrixworkout.apk | grep -Ei 'bluetooth|nfc'            # vazio

# Sem libs nativas
unzip -l com.netpulse.mobile.viewfit.apk | grep -c 'lib/'                                      # 0

# ViewFit == MyGymFitness (dex)
unzip -p com.netpulse.mobile.viewfit.apk classes.dex | md5sum
unzip -p com.netpulse.mobile.mygymfitness.apk classes.dex | md5sum

# Ausência de BLE/FTMS nas strings dos dex (independe do jadx)
for f in ex-com.netpulse.mobile.viewfit/classes*.dex; do strings -a "$f"; done \
  | grep -acE 'BluetoothGatt|BluetoothLeScanner|BluetoothAdapter|00001826|FFF0|FFB0'           # 0

# Strings de UI relevantes (xCapture, QR, wallet)
$AAPT dump --values resources com.netpulse.mobile.viewfit.apk > /tmp/v.txt
grep -A1 'string/take_a_picture_of_the_control_panel' /tmp/v.txt
grep -A1 'string/show_as_qr_code' /tmp/v.txt

# Portal remoto / matriz de integração
grep -n 'orion.jfit.co' -r ../decompiled/com.netpulse.mobile.viewfit/sources/com/netpulse/mobile/matrix_workouts/
sed -n '55,110p' ../decompiled/com.netpulse.mobile.viewfit/sources/com/netpulse/mobile/mwa/domain/MwaPortalExtensionsKt.java
cat ex-com.netpulse.mobile.viewfit/assets/capacitor.config.json

# eAPI JHT (recon externo; dado não confiável)
curl -sS https://orion.jfit.co/spec.json | python3 -c 'import json,sys; s=json.load(sys.stdin); print(s["info"]); print(len(s["paths"]),"paths")'
```
