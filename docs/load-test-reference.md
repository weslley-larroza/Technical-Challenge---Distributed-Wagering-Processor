# Relatório de teste de carga

> **Execução de referência**, gerada por `bun run test:load` em 2026-11-16T00:58:09.906Z, depois da otimização da outbox descrita na análise. Uma nova execução escreve em `docs/load-test-report.md` e não altera este arquivo.

## Ambiente

| Item | Valor |
|---|---|
| Máquina | Windows_NT 10.0.19045 · AMD Ryzen 7 5700G with Radeon Graphics · 16 threads · 15.4 GiB RAM |
| Runtime | Bun 1.4.4 |
| PostgreSQL | PostgreSQL 15.20 on x86_64-pc-linux-musl (Docker Desktop) |
| SQS | LocalStack 4.4.0 (Docker Desktop) |
| Instâncias da app | 3 processos `src/main.ts` (HTTP + consumidor + outbox + worker), pool de 10 conexões cada, `LOG_LEVEL=warn` |
| Gerador de carga | mesmo host, processo único, *closed loop* |

**Tudo roda na mesma máquina:** gerador, 3 instâncias, PostgreSQL e LocalStack competem pela mesma CPU (e o Docker roda sobre uma VM no Windows). Os números são um **limite inferior** e servem para comparar cenários entre si, não para dimensionar produção.

## Metodologia

- **Banco e filas isolados:** banco `wagering_load` recriado e migrado do zero; filas com nome único.
- **Wallets:** 200 wallets com 1.000.000,00 BRL (saldo alto para que rejeições por saldo não dominem o cenário misto), mais 1 *hot wallet*.
- **Gerador *closed loop*:** cada worker envia, espera a resposta e envia de novo; as requisições são distribuídas *round-robin* entre as instâncias. A latência é medida no cliente (envio → corpo recebido) e inclui a fila do pool de conexões.
- **Erro** = HTTP 5xx ou falha de rede. **422 (rejeição de negócio) e 409 (conflito) não são erros**: são respostas corretas e aparecem separadas.
- **Métricas do servidor:** scrape do `/metrics` das 3 instâncias (somadas). O backlog e a idade da outbox foram amostrados a cada 1s durante toda a execução.
- **Consistência:** ao final, o invariante global foi verificado no banco inteiro (saldo = ledger em todas as wallets; um lançamento por transação processada).

| Cenário | Descrição |
|---|---|
| 1. Misto | 64 workers por 30s; BET 65% · WIN 25% · LOSS 10%, valores aleatórios, wallet aleatória entre 200 |
| 1b. Replay | 16 workers por 5s reenviando requisições já processadas (mesma key + payload); valida que a resposta é o replay da transação original |
| 2. Hot wallet | 32 workers por 15s **na mesma wallet** (BET/WIN de 1,00) — pior caso do lock por wallet |
| 3. SQS | 3000 mensagens `WagerTransactionRequested` enfileiradas em lote em 200 grupos FIFO; tempo até todas serem aplicadas |

## Resultados — HTTP

| Cenário | Requisições | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Taxa de erro | 422 | 409 |
|---|---|---|---|---|---|---|---|---|---|
| 1. Misto | 11690 | 387.7 | 160.6 | 235.1 | 281.1 | 460.8 | 0.00% (0) | 0 | 0 |
| 1b. Replay | 8217 | 1640.6 | 8.3 | 19.8 | 26.5 | 65.9 | 0.00% (0) | 0 | 0 |
| 2. Hot wallet | 1272 | 82.8 | 449.0 | 568.5 | 612.7 | 640.6 | 0.00% (0) | 0 | 0 |

- Status por cenário: misto `{"200":11690}` · replay `{"200":8217}` · hot `{"200":1272}`
- Replays verificados (mesmo `transactionId`, `idempotentReplay: true`): **8217**; divergências: **0**

## Resultados — SQS

| Métrica | Valor |
|---|---|
| Mensagens | 3000 |
| Tempo de enfileiramento (cliente) | 1.28 s |
| Tempo até todas aplicadas (desde o primeiro envio) | 23.62 s |
| Throughput de consumo (3 consumidores) | **127.0 msg/s** |
| DLQ | 0 |
| Retries de mensagem | 0 |

## Concorrência e outbox

