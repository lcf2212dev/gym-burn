# Sonda BLE 0xFFF0 — como usar e o que já sabemos

## Para que serve

A T600X real (VISION ID 1931, MAC A0:BB:3E:40:19:31) expôs no teste de 11/11/2026 um serviço
proprietário que a esteira simulada não tinha:

- 0xFFF0: FFF1 (read+write), FFF2 (read), FFF3 (write), FFF4 (notify), FFF5 (read)
- 0x1816 (Cycling Speed and Cadence): 2A5B (notify), 2A5C (read)
- 0x181C (User Data Service)
- 00010203-0405-0607-0809-0a0b0c0d1912, característica 2B12 (read)

O FTMS dela é somente leitura para velocidade e inclinação (Target Setting Features = 0x10, só
FC), então o 0xFFF0 foi por um tempo o caminho mais promissor para descobrir como o painel aceita
comandos. **Atualização 12/11:** a análise do app oficial da Vision mostrou que a própria JHT nomeia
esse serviço como `SERVICE_RENAME` e a característica `FFF3` como `CHANGE_DEVICE_NAME` (configuração/
renomeação do módulo BLE), e que o app oficial **não comanda** a esteira. A sonda continua útil, mas
trate o 0xFFF0 como **config/protocolo desconhecido de baixa probabilidade** — ver
[`docs/re/vision-fitness-app.md`](re/vision-fitness-app.md) §7.

A sonda do app é manual: nada é escrito sem um toque. Cada leitura, escrita e notificação vai
para o registro em arquivo da sessão, com tipo rx/tx e o hexadecimal. Serve para descobrir o
protocolo sem precisar de outro app.

## Como abrir

1. Conecte na esteira normalmente (painel no modo APP, toque no nome dela para confirmar).
2. Na tela de conexão (ou no painel), **faça toque longo na linha da versão** (“versão 1.3.0”).
   A Sonda abre.
3. Também dá para abrir direto pelo link gymburn://sonda com o app já aberto.

A Sonda é uma ferramenta avançada e ficou escondida para a tela do dia a dia continuar simples: a
partir da 1.3.0 os botões de controle do painel são experimentais (o FTMS desta T600X os recusa); o foco é monitoramento e copiloto.

## O que testar na próxima ida à academia

Ordem sugerida (anote o horário de cada toque; o registro já marca sozinho):

1. Ler FFF1, FFF2 e FFF5. São leituras baratas e podem revelar versão, estado ou configuração.
2. Assinar FFF4 e, com o celular na mão, mexer no painel: apertar Start, mudar velocidade,
   inclinação, Stop, tirar a chave de segurança. Se o FFF4 notificar nesses momentos, ele é o
   espelho de eventos do painel e o protocolo fica muito mais fácil de decifrar.
3. Sem tocar em nada, escrever 00 no FFF3 e ver o que acontece (notificação? mudança no painel?).
   Depois 01, depois F1. Se nada acontecer, tentar o FFF1 com os mesmos bytes.
4. Ler Device Information (modelo, firmware, serial) — o app agora lê ao conectar, mas a sonda
   deixa repetir e ver na tela.
5. Se o FFF4 notificar, tentar casar os bytes com o evento do painel: cada aperto de tecla deve
   gerar um pacote com opcode e argumento.
6. Antes de ir embora: na Sonda, **Compartilhar registro**, e mande o arquivo. Com ele dá para
   montar o dicionário de comandos. (Não há mais tela de Registros: o arquivo continua sendo
   gravado sozinho.)

Segurança: lona vazia, Emergency Stop ao alcance, ninguém em cima da esteira. Escritas em
FFF1/FFF3 são experimentais e podem alterar o estado do painel; se algo estranho acontecer,
desconecte e use o painel.

## Controle experimental (histórico)

Até a 1.2.0 a Sonda também configurava um protocolo candidato do **0xFFF0** e o painel tinha botões
que o enviavam. Na 1.3.0 **o painel deixou de ter botões de controle** (o app é só leitura +
copiloto); o editor de protocolo e a **varredura segura** continuam na Sonda para experimentos
futuros. O roteiro e o histórico estão em
[`docs/controle-experimental.md`](controle-experimental.md) (arquivado).

## Teste automático do canal Gizwits (AFG Pro)

