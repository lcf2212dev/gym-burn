# Controle experimental pelo 0xFFF0 — histórico (arquivado na 1.3.0)

> **Arquivado em 12/11/2026:** o app virou **monitoramento + copiloto**, com **Controles do app**
> experimentais (FTMS) e um **Canal alternativo** no painel para tentar o `0xFFF0`. Este documento
> fica como histórico do caminho
> experimental do `0xFFF0`, do mapeamento de payloads e da varredura segura, que continuam
> disponíveis na **Sonda escondida** (toque longo na versão). O teste de **op codes vendor do
> FTMS** (`0x7E`/`0x7F`) é o experimento de campo atual; ver
> [`docs/re/johnsonota.md`](re/johnsonota.md) §6.

Este documento descreve o caminho de controle que o app ganhou para tentar comandar a esteira
Matrix/Vision T600X pelo **serviço proprietário 0xFFF0**, já que o FTMS dela é somente leitura.

> **Status, sem rodeios:** o protocolo do 0xFFF0 **continua desconhecido**. O app não "sabe" mandar a
> esteira andar: ele agora consegue **enviar payloads configuráveis**, **ouvir o canal de resposta**,
> **varrer bytes com segurança** e **registrar tudo**, para que o protocolo seja descoberto e
> plugado sem mudar código. O funcionamento dos comandos só será confirmado na esteira real.

> **Atualização 12/11 (análise dos apps oficiais do fabricante):** o app oficial da Vision
> (`com.johnsonfitness.visionapp` 2.0.0) chama o serviço `0xFFF0` de **`SERVICE_RENAME`** e a
> característica `0xFFF3` de **`CHANGE_DEVICE_NAME`** — ou seja, o uso conhecido desse serviço é
> **configuração/renomeação do módulo BLE**, não um canal de comando do motor. O mesmo app tem a API
> de controle do FTMS implementada mas **nunca a chama** (código morto): o app oficial também não
> controla a esteira. Com isso, a hipótese de comando pelo FFF3 **perde força** e este modo passa a
> ser tratado como **experimento de baixa probabilidade**; o risco é que a escrita no FFF3 apenas
> renomeie o módulo BLE. Detalhes e evidências em
> [`docs/re/vision-fitness-app.md`](re/vision-fitness-app.md) §6–§7.

## 1. Por que não é pelo FTMS

- A unidade de 12/11 declarou `Fitness Machine Feature` com **Target Setting Features = 0x10** —
  apenas alvo de frequência cardíaca.
- O Control Point até aceita `Request Control`, mas recusa **todos** os comandos com
  `Control Not Permitted (0x05)`: 2 Start, 20 Set Target Speed, 12 Set Target Inclination e 3
  Stop/Pause na coleta de 12/11. A unidade de 11/11 respondeu igual.
- Detalhes em [`docs/dossie-esteira-2026-11-12.md`](dossie-esteira-2026-11-12.md) §5 e §9.

O que sobrou foi o **0xFFF0**: `FFF1 read+write`, `FFF2 read`, `FFF3 write`, `FFF4 notify`,
`FFF5 read` — exatamente o perfil de demonstração da TI (SimpleGATTProfile), no qual escrever em
Char3 (FFF3) gera notificação em Char4 (FFF4). A hipótese inicial era que o fabricante tivesse ligado
FFF1/FFF3 na UART do console e FFF4 na volta; **depois da análise do app oficial (§Atualização
acima), a leitura mais provável é que o FFF3 grave o nome/configuração do módulo BLE** — o teste de
campo continua válido (é barato e a varredura só escreve 1 byte por vez), mas sem contar com
controle de motor por esse caminho.

## 2. O que foi implementado no app