| Métrica | Hot wallet (só o cenário 2) | Execução inteira |
|---|---|---|
| Conflitos de lock (deadlock + lock timeout) | 0 | 0 |
| Retries da unidade de trabalho (todas as razões) | 0 | 0 |
| …dos quais corrida de chave única | 0 | 0 |

| Outbox | Valor |
|---|---|
| Eventos gerados | 30908 |
| Lag commit → broker p50 / p95 / p99 (histograma) | 197 / 493 / 983 ms |
| Backlog máximo observado (amostrado no banco a cada 1s) | 596 eventos |
| Idade máxima do evento pendente mais antigo (idem) | 0.82 s |
| Tempo para zerar o backlog após o fim da carga | 0.25 s |

## Consistência final

- Transações: 16163 · lançamentos no ledger: 14946 · eventos: 30908
- Invariante global (saldo = ledger em todas as wallets; 1 lançamento por transação processada): **OK**

## Análise

### 1. Correção sob carga

Com cerca de 21,2 mil requisições HTTP (11.690 mistas, 8.217 replays e 1.272 na hot wallet) e 3 mil mensagens SQS, distribuídas por 3 instâncias:
- **0 erros:** nenhum 5xx e nenhuma falha de rede.
- **0 deadlocks e 0 lock timeouts.**
- **0 mensagens na DLQ.**
- **8.217 replays verificados**, todos com o mesmo `transactionId` e `idempotentReplay: true`, e **0 divergências**.
- **Invariante global OK** no fim.

As contagens fecham. Transações = mistas + hot + SQS + aberturas, ou seja, 11.690 + 1.272 + 3.000 + 201 = 16.163. Os 14.946 lançamentos são 1.217 a menos: exatamente as `LOSS` (≈ 10% do misto), que não movem saldo. É a parte que mais importa: **a carga não abriu nenhuma brecha de consistência**.

### 2. Cenário misto: 388 req/s, p50 161 ms, p99 281 ms

- **Saturação:** pela lei de Little, 64 workers / 0,161 s ≈ 398 req/s, praticamente o throughput medido. O sistema está saturado, e a latência a partir daí é **tempo de fila**, não de processamento.
- **Onde está a fila: não perfilei.** Há duas hipóteses, nenhuma verificada:
  - **CPU compartilhada:** o gerador, 3 processos Bun e o PostgreSQL disputam 16 threads, com o Docker numa VM;
  - **Custo por requisição:** cerca de 10 comandos SQL (lock da wallet, duas buscas de idempotência, busca por id externo, inserts de transação, ledger e 2 eventos, update da wallet), mais os triggers de cadeia e de consistência no commit.

  O próximo passo seria `pg_stat_statements` e um profile de CPU das instâncias.
- **Limite inferior:** como tudo roda numa máquina só, o número diz pouco sobre capacidade em produção. O valor dele é comparar cenários e detectar gargalos, como no item 5.

### 3. Hot wallet: 83 tx/s, p50 449 ms

Este é o custo conhecido e aceito do lock pessimista por wallet (ARCHITECTURE §5):
- **Serialização total:** 32 workers na mesma linha são atendidos um de cada vez.
- **Seção crítica:** 83 tx/s ⇒ ≈ 12 ms de lock por transação.
- **Fila:** p50 ≈ 32 × 12 ms ≈ 390 ms + overhead, o que bate com uma fila simples na linha.
- **Sem timeout:** nenhuma espera chegou ao `lock_timeout` de 5s.
- **O que o contador mede:** `lock_conflicts_total` conta só deadlocks e timeouts, não esperas. **O tempo de espera por lock não é medido diretamente**; aqui ele aparece como latência.
- **Implicação:** neste hardware, **uma única wallet não passa de ~80 tx/s**. Wallets diferentes não disputam entre si (o cenário misto mostra 388 req/s sobre 200 wallets).
- **Como melhorar:** só reduzindo a seção crítica, ou seja, menos comandos sob o lock. Relaxar o lock trocaria correção por vazão, o que não é aceitável para saldo.

### 4. Replay: 1.641 req/s, p50 8 ms

O replay usa o caminho rápido **sem lock** (a busca da key acontece antes do `FOR UPDATE`) e não escreve nada. A diferença de cerca de 20× em relação a uma transação nova confirma o desenho: reenvios de provedores, que são comuns com entrega *at-least-once*, não competem pelo lock da wallet.

