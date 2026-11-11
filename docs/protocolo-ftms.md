# Protocolo FTMS usado pelo app

Referência curta do subconjunto do Fitness Machine Service (FTMS 1.0.1, Bluetooth SIG) que o app usa, para quem for depurar com o registro de diagnóstico em mãos. O código está em `src/ftms/`; os vetores de exemplo vêm de `src/ftms/__tests__/`.

Convenções: todos os campos são little-endian; "u" é sem sinal e "s" com sinal; os pacotes aparecem em hexadecimal, um octeto por par, como no registro do app.

## Serviço e características

O serviço é o 0x1826. Os UUIDs de 16 bits expandem para `0000XXXX-0000-1000-8000-00805f9b34fb`.

| Característica | UUID | Propriedades usadas | Uso no app |
| --- | --- | --- | --- |
| Fitness Machine Feature | 0x2ACC | read | Lida ao conectar; opcional |
| Treadmill Data | 0x2ACD | notify | Obrigatória: sem ela a conexão é recusada |
| Training Status | 0x2AD3 | read, notify | Lida e assinada; opcional |
| Supported Speed Range | 0x2AD4 | read | Lida ao conectar; opcional |
| Supported Inclination Range | 0x2AD5 | read | Lida ao conectar; opcional |
| Fitness Machine Control Point | 0x2AD9 | write, indicate | Comandos; o app só considera que há controle se a característica aceita write e indicate e a assinatura das indications funciona |
| Fitness Machine Status | 0x2ADA | notify | Assinada; opcional |

O Control Point é assinado antes das demais características, porque a esteira recusa comandos enquanto as indications dele não estão habilitadas. A escrita é com resposta (GATT Write).

Sem Control Point, o app é só leitor de dados. Sem as faixas, vale a ficha técnica da T600X: 0,8 a 22 km/h (passo 0,1) e 0 a 15 % (passo 0,5).

## Treadmill Data (0x2ACD)

Estrutura: `Flags (u16)` seguido dos campos cuja presença as flags indicam, na ordem da tabela.

### Flags

| Bit | Máscara | Significado | Campos que acrescenta |
| --- | --- | --- | --- |
| 0 | 0x0001 | More Data | Ver "Regra do More Data" |
| 1 | 0x0002 | Average Speed | Velocidade média |
| 2 | 0x0004 | Total Distance | Distância total |
| 3 | 0x0008 | Inclination and Ramp Angle | Inclinação e ângulo de rampa |
| 4 | 0x0010 | Elevation Gain | Ganho de elevação positivo e negativo |
| 5 | 0x0020 | Instantaneous Pace | Ritmo instantâneo |
| 6 | 0x0040 | Average Pace | Ritmo médio |
| 7 | 0x0080 | Expended Energy | Energia total, por hora e por minuto |
| 8 | 0x0100 | Heart Rate | Frequência cardíaca |
| 9 | 0x0200 | Metabolic Equivalent | METs |
| 10 | 0x0400 | Elapsed Time | Tempo decorrido |
| 11 | 0x0800 | Remaining Time | Tempo restante |
| 12 | 0x1000 | Force on Belt and Power Output | Força na lona e potência |

Os bits acima de 12 são ignorados.

### Campos, na ordem do pacote

| Campo | Presente quando | Tipo | Resolução | Valor "não disponível" |
| --- | --- | --- | --- | --- |
| Instantaneous Speed | bit 0 = 0 | u16 | 0,01 km/h | não tratado |
| Average Speed | bit 1 | u16 | 0,01 km/h | não tratado |
| Total Distance | bit 2 | u24 | 1 m | não tratado |
| Inclination | bit 3 | s16 | 0,1 % | 0x7FFF |
| Ramp Angle | bit 3 | s16 | 0,1 ° | 0x7FFF |
| Positive Elevation Gain | bit 4 | u16 | 0,1 m | não tratado |
| Negative Elevation Gain | bit 4 | u16 | 0,1 m | não tratado |
| Instantaneous Pace | bit 5 | u8 ou u16 | ver "Largura do campo de ritmo" | não tratado |
| Average Pace | bit 6 | u8 ou u16 | idem | não tratado |
| Total Energy | bit 7 | u16 | 1 kcal | 0xFFFF |
| Energy per Hour | bit 7 | u16 | 1 kcal/h | 0xFFFF |
| Energy per Minute | bit 7 | u8 | 1 kcal/min | 0xFF |
| Heart Rate | bit 8 | u8 | 1 bpm | não tratado |
| Metabolic Equivalent | bit 9 | u8 | 0,1 MET (suposição do app) | não tratado |
| Elapsed Time | bit 10 | u16 | 1 s | não tratado |
| Remaining Time | bit 11 | u16 | 1 s | não tratado |
| Force on Belt | bit 12 | s16 | 1 N | 0x7FFF |
| Power Output | bit 12 | s16 | 1 W | 0x7FFF |

