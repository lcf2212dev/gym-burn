# Dados da esteira

Referência dos campos que o Gym Burn lê da Matrix T600X pelo perfil **FTMS — Fitness Machine
Service (0x1826)** e mostra no cockpit. Todas as informações vêm de notificações e leituras GATT
feitas pelo celular: o app **só lê**; nenhuma característica de controle é escrita.

O que a esteira manda é o que a tela mostra. Quando um campo não chega, o app mostra `—` em vez de
inventar um número.

## Serviço e características usadas

| Característica | UUID | Como é usada |
| --- | --- | --- |
| Fitness Machine Service | 0x1826 | serviço que agrupa as características abaixo |
| Treadmill Data | 0x2ACD | notificações contínuas, ~1 vez por segundo — é a fonte da telemetria |
| Fitness Machine Status | 0x2ADA | notificações de eventos do console |
| Training Status | 0x2AD3 | notificações do estado de treino declarado pelo console |
| Fitness Machine Feature | 0x2ACC | lida uma vez ao conectar: o que a esteira mede e o que aceitaria como alvo |
| Supported Speed Range | 0x2AD4 | lida ao conectar: faixa de velocidade declarada |
| Supported Inclination Range | 0x2AD5 | lida ao conectar: faixa de inclinação declarada |
| Device Information | 0x180A | lida ao conectar: identidade do módulo de comunicação |

O Control Point (0x2AD9) **não é usado**. Só as notificações das características de dados são
habilitadas (CCC), sem escrever nada na esteira.

## Treadmill Data (0x2ACD)

Os campos vêm empacotados no payload e um conjunto de flags (uint16) diz quais estão presentes. A
ordem é fixa; campos ausentes não ocupam espaço. Um registro grande pode chegar dividido em mais de
uma notificação.

| Campo | Resolução da especificação | Como a T600X entrega | O que o app exibe |
| --- | --- | --- | --- |
| Velocidade instantânea | 0,01 km/h | sim | km/h (velocidade gigante do cockpit) |
| Velocidade média | 0,01 km/h | nunca envia | `—` |
| Distância total | metro (24 bits) | sim | km, calculado a partir dos metros |
| Inclinação | 0,1 % | sim, com a escala própria do firmware | % corrigido, igual ao painel |
| Ângulo de rampa | 0,1° | valor fixo em 0,5°, sem uso | aparece em "Dados da esteira" sem uso |
| Ganho de elevação (positivo e negativo) | 0,1 m | nunca envia | `—` |
| Ritmo instantâneo | 0,1 km/min ou s/500 m | nunca envia | `—` na lista de dados; o cockpit calcula min/km da velocidade |
| Ritmo médio | idem | nunca envia | `—` |
| Energia total | kcal | sim | kcal |
| Energia por hora | kcal/h | sim | kcal/h |
| Energia por minuto | kcal/min | sim | kcal/min |
| Frequência cardíaca | bpm | sim (0 = sem contato nas alças) | bpm ou `—` |
| MET | 0,1 MET | sim | MET |
| Tempo decorrido | segundo | sim | mm:ss ou h:mm:ss |
| Tempo restante | segundo | nunca envia | `—` |
| Força na lona | newton | nunca envia | `—` |
| Potência | watt | nunca envia | `—` |

Valores especiais de "dado não disponível" definidos pelo FTMS são tratados como ausência do campo,
e o app continua mostrando o último valor recebido. A tela de detalhes indica quais campos a esteira
anunciou mas não envia.

## Fitness Machine Status (0x2ADA)

Eventos pontuais, como mudanças feitas no painel do console:

| Op code | Evento | Como o app usa |
| --- | --- | --- |
| 0x01 | Reset | registra na lista de eventos do console |
| 0x02 | Parada ou pausa pelo usuário (0x01 parar, 0x02 pausar) | registra |
| 0x03 | Parada pela chave de segurança / Emergency Stop | registra e mostra o aviso de segurança |
| 0x04 | Início ou retomada pelo usuário | registra |
| 0x05 | Mudança do alvo de velocidade feita no painel | registra o evento |
| 0x06 | Mudança do alvo de inclinação feita no painel | registra o evento |
| 0xFF | Perda de permissão de controle | não se aplica: o app nunca pede controle |

