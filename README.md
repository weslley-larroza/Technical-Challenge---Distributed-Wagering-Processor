# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de vários provedores, por HTTP e por SQS. Ele continua correto com mensagens duplicadas, fora de ordem ou processadas ao mesmo tempo, com várias instâncias rodando e quando um processo morre.

- **Stack:** Bun 1.4 · TypeScript strict · NestJS 11 · MikroORM 6 · PostgreSQL 15 · SQS (LocalStack 4.4) · Docker Compose
- **Decisões, trade-offs e limitações:** ver **[ARCHITECTURE.md](ARCHITECTURE.md)**

---

## Pré-requisitos

| Ferramenta | Versão |
|---|---|
| [Bun](https://bun.sh) | 1.4.x (`bun --version`) |
| Docker + Docker Compose | Docker 24+ |

As portas `5432` (PostgreSQL), `4566` (LocalStack) e `3000` (app) precisam estar livres. O cluster do compose usa também `3001`–`3003`.

## Início rápido

```bash
bun install                 # dependências (versões fixadas, lockfile)
bun run infra:up            # PostgreSQL + LocalStack; as filas FIFO são criadas no boot do LocalStack
bun run migration:up        # aplica as migrations
bun run start               # HTTP :3000 + consumidor SQS + publisher da outbox + worker de referências
```

Verificação:

```bash
curl localhost:3000/health/ready
# {"status":"ready","checks":{"postgres":{"status":"up"},"sqs":{"status":"up"}}}
```

### Cluster com 3 instâncias (Docker)

```bash
docker compose --profile app up -d --build   # migrate (one-shot) + app1..app3 nas portas 3001..3003
docker compose --profile app stop app2       # SIGTERM → shutdown gracioso (ver logs)
docker compose --profile app down
```

### Autenticação com Keycloak (opcional)

Por padrão a API roda **sem autenticação** (`AUTH_MODE=none`, com aviso no log), para facilitar o desenvolvimento local. Para ligar OIDC:

```bash
docker compose --profile auth up -d --wait keycloak     # realm "wagering" importado de docker/keycloak/
AUTH_MODE=oidc OIDC_ISSUER=http://localhost:8080/realms/wagering bun run start

# token de máquina para máquina do provider-a (clients: provider-a, provider-b, backoffice; secret = <client>-secret)
TOKEN=$(curl -s -X POST http://localhost:8080/realms/wagering/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret | jq -r .access_token)
curl -H "Authorization: Bearer $TOKEN" localhost:3000/wallets/<id>
```

No cluster Docker: `AUTH_MODE=oidc docker compose --profile app --profile auth up -d --build`. O console admin do Keycloak fica em `localhost:8080`, usuário e senha `admin`/`admin`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | Sobe a aplicação com todos os papéis habilitados |
| `bun run infra:up` / `infra:down` | Sobe / derruba PostgreSQL e LocalStack |
| `bun run migration:up` / `migration:down` / `migration:status` | Migrations versionadas e reversíveis |
| `bun run sqs:setup` | Cria as filas de forma idempotente (alternativa ao script de init do LocalStack) |
| `bun run typecheck` | `tsc --noEmit` em modo strict |
| `bun test` | **Suíte completa**: unidade + integração + e2e + concorrência (precisa de `infra:up`) |
| `bun run test:unit` | Só domínio, sem infraestrutura |
| `bun run test:integration` | PostgreSQL e LocalStack reais |
| `bun run test:concurrency` | Paralelismo real, incluindo **3 processos** do `src/main.ts` |
| `bun run test:docker` | Opcional: `SIGTERM` real nas 3 instâncias do compose (Linux) + fluxo com Keycloak real |

Os testes usam o banco `wagering_test`, criado automaticamente, e filas com nome único por arquivo. Não interferem nos dados de desenvolvimento.

## API

Contrato de status (o mesmo em todos os endpoints):
- **200** processada / replay
- **202** aguardando referência
- **400** payload inválido
- **404** não encontrado
- **409** conflito de idempotência
- **422** rejeição de negócio
- **503** falha transitória (reenviar)

A tabela completa está em [ARCHITECTURE.md §9](ARCHITECTURE.md#9-api-http--contrato-de-status).

```bash
# criar wallet (saldo inicial gera OPENING + lançamento CREDIT na mesma transação SQL)
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# submeter aposta (Idempotency-Key é obrigatório)
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123",
       "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id da wallet>",
       "roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
```

| Método | Rota |
|---|---|
| `POST` | `/wallets` |
| `GET` | `/wallets/:walletId` |
| `GET` | `/wallets/:walletId/ledger?cursor=…&limit=50` (cursor opaco e estável, `limit` ≤ 200) |
| `POST` | `/wallets/:walletId/reconciliation` |
| `POST` | `/wagering/transactions` (header `Idempotency-Key`) |
| `GET` | `/wagering/transactions/:transactionId` |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` |
| `GET` | `/health/live`, `/health/ready` (públicos) |
| `GET` | `/metrics` (Prometheus, público) |

### Enviar pela fila

Envelope da seção 10 do enunciado em `wager-transactions.fifo`. Use `MessageGroupId = walletId` (ordenação por wallet) e `MessageDeduplicationId = messageId`:

```bash
aws --endpoint-url http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{...}}'
```

Os eventos de integração (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`) são publicados pela outbox em `wagering-events.fifo`.

