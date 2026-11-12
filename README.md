# Gym Burn

App Expo (SDK 58, React Native 0.88, TypeScript) que se conecta por Bluetooth Low Energy a uma esteira Matrix T600X usando o protocolo padrão FTMS (Fitness Machine Service, 0x1826). Lê os dados do treino e ajusta velocidade e inclinação pelo Fitness Machine Control Point.

O que faz:

- lê velocidade, inclinação, distância, tempo, calorias e frequência cardíaca;
- ajusta velocidade e inclinação;
- inicia, pausa e para a lona;
- modo demonstração, com uma esteira simulada, sem usar o rádio;
- **sonda BLE do serviço proprietário 0xFFF0** (experimental): lê, escreve e assina características fora do FTMS e registra tudo, para descobrir o protocolo de controle do painel (ver [docs/sonda-ble.md](docs/sonda-ble.md));
- **coleta RE**: página para deixar rodando na academia — despeja o GATT, lê todas as características legíveis, assina as notificações extras e grava marcações de eventos no mesmo registro (ver [docs/coleta-re.md](docs/coleta-re.md));
- tela de diagnóstico, com o registro dos pacotes enviados e recebidos, que pode ser compartilhado como texto;
- roteiro do primeiro teste na esteira real, que acompanha cada passo, marca o que a esteira aceitou e pergunta o que só quem está na frente dela vê;
- gravação contínua de tudo o que acontece em arquivos de texto no celular, para depurar depois.

## Estado atual: leia antes de usar

- O app **nunca foi testado numa T600X de verdade**. Foi verificado de três formas: por testes automatizados; contra a esteira simulada (`src/simulator`), que implementa o FTMS no nível de bytes; e pelo rádio, com um celular Android de verdade conectado a um computador que se anuncia como esteira FTMS (`tools/esteira-ble.py`). Nesse último teste o celular achou a esteira na busca, leu os dados, iniciou, ajustou velocidade e inclinação, pausou e parou a lona.
- A documentação da Matrix/Vision só diz que a T600X "transmite velocidade e outros dados" por FTMS. Não há confirmação do fabricante de que ela **aceita comandos** de velocidade e inclinação. Relatos de usuários (issues do projeto qdomyos-zwift) indicam que consoles Matrix vizinhos (T50 XR, TF50, T75 XUR) aceitam controle pelo FTMS Control Point; para a T600X não há evidência nem a favor nem contra. Se ela não tiver Control Point, o app funciona como leitor de dados e explica isso na tela.
- O primeiro teste real deve ser feito com a lona vazia e em velocidade baixa. A tela **Diagnóstico → Compartilhar registro** gera o texto que mostra o que a esteira realmente suporta.

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

Passo a passo baseado no manual Bluetooth da Matrix:

1. Com o indicador BT do painel apagado, segure o botão Bluetooth por 5 segundos, até entrar no **modo APP**. Na T600X é a tecla ✓ do teclado numérico, marcada com "BT". Segurar de novo alterna para o modo de frequência cardíaca; o painel não pareia com cinta e app ao mesmo tempo.
2. No app, toque em **Procurar esteiras** e conecte na sua.
3. O indicador BT do painel acende quando a conexão se estabelece.
4. Inicie o treino.

Para parar pelo painel, segure Stop por 3 segundos, ou aperte o botão vermelho Emergency Stop.

A esteira não precisa aparecer na lista de Bluetooth das configurações do celular: o app faz a própria busca e conecta por ela. Fóruns de apps de treino recomendam inclusive não parear esse tipo de equipamento pelas configurações do sistema.

Consoles Matrix e Vision costumam se anunciar com o número de série (`CTM780…` seguido de mais uma dúzia de caracteres, numa Vision T600E) ou com um nome curto e um sufixo de quatro caracteres (`MX-TM xxxx`, numa Matrix T50), não com o nome do modelo. O número de série das T600X começa com `TM781`, então o nome esperado é algo como `CTM781…`. O código que o painel mostra ao entrar no modo APP provavelmente é parte desse nome. Nada disso tem fonte do fabricante; um scanner BLE como o nRF Connect tira a dúvida. No teste real de 11/11/2026 a esteira apareceu como **VISION ID 1931** — o sufixo 1931 são os dois últimos octetos do MAC (A0:BB:3E:40:19:31), não o serial nem o código do painel.

A lista do app mostra os aparelhos que anunciam o serviço FTMS e os que têm nome de console Matrix (`CTM…`, `MX-TM…`, `MATRIX…`), ordenados por força de sinal: numa academia com várias esteiras iguais, a sua tende a ficar no topo. Se ela não aparecer, ligue **Mostrar outros aparelhos Bluetooth**, que lista tudo o que estiver ao alcance, inclusive aparelhos sem nome.

Sem esteira por perto, **Abrir modo demonstração** conecta na esteira simulada.

### Roteiro do primeiro teste