"Não tratado" significa que o parser devolve o valor como veio. Os campos com valor "não disponível" tratado ficam ausentes no resultado. A frequência cardíaca de 0 bpm, por exemplo, sai do parser como 0; é a interface que mostra "—" nesse caso.

### Regra do More Data

A lógica é a invertida da intuição: com o bit 0 em **0**, o registro traz a velocidade instantânea (2 octetos logo depois das flags). Com o bit 0 em **1**, o registro continua na próxima notificação e **não** traz velocidade instantânea. O parser só marca `moreData`; o app usa cada notificação como veio e mantém o último valor conhecido dos campos ausentes.

### Largura do campo de ritmo

A definição original do FTMS (2017) fixa os campos de ritmo em 1 octeto, com resolução de 0,1 km/min. O GATT Specification Supplement atual os define com 2 octetos, em segundos por 500 m. A esteira não informa qual versão implementa.

Como as flags fixam o tamanho de todos os outros campos, o parser desempata pelo tamanho do pacote:

1. Se nenhum dos bits 5 e 6 está ligado, não há ritmo e nada a decidir.
2. Se o tamanho do pacote é igual ao esperado com ritmo de 2 octetos, vale 2.
3. Senão, se é igual ao esperado com 1 octeto, vale 1.
4. Se nenhum bate, vale 2 quando o pacote é pelo menos tão grande quanto o layout de 2 octetos, e 1 caso contrário.

O valor lido fica "cru" (`instantaneousPaceRaw`, `averagePaceRaw`) e a largura detectada vai em `paceFieldWidth`; o app não converte o ritmo.

### Pacote cortado ou com sobra

Se o pacote acaba antes de um campo anunciado nas flags, o parser mantém os campos já lidos e marca `truncated`. Octetos depois do último campo conhecido são contados em `trailingBytes`. Os dois casos aparecem no registro como erro.

## Fitness Machine Feature (0x2ACC)

Dois campos u32: `Fitness Machine Features` e `Target Setting Features`. Se só o primeiro vier (4 octetos), o app assume nenhum alvo suportado.

| Bit | Fitness Machine Features | Target Setting Features |
| --- | --- | --- |
| 0 | Average Speed | Speed Target Setting |
| 1 | Cadence | Inclination Target Setting |
| 2 | Total Distance | Resistance Target Setting |
| 3 | Inclination | Power Target Setting |
| 4 | Elevation Gain | Heart Rate Target Setting |
| 5 | Pace | Targeted Expended Energy |
| 6 | Step Count | Targeted Step Number |
| 7 | Resistance Level | Targeted Stride Number |
| 8 | Stride Count | Targeted Distance |
| 9 | Expended Energy | Targeted Training Time |
| 10 | Heart Rate Measurement | Targeted Time in Two Heart Rate Zones |
| 11 | Metabolic Equivalent | Targeted Time in Three Heart Rate Zones |
| 12 | Elapsed Time | Targeted Time in Five Heart Rate Zones |
| 13 | Remaining Time | Indoor Bike Simulation Parameters |
| 14 | Power Measurement | Wheel Circumference |
| 15 | Force on Belt and Power Output | Spin Down Control |
| 16 | User Data Retention | Targeted Cadence |

Para este app interessam os bits 0 e 1 de Target Setting Features (velocidade e inclinação). O relatório de diagnóstico mostra os dois campos brutos como `Machine Features` e `Target Settings`.

## Supported Speed Range (0x2AD4) e Supported Inclination Range (0x2AD5)

Seis octetos cada, três campos de 2 octetos:

