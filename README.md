# Gym Burn

App Expo (SDK 58, React Native 0.88, TypeScript) que acompanha um treino na esteira Matrix T600X
(Johnson Health Tech) por Bluetooth Low Energy. Abre, **procura a esteira sozinho**, mostra o nome
das encontradas e, depois que você confirma a sua, **conduz uma sequência curta de reconhecimento
sem pedir que você toque em nada** — quem controla a esteira é o painel dela.

O que faz hoje:

- **busca automática** ao abrir o app e ao voltar para a tela de conexão;
- **monitoramento no topo do painel**: velocidade, inclinação, batimentos, tempo, distância,
  calorias e ritmo;
- **copiloto**: uma faixa discreta no topo diz o que fazer (começar a andar, aumentar/diminuir
  velocidade, subir/descer inclinação, conferir os batimentos, parar) e avança sozinha quando a
  esteira mostra o efeito — sem botões de comando no app;
- **controles do app**: Iniciar/Pausar/Parar e velocidade/inclinação em passos. Eles usam o FTMS
  quando a esteira libera; nesta T600X, quando o teste automático confirma o **canal alternativo**,
  passam a usar o protocolo Gizwits do app AFG Pro, com confirmação pela telemetria e avisos se a
  esteira não reagir;
- **teste automático do canal alternativo**: ao conectar, o app assina o FFF4, pede “machine info”
  no FFF3 com o protocolo do app AFG Pro (frame `55 AA …`) e, conforme a resposta, tenta sozinho as
  variantes seguras (FFF1, sequência, CRC invertido, ack, `AA 55`), lê FFF1/FFF2/FFF5 e roda a
  varredura de 1 byte por vez (a mesma da Sonda) — **sem precisar abrir a Sonda**, sem ligar nem
  ajustar a lona; o resultado aparece no painel e, se precisar de uma ação sua (parar a lona,
  reconectar), a instrução aparece numa faixa discreta no topo;
- **registro automático** de tudo em arquivo de texto no celular (pacotes, estados, instruções), com
  compartilhamento escondido na Sonda para depurar depois;
- **Sonda BLE** avançada, escondida atrás de um toque longo na versão: leitura/escrita no serviço
  proprietário 0xFFF0 e o teste dos op codes vendor do FTMS (0x7E/0x7F).

O app **não comanda a esteira**: o FTMS da T600X é somente leitura para velocidade/inclinação
(Target Setting Features = 0x10) e o Control Point recusa os comandos da especificação. A Sonda
continua disponível para a engenharia reversa do canal do fabricante.

## Requisitos

- Node `^22.13.0`, `^24.3.0`, `^26.0.0` ou `>=27` (`engines` do pacote `expo` instalado).
- JDK 17 ou 21.
- Android SDK, com `ANDROID_HOME` definido. O build usa compileSdk 37.
- Um celular Android de verdade com depuração USB. O emulador serve para o modo demonstração, mas não alcança a esteira. No Android 11 ou anterior, a busca só encontra aparelhos com a Localização do sistema ligada.
- iOS exige macOS e Xcode e não foi compilado nem testado.

O Expo Go não serve: a biblioteca de Bluetooth (`react-native-ble-manager`) tem código nativo, então é preciso um build próprio.

## Como rodar

```bash
npm install
npm run android
```

`npm run android` é `expo run:android`: gera `android/` por prebuild, compila, instala no celular conectado e abre o Metro.

Para usar na academia sem o computador, faça um build que embute o JavaScript:

```bash
npx expo run:android --variant release
```

Depois de mudar `app.json` (plugins, permissões, pacote `com.gymburn.app`), regenere a pasta nativa:

```bash
npx expo prebuild --clean -p android
```

As pastas `android/` e `ios/` são geradas e estão no `.gitignore`; não edite à mão.

## Como usar com a esteira

1. No painel da esteira, segure o botão Bluetooth por cerca de 5 segundos, até entrar no **modo
   APP**. Na T600X é a tecla ✓ do teclado numérico, marcada com “BT”.
2. Abra o app. Ele já começa a procurar sozinho e pede para ligar o Bluetooth do celular, se for o
   caso.
3. Quando o nome da sua esteira aparecer, **toque em Conectar**. Esse toque é a confirmação: numa
   academia com várias iguais, é você quem sabe qual é a sua.
4. Daí em diante não precisa tocar no app. O painel mostra os números e a faixa do topo diz o que
   fazer.