## Configuração (variáveis de ambiente)

| Variável | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/wagering_db` | |
| `DB_POOL_MAX` / `DB_LOCK_TIMEOUT_MS` | `10` / `5000` | Espera máxima por lock de linha (estourou → 503 / retry) |
| `SQS_ENDPOINT` | `http://localhost:4566` | |
| `SQS_WAGER_QUEUE` / `SQS_WAGER_DLQ` / `SQS_EVENTS_QUEUE` | `wager-transactions.fifo` / `wager-transactions-dlq.fifo` / `wagering-events.fifo` | |
| `SQS_MAX_ATTEMPTS` | `5` | Tentativas antes da DLQ |
| `SQS_VISIBILITY_TIMEOUT_SEC` / `SQS_WAIT_TIME_SEC` | `30` / `10` | |
| `SQS_RETRY_BASE_SEC` / `SQS_RETRY_MAX_SEC` | `2` / `300` | Backoff exponencial via visibilidade |
| `ENABLE_HTTP` / `ENABLE_CONSUMER` / `ENABLE_OUTBOX_PUBLISHER` / `ENABLE_PENDING_REFERENCE_WORKER` | `true` | Papéis do processo; todos podem rodar em todas as instâncias |
| `SHUTDOWN_GRACE_MS` | `20000` | |
| `AUTH_MODE` | `none` | `none` · `oidc` |
| `OIDC_ISSUER` | — | Obrigatório com `oidc`, ex.: `http://localhost:8080/realms/wagering` |
| `OIDC_JWKS_URI` | `<issuer>/protocol/openid-connect/certs` | Separado do issuer para uso em containers |
| `OIDC_AUDIENCE` / `OIDC_PROVIDER_CLAIM` / `OIDC_BACKOFFICE_ROLE` | `wagering-api` / `provider_id` / `wagering-backoffice` | |
| `LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` · `silent` |
| `INSTANCE_ID` | `instance-<pid>` | Aparece em todo log |

## Estrutura

```
src/
  domain/          Money, Wallet, WagerTransaction, WalletLedgerEntry, WagerSettlement (regras), eventos, inbox/outbox
  application/     use cases (submit, create wallet, reconcile, resolve pending, publish outbox), portas
  infrastructure/  MikroORM (schema, migrations, repositórios, UoW), SQS, Prometheus, logger
  interfaces/      HTTP (NestJS) e consumidor SQS: adaptadores finos sobre os MESMOS use cases
  bootstrap/       configuração e composition root
test/
  unit/  integration/  e2e/  concurrency/  docker/
```