| Característica | Mínimo | Máximo | Passo |
| --- | --- | --- | --- |
| Speed | u16, 0,01 km/h | u16, 0,01 km/h | u16, 0,01 km/h |
| Inclination | s16, 0,1 % | s16, 0,1 % | u16, 0,1 % |

A sessão só usa a faixa lida se o máximo for maior que o mínimo; passo 0 cai no passo da ficha técnica.

Exemplos (T600X, valores da ficha técnica):

| Pacote | Decodificação |
| --- | --- |
| `50 00 98 08 0A 00` | Velocidade: 0,80 a 22,00 km/h, passo 0,10 |
| `00 00 96 00 05 00` | Inclinação: 0 a 15,0 %, passo 0,5 |

## Fitness Machine Control Point (0x2AD9)

O app escreve o pedido e espera uma indication de resposta com o mesmo op code.

### Pedidos que o app envia

| Op code | Nome | Parâmetro | Exemplo | Decodificação |
| --- | --- | --- | --- | --- |
| 0x00 | Request Control | nenhum | `00` | Pede o controle |
| 0x02 | Set Target Speed | u16, 0,01 km/h | `02 1A 04` | 0x041A = 1050 = 10,50 km/h |
| 0x03 | Set Target Inclination | s16, 0,1 % | `03 19 00` | 25 = 2,5 % |
| 0x07 | Start or Resume | nenhum | `07` | Inicia ou retoma a lona |
| 0x08 | Stop or Pause | u8: 0x01 parar, 0x02 pausar | `08 01` / `08 02` | Parar / pausar |

Inclinação negativa usa complemento de dois: -1,5 % é `03 F1 FF`. O codec também tem o Reset (0x01, `01`), mas a sessão não o envia.

### Resposta (indication)

Formato: `80 <op code do pedido> <result code> [parâmetros]`.

| Result code | Nome | Reação do app |
| --- | --- | --- |
| 0x01 | Success | Confirma o alvo ou o estado da lona |
| 0x02 | Op Code Not Supported | Desfaz o alvo e avisa que a esteira não permite isso por Bluetooth |
| 0x03 | Invalid Parameter | Desfaz o alvo e avisa que a esteira recusou o valor |
| 0x04 | Operation Failed | Desfaz o alvo e avisa |
| 0x05 | Control Not Permitted | Pede o controle de novo, uma vez; se falhar, marca o controle como negado. No Parar, pede de novo a cada tentativa, até o prazo |

Outros códigos viram "código desconhecido" e desfazem o alvo.

Exemplos: `80 02 01` é Success para Set Target Speed; `80 00 05` é Control Not Permitted para Request Control.

### Comportamento de temporização

- A espera pela indication é de até 10 s. Passado o tempo, a sessão **não** derruba a conexão (a especificação manda encerrar o link), porque há esteiras que obedecem sem nunca enviar a indication. O app avisa que a esteira não confirmou e passa a esperar só 1,5 s nos comandos seguintes, até chegar alguma indication.
- Se a escrita do primeiro Request Control falha, o app tenta mais uma vez depois de 1,5 s, para cobrir o caso de o sistema estar pareando com a esteira.
- Toda escrita no Control Point tem prazo de 4 s. No Android, a biblioteca de Bluetooth não devolve nada enquanto o sistema pareia com a esteira; sem o prazo, o app ficaria esperando essa escrita indefinidamente. O prazo não tira a escrita da fila do sistema: enquanto ela não termina, o app não envia outros comandos (só o Parar) e avisa que a esteira ainda não respondeu.
- O Parar tem regras próprias:
  - enquanto ele não é concluído, nenhum outro comando é escrito;
  - a resposta do comando que estava em andamento só é esperada por 250 ms;
  - se a esteira recusa a escrita (por exemplo, com o erro ATT "Procedure Already In Progress", porque ainda não concluiu o comando anterior) ou responde Control Not Permitted, o app pede o controle de novo se for o caso e repete a cada 300 ms, por até 10 s contados do toque; nenhuma escrita ou espera passa desse prazo;
  - a indication do próprio Stop é esperada por 1,5 s;
  - se nada disso der certo, o app avisa para apertar o Emergency Stop da esteira ou puxar a chave de segurança.
