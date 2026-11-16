# Teste manual

Três níveis, do mais rápido ao mais completo. Os comandos são para **Git Bash** (no Windows, o `curl` do PowerShell 5.1 é um alias de `Invoke-WebRequest`).

## 0. Subir o ambiente

```bash
bun install
bun run infra:up          # PostgreSQL + LocalStack (filas criadas no boot)
bun run migration:up
bun run start             # deixe rodando neste terminal; use outro para os próximos passos
```

## 1. Roteiro guiado (2 min) — `bun run demo`

Executa contra a aplicação rodando e mostra cada requisição, a resposta e ✔/✘ do resultado esperado:

| # | O que demonstra |
|---|---|
| 1 | Wallet com saldo inicial: `OPENING` + lançamento `CREDIT`; wallet duplicada → 409 |
| 2 | Idempotência: replay com o **saldo observado na época**, conflito 409, `Idempotency-Key` obrigatório |
| 3 | Validação (dinheiro como número → 400, `OPENING` interno), `INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`, `LOSS` |
| 4 | **Seção 8**: duas apostas de 80.00 simultâneas sobre 100.00 → uma 200, uma 422, saldo 20.00, um débito |
| 5 | `ROLLBACK` antes da `BET` → 202 → resolvido na mesma transação da `BET`; segunda reversão → `ALREADY_REVERSED` |
| 6 | Mesma operação pela **fila**, entregue **duas vezes** → aplicada uma vez (inbox) |
| 7 | Ledger paginado com cursor, reconciliação, métricas |

Código de saída 1 se alguma verificação falhar. Com `AUTH_MODE=oidc`, passe um token: `DEMO_TOKEN=<token> bun run demo`.

## 2. Passo a passo com curl

```bash
B=http://localhost:3000
PLAYER=0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1   # troque a cada execução (uma wallet por player+moeda)

# criar wallet
curl -s -X POST $B/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}"
WALLET=<id retornado>

# helper: submeter transação  →  tx <externalId> <kind> <amount> [referenceExternalId]
tx() {
  REF=${4:+",\"referenceExternalTransactionId\":\"$4\""}
  curl -s -w '  [HTTP %{http_code}]\n' -X POST $B/wagering/transactions \
    -H 'content-type: application/json' -H "Idempotency-Key: provider-a:$1" \
    -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"r-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"$2\",\"money\":{\"amount\":\"$3\",\"currency\":\"BRL\"}$REF}"
}

tx bet-1 BET 25.00          # 200, saldo 75.00
tx bet-1 BET 25.00          # 200, idempotentReplay: true
tx bet-1 BET 30.00          # 409 IDEMPOTENCY_KEY_REUSED
tx bet-2 BET 500.00         # 422 INSUFFICIENT_FUNDS
tx rb-3 ROLLBACK 10.00 bet-3   # 202 PENDING_REFERENCE (bet-3 ainda não existe)
tx bet-3 BET 10.00          # 200 — e o rb-3 é liquidado junto
curl -s $B/providers/provider-a/wagering/transactions/rb-3     # status PROCESSED

# seção 8 (wallet nova com 100.00): duas apostas em paralelo
tx s8-a BET 80.00 & tx s8-b BET 80.00 & wait   # uma 200 e uma 422

curl -s "$B/wallets/$WALLET/ledger?limit=2"     # use nextCursor em ?cursor=
curl -s -X POST $B/wallets/$WALLET/reconciliation
curl -s $B/metrics | grep -E '^(wager_transactions_total|idempotent_replays_total|outbox_)'
```

Pela fila (precisa do [AWS CLI](https://aws.amazon.com/cli/)):

```bash
aws --endpoint-url http://localhost:4566 --region us-east-1 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id $WALLET --message-deduplication-id m-1 \
  --message-body "{\"messageId\":\"m-1\",\"type\":\"WagerTransactionRequested\",\"occurredAt\":\"2026-07-29T15:00:00.000Z\",\"data\":{\"providerId\":\"provider-a\",\"externalTransactionId\":\"q-1\",\"idempotencyKey\":\"provider-a:q-1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"r-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"5.00\",\"currency\":\"BRL\"}}}"

# mensagem inválida → DLQ com o motivo
aws --endpoint-url http://localhost:4566 --region us-east-1 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id g --message-deduplication-id bad-1 --message-body '{"oops":true}'
aws --endpoint-url http://localhost:4566 --region us-east-1 sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo --message-attribute-names All

# eventos publicados pela outbox
aws --endpoint-url http://localhost:4566 --region us-east-1 sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wagering-events.fifo --max-number-of-messages 10
```

## 3. Falhas de verdade

| Experimento | Como | O que observar |
|---|---|---|
| **Postgres cai** | `docker stop wagering_postgres` | `/health/live` 200, `/health/ready` 503, requisições 503 + `Retry-After`; `docker start wagering_postgres` → volta sozinho, sem reiniciar a app |
| **SQS cai** | `docker stop wagering_localstack` | `/health/ready` 503 (`sqs: down`); HTTP continua processando; eventos acumulam na outbox (`outbox_pending_messages` sobe) e são publicados quando o LocalStack volta |
| **3 instâncias + SIGTERM** | `docker compose --profile app up -d --build`, depois `docker compose --profile app stop app2` | logs `shutdown requested` → `shutdown complete` em ms, exit code 0 (`docker compose --profile app ps -a`); app1/app3 seguem atendendo em 3001/3003 |
| **Morte abrupta (SIGKILL)** | durante carga: `docker compose --profile app kill -s KILL app2` | as mensagens dela voltam após a visibilidade (30s) e são processadas uma vez pelas outras; `POST /wallets/:id/reconciliation` continua `consistent: true` |
| **Carga** | `bun run test:load` | relatório em `docs/load-test-report.md` (compare com `docs/load-test-reference.md`) |
| **Keycloak** | `docker compose --profile auth up -d --wait keycloak`, app com `AUTH_MODE=oidc OIDC_ISSUER=http://localhost:8080/realms/wagering bun run start` | sem token → 401; token `provider-a` com `providerId: provider-b` → 403; token: `curl -s -X POST http://localhost:8080/realms/wagering/protocol/openid-connect/token -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret` |

Para inspecionar o banco: `docker exec -it wagering_postgres psql -U postgres wagering_db`, e por exemplo `select status, count(*) from wager_transactions group by 1;`. Tente `update wallet_ledger_entries set amount = 1;` para ver o trigger recusar.