| Peça | Onde | O que faz |
| --- | --- | --- |
| Mapeamento de protocolo | `src/vendor/types.ts`, `payload.ts` | Diz, para cada ação (`start`, `pause`, `stop`, `speedUp`, `speedDown`, `inclineUp`, `inclineDown`), qual payload enviar, em qual característica (FFF1/FFF3) e como codificar o número do alvo. |
| Presets | `src/vendor/presets.ts` | Três protocolos candidatos prontos (tabela em §4). |
| Varredura segura | `src/vendor/discovery.ts` + sessão | Escreve 1 byte por vez nas características de escrita, com FFF4 assinado, e mede o que mudou (FFF4, FFF1, FFF2, velocidade, inclinação). |
| Motor de envio | `src/treadmill/treadmill-session.ts` | Liga/desliga o modo, assina o FFF4, envia as ações, registra `tx`/`rx`/info/erro no arquivo, valida templates e mantém os alvos. |
| Editor e varredura | `src/app/sonda.tsx` | Seção **Controle experimental (0xFFF0)** e **Varredura segura do 0xFFF0**. |
| Ativação no painel | `src/components/vendor-control-card.tsx` | Cartão no painel com Ativar/Desativar, protocolo atual e última resposta. |
| Persistência | `src/vendor/mapping-storage.ts` | O mapeamento aprovado fica salvo em `Paths.document/controle-0xfff0.json` e é recarregado na abertura do app. |

### Como o painel se comporta com o modo ligado

- Velocidade `+`/`−`, inclinação `+`/`−`, Iniciar, Pausar e Parar passam a **escrever no 0xFFF0** e
  **não escrevem mais no Control Point do FTMS** (o log deixa de acumular recusas).
- O alvo é calculado como hoje (medido + passo, quantizado pela faixa). A velocidade só é ajustável
  com a lona andando; a inclinação usa a **ficha da T600X (0–15 %, passo 0,5 %)** quando a faixa
  declarada pelo FTMS é implausível (como a `0–50 %/3 %` desta unidade).
- **Não há confirmação da esteira** nesse canal: o app manda os bytes e a telemetria (0x2ACD)
  mostra se a lona/inclinação mudou. Se o alvo não for seguido, ele é descartado como hoje.
- A **velocidade** parte sempre da velocidade **medida** (nunca do alvo notificado) e um ajuste que
  pule mais de 1 km/h é recusado. O alvo notificado pelo console é normalizado: nesta família de
  firmware (reconhecida pela faixa de inclinação declarada 0–50 %/3 %) ele vem em ×16; numa esteira
  conforme vale a escala da especificação.
- A **inclinação** parte do alvo do `0x2ADA` (escala correta) ou, na falta dele, da leitura do
  `0x2ACD` convertida (raw × 0,015); se não houver leitura confiável, o ajuste é recusado em vez de
  chutar. No painel, a inclinação medida também aparece corrigida (~6,667× menor).
- O **Parar** envia o payload do mapeamento **e sempre tenta o Control Point do FTMS em paralelo**
  (esta esteira recusa, mas outra unidade com o mesmo 0xFFF0 pode aceitar), com prazo de 4 s para a
  escrita. O aviso "Parar enviado" só aparece depois da escrita. O **Emergency Stop/chave de
  segurança do painel continua sendo a parada real** — o app não substitui isso.
- Depois de Parar/Pausar, velocidade e inclinação ficam bloqueadas até a lona parar de girar.
- Escritas pelo 0xFFF0 contam como **“sem resposta”** no placar de comandos (aceitas = não se sabe),
  e falha de escrita conta como recusada.
- Se o modo for desligado, tudo volta ao comportamento anterior (FTMS), sem reiniciar o app.

## 3. Como usar

### 3.1 Na Sonda (configurar)

1. Conecte na esteira e confirme **“É esta esteira”**.
2. Abra a **Sonda** com um toque longo na linha da versão (“versão 1.3.0”), na tela de conexão.
3. Em **Controle experimental (0xFFF0)**:
   - toque em um **preset** para carregar um protocolo candidato no rascunho;
   - ajuste **FFF3/FFF1**, **Hex/ASCII**, as codificações de valor e os **payloads** de cada ação;
   - toque em **Aplicar mapeamento** (valida os templates e salva no celular).
4. (Opcional) Rode a **Varredura segura** (§5) antes de ativar.
5. Volte ao painel e toque em **Ativar controle experimental**.

### 3.2 Na esteira (testar)