- Depois de um Pausar ou Parar, Iniciar/Retomar fica bloqueado até a velocidade medida estar em zero há 1 s (no mínimo 1,5 s e no máximo 15 s depois do toque).
- A indication de resposta só traz o op code do pedido. Uma resposta atrasada de um comando que o app já abandonou pode, por isso, ser tomada como a do comando seguinte de mesmo op code (um Pause atropelado por um Stop, por exemplo).

## Fitness Machine Status (0x2ADA)

Notifica mudanças feitas no console ou por outro cliente. Primeiro octeto é o op code.

| Op code | Evento | Parâmetro | Efeito no app |
| --- | --- | --- | --- |
| 0x01 | Reset | nenhum | Lona parada, alvos descartados, controle volta a `idle` |
| 0x02 | Stopped or Paused by User | u8: 0x01 parar, 0x02 pausar | Pausada ou parada; descarta a fila |
| 0x03 | Stopped by Safety Key | nenhum | Parada pela chave; descarta a fila e o alvo de velocidade |
| 0x04 | Started or Resumed by User | nenhum | Lona em movimento |
| 0x05 | Target Speed Changed | u16, 0,01 km/h | Atualiza o alvo de velocidade |
| 0x06 | Target Incline Changed | s16, 0,1 % | Atualiza o alvo de inclinação |
| 0xFF | Control Permission Lost | nenhum | Controle passa a `lost`; o próximo comando pede de novo |

Outros op codes (por exemplo 0x0E, tempo de treino alvo alterado) são registrados e ignorados. Um 0x05 ou 0x06 sem os 2 octetos do parâmetro também cai em "outro".

## Training Status (0x2AD3)

Formato: `Flags (u8)`, `Training Status (u8)` e, se o bit 0 das flags estiver ligado, um texto UTF-8.

| Código | Estado | Código | Estado |
| --- | --- | --- | --- |
| 0x00 | Other | 0x08 | Fitness Test |
| 0x01 | Idle | 0x09 | Speed Too Low |
| 0x02 | Warming Up | 0x0A | Speed Too High |
| 0x03 | Low Intensity Interval | 0x0B | Cool Down |
| 0x04 | High Intensity Interval | 0x0C | Watt Control |
| 0x05 | Recovery Interval | 0x0D | Manual Mode |
| 0x06 | Isometric | 0x0E | Pre-Workout |
| 0x07 | Heart Rate Control | 0x0F | Post-Workout |

Códigos acima de 0x0F aparecem como "reservado". Exemplos: `00 0D` é Manual Mode sem texto; `01 01 49 64 6C 65` é Idle com o texto "Idle".

## Pacotes de exemplo decodificados

### 1. Registro mínimo

```
00 00 1A 04
```

| Octetos | Campo | Valor |
| --- | --- | --- |
| `00 00` | Flags | 0x0000: só a velocidade instantânea |
| `1A 04` | Instantaneous Speed | 0x041A = 1050 = 10,50 km/h |

### 2. Registro típico de esteira

```
8C 05 20 03 D2 04 00 19 00 0E 00 96 00 58 02 0A 8E F2 02
```

Flags 0x058C: bits 2, 3, 7, 8 e 10 (distância, inclinação, energia, frequência cardíaca, tempo decorrido).

| Octetos | Campo | Valor |
| --- | --- | --- |
| `8C 05` | Flags | 0x058C |
| `20 03` | Instantaneous Speed | 0x0320 = 800 = 8,00 km/h |
| `D2 04 00` | Total Distance | 0x0004D2 = 1234 m |
| `19 00` | Inclination | 25 = 2,5 % |
| `0E 00` | Ramp Angle | 14 = 1,4 ° |
| `96 00` | Total Energy | 150 kcal |
| `58 02` | Energy per Hour | 0x0258 = 600 kcal/h |
| `0A` | Energy per Minute | 10 kcal/min |
| `8E` | Heart Rate | 142 bpm |
| `F2 02` | Elapsed Time | 0x02F2 = 754 s |

### 3. Ritmo com 2 octetos

```
60 00 B0 04 96 00 9B 00
```

Flags 0x0060: bits 5 e 6 (ritmo instantâneo e médio). O pacote tem 8 octetos, o tamanho esperado com ritmo de 2 octetos (com 1 octeto seriam 6).