Assim que você confirma a esteira, o app **testa sozinho** o canal alternativo: pede as informações
da máquina pelo protocolo do app AFG Pro; se não houver resposta, tenta variantes de canal e CRC; se
responder, segue com consultas de leitura e comandos de parada com a lona parada. Nada disso liga ou
ajusta a esteira. O resultado aparece no painel e, quando é preciso uma ação sua, uma faixa discreta
no topo diz o que fazer (por exemplo, parar a lona para o teste continuar).

Se o teste automático confirmar o **canal alternativo**, os **Controles do app** (Iniciar, Pausar,
Parar, velocidade e inclinação) passam a enviar os comandos pelo protocolo Gizwits (o mesmo do app
AFG Pro) sem você configurar nada; o cartão mostra “canal alternativo” e cada comando é conferido
pelos dados da esteira, com aviso se ela não reagir. Sem essa confirmação, os controles ficam no
FTMS (que nesta T600X recusa) e o painel da esteira continua sendo o controle de verdade.

Para parar ou mudar velocidade e inclinação de forma garantida, use o painel da esteira. O botão
vermelho (Emergency Stop) e a chave de segurança são a parada real.

O app faz a própria busca e conecta por ela: a esteira não precisa aparecer na lista de Bluetooth
das configurações do celular. **Não tente parear pela tela de Bluetooth do sistema** — a esteira é
um periférico BLE que recusa o pareamento comum, e o app conecta direto (GATT) mesmo assim.

### Acompanhamento guiado (o copiloto)

Depois de conectar, a faixa no topo da tela conduz um reconhecimento curto, em sete passos, na
linguagem da academia:

1. pode começar a andar no painel;
2. aumente a velocidade em um passo;
3. diminua a velocidade um pouco;
4. aumente a inclinação;
5. diminua a inclinação de volta;
6. segure as alças com sensor até os batimentos aparecerem;
7. para terminar, pare a esteira no painel.

Cada passo avança sozinho quando o app percebe o efeito nos dados que a esteira manda. Se você parar
no meio, ele volta ao início e espera você andar de novo. Se os batimentos não aparecerem em 30
segundos, ele segue sem travar. No fim, a faixa mostra “Tudo certo!” por alguns segundos e desaparece
— o monitoramento continua.

A faixa também avisa quando a esteira para de mandar dados e, se a conexão cair ou a esteira não
aparecer, a tela de conexão sugere **fechar o app e abrir de novo**.

### Sonda e registro (avançado, escondido)

- **toque longo na versão** (na tela de conexão) abre a **Sonda BLE**: leitura/escrita do serviço
  proprietário `0xFFF0`, teste dos op codes vendor do FTMS (`0x7E`/`0x7F`) e **compartilhar o
  registro da sessão**.
- O app grava tudo em arquivo de texto no armazenamento interno, automaticamente, desde a abertura
  (“App aberto”) até o fim: cada pacote enviado/recebido em hexadecimal, mudanças de estado,
  instruções do copiloto e erros. Não há mais tela de registros: para levar o arquivo, use
  **Sonda → Compartilhar registro** (com a esteira parada).

### Qual é a minha esteira?

Numa academia com várias T600X lado a lado, todas ao alcance podem aparecer na busca. Por isso:

- a lista vem ordenada por força de sinal; com o celular apoiado no painel da sua esteira, ela tende
  a ser a primeira, mas o sinal sozinho não garante;
- o nome anunciado costuma ser `VISION ID xxxx` (os quatro últimos dígitos vêm do MAC) — no teste
  real de 11/11/2026 a unidade apareceu como `VISION ID 1931`;
- toque no nome **da sua**; o app considera que esse toque é a confirmação.

## Registros

O app grava em arquivo de texto tudo o que acontece, sem você precisar ligar nada: cada pacote
enviado e recebido (em hexadecimal), cada mudança de estado, cada instrução mostrada e cada erro. É
um arquivo por execução do app, começando com `App aberto`; grava a cada 2 segundos, a cada 100
linhas, quando há um erro e quando o app vai para segundo plano.

- **Onde ficam**: no armazenamento interno do app (e, se a pasta de cópia estiver configurada, em
  `Documents/GymBurn` no armazenamento do celular). Para levar um arquivo, abra a **Sonda** (toque
  longo na versão) e use **Compartilhar registro**; a folha de compartilhamento abre com **uma
  cópia** do arquivo do momento — o original continua no celular e segue crescendo até o app
  fechar. Ficam guardados os 30 arquivos mais recentes, até 30 MB.