1. Lona vazia, Emergency Stop/chave ao alcance. Confirme o modo APP no painel.
2. Com a lona andando pelo painel em velocidade baixa, toque em **+ velocidade** no app e **olhe o
   painel**: mudou 0,1 km/h? Então o protocolo/payload de velocidade está certo.
3. Repita para inclinação e para Iniciar/Pausar/Parar, **um toque por vez**, conferindo o painel.
4. Tudo o que for enviado e recebido aparece no registro com o prefixo `Controle 0xFFF0:` — é esse
   arquivo que fecha a engenharia reversa.

## 4. Presets (hipóteses de trabalho)

| Preset | Característica | Payload de exemplo | Racional |
| --- | --- | --- | --- |
| **Túnel FTMS (candidato)** | FFF3 | velocidade 5,10 km/h → `02 FE 01`; inclinação 2,5 % → `03 19 00`; Iniciar `07`; Parar `08 01` | Se o canal for uma ponte serial, talvez aceite os opcodes do FTMS Control Point crus. |
| **Túnel FTMS, velocidade ×16** | FFF3 | velocidade 5,00 km/h → `02 40 1F` | Idem, com a escala que o próprio firmware usa em `targetSpeedChanged` (raw/1600). |
| **Linhas ASCII (exemplo)** | FFF3 | `SPEED 5.1\r\n`, `INCLINE 2.5\r\n`, `START\r\n`, `STOP\r\n` | Se o console/serviço for texto/AT, é o formato mais provável. |

Nenhum foi confirmado. O preset é só o ponto de partida: a Sonda permite editar **qualquer** payload
em hex ou ASCII, com `%v` no lugar do número do alvo.

### Sintaxe dos payloads

- **Hex:** bytes separados por espaço; `%v` expande para 2 bytes (ou 1, em `u8`).
  Ex.: `02 %v`, `AA 55 %v 0D`.
- **ASCII:** texto; aceita `\r`, `\n`, `\t` e `\\`; `%v` expande para o número formatado.
  Ex.: `SPEED %v\r\n`.
- **Codificação do valor:**
  - velocidade: `u16 LE ×100` (padrão FTMS, 5,10 → 510), `u16 LE ×1600` (escala do alvo notificado
    pelo firmware, 5,00 → 8000) ou texto com 1 decimal;
  - inclinação: `s16 LE ×10` (padrão FTMS, 2,5 % → 25), 1 byte inteiro ou texto com 1 decimal.

## 5. Varredura segura do 0xFFF0

Objetivo: descobrir se o canal responde a alguma coisa, **sem** comandar a lona.

O que ela faz, para cada candidato:

1. lê `FFF1` e `FFF2` antes;
2. assina o `FFF4` (se ainda não estiver assinado);
3. escreve **1 byte** (ou o texto `AT\r\n`) em `FFF3` ou `FFF1`;
4. espera **6 s** e guarda toda notificação que chegar no FFF4 (o perfil de demonstração da TI
   notifica até ~5 s depois da escrita);
5. relê `FFF1`/`FFF2`, registra a velocidade/inclinação medidas antes/depois e grava tudo no registro;
6. espera 0,8 s e segue para o próximo (a varredura inteira leva ~70 s).

Candidatos (10): `FFF3 ← 00, 01, 55, AA, FF, "AT\r\n"` e `FFF1 ← 00, 55, AA, FF`.

Se a lona começar a andar no meio da varredura, ela é interrompida na hora, o app tenta o
**Parar** (0xFFF0 e FTMS) e avisa — a varredura é justamente para achar um byte que mexa no
equipamento.

**Por que é seguro:** nenhum comando de controle entra na lista; são bytes neutros, um por vez,
com a lona parada (o app recusa iniciar a varredura com `belt === 'running'`). Se algum candidato
provocar resposta no FFF4, mudança no FFF1/FFF2 ou mexer na telemetria, a Sonda destaca e o registro
tem a linha correspondente.

## 6. Roteiro completo da próxima ida à academia

Ordem sugerida (detalhes em
[`gymburn-logs/analise/pesquisa/proximos-experimentos.md`](../gymburn-logs/analise/pesquisa/proximos-experimentos.md)):