Na tela de conexão, **Primeiro teste na esteira** abre um roteiro de seis passos para o primeiro contato com a esteira real: segurança, modo APP, conectar, confirmar a esteira, comandos (Iniciar, +0,1, Parar e o Emergency Stop com o app conectado) e envio do registro. Com o roteiro em andamento, uma faixa no topo das telas diz o que fazer agora e abre o roteiro ao toque. O registro pode ser enviado de qualquer passo: se algo travar (a esteira não aparece na busca, por exemplo), é ele que explica o motivo.

Os passos de conexão e de comandos são marcados sozinhos, pelo que a esteira responde. Cada comando termina de um destes jeitos:

- **concluída**: a esteira aceitou o comando e a velocidade medida mostrou o efeito em até 15 segundos: a lona andou depois do Iniciar, ou ficou em zero depois do Parar. No Parar isso ainda não basta, porque o app vê a lona parar, mas não quem a parou. O roteiro pergunta se ela parou sozinha, sem você tocar no painel nem no Emergency Stop, e é a sua resposta que conclui a verificação;
- **sem confirmação**: a esteira não respondeu ao comando; o detalhe diz se a lona andou ou parou mesmo assim;
- **falhou**: a esteira recusou o comando, ou aceitou e o efeito não apareceu no prazo, ou, no Parar, você respondeu que parou a lona pelo painel ou pelo Emergency Stop, ou que ela não parou.

Uma tentativa que dá certo não apaga as que falharam antes: se um Parar foi aceito e a lona não parou, isso continua na verificação e no resumo, como tentativa anterior sem sucesso, mesmo que o Parar seguinte funcione.

Um comando só é posto à prova se pedido na condição certa: Iniciar com a lona parada, Parar com ela girando livre. Um Parar com a lona já parada, com a esteira avisando outra parada ou logo depois de um Pausar do app não prova nada: a verificação continua pendente e pede para repetir. O mesmo vale se a esteira avisar parada de emergência antes de a lona parar.

O Emergency Stop também depende de quem está na frente da esteira. O roteiro o dá por concluído sozinho num caso só: a lona girava livre (sem Parar ou Pausar pedido pelo app, sem aviso de parada da esteira, sem a velocidade já caindo), a esteira avisou a parada de emergência (Fitness Machine Status 0x03) e, sem mais nada no meio, a velocidade medida ficou em zero. Lona que para sem esse aviso (o Stop do painel faz isso), conexão que termina com a lona girando e aviso que chega com a lona já freando viram uma pergunta, e a resposta é sua: **A lona parou** ou **A lona não parou**. O botão acionado com a lona já parada não testa nada: o roteiro pede para repetir com ela girando. O resumo diz de onde veio o resultado (resposta sua ou aviso da esteira).

As perguntas do Parar e do Emergency Stop aparecem em qualquer passo do roteiro, porque o Emergency Stop pode derrubar a conexão e devolver o roteiro ao passo 3.

O roteiro só vê o que a esteira informa: as leituras de velocidade (em geral uma por segundo) e os avisos que ela mandar. No Iniciar não há pergunta, e fica um limite: se a lona for iniciada pelo painel nos 15 segundos depois de um Iniciar aceito, a verificação sai como concluída. Enquanto uma verificação espera a lona, não toque no painel (a tela avisa); e, se o que você viu não bate com o resumo, anote nas observações do passo 6.

O roteiro também pergunta o código que o painel mostrou ao entrar no modo APP e se o indicador Bluetooth acendeu. Tudo isso vai para o registro.

Dá para ensaiar em casa, no modo demonstração ou com `tools/esteira-ble.py` (veja abaixo).

### Qual é a minha esteira?

Numa academia com várias T600X lado a lado, todas ao alcance podem aparecer na busca, e conectar na errada significaria comandar a lona de outra pessoa. Por isso:

- A lista vem ordenada por força de sinal. Com o celular apoiado no painel da sua esteira, ela tende a ser a primeira, mas a vizinha fica a um metro: o sinal sozinho não garante.
- Se o código que o painel mostra ao entrar no modo APP fizer parte do nome (hipótese ainda não confirmada), é ele que identifica a esteira na lista.
- Depois de conectar, o app **não aceita nenhum comando** até você confirmar que a esteira é a sua. Confira no painel dela: o indicador Bluetooth acendeu e os números (tempo, velocidade, inclinação) são os mesmos do app. Se não forem, toque em **Não é, desconectar** e escolha outra.

## Registros

O app grava em arquivo de texto tudo o que acontece: cada pacote enviado e recebido (em hexadecimal), cada mudança de estado, cada toque nos botões, cada aviso mostrado, os aparelhos encontrados na busca com o que anunciaram, e os passos e respostas do roteiro. É um arquivo por execução do app, que começa com a linha `App aberto` e é gravado aos poucos: a cada 2 segundos, a cada 100 linhas, na hora quando há uma linha de erro e quando o app vai para segundo plano. Num erro fatal de JavaScript, a linha do erro é gravada de forma síncrona antes de o app encerrar. Um fechamento abrupto do processo (o sistema matando o app, uma falha nativa, o celular desligando) ainda pode perder as últimas linhas, até 2 segundos de registro. Se a gravação falhar no meio (disco cheio), um trecho pode aparecer repetido, com uma linha de erro avisando.

