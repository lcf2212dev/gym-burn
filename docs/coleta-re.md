# Coleta RE — página para coletar tudo na academia

## Para que serve

Enquanto o celular está pareado com a T600X (painel no modo APP e esteira confirmada na tela
principal), esta página deixa o app coletando o máximo de dados útil para a engenharia reversa
posterior:

- **inventário completo do GATT**: cada serviço e cada característica com read/write/notify/indicate,
  gravado no registro;
- **todas as leituras possíveis**: lê todas as características legíveis (Device Information,
  faixas do FTMS, 0x1816 CSC, o serviço proprietário 0xFFF0, 0x181C, o serviço custom etc.) e grava
  o hexadecimal de cada uma;
- **notificações extras**: assina todas as características que a sessão normal ainda não escuta
  (a sessão já assina Treadmill Data, Training Status, Machine Status e Control Point e grava cada
  pacote do FTMS). No teste real, isso deve incluir FFF4, 2A5B (CSC) e as características de dados
  opcionais do FTMS;
- **marcações de eventos**: botões para anotar "comecei a andar", "aumentei a velocidade", "subi a
  inclinação", "parei", "chave de segurança" etc., com o tempo decorrido, no meio da linha do tempo
  dos pacotes;
- **tudo no mesmo arquivo de registro** da execução, que pode ser compartilhado pelo app ou
  copiado por USB (Documents/GymBurn).

## Como abrir

1. Conecte na esteira e toque em **É esta esteira**.
2. Na tela principal (painel), toque em **Coleta** no topo; ou abra **Diagnóstico** e toque em
   **Abrir coleta**.
3. Toque em **Iniciar coleta** e deixe a tela aberta. Ela mantém a tela ligada sozinha.
4. Use a esteira normalmente e vá marcando os eventos.
5. Ao terminar, toque em **Parar coleta** e depois em **Compartilhar registro** (ou copie a pasta
   por USB). O arquivo tem tudo o que foi feito naquela execução.

Também é possível ensaiar o fluxo no **modo demonstração**: a página avisa em vermelho que os dados
são simulados e não servem para engenharia reversa. Use só para conferir a interface antes de ir à
academia.

## O que foi verificado

Ensaio no celular com a esteira simulada (11/11/2026, 20:56):

- a página abriu com os contadores zerados;
- ao iniciar, gravou no registro as linhas:
  - "Coleta RE iniciada";
  - "GATT 0x1826: 0x2ACC[read], 0x2ACD[notify], 0x2AD3[read notify], ...";
  - "Coleta: leitura 0x2ACC (0x1826) = 0C 16 00 00 03 00 00 00" (e as demais leituras);
  - "Coleta RE ativa: 0 assinaturas, 4 leituras";
- a marcação "MARCA +0:47: Comecei a andar" entrou no mesmo arquivo;
- ao parar: "Coleta RE encerrada depois de 1:35: 0 notificações, 4 leituras, 1 marcas".

No modo demonstração o simulador só tem as características do FTMS que a sessão já assina, por
isso "0 assinaturas". Na T600X real devem aparecer as assinaturas extras (FFF4, 2A5B, ...), e o
contador de notificações extras deve subir quando o painel mandar dados por elas.

## O que mandar depois da academia

O arquivo de registro inteiro (Compartilhar registro ou a pasta Documents/GymBurn). Com ele dá
para:

- reconstruir a linha do tempo de notificações e marcações;
- testar hipóteses de protocolo no 0xFFF0 (comparar bytes das notificações com os eventos marcados);
- decidir os próximos experimentos de escrita na página Sonda BLE.

## Segurança

Esta página não escreve nada na esteira: só lê, assina e anota. Mesmo assim, mantenha a lona vazia
e o Emergency Stop ao alcance; a página seguinte (Sonda BLE) é a que faz escritas experimentais.