- **Formato**: uma linha por evento, `HH:mm:ss.SSS TIPO texto [hex=BYTES]`, com um cabeçalho que
  identifica o app, o aparelho e o sistema. Os tipos são `rx` e `tx` (pacotes), `state` (estado da
  sessão), `action` (toque do usuário), `info` e `error`. `docs/protocolo-ftms.md` explica como ler
  os pacotes.
- **O que eles contêm de terceiros**: o nome e o endereço Bluetooth dos aparelhos que estavam por
  perto durante a busca. Vale lembrar disso antes de mandar um registro para alguém.

## Segurança

Nesta T600X o app é, na prática, de **leitura**: o FTMS declara que não aceita alvos de velocidade e
inclinação e recusa os comandos. Quem controla a máquina é o painel, e a parada real é o botão
vermelho (Emergency Stop) e a chave de segurança.

- O app só considera a esteira “sua” quando você toca no nome dela na lista e a conexão termina.
- Os **Controles do app** existem para o caso de a esteira aceitar comandos; nesta unidade eles
  devem ser recusados (o cartão avisa antes). O canal alternativo `0xFFF0` é um experimento: não há
  confirmação e ele pode não fazer nada.
- Nada é enviado sem um toque seu; o Parar é o botão vermelho sólido, e continua valendo o
  Emergency Stop do painel.
- A Sonda (escondida atrás do toque longo na versão) escreve apenas bytes de experimento, um toque
  por vez, com a esteira conectada e confirmada; ela nunca envia firmware.
- Se a conexão cair, a lona continua como estava; o app volta para a tela de conexão e retoma a
  busca.

Responsabilidade do usuário:

- O botão vermelho Emergency Stop e a chave de segurança presa a ele são o freio de verdade.
- O app não substitui as proteções do painel; apoie o celular com segurança e mantenha a lona
  vazia enquanto testa.

## Arquitetura

A interface (`screens`, `components`) só lê um snapshot imutável e chama ações de `TreadmillSession`. A sessão cuida de busca, conexão, leitura dos dados e fila de comandos, e depende apenas do contrato `BleTransport`; por isso o rádio real e a esteira simulada são intercambiáveis. O protocolo (`src/ftms`) é código puro, sem dependência de React nem de Bluetooth.

```
telas (src/screens, src/components)
   |  snapshot / ações
   v
sessão (src/treadmill/treadmill-session.ts)
   |  contrato BleTransport (src/ble/transport.ts)
   v
transporte: ble-manager-transport.ts (rádio)  |  simulated-treadmill.ts (demo e testes)
   |
   v
esteira  (codec FTMS em src/ftms usado pela sessão e pelo simulador)
```

| Pasta | Papel |
| --- | --- |
| `src/ftms` | Codec do FTMS: UUIDs, Treadmill Data, Feature, faixas, Control Point, Machine Status, Training Status. Puro e testado. |
| `src/ble` | Contrato `BleTransport`, implementação com `react-native-ble-manager` e permissões do Android. |
| `src/simulator` | Esteira simulada que fala FTMS em bytes; usada no modo demonstração e nos testes. |
| `src/treadmill` | Sessão (estado, fila de comandos, regras de segurança), tipos, faixas da T600X e contexto React. |
| `src/copilot` | Copiloto: máquina de estados que decide a próxima instrução a partir dos dados da esteira e avança sozinha. |
| `src/logging` | Gravador dos registros em arquivo: formato das linhas, buffer, retenção e cópia para uma pasta do celular. |
| `src/screens`, `src/components` | Telas (conexão, painel e Sonda) e componentes de interface. |
| `src/utils` | Formatação de números e textos. |
| `tools` | `esteira-ble.py`: periférico BLE que imita uma esteira FTMS, para testar com um celular de verdade. |

As rotas ficam em `src/app` (Expo Router): a tela principal (conexão ou painel, conforme a fase da sessão) e a `sonda`. `src/app-services.ts` cria o gravador e a sessão, que vivem durante toda a execução do app.

## Testes e verificação

```bash
npm test
npm run typecheck
npm run lint
```

### Esteira de mentira pelo rádio

`tools/esteira-ble.py` transforma o Bluetooth de um computador Linux (BlueZ, com `python-dbus` e `python-gobject`) num periférico BLE que anuncia o serviço FTMS como `CTM781TESTE01` e se comporta como uma esteira. Com ele dá para testar o app instalado no celular, pelo rádio de verdade, sem ir à academia. Cada leitura, escrita e indication é impressa no terminal, o que permite conferir byte a byte o que o app mandou.