1. **Descritores** (nRF Connect / Sonda): ler `0x2901`/`0x2902` do 0xFFF0 e ver se os nomes são
   “Characteristic 1..5” do perfil TI. É leitura pura e diz se o perfil foi copiado ou customizado.
2. **Bonding** (Android → Bluetooth): parear a esteira e reler `FFF5` e `FFF1/FFF2` — o `FFF5` é a
   Char5 protegida do perfil TI e pode destravar com link criptografado.
3. **Varredura segura** do app (~70 s, 6 s de observação por byte) com a lona parada.
4. **Testar os presets** em ordem, um por vez, olhando o painel: `Túnel FTMS` → `Túnel FTMS ×16` →
   `Linhas ASCII`. Se houver reação, pare e anote o preset + o comando que mudou a lona/painel.
5. **Mapear no app** o protocolo que funcionar (Sonda → payloads por ação → Aplicar) e validar
   Iniciar/Pausar/Parar com a lona vazia.
6. **Captura do app oficial** (ViewFit / Vision Fitness) com *Bluetooth HCI snoop log* é o caminho
   mais rápido se ele fizer controle: o tráfego do 0xFFF0 aparece como ATT Write/Notification e
   revela o protocolo de graça.
7. Plano C (se o BLE não der controle): RS-485 entre console e MCB, com autorização da academia.

## 7. Limitações e riscos

- **O protocolo é desconhecido**; os presets podem não funcionar e a varredura pode não achar nada
  (foi o que aconteceu na coleta de 12/11: 17 min de escuta passiva = 0 notificações).
- Escrever no 0xFFF0 pode ser configuração do módulo, não canal de comando. É por isso que a
  varredura só usa bytes neutros e a escrita de controle é opt-in, um comando por toque.
- **Segurança:** nunca com alguém em cima da lona; mão no Emergency Stop; a chave de segurança do
  painel é a parada real. A lona pode começar a andar se um preset for realmente aceito.
- O app não mede a inclinação física: confirme no painel. A escala do campo `0x2ACD` é hipótese
  (raw × 0,015), então o app usa a ficha da T600X para quantizar o alvo.
- O mapeamento fica no celular; um registro de sessão com `Controle 0xFFF0:` mostra exatamente o que
  foi tentado, o que voltou e em qual horário.

## 8. Verificação e testes

- `npx jest src/vendor src/treadmill/__tests__/vendor-session.test.ts` — codificação de payloads,
  presets, templates, validação e o fluxo de sessão (envio, assinatura do FFF4, varredura,
  desligar o modo).
- `npx tsc --noEmit` e `npx expo lint`.
- Suíte completa: `npx jest` (604 testes, todos passando na revisão de 12/11).
- O log dos testes de sessão usa um transporte falso com o 0xFFF0 (FFF1..FFF4) e confere que o
  Control Point **não** é escrito quando o modo experimental está ligado.

## 9. Teste separado: opcodes vendor do FTMS (0x7E/0x7F)

A análise do app de firmware da JHT revelou que o **Control Point (`0x2AD9`)** dessa família de
firmware aceita dois op codes fora da spec: **`0x7E`** (`Reset Console Resource` / “Device Update”) e
**`0x7F`** (`Set AP Mode`, obsoleto). Ver [`docs/re/johnsonota.md`](re/johnsonota.md).

A Sonda ganhou a seção **“Opcodes vendor do FTMS (experimental)”** com um botão para cada um. Isso é
**independente** do controle experimental do 0xFFF0 (e os dois não podem ficar ligados ao mesmo
tempo):

- só libera com conexão BLE real, Control Point disponível, esteira confirmada, nenhum comando em
  andamento e **lona parada com leitura de velocidade em 0,0 km/h** (a sessão repete as checagens);
- pede **confirmação explícita** e avisa que o console pode reiniciar e a conexão cair;
- a resposta aparece na tela e no registro (`Success`, `Control Not Permitted`, `Op Code Not
  Supported`, e o **delay** quando o `0x7E` é aceito);
- **não atualiza firmware**: o app não tem cliente HTTP do console e nunca chama `/upload`. O único
  efeito colateral conhecido é o console reiniciar no modo de serviço.
