# Gym Burn

App Expo (SDK 58, React Native 0.88, TypeScript) que se conecta por Bluetooth Low Energy a uma esteira Matrix T600X usando o protocolo padrão FTMS (Fitness Machine Service, 0x1826). Lê os dados do treino e ajusta velocidade e inclinação pelo Fitness Machine Control Point.

O que faz:

- lê velocidade, inclinação, distância, tempo, calorias e frequência cardíaca;
- ajusta velocidade e inclinação;
- inicia, pausa e para a lona;
- modo demonstração, com uma esteira simulada, sem usar o rádio;
- tela de diagnóstico, com o registro dos pacotes enviados e recebidos, que pode ser compartilhado como texto.

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

Consoles Matrix e Vision costumam se anunciar com o número de série (`CTM780…` seguido de mais uma dúzia de caracteres, numa Vision T600E) ou com um nome curto e um sufixo de quatro caracteres (`MX-TM xxxx`, numa Matrix T50), não com o nome do modelo. O número de série das T600X começa com `TM781`, então o nome esperado é algo como `CTM781…`. O código que o painel mostra ao entrar no modo APP provavelmente é parte desse nome. Nada disso tem fonte do fabricante; um scanner BLE como o nRF Connect tira a dúvida.

A lista do app mostra os aparelhos que anunciam o serviço FTMS e os que têm nome de console Matrix (`CTM…`, `MX-TM…`, `MATRIX…`), ordenados por força de sinal: numa academia com várias esteiras iguais, a sua tende a ficar no topo. Se ela não aparecer, ligue **Mostrar outros aparelhos Bluetooth**, que lista tudo o que estiver ao alcance, inclusive aparelhos sem nome.

Sem esteira por perto, **Abrir modo demonstração** conecta na esteira simulada.

### Qual é a minha esteira?

Numa academia com várias T600X lado a lado, todas ao alcance podem aparecer na busca, e conectar na errada significaria comandar a lona de outra pessoa. Por isso:

- A lista vem ordenada por força de sinal. Com o celular apoiado no painel da sua esteira, ela tende a ser a primeira, mas a vizinha fica a um metro: o sinal sozinho não garante.
- Se o código que o painel mostra ao entrar no modo APP fizer parte do nome (hipótese ainda não confirmada), é ele que identifica a esteira na lista.
- Depois de conectar, o app **não aceita nenhum comando** até você confirmar que a esteira é a sua. Confira no painel dela: o indicador Bluetooth acendeu e os números (tempo, velocidade, inclinação) são os mesmos do app. Se não forem, toque em **Não é, desconectar** e escolha outra.

## Segurança

O app comanda uma máquina com uma pessoa em cima. Por desenho (`src/treadmill/treadmill-session.ts`):

- Nenhum comando é aceito antes de o usuário confirmar, no app, que a esteira conectada é a dele.
- O controle da esteira (Request Control) só é pedido no primeiro comando, não ao conectar.
- Ajustar a velocidade nunca põe a lona em movimento: com a lona parada o app só avisa "Inicie a lona para ajustar a velocidade". Só o botão Iniciar envia Start.
- Os alvos são sempre limitados à faixa e ao passo informados pela esteira (Supported Speed/Inclination Range) ou, na falta deles, à ficha técnica: 0,8 a 22 km/h e 0 a 15 %.
- Enquanto houver um Parar a executar, nenhum outro comando é escrito nem aceito. Ele esvazia a fila, não espera o comando que estava em andamento e insiste por cerca de 10 s, contados do toque, se a esteira recusar a escrita; se ainda assim não for aceito, o app avisa para parar pela esteira.
- Depois de Pausar ou Parar, Iniciar/Retomar fica bloqueado (botão desabilitado) até a lona parar de girar, no mínimo 1,5 s e no máximo 15 s: um segundo toque no mesmo lugar não a recoloca em movimento.
- O alvo de velocidade só é mantido enquanto a lona o segue. Se ela se afasta dele ou para longe dele (alguém mexeu no console e a esteira não avisou), o alvo é descartado e o próximo ajuste parte da velocidade medida. A checagem é feita a cada leitura da esteira, uma por segundo, e fica suspensa por 3 s depois de cada ajuste do app ou aviso de alvo da esteira (o tempo de a lona começar a reagir); nesses intervalos o app ainda pode usar o alvo antigo.
- O botão Parar fica sempre na tela, inclusive com o Diagnóstico aberto.
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
| `src/screens`, `src/components` | Telas (conexão, painel, diagnóstico) e componentes de interface. |
| `src/utils` | Formatação, textos e geração do relatório de diagnóstico. |
| `tools` | `esteira-ble.py`: periférico BLE que imita uma esteira FTMS, para testar com um celular de verdade. |

As rotas ficam em `src/app` (Expo Router).

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
```

É uma terceira implementação do protocolo, independente do codec do app e da esteira simulada. Não substitui o teste na T600X: ela pode se comportar de outro jeito.

## Pendências conhecidas: o que validar na esteira real

- Se existe Control Point e o que os bits de Target Setting (Fitness Machine Feature) dizem.
- Se as faixas de velocidade e inclinação vêm da esteira ou caem na ficha técnica.
- Largura do campo de ritmo no Treadmill Data (1 ou 2 octetos; ver `docs/protocolo-ftms.md`).
- Se a esteira envia Fitness Machine Status para quem deu o comando.
- Se o Control Point exige pareamento (e se o código mostrado no painel é pedido nesse momento).
- Com que nome a esteira se anuncia e se o código do painel faz parte dele.
- Se o console está em unidades métricas: há relato, em outro modelo Matrix, de comandos de velocidade falhando com o console em milhas.
- iOS não foi testado.
- Ícone e splash ainda são os do template do Expo.

## Licença

MIT. Veja [`LICENSE`](LICENSE).

## Documentação adicional

- [`docs/protocolo-ftms.md`](docs/protocolo-ftms.md): subconjunto do FTMS usado pelo app e como ler o registro de diagnóstico.
