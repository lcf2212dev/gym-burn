# Teste real de 11/11/2026 — o que os registros mostram

Análise dos registros do app Gym Burn gravados no celular (Xiaomi 23049PCD8G, Android 15) e copiados para /sdcard/Documents/GymBurn/ (12 arquivos, ~890 KB, de 10/11 21:57 a 11/11 20:19). Os arquivos foram puxados por USB com adb pull e analisados linha a linha.

## Resumo em uma frase

O FTMS da T600X **funciona para leitura** (velocidade, inclinação, distância e status), mas **não aceita comando nenhum**: ela declara, no campo Target Setting Features, que só suporta alvo de frequência cardíaca (0x10), e responde a toda escrita no Control Point com **Control Not Permitted (0x80 xx 05)**. O caminho de controle tem de ser outro — provavelmente o serviço proprietário **0xFFF0**, que a esteira também expõe.

## Sessões

| Arquivo | Aparelho conectado | Resultado |
| --- | --- | --- |
| 10/11 21:57, 22:38, 23:02, 23:18, 23:28 | CTM781TESTE01 (F4:28:9D:8A:C2:6C) | esteira de mentira (tools/esteira-ble.py): Request Control, Start, Set Target Speed e Stop **todos Success** |
| 10/11 23:35 | Esteira simulada (app) | idem, Success |
| 11/11 15:59 e 16:25 e 16:53 | **VISION ID 1931 (A0:BB:3E:40:19:31)** | esteira real: leitura OK; Request Control Success; **todos os comandos Control Not Permitted** |
| 11/11 08:11 e 20:19 | — | só "App aberto" (aberturas sem teste) |

Nas sessões reais o RSSI ficou entre -34 e -51, ou seja, o celular estava junto ao painel.

## O que a esteira real expõe

Serviços descobertos na conexão (registros de 16:25:59 e 16:53:30):

- 0x1800 (Generic Access), 0x1801 (Generic Attribute), 0x180A (Device Information);
- **0x181C (User Data Service)** com First Name, Weight, Date of Birth, Gender, Language etc.;
- **0x1826 (FTMS)** com muito mais características do que o console da simulação: 0x2ACC, 0x2ACD, 0x2ACE, 0x2AD0, 0x2AD1, 0x2AD2, 0x2AD3, 0x2AD4, 0x2AD5, 0x2AD6, 0x2AD7, 0x2AD8, **0x2AD9 (Control Point, write+indicate)**, 0x2ADA;
- **0x1816 (Cycling Speed and Cadence)**: 0x2A5B (notify) e 0x2A5C (read) — provável telemetria alternativa de velocidade/cadência;
- **0xFFF0 (proprietário)**: 0xFFF1 (read+write), 0xFFF2 (read), 0xFFF3 (write), 0xFFF4 (notify), 0xFFF5 (read);
- 00010203-0405-0607-0809-0a0b0c0d1912, característica 00010203-0405-0607-0809-0a0b0c0d2b12 (read).

Anúncio: serviços [0x1826, 0x1816]; Service Data 0x1826 = 01 01 00; manufacturer data com company ID 0x000D (Texas Instruments) e o MAC. Nome **VISION ID 1931** — "1931" são os dois últimos octetos do MAC (19:31), não o serial nem o código do painel.

## FTMS: leitura funciona

- Fitness Machine Feature = 2C 3E 00 00 10 00 00 00: machine features 0x3E2C, **Target Setting Features 0x10**.
- Supported Speed Range = 50 00 98 08 0A 00: mínimo 0,80 km/h, máximo 22,00 km/h, passo 0,10 km/h.
- Supported Inclination Range = 00 00 F4 01 1E 00: mínimo 0%, máximo 50,0%, passo 3,0% (a T600X tem 0-15%; a faixa reportada é suspeita e precisa ser confirmada com o modo de serviço da esteira).
- Treadmill Data (0x2ACD) chega a cada ~1 s, flags 0x078C, e reflete o que o usuário fazia no painel: 5,00 km/h, distância, inclinação, energia, FC, MET, tempo. Exemplo real de 16:27:34: 8C 07 F4 01 50 00 00 00 00 05 00 04 00 E4 00 03 00 21 3F 00.
- Training Status e Fitness Machine Status também chegam (preWorkout/postWorkout, stoppedOrPausedByUser).
- O parser do app está correto: velocidade e inclinação bateram com o que o painel mostrava (a lona andou a 5,0 km/h sob comando do painel).

