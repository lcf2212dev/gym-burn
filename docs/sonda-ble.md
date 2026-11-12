# Sonda BLE 0xFFF0 — como usar e o que já sabemos

## Para que serve

A T600X real (VISION ID 1931, MAC A0:BB:3E:40:19:31) expôs no teste de 11/11/2026 um serviço
proprietário que a esteira simulada não tinha:

- 0xFFF0: FFF1 (read+write), FFF2 (read), FFF3 (write), FFF4 (notify), FFF5 (read)
- 0x1816 (Cycling Speed and Cadence): 2A5B (notify), 2A5C (read)
- 0x181C (User Data Service)
- 00010203-0405-0607-0809-0a0b0c0d1912, característica 2B12 (read)

O FTMS dela é somente leitura para velocidade e inclinação (Target Setting Features = 0x10, só
FC), então o 0xFFF0 é o caminho mais promissor para descobrir como o painel aceita comandos.

A sonda do app é manual: nada é escrito sem um toque. Cada leitura, escrita e notificação vai
para o registro em arquivo da sessão, com tipo rx/tx e o hexadecimal. Serve para descobrir o
protocolo sem precisar de outro app.

## Como abrir

1. Conecte na esteira normalmente (painel no modo APP, confirmar que é a sua esteira).
2. Na tela de conexão, toque em Sonda (aparece quando a esteira está conectada); ou abra
   Diagnóstico e toque em Abrir sonda 0xFFF0.
3. Também dá para abrir direto pelo link gymburn://sonda com o app já aberto.

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
6. Antes de ir embora: Registros → Compartilhar (ou copiar a pasta Documents/GymBurn por USB),
   e mandar o arquivo. Com ele dá para montar o dicionário de comandos.

Segurança: lona vazia, Emergency Stop ao alcance, ninguém em cima da esteira. Escritas em
FFF1/FFF3 são experimentais e podem alterar o estado do painel; se algo estranho acontecer,
desconecte e use o painel.

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
Se o 0xFFF0 for o canal de controle do fabricante, só um teste (sonda ou captura do app oficial
com HCI snoop log) vai confirmar.

## Alternativa: capturar o app oficial

Se quiser testar o app oficial: ativar Opções do desenvolvedor → Ativar registro de snoop de
Bluetooth HCI, usar o app oficial pareado na esteira, depois copiar /sdcard/btsnoop_hci.log e
abrir no Wireshark. O tráfego do 0xFFF0 aparece como ATT Write/Notification e revela o protocolo.