```bash
python3 tools/esteira-ble.py                # esteira que aceita comandos
python3 tools/esteira-ble.py --countdown 3  # o Start só conclui depois de 3 s (para testar o Parar no meio)
python3 tools/esteira-ble.py --read-only    # sem Control Point: só transmite dados
kill -USR1 <pid do script>                  # "aperta" o Emergency Stop do painel
```

É uma terceira implementação do protocolo, independente do codec do app e da esteira simulada. Não substitui o teste na T600X: ela pode se comportar de outro jeito.

## Pendências conhecidas: o que validar na esteira real

> Atualização 11/11/2026: o teste real respondeu as principais pendências — ver [docs/teste-real-2026-11-11.md](docs/teste-real-2026-11-11.md). Resumo: o FTMS da T600X é **somente leitura** para velocidade/inclinação (Target Setting Features = 0x10, só FC) e o Control Point recusa todo comando com 0x05 Control Not Permitted; a esteira também expõe um **serviço proprietário 0xFFF0** (FFF1 read/write, FFF3 write, FFF4 notify, FFF2/FFF5 read), que é o próximo alvo de investigação.

- Se existe Control Point e o que os bits de Target Setting (Fitness Machine Feature) dizem.
- Se as faixas de velocidade e inclinação vêm da esteira ou caem na ficha técnica.
- Largura do campo de ritmo no Treadmill Data (1 ou 2 octetos; ver `docs/protocolo-ftms.md`).
- Se a esteira envia Fitness Machine Status para quem deu o comando.
- Se o Control Point exige pareamento (e se o código mostrado no painel é pedido nesse momento).
- Com que nome a esteira se anuncia e se o código do painel faz parte dele.
- Se o console está em unidades métricas: há relato, em outro modelo Matrix, de comandos de velocidade falhando com o console em milhas.
- iOS não foi testado.
- Ícone e splash ainda são os do template do Expo.

## Resultados do teste real (11/11/2026)

Os registros das sessões de 11/11/2026 com a T600X real (VISION ID 1931) mostram que:

- a conexão e a leitura funcionam: FTMS (0x1826) completo, Treadmill Data a cada ~1 s, velocidade/inclinação/distância/tempo coerentes com o painel, Training Status e Fitness Machine Status chegando;
- o controle por FTMS **não funciona nesta unidade**: Request Control devolve Success, mas Start/Stop/Set Target Speed/Set Target Inclination devolvem **Control Not Permitted (0x05)**;
- o motivo está no anúncio: Target Setting Features = 0x10 (só frequência cardíaca), ou seja, a esteira declara que não aceita alvo de velocidade nem de inclinação pelo FTMS;
- a esteira expõe serviços que a simulação não tinha: 0x181C (User Data), 0x1816 (CSC), 00010203-0405-0607-0809-0a0b0c0d1912 e o **proprietário 0xFFF0** (FFF1 read/write, FFF2 read, FFF3 write, FFF4 notify, FFF5 read), provável canal de controle do fabricante;
- a faixa de inclinação reportada (0–50%, passo 3%) é implausível para a T600X e deve ser ignorada em favor da ficha (0–15%, passo 0,5%);
- Device Information (modelo/firmware/serial do console) ainda não está nos registros: as sessões rodavam um APK anterior ao commit que passou a lê-la; a próxima visita deve capturar.

Detalhes, tabelas de evidência e próximos passos em [docs/teste-real-2026-11-11.md](docs/teste-real-2026-11-11.md).

## Coleta de 2026-11-12 (engenharia reversa)

Segunda ida à academia, com a esteira conectada e o modo **Coleta** gravado duas vezes na mesma
sessão (unidade `VISION ID 1AB1`, diferente da de 11/11). O dossiê completo está em
[docs/dossie-esteira-2026-11-12.md](docs/dossie-esteira-2026-11-12.md). Em resumo, ficou registrado:

- a identidade do módulo BLE (`WiLinktech` / `WLT8258` / firmware `V10.23.17`) e o mapa GATT completo
  (8 serviços, 39 características), incluindo o serviço proprietário `0xFFF0`;
- as 27 leituras do Coleta (Device Information, faixas do FTMS, User Data, CSC, `0xFFF0` e o serviço
  custom `…1912`), com `0xFFF5` recusando leitura e o `0x181C` todo zerado;