Desde a 1.3.3 o app faz sozinho, ao conectar, um plano de teste do protocolo do app AFG Pro:
assina o `FFF4`, pede machine info no `FFF3` e, conforme a resposta, tenta variantes (FFF1,
sequência, CRC invertido, ack) e comandos seguros de leitura/parada com a lona parada. Se precisar
de uma ação do usuário (parar a lona, reconectar), a frase aparece na faixa discreta do topo do
painel. O resultado resumido fica num cartão no painel; a seção **“Teste automático (canal
alternativo Gizwits)”** desta Sonda mostra cada tentativa, o hex e o botão **Refazer teste**. Se o
teste confirmar o protocolo, os botões de controle do app passam a usar esse canal sozinhos (com
confirmação pela telemetria; ver [`re/afg-pro-fitness.md`](re/afg-pro-fitness.md)). O
protocolo completo está em [`re/afg-pro-fitness.md`](re/afg-pro-fitness.md).

## Opcodes vendor do FTMS (0x7E/0x7F) — novo em 12/11/2026

A RE do app de firmware JohnsonOTA revelou que a família de firmware JHT estende o **Control Point
(`0x2AD9`)** com dois op codes fora da especificação: **`0x7E`** (`Reset Console Resource` / “Device
Update”, reinicia o console em modo de atualização) e **`0x7F`** (`Set AP Mode`, obsoleto). Ver
[`docs/re/johnsonota.md`](re/johnsonota.md).

A Sonda ganhou uma seção **Opcodes vendor do FTMS (experimental)** com dois botões (Enviar 0x7E /
Enviar 0x7F). Ela só libera quando: conexão BLE real, Control Point presente, esteira confirmada,
controle experimental 0xFFF0 desligado, sem comando em andamento e **lona parada** (velocidade ≤
0,5 km/h). Cada envio pede confirmação e a resposta (`Success`, `Control Not Permitted`, `Op Code
Not Supported`, delay etc.) aparece na tela e vai para o registro.

Interpretação da resposta do 0x7E:

- `80 7E 01 <delay>` → a extensão **existe**; o console deve reiniciar em `<delay>` segundos e a
  conexão cai;
- `80 7E 05` → op code reconhecido mas bloqueado (como os comandos da spec);
- `80 7E 02` → não suportado nesta variante de firmware.

**Nada aqui atualiza firmware.** O GymBurn não tem cliente HTTP do console e nunca chama
`/upload`; o único efeito colateral conhecido é o console reiniciar. Ainda assim: lona vazia,
Emergency Stop ao alcance, e não faça o teste com alguém andando.

## O app oficial Matrix/Vision controla a velocidade?

Evidências reunidas em 11/11/2026:

- O blog oficial da Matrix sobre FTMS (set/2022) diz que o recurso de controle por FTMS é uma
  tendência e que "na Matrix, esperamos adicionar a capacidade de controle em breve, à medida
  que mais apps passem a usá-la". Ou seja: na época, o equipamento Matrix não tinha controle por
  FTMS habilitado.
  https://matrixhomefitness.com/blogs/blog/how-to-use-bluetooth-ftms-to-enhance-your-workout
- Os apps oficiais da Johnson Health Tech são de acompanhamento/community, não de controle:
  - ViewFit (Matrix, Vision e Horizon): "track your workouts, link popular fitness apps and
    wearables, set goals and join challenges".
    https://apps.apple.com/au/app/viewfit/id1111739900
  - Matrix Home Fitness / MATRIX COMMUNITY 360 (Netpulse/EGYM): workout tracking, training
    plans, activity levels, challenges, schedules.
    https://apps.apple.com/us/app/matrix-community-360/id1605490527
- A própria T600X relata Target Setting Features = 0x10: não aceita alvo de velocidade nem de
  inclinação por FTMS. Nenhum app, oficial ou não, consegue controlar por esse caminho.
- Apps de terceiros controlam alguns modelos Matrix mais novos (relatos de qdomyos-zwift com
  T75 XUR e T30 XR; o Treadmill Pro anuncia controle do TF50 por FTMS), mas são consoles e
  firmwares diferentes do LED da T600X.

Conclusão: para a T600X com console LED, não há evidência de que o app oficial controle
velocidade/inclinação; tudo indica que o pareamento no modo APP serve para dados e community.
A análise estática do app oficial (12/11) confirmou isso: a API de controle existe na biblioteca mas
nunca é chamada, e o único uso nomeado do 0xFFF0 é renomeação do módulo. Se existe comando, ele está
no console (modo de serviço), em um app de técnico/OTA (JohnsonOTA) ou na porta CSAFE — ver
[`docs/re/vision-fitness-app.md`](re/vision-fitness-app.md) §9.4.

## Alternativa: capturar o app oficial

Se quiser testar o app oficial: ativar Opções do desenvolvedor → Ativar registro de snoop de
Bluetooth HCI, usar o app oficial pareado na esteira, depois copiar /sdcard/btsnoop_hci.log e
abrir no Wireshark. O tráfego do 0xFFF0 aparece como ATT Write/Notification e revela o protocolo.