### 5. Gargalo encontrado e corrigido: a outbox não acompanhava a carga

A primeira execução mostrou a outbox acumulando backlog durante o cenário misto. Investiguei em três passos, e a primeira hipótese estava **errada**.

| Execução | Lag commit→broker p50 / p95 / p99 | Backlog máx. | Pendente mais antigo |
|---|---|---|---|
| Linha de base (lote 50, envio sequencial) | 8,3s / n/a ¹ / n/a ¹ | 11.577 | 16,2s ² |
| Hipótese 1: lanes paralelas para o SQS | 10,5s / 19,3s / 19,9s | 11.501 | 17,0s |
| **Causa real: `UPDATE` em conjunto + lote 200** | **197 ms / 493 ms / 983 ms** | **596** | **0,82s** |

¹ Os buckets do histograma saltavam de 15s para 60s, então o p95/p99 interpolado não tinha significado. Os buckets foram adensados entre 1s e 60s.
² Lido do gauge `/metrics`, que tem timeout curto e mantém o último valor sob carga, provavelmente subestimado. O teste passou a amostrar direto no banco.

- **Hipótese errada:** suspeitei do envio sequencial de lotes de 10 ao SQS e paralelizei por lanes, mantendo a ordem por agregado. **Não mudou nada.**
- **Medição:** separei o tempo de cada rodada do publisher, com um publisher só e sem carga. A chamada ao SQS ficava com cerca de 25%, e **marcar as linhas como publicadas** ficava com 74–270 ms por lote: um `UPDATE` por mensagem emitido pelo Unit of Work, cada um com trigger e round-trip.
- **Correção:** um único `UPDATE … WHERE published_at IS NULL AND id IN (…)` por lote. A transição de domínio `markPublished` continua sendo aplicada em cada objeto antes do update. O caminho de falha, que é raro, continua por linha, com backoff.
  - Banco + ORM caíram para cerca de 16 ms por lote, **independente do tamanho**.
  - Isso tornou vantajoso subir o lote padrão de 50 para 200: com um publisher, a vazão foi de 499 para 2.293 eventos/s.
  - As lanes paralelas ficaram: com lote 200, o SQS virou a maior parte do tempo restante.
- **Lição:** sem o teste de carga isso não apareceria, porque os testes funcionais nunca geram backlog. Sem medir, eu teria entregue a otimização errada.

### 6. Consumo SQS: 127 msg/s com 3 consumidores

Medido do primeiro envio até a última transação aplicada. São cerca de 42 msg/s por consumidor, bem abaixo do HTTP. **Hipóteses ainda não verificadas:**
- **Ack individual:** cada mensagem faz um `DeleteMessage` próprio. `DeleteMessageBatch` cortaria até 10× essas chamadas.
- **Um loop por instância:** cada instância tem um único loop de receive; o próximo receive só começa quando o lote anterior termina. Vários loops concorrentes por instância aumentariam o paralelismo.
- **LocalStack:** a latência de API dele não representa a da AWS.

Na AWS, filas FIFO têm limite de throughput por fila (maior com batching e com o modo *high throughput*), que precisaria entrar no dimensionamento. Ficou como próximo passo, porque o mesmo método do item 5 (medir antes de otimizar) vale aqui.

### 7. Limitações do experimento

- **Host único e não isolado:** gerador, aplicação e infraestrutura disputam a CPU; o Docker roda numa VM.
- **LocalStack** em vez de SQS real.
- **Durações curtas** (30s e 15s): não capturam efeitos de longo prazo (crescimento de tabelas e índices, autovacuum, GC).
- **Closed loop** subestima a cauda da latência em comparação com chegadas em *open loop*. Com o sistema lento, o gerador também desacelera (*coordinated omission*). Os p99 aqui são otimistas.
- **Variação entre execuções:** cerca de ±10%. Nas três execuções completas, que usaram versões diferentes do publisher da outbox (o que também muda a carga no banco), o cenário misto ficou entre 358 e 388 req/s, a hot wallet entre 71 e 83 tx/s e o SQS entre 112 e 136 msg/s. Não fiz várias repetições da versão final para obter um intervalo de confiança.
- **O que não foi medido:** tempo de espera por lock, CPU por componente e uso do pool de conexões.
