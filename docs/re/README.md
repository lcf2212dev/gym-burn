# Engenharia reversa dos apps oficiais do fabricante

Os apps da JHT/Vision/Matrix analisados estaticamente (APK → jadx/regex/strings) para entender o
**protocolo da esteira Matrix/Vision T600X** (VISION ID `1AB1`, MAC `A0:BB:3E:30:1A:B1`) e achar algo
que ajude a **comandar** o equipamento.

| App (nome na Play Store) | Package / versão | Doc | Veredito para controle |
| --- | --- | --- | --- |
| **Vision Fitness-Workout Tracker** | `com.johnsonfitness.visionapp` 2.0.0 | [vision-fitness-app.md](vision-fitness-app.md) | Só lê FTMS; API de controle é código morto. `0xFFF0` = **`SERVICE_RENAME`** e `FFF3` = `CHANGE_DEVICE_NAME` (config/nome do módulo). |
| **JohnsonOTA** (app de firmware, baixado do APKPure) | `com.johnsonfitness.wave` 1.2.0 | [johnsonota.md](johnsonota.md) | **Achado mais útil:** o FTMS da família JHT tem **opcodes proprietários** (`0x7E` reset/Device Update, `0x7F` AP mode no Control Point; `0xFD`/`0xFE` de upgrade no Machine Status) e a atualização é por **Wi-Fi AP do console** (`10.10.10.1:88`, `/Now` e `/upload`). Nada de controle de motor, mas é o primeiro comando vendor real a testar. |
| **AFG Pro Fitness** (outra marca da JHT) | `com.xtremeprog.shell.treadmillv2` 1.6.1 | [afg-pro-fitness.md](afg-pro-fitness.md) | **Controla esteira de verdade** pelo mesmo serviço `0xFFF0`/`FFF3`/`FFF4` da T600X, com protocolo binário (`55 AA` + CRC16). É a melhor pista para controle; testar na T600X. |
| **ViewFit** | `com.netpulse.mobile.viewfit` 2.4 | [netpulse-apps.md](netpulse-apps.md) | Nada de BLE; integração só via nuvem/QR. |
| **MATRIX COMMUNITY 360** | `com.netpulse.mobile.mygymfitness` 1.9 | [netpulse-apps.md](netpulse-apps.md) | Mesmo código do ViewFit (dex idêntico, só branding): nada de BLE. |
| **Matrix Community 360 - Basic** | `com.netpulse.mobile.matrixworkout` 3.5 | [netpulse-apps.md](netpulse-apps.md) | Mesma base Netpulse + flavor "MatrixWorkoutTracking": nada de BLE. |

## Resumo em uma linha
Os apps de **usuário** não expõem controle motor: o consumidor lê FTMS e o `0xFFF0` é config/rename.
O app de **firmware** revelou que o firmware JHT estende o FTMS com opcodes proprietários (o `0x7E`
“Device Update” reinicia o console em modo AP de atualização) — é o próximo experimento de campo
promissor; o controle de velocidade/inclinação continua fora do BLE de usuário (console/modo de
serviço/app de técnico/CSAFE).

## Artefatos locais (não versionados no git)
- APKs: `gymburn-re/apks/*.apk` (e o `.xapk` do JohnsonOTA)
- Decompilado jadx: `gymburn-re/decompiled/<package>/sources/`
- Recursos (manifest/strings): `gymburn-re/res/<package>/resources/res/`
- Firmware público analisado (Bowflex T6, só estudo) + config do Firebase: `gymburn-re/ota-re/`
- Ferramenta: `gymburn-re/tools/jadx/bin/jadx` (1.5.6)
