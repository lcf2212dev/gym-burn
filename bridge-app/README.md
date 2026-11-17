# Ponte GymBurn

App Android mínimo que segura a conexão BLE com a esteira **fora do GymBurn**.
O GymBurn pode ser reconstruído/reinstalado quantas vezes for preciso: este app
continua com o link de pé e o GymBurn só se reconecta a ele.

## Por que existe

O `react-native-ble-manager` vive no processo do GymBurn. Reinstalar o APK mata
o processo e derruba o GATT — e a esteira, ao perder o link, costuma sair do
modo APP, obrigando alguém a segurar o botão no painel de novo. A ponte resolve
isso:

- serviço em primeiro plano (`connectedDevice`) dono do `BluetoothGatt`;
- guarda o endereço da última esteira e reconecta sozinho;
- reemite o último anúncio da esteira conectada, para o GymBurn reencontrá-la
  na busca mesmo quando ela para de anunciar;
- expõe tudo por um HTTP **local** (`127.0.0.1:8765`), sem nada exposto na rede.

## Como o GymBurn usa

`src/ble/treadmill-transport.ts` sonda `127.0.0.1:8765/ping` no `prepare()`:

- respondeu → usa `src/ble/bridge-transport.ts` (mesmo contrato `BleTransport`);
- não respondeu → cai no BLE direto de sempre.

A escolha é refeita a cada conexão: basta abrir a ponte para o GymBurn passar a
usá-la sem reiniciar.

## API local

| Rota | Corpo | Devolve |
| --- | --- | --- |
| `GET /ping` | — | `{ok}` |
| `GET /status` | — | estado do link, esteira salva, permissões |
| `GET /events?after=N` | — | eventos desde o seq N (`scan`, `notify`, `disconnected`…) |
| `POST /scan/start` · `/scan/stop` | — | controla a busca |
| `POST /connect` | `{id}` | reconecta (reusa o link se já for o mesmo aparelho) |
| `POST /disconnect` | — | desliga o link |
| `POST /forget` | — | esquece a esteira salva |
| `POST /services` | — | serviços/características descobertos |
| `POST /read` | `{service, char}` | `{data: "hex"}` |
| `POST /write` | `{service, char, data, response}` | status do GATT |
| `POST /subscribe` | `{service, char, notify}` | habilita/desliga notificações |

## Build e instalação

```bash
cd bridge-app
ANDROID_HOME=$HOME/Android/Sdk ./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.gymburn.bridge/.MainActivity
```

Na primeira abertura o app pede as permissões de Bluetooth e de notificação.
O serviço sobe sozinho no boot e volta com `START_STICKY`.

## Limitações

- É um app separado (`com.gymburn.bridge`): não compartilha permissões nem a
  pasta de espelho do GymBurn.
- Só fala com o GymBurn em loopback. Em build **release** do GymBurn o Android
  bloqueia HTTP em texto puro; é preciso liberar `127.0.0.1` num
  `network_security_config` antes de usar a ponte fora do build de
  desenvolvimento.
- O protocolo da Matrix (canal `0xFFF0`, Gizwits) continua no GymBurn: a ponte
  é GATT genérico.