- o FTMS continua **somente leitura** para velocidade/inclinação (Target Setting Features `0x10`; 37
  comandos recusados com `Control Not Permitted`);
- seis assinaturas extras (incluindo `0xFFF4`) ficaram ativas por ~17 min **sem uma única notificação**
  — o canal proprietário parece só reagir a escrita;
- duas escalas fora da especificação no firmware: `targetSpeedChanged` do `0x2ADA` é **×16** (8000 =
  5,0 km/h) e a inclinação do `0x2ACD` não usa 0,1 % (`raw × 0,015` ≈ %, *hipótese forte* validada pelo
  MET do próprio equipamento).

O plano da próxima ida (descritores, pareamento, escrita em `FFF1`/`FFF3`, captura do app oficial)
está nas análises de apoio em `gymburn-logs/analise/pesquisa/proximos-experimentos.md`.

## Análise dos apps oficiais (2026-11-12)

Baixamos e analisamos estaticamente os 4 apps do fabricante disponíveis no celular (Vision
Fitness-Workout Tracker, ViewFit, MATRIX COMMUNITY 360 e Matrix Community 360 - Basic) para procurar
algum protocolo de comando da esteira. Resultado: **nenhum deles controla o equipamento**.

- **Vision Fitness** (`com.johnsonfitness.visionapp` 2.0.0) tem a pilha BLE completa (cliente FTMS,
  lib Nordic renomeada) mas **só lê**: a API de controle existe no código e nunca é chamada por
  nenhuma tela. O serviço `0xFFF0` é nomeado pela própria JHT como **`SERVICE_RENAME`** e o `0xFFF3`
  como **`CHANGE_DEVICE_NAME`** — uso de configuração/renomeação do módulo, não de motor. O
  pareamento do app oficial é por **tag NFC** (`vision://…?device-id=…`).
- **ViewFit / MATRIX COMMUNITY 360 / Matrix Community 360 - Basic** são o mesmo app Netpulse (dex
  idêntico, só branding) **sem nenhuma permissão ou classe BLE**; a integração com equipamento é por
  nuvem/QR/foto do painel do console.

Docs: [docs/re/vision-fitness-app.md](docs/re/vision-fitness-app.md) (app Vision, incluindo o que
muda no plano de controle) e [docs/re/netpulse-apps.md](docs/re/netpulse-apps.md) (apps Netpulse);
índice em [docs/re/README.md](docs/re/README.md).

### JohnsonOTA — o app de firmware (e o que ele revelou)

Depois da análise dos apps de usuário, baixamos o **JohnsonOTA** (`com.johnsonfitness.wave`, app de
atualização de firmware da JHT; o Google Play o bloqueia no Brasil, então o APK foi obtido do APKPure
e instalado por sideload). A análise estática trouxe o achado mais útil da rodada:

- o FTMS da família JHT tem **opcodes proprietários** no Control Point (`0x2AD9`): **`0x7E` =
  `RESET_CONSOLE_RESOURCE`** (“Device Update”, reinicia o console em modo de atualização) e **`0x7F` =
  `SET_AP_MODE`** (deprecated); e no Machine Status (`0x2ADA`): **`0xFD` = `UPGRADE_RESULT`** e
  **`0xFE` = `UPGRADE_PROGRESS`**;
- a atualização é feita por **Wi-Fi AP do próprio console**: o app manda `0x7E`, espera o delay que o
  console responde, reconecta o BLE, entra num Wi-Fi com **SSID = nome BLE do equipamento** e fala HTTP
  com `http://10.10.10.1:88/` (`GET /Now`, `POST /upload` octet-stream);
- a lista de firmwares vem do **Firebase Remote Config** (`consoleConf`) e aponta para o CDN público
  `https://ota.jhtfitness.com/`; em produção só há Bowflex `T6` e Schwinn `IC4-02` — a T600X não está
  na lista (e lê modelo `000000`), então este app não a atualizaria;
- o pacote é JSON + imagens ESP32 (console ESP32-S3 `BFX_T6` e placa inferior ESP32-S2 `T6_LB`, com
  comandos de motor por I2C como `CMD_W_MOTOR_RPM_TARGET`), mas é de **outro produto** — só estudo.