- **Onde ficam**: no armazenamento interno do app. A tela **Registros** (no topo da tela de conexão, ou em Diagnóstico → Registros salvos) lista os arquivos, com **Compartilhar** (abre a folha de compartilhamento do sistema com o arquivo) e **Apagar**. Ficam guardados os 30 arquivos mais recentes, até 30 MB.
- **Cópia fora do app**: em Registros, **Escolher pasta para a cópia** abre o seletor de pastas do sistema. A partir daí cada trecho gravado vai também para um arquivo de mesmo nome nessa pasta, que o aplicativo Arquivos e um computador ligado por USB conseguem ler. Com a pasta `Documents/GymBurn`, por exemplo:

  ```bash
  adb pull /sdcard/Documents/GymBurn/
  ```

- **Formato**: uma linha por evento, `HH:mm:ss.SSS TIPO texto [hex=BYTES]`, com um cabeçalho que identifica o app, o aparelho e o sistema. Os tipos são `rx` e `tx` (pacotes), `state` (estado da sessão), `action` (toque do usuário), `guide` (roteiro), `info` e `error`. `docs/protocolo-ftms.md` explica como ler os pacotes.
- **O que eles contêm de terceiros**: o nome e o endereço Bluetooth dos aparelhos que estavam por perto durante a busca. Vale lembrar disso antes de mandar um registro para alguém.

## Segurança

O app comanda uma máquina com uma pessoa em cima. Por desenho (`src/treadmill/treadmill-session.ts`):

- Nenhum comando é aceito antes de o usuário confirmar, no app, que a esteira conectada é a dele.
- O controle da esteira (Request Control) só é pedido no primeiro comando, não ao conectar.
- Ajustar a velocidade nunca põe a lona em movimento: com a lona parada o app só avisa "Inicie a lona para ajustar a velocidade". Só o botão Iniciar envia Start.
- Os alvos são sempre limitados à faixa e ao passo informados pela esteira (Supported Speed/Inclination Range) ou, na falta deles, à ficha técnica: 0,8 a 22 km/h e 0 a 15 %.
- Enquanto houver um Parar a executar, nenhum outro comando é escrito nem aceito. Ele esvazia a fila, não espera o comando que estava em andamento e insiste por cerca de 10 s, contados do toque, se a esteira recusar a escrita; se ainda assim não for aceito, o app avisa para parar pela esteira.
- Depois de Pausar ou Parar, Iniciar/Retomar fica bloqueado (botão desabilitado) até a lona parar de girar, no mínimo 1,5 s e no máximo 15 s: um segundo toque no mesmo lugar não a recoloca em movimento.
- O alvo de velocidade só é mantido enquanto a lona o segue. Se ela se afasta dele ou para longe dele (alguém mexeu no console e a esteira não avisou), o alvo é descartado e o próximo ajuste parte da velocidade medida. A checagem é feita a cada leitura da esteira, uma por segundo, e fica suspensa por 3 s depois de cada ajuste do app ou aviso de alvo da esteira (o tempo de a lona começar a reagir); nesses intervalos o app ainda pode usar o alvo antigo.
- Com uma esteira confirmada que aceita comandos, o botão Parar fica à vista em todas as telas do app: no painel e também no Diagnóstico, no roteiro do primeiro teste e nos Registros, que o cobrem. O que é do sistema fica por cima dele enquanto está aberto: a folha de compartilhamento, o seletor de pastas e o teclado. Compartilhe registros e escolha a pasta de cópia com a lona parada.
- Se a conexão cai, a lona continua como estava.

Responsabilidade do usuário:

- O botão vermelho Emergency Stop e a chave de segurança presa a ele são o freio de verdade.
- Alguns consoles travam os botões físicos enquanto um app detém o controle (relato para outros modelos da mesma fabricante). Confirme na T600X, com a lona vazia, antes de confiar.

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
| `src/guide` | Roteiro do primeiro teste: deriva os passos do estado da sessão e das respostas do usuário. |
| `src/logging` | Gravador dos registros em arquivo: formato das linhas, buffer, retenção e cópia para uma pasta do celular. |
| `src/screens`, `src/components` | Telas (conexão, painel, diagnóstico) e componentes de interface. |
| `src/utils` | Formatação, textos e geração do relatório de diagnóstico. |
| `tools` | `esteira-ble.py`: periférico BLE que imita uma esteira FTMS, para testar com um celular de verdade. |

As rotas ficam em `src/app` (Expo Router): a tela principal, `roteiro` e `registros`. `src/app-services.ts` cria o gravador, a sessão e o roteiro, que vivem durante toda a execução do app.

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

## Licença

MIT. Veja [`LICENSE`](LICENSE).

## Documentação adicional

- [`docs/protocolo-ftms.md`](docs/protocolo-ftms.md): subconjunto do FTMS usado pelo app e como ler o registro de diagnóstico.