| Octetos | Campo | Valor |
| --- | --- | --- |
| `60 00` | Flags | 0x0060 |
| `B0 04` | Instantaneous Speed | 1200 = 12,00 km/h |
| `96 00` | Instantaneous Pace | 150 (500 m em 150 s) |
| `9B 00` | Average Pace | 155 |

### 4. Ritmo com 1 octeto

```
60 00 B0 04 02 03
```

Mesmas flags do exemplo 3, mas com 6 octetos: o parser detecta ritmo de 1 octeto. Ritmo instantâneo 2 e médio 3, valores crus (0,1 km/min na definição original).

### 5. More Data (registro dividido)

```
01 04 3C 00
```

Flags 0x0401: More Data (bit 0) e Elapsed Time (bit 10). Sem velocidade instantânea; tempo decorrido `3C 00` = 60 s. O restante do registro vem na notificação seguinte.

## Como ler o registro de diagnóstico

A tela **Diagnóstico** mostra o registro da sessão (até 300 itens, do mais antigo para o mais novo; o mais antigo é descartado ao estourar). **Compartilhar registro** gera um texto com um cabeçalho e o registro.

O cabeçalho traz: nome e identificador da esteira, modo (Bluetooth ou Demonstração), faixa de velocidade e de inclinação (com a origem: "informada pela esteira" ou "presumida pela ficha técnica da T600X"), se há Control Point, os campos `Machine Features` e `Target Settings` em hexadecimal e as características encontradas no serviço.

Cada linha do registro tem o formato `hora  direção  rótulo  hexadecimal`:

| Direção | Significado |
| --- | --- |
| `enviado` | Escrita do app no Control Point (por exemplo `Set Target Speed 10,50 km/h  02 1A 04`) |
| `recebido` | Algo que a esteira mandou: leitura, notificação ou indication (por exemplo `Resposta a Set Target Speed: Success  80 02 01`) |
| `info` | Evento do app, sem pacote (busca, conexão, desconexão) |
| `erro` | Falha do app ou da esteira: escrita recusada, resposta ausente, pacote ilegível, conexão perdida |

Do Treadmill Data, o registro guarda só o **primeiro pacote de cada formato** (combinação de flags e tamanho), para não encher de uma linha por segundo. Um pacote diferente do anterior, por exemplo uma flag nova, gera nova linha.

O que procurar no primeiro teste real:

1. **Cabeçalho: `Control Point: sim` ou `não`.** Sem Control Point a esteira é só leitora.
2. **`Target Settings`.** Os bits 0 e 1 (0x03) indicam que a esteira declara aceitar alvo de velocidade e inclinação. Valor 0x00000000 sugere só transmissão de dados.
3. **Origem das faixas.** "informada pela esteira" confirma os valores lidos; "presumida" quer dizer que as características 0x2AD4/0x2AD5 não existem ou vieram inválidas.
4. **Primeira linha `Treadmill Data`.** Confira as flags e o tamanho. Linhas de erro com "pacote menor que o anunciado" ou "byte(s) além do esperado" indicam layout diferente do documentado; o campo de ritmo (exemplos 3 e 4) é o suspeito mais provável.
5. **O primeiro comando.** Um `enviado  Request Control  00` deve ser seguido de `recebido  Resposta a Request Control: Success  80 00 01`. `Control Not Permitted`, `Op Code Not Supported` ou erro de escrita (sobretudo na primeira tentativa) apontam para pareamento exigido ou para ausência de controle.
6. **A resposta ao comando de velocidade.** Depois de `enviado  Set Target Speed …`, procure a resposta e, nos pacotes seguintes, a velocidade subindo. Linha de erro "sem resposta em … ms" com a lona obedecendo significa esteira que age sem enviar a indication. Resposta de sucesso sem a velocidade mudar merece atenção; confira se o console está em quilômetros, já que há relato, em outro modelo Matrix, de comandos de velocidade falhando com o console em milhas.
7. **`Fitness Machine Status`.** Veja se a esteira o envia depois dos comandos do app (nem toda esteira envia para quem comandou) e quando alguém usa o painel (`startedOrResumedByUser`, `targetSpeedChanged`, `stoppedBySafetyKey`).
8. **`Fitness Machine Status: controlPermissionLost`.** A esteira retomou o controle; confira se isso acontece quando alguém aperta um botão físico.