## FTMS: controle é recusado (e o motivo está no anúncio)

Evidência das sessões reais:

| Comando | Resposta da esteira | Quantas vezes |
| --- | --- | --- |
| Request Control (0x00) | **Success** (80 00 01) | 42 |
| Start or Resume (0x07) | **Control Not Permitted** (80 07 05) | 6 |
| Stop or Pause (0x08 01) | **Control Not Permitted** (80 08 05) | 15 |
| Set Target Speed (0x02 ...) | **Control Not Permitted** (80 02 05) | 8 |
| Set Target Inclination (0x03 ...) | **Control Not Permitted** (80 03 05) | 12 |

A esteira concede o controle, mas recusa toda operação. A explicação está no FTMS 1.0, campo **Target Setting Features**: o bit 0 significa "aceita alvo de velocidade" e o bit 1 "aceita alvo de inclinação". A T600X reporta **0x10**, isto é, **somente bit 4 (frequência cardíaca)**. Ou seja: o próprio equipamento declara que **não aceita alvo de velocidade nem de inclinação** por FTMS. O resultado 0x05 (Control Not Permitted) é o comportamento correto do firmware para comandos que ele não suporta.

Conclusão: **não é problema do app, de pareamento nem de modo APP** — o FTMS da T600X é somente leitura para velocidade/inclinação. As tentativas de Start/Stop/Target foram feitas com a lona parada e também com ela andando a 5 km/h (o usuário iniciou pelo painel às 16:26:30), e todas foram recusadas. Também foi testado antes e depois de entrar no modo APP do painel.

O app hoje só verifica se existe Control Point; deveria também olhar os bits de Target Settings e explicar "esta esteira não aceita comandos por FTMS" em vez de tentar e mostrar erro. Fica como melhoria.

## O que ainda pode dar controle

1. **Serviço proprietário 0xFFF0** — é o candidato mais forte. Os characteristics (FFF1 read/write, FFF3 write, FFF4 notify, FFF2/FFF5 read) têm cara de canal serial transparente do módulo BLE: escrever em FFF1/FFF3, receber em FFF4. Se for isso, o console pode aceitar comandos no mesmo formato do protocolo interno (ou num protocolo do console). Próximo experimento: ler FFF1/FFF2/FFF5, assinar FFF4, escrever em FFF3/FFF1 payloads simples e observar notificações e mudanças no painel. É barato e não invasivo.
2. **0x1816 (CSC)** — provavelmente só telemetria, mas vale assinar 0x2A5B para ver se traz velocidade; não deve dar controle.
3. **App oficial da Matrix/Vision** — se o app oficial da marca controlar a esteira, capturar o tráfego BLE dele com o "Bluetooth HCI snoop log" do Android (Opções do desenvolvedor) e ler o log com o Wireshark. É o caminho mais rápido para descobrir o protocolo do 0xFFF0.
4. **RS-485 entre console e MCB** — o plano de hardware do dossiê anterior continua válido se o BLE não der controle.

## Observações menores

- O app lê Device Information (0x180A) desde o commit "Lê o Device Information..." — mas as sessões reais de 11/11 rodavam um APK anterior a esse commit, então modelo, firmware e serial do console ainda não estão nos registros. O APK instalado em 11/11 20:18 já tem o código; a próxima visita à academia deve capturar esses dados (e aí saberemos a versão de firmware do console).
- O evento "targetSpeedChanged" veio com valores estranhos (05 40 1F = 0x1F40 = 8000, que o app converteu em 80 km/h). Ou a esteira usa unidade diferente, ou o opcode 0x05 dessa firmware não é exatamente o do FTMS. Vale confirmar com o probe do 0xFFF0.
- A faixa de inclinação reportada (0-50%, passo 3%) não bate com a ficha (0-15%, passo 0,5%) — o app deve usar a ficha da T600X como limite quando a faixa da esteira for implausível.
- O nome "VISION ID 1931" mostra que a hipótese do README (nome derivado do serial CTM781...) está errada: o sufixo vem do MAC.

## Arquivos e método

- Registros originais: /sdcard/Documents/GymBurn/ no celular (pasta de cópia configurada no app), copiados para gymburn-logs/device/GymBurn/ no PC.
- Cópia local desta análise: gymburn-logs/ANALISE-LOGS.md (mesmo texto).
- Contagem e evidências: grep de " tx ", " rx " e "Resposta a" sobre os arquivos de 11/11.