**O que fazer com isso:** testar o `0x7E` na T600X (com a lona vazia e o console ocioso) e ler a
resposta (`80 7E 01 <delay>` = existe; `80 7E 05` = bloqueado; `80 7E 02` = não suportado). Se
existir, o console entra em AP e dá para ler `http://10.10.10.1:88/Now` (diagnóstico). **Nunca**
chamar `/upload` no equipamento da academia — isso grava firmware. Detalhes, riscos e evidências em
[docs/re/johnsonota.md](docs/re/johnsonota.md).

Esse teste já está **implementado no app (build 1.3.1)**: a Sonda tem a seção **“Opcodes vendor do
FTMS (experimental)”** com os botões `0x7E`/`0x7F`, confirmação explícita, bloqueio com a lona
andando e a resposta decodificada na tela. O app **não tem** cliente HTTP do console e **nunca**
envia firmware — o único efeito colateral conhecido do `0x7E` é o console reiniciar.

## Sonda, op codes vendor e engenharia reversa

O app de usuário é **somente leitura**: ele não tem botões de velocidade, inclinação ou Parar, e o
FTMS desta esteira recusa os comandos da especificação. A investigação do canal do fabricante
continua disponível numa ferramenta escondida:

- **toque longo na versão** (tela de conexão) abre a **Sonda BLE**, que lê/escreve características
  do serviço proprietário `0xFFF0`, roda a **varredura segura** (1 byte por vez, com o `FFF4`
  assinado), testa os **op codes vendor do FTMS** (`0x7E`/`0x7F`, descobertos no app de firmware
  JohnsonOTA) e permite **compartilhar o registro da sessão**;
- o teste dos op codes só libera com a esteira conectada, confirmada e **parada** (velocidade
  medida em 0,0 km/h), pede confirmação e mostra a resposta decodificada (por exemplo o delay do
  `0x7E`, quando aceito);
- **firmware nunca é enviado**: o app não tem cliente HTTP do console e não implementa `/upload`.
  O único efeito colateral conhecido do `0x7E` é o console reiniciar.

O histórico da engenharia reversa (dossiê da T600X, apps oficiais da JHT/Matrix, firmware JohnsonOTA
e experimentos) está nos documentos abaixo.

## Licença

MIT. Veja [`LICENSE`](LICENSE).

## Documentação adicional

- [`docs/protocolo-ftms.md`](docs/protocolo-ftms.md): subconjunto do FTMS usado pelo app e como ler o registro de diagnóstico.
- [`docs/teste-real-2026-11-11.md`](docs/teste-real-2026-11-11.md): o que os registros de 11/11 mostraram.
- [`docs/dossie-esteira-2026-11-12.md`](docs/dossie-esteira-2026-11-12.md): dossiê completo da esteira (identidade, GATT, leituras, escalas e plano de engenharia reversa) a partir da coleta de 2026-11-12.
- [`docs/controle-experimental.md`](docs/controle-experimental.md): histórico do controle experimental pelo 0xFFF0 (arquivado; o app não tem mais botões de controle).
- [`docs/sonda-ble.md`](docs/sonda-ble.md): a Sonda BLE escondida (leitura/escrita do 0xFFF0, varredura segura, op codes vendor e compartilhar registro).
- [`docs/re/vision-fitness-app.md`](docs/re/vision-fitness-app.md): engenharia reversa do app oficial da Vision (FTMS cliente, `0xFFF0` = rename, NFC de pareamento) e o que isso muda no controle.
- [`docs/re/netpulse-apps.md`](docs/re/netpulse-apps.md): engenharia reversa dos apps Netpulse (ViewFit/Matrix) — sem BLE, integração só por nuvem/QR; API JHT descoberta por acaso.
- [`docs/re/johnsonota.md`](docs/re/johnsonota.md): engenharia reversa do app de firmware JohnsonOTA — opcodes proprietários do FTMS (`0x7E`/`0x7F` no Control Point, `0xFD`/`0xFE` no Machine Status), OTA por Wi-Fi AP do console (`10.10.10.1:88`) e análise do pacote de firmware JHT.
- [`docs/re/afg-pro-fitness.md`](docs/re/afg-pro-fitness.md): engenharia reversa do **AFG Pro Fitness** (JHT) — o app que controla esteira pelo protocolo Gizwits; **o teste na T600X em 13/11 não respondeu** (módulo é uma ponte UART transparente WLT8258).
- [`docs/analise-logs-2026-11-13.md`](docs/analise-logs-2026-11-13.md): análise da visita à academia em 13/11 — o que o teste automático enviou, por que não houve resposta, os comandos FTMS recusados e os próximos passos (AFG Pro + HCI snoop).