Os eventos ficam numa lista curta, do mais novo para o mais antigo, com o horário em que chegaram;
o cartão Console mostra os três mais recentes. Eles descrevem o que aconteceu no painel; a
telemetria continua vindo do 0x2ACD.

## Training Status (0x2AD3)

Etapa de treino declarada pelo console (parado, aquecendo, intervalo, pós-treino etc.). Nesta
família de esteiras o campo é **"pegajoso"**: pode continuar dizendo "pós-treino" mesmo com a
pessoa andando, e só muda quando o console decide mudar. O app mostra o rótulo no cartão Console,
mas **não usa** esse campo para saber se a lona está andando — isso vem da velocidade medida no
0x2ACD.

## Device Information (0x180A)

Identidade do **módulo de comunicação** da esteira, não do console como um todo:

| Característica | UUID | Conteúdo |
| --- | --- | --- |
| Manufacturer Name | 0x2A29 | fabricante do módulo |
| Model Number | 0x2A24 | modelo — nesta T600X vem `000000`, o valor de preenchimento do firmware |
| Serial Number | 0x2A25 | número de série do módulo |
| Firmware Revision | 0x2A26 | versão de firmware do módulo |
| Software Revision | 0x2A28 | versão de software |
| Hardware Revision | 0x2A27 | versão de hardware |
| System ID | 0x2A23 | identificador em hexadecimal |

## Fitness Machine Feature (0x2ACC)

Dois campos de bits que o FTMS define:

- **Fitness Machine Features** — o que a esteira mede e reporta (velocidade, distância, inclinação,
  energia, frequência cardíaca, MET, tempo etc.);
- **Target Setting Features** — o que a esteira **aceitaria** como alvo de controle. Na T600X o
  valor é `0x10`, ou seja, **apenas frequência cardíaca**: não há alvo de velocidade nem de
  inclinação. É a declaração oficial de que o equipamento é somente leitura por este perfil.

O app lê esse campo ao conectar: os recursos de medição aparecem na seção de detalhes do
equipamento, e o campo de alvos é a base da decisão de o app ser somente leitura.

## Faixas declaradas (0x2AD4 e 0x2AD5)

| Característica | Formato | Unidade |
| --- | --- | --- |
| Supported Speed Range (0x2AD4) | mínimo, máximo e passo sem sinal | 0,01 km/h |
| Supported Inclination Range (0x2AD5) | mínimo e máximo com sinal; passo sem sinal | 0,1 % |

O app usa o que a esteira informa. Se as características não existirem, ele usa a ficha técnica da
T600X como referência: 0,8–22 km/h e 0–15 %, passo de 0,5 %.

## Peculiaridades do firmware da T600X

1. **Inclinação com escala própria.** O firmware preenche o campo de 0,1 % da especificação com o
   contador interno da inclinação, cuja escala real é `raw × 0,015`. Como o app lê pela
   especificação (`raw / 10`), a leitura sai 6,667× maior; o app aplica o fator 0,15 sobre o valor
   lido (equivalente a `raw × 0,015`) para exibir o mesmo percentual do painel.
2. **Frequência cardíaca 0 = sem contato.** O firmware manda 0 quando nenhuma das alças está sendo
   segurada; o app mostra `—` em vez de 0 bpm.
3. **Campos declarados e nunca enviados.** A esteira anuncia recursos que não implementa —
   velocidade média, ritmo instantâneo e médio, tempo restante, ganho de elevação, força na lona e
   potência. Esses campos nunca chegam; o app mostra `—` e lista a ausência na seção de detalhes. O
   ângulo de rampa é mandado, mas fica fixo em 0,5° e não tem uso.
4. **Training Status pegajoso.** O estado de treino pode ficar desatualizado; não serve para saber se
   a lona está andando (ver acima).
5. **Faixa de inclinação declarada é template do firmware.** A faixa 0–50 % com passo de 3 % não
   corresponde à mecânica da máquina. O app a mostra como declarada, mas não a trata como faixa
   mecânica e usa a ficha da T600X quando precisa de um valor plausível.
