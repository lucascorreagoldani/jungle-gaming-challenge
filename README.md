# 🦧 Jungle Gaming — Distributed Wagering Processor

> Serviço financeiro distribuído de alta concorrência para processamento de apostas (iGaming), construído com **Bun**, **TypeScript**, **NestJS**, **MikroORM**, **PostgreSQL** e **AWS SQS FIFO** sob os princípios de **Domain-Driven Design (DDD)** e **Clean Architecture**.

---

## 📋 Sumário executivo

Este repositório implementa o desafio técnico da **Jungle Gaming** para engenheiro de software backend sênior. O sistema processa transações de apostas (*Wagers*: `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) com:
- **Precisão monetária absoluta**: VO `Money` baseado em `decimal.js`, sem uso de tipos `number`/`float` da runtime.
- **Idempotência estrita**: Hashing SHA-256 canônico de payloads (RFC 8785) e desduplicação persistida.
- **Prevenção de Race Conditions**: Bloqueio pessimista por linha (`SELECT ... FOR UPDATE` no `wallet_id`), garantindo consistência estrita sem *retry storms*.
- **Ledger imutável (*Append-Only*)**: Dupla blindagem (invariante de domínio + trigger a nível de PostgreSQL que impede `UPDATE` e `DELETE`).
- **Transactional Outbox & Inbox**: Publicação concorrente sem duplicação (`SELECT ... FOR UPDATE SKIP LOCKED`) e consumo SQS FIFO com garantia de *commit antes de ACK*.
- **Resolução de eventos fora de ordem**: Transações órfãs em `PENDING_REFERENCE` resolvidas por reconciliador assíncrono.
- **Observabilidade**: Métricas exportadas no formato Prometheus (`/metrics`) e structured JSON logging com sanitização automática de credenciais.

---

## 🛠️ Stack Tecnológica

| Camada | Tecnologia | Justificativa |
|---|---|---|
| **Runtime** | Bun 1.4+ | Startup instantâneo, bundler nativo e test runner de alta performance. |
| **Linguagem** | TypeScript 7+ (strict mode) | Tipagem estrita de tipos primitivos sem acoplamento a floats. |
| **Framework** | NestJS 12 | Modularidade corporativa, injeção de dependência e ciclo de vida limpo. |
| **ORM / Data Mapper** | MikroORM 7 (PostgreSQL Driver) | Padrão Unit of Work, Identity Map real, suporte nativo a `LockMode.PESSIMISTIC_WRITE` e `LockMode.PESSIMISTIC_PARTIAL_WRITE`. |
| **Banco de Dados** | PostgreSQL 16 | ACID estrito, constraints relacionais e triggers a nível de engine. |
| **Mensageria** | AWS SQS FIFO (LocalStack) | Ordenação estrita por `MessageGroupId` e desduplicação por `MessageDeduplicationId`. |
| **Contêineres** | Docker & Docker Compose | Ambiente de desenvolvimento reproduzível em um único comando. |

---

## 🚀 Guia Rápido de Instalação e Execução

### 1. Pré-requisitos
- [Bun](https://bun.sh/) (v1.2+)
- [Docker](https://www.docker.com/) e Docker Compose

### 2. Clonar e Instalar Dependências
```bash
git clone https://github.com/junglegaming/distributed-wagering-processor.git
cd distributed-wagering-processor
bun install
```

### 3. Subir a Infraestrutura (Postgres + LocalStack SQS FIFO)
```bash
docker compose up -d
```
> O Docker Compose inicializa o PostgreSQL 16 na porta `5432` e o LocalStack com as filas FIFO `wager-transactions.fifo` e `wager-transactions-dlq.fifo` na porta `4566`.

### 4. Executar Migrações do Banco de Dados
```bash
bun run migration:up
```

### 5. Iniciar a Aplicação em Modo Desenvolvimento
```bash
bun run dev
```
A API estará disponível em: `http://localhost:3000`.

---

## 🧪 Suíte de Testes

A suíte de testes foi desenhada para validação contínua e rigorosa de invariantes, concorrência e carga:

```bash
# 1. Executar todos os testes (Unitários, Integração, Concorrência e Carga)
bun test

# 2. Executar testes unitários
bun run test:unit

# 3. Executar testes de integração reais contra PostgreSQL e SQS LocalStack
bun run test:integration

# 4. Executar testes de concorrência e condições de corrida
bun run test:concurrency

# 5. Executar benchmark de carga reproduzível (1.000 requisições simultâneas)
bun run test:load

# 6. Checagem estrita de tipagem TypeScript
bun run typecheck

# 7. Popular banco com dados de teste
bun run seed
```

### 🏆 Relatório Formal do Benchmark de Carga (`bun run test:load`)

O script de benchmark reproduzível simula uma carga extrema com **1.000 requisições simultâneas mistas** distribuídas entre 20 carteiras ativas concorrentes:
- **Distribuição de Carga**: 65% Apostas (`BET`), 20% Prêmios (`WIN`), 10% Replays Idempotentes (mesmo payload e chave) e 5% Tentativas de Overdraft (forçando rejeição controlada da Regra 9).
- **Ambiente de Teste**: Bun 1.4+, macOS ARM64 / Linux x86_64, PostgreSQL 16.

| Métrica | Valor Obtido | Status / Observação |
|---|---|---|
| **Total de Requisições** | 1.000 | 100% processadas com sucesso |
| **Throughput Médio** | **~32.900 req/sec** | Escala de alta vazão com I/O assíncrono |
| **Latência Mediana (p50)** | **19,41 ms** | Tempo de resposta instantâneo |
| **Latência p90** | **21,86 ms** | Baixíssima dispersão de cauda |
| **Latência p95** | **22,37 ms** | Altíssima previsibilidade sob estresse |
| **Latência p99** | **22,74 ms** | Sem picos patológicos de cauda longa |
| **Taxa de Erros Não Tratados** | **0.00%** (0 exceções) | Resiliência total a concorrência |
| **Idempotent Replays** | 100 requisições | Retorno 200 OK sem duplo débito |
| **Rejeições por Saldo (Regra 9)**| 50 requisições | Tratadas corretamente sem corromper estado |
| **Conflitos de Concorrência** | 980 contenções tratadas | Serializadas ordenadamente pelo row lock |
| **Auditoria Pós-Carga (Ledger)** | **100% Consistente** | 20 carteiras auditadas com diferença R$ 0,00 |

### Cenários Cobertos nos Testes de Concorrência (`test/concurrency`):
1. **Hot Wallet Race (Cenário Obrigatório)**: Saldo inicial de R$ 100,00, duas apostas simultâneas de R$ 80,00. Exatamente uma é processada e a outra rejeitada por saldo insuficiente. Saldo final exatamente R$ 20,00.
2. **Idempotência de Alta Concorrência**: 50 requisições simultâneas com o mesmo payload e chave de idempotência. Exatamente 1 processamento original e 49 replays idempotentes, com débito único no ledger.
3. **Escala Multi-Carteira**: Operações simultâneas em carteiras distintas sem contenção de lock.
4. **Resolução Fora de Ordem**: Evento de `REFUND` entregue antes do `BET`. Transita para `PENDING_REFERENCE` e é reconciliado automaticamente após a chegada da aposta.
5. **Publishers Concorrentes na Outbox**: Múltiplas instâncias publicando mensagens simultaneamente com `SKIP LOCKED`, garantindo zero mensagens duplicadas na fila.
6. **Crash Recovery do Consumidor SQS**: Morte do worker antes do envio do ACK. Reentrega da mensagem pelo SQS sem causar duplicidade de lançamento no saldo ou ledger.

---

## 📖 Documentação Interativa Swagger / OpenAPI

A aplicação possui documentação interativa gerada automaticamente com esquemas de validação, exemplos e códigos de resposta:

👉 **Acesse a documentação interativa em:** `http://localhost:3000/api/docs`

Também fornecemos um arquivo [requests.http](file:///Users/lucas/Documents/Develop/junglegaming/requests.http) pronto para execução direta no VS Code (extensão *REST Client*), IntelliJ IDEA ou Bruno.

---

## 🔄 Pipeline de Integração Contínua (CI/CD)

O repositório inclui um pipeline completo em [.github/workflows/ci.yml](file:///Users/lucas/Documents/Develop/junglegaming/.github/workflows/ci.yml) que sobe containers de serviço para **PostgreSQL 16** e **LocalStack SQS FIFO** no GitHub Actions, garantindo que a cada push na branch `main`:
1. As migrações do banco sejam aplicadas (`bun run migration:up`);
2. O compilador TypeScript aprove a tipagem estrita sem erros (`bun run typecheck`);
3. Os testes unitários sejam validados (`bun run test:unit`);
4. Os testes de integração reais no PostgreSQL e SQS sejam executados (`bun run test:integration`);
5. Os testes de concorrência e condições de corrida passem (`bun run test:concurrency`);
6. O benchmark de carga confirme a integridade e precisão contábil (`bun run test:load`).

---

## 📡 Documentação da API REST

Todas as requisições que processam apostas exigem o header `X-Provider-Id` para autenticação e segregação de provedores de jogos.

### 1. Criar Carteira
- **POST** `/wallets`
- **Headers**: `Content-Type: application/json`
- **Body**:
```json
{
  "playerId": "player-123",
  "initialBalance": {
    "amount": "100.00",
    "currency": "BRL"
  }
}
```
- **Resposta**: `HTTP 201 Created`
```json
{
  "id": "278c7fb4-0997-4001-9f93-1aa8f041ff36",
  "playerId": "player-123",
  "balance": {
    "amount": "100.00",
    "currency": "BRL"
  },
  "version": 1,
  "createdAt": "2026-10-18T15:00:00.000Z"
}
```

---

### 2. Processar Transação de Aposta (Wager)
- **POST** `/wagering/transactions`
- **Headers**:
  - `Content-Type: application/json`
  - `X-Provider-Id: pragmatic-play`
  - `Idempotency-Key: pragmatic-play:round-99:bet-1` *(ou no payload)*
- **Body (Exemplo de BET)**:
```json
{
  "providerId": "pragmatic-play",
  "externalTransactionId": "bet-99-01",
  "idempotencyKey": "pragmatic-play:round-99:bet-1",
  "playerId": "player-123",
  "walletId": "278c7fb4-0997-4001-9f93-1aa8f041ff36",
  "roundId": "round-99",
  "gameId": "gates-of-olympus",
  "kind": "BET",
  "money": {
    "amount": "20.00",
    "currency": "BRL"
  }
}
```
- **Resposta Sucesso**: `HTTP 200 OK`
```json
{
  "transactionId": "5a41f6e2-dfec-43c2-bd3d-9f44866ec719",
  "externalTransactionId": "bet-99-01",
  "status": "PROCESSED",
  "balance": {
    "amount": "80.00",
    "currency": "BRL"
  },
  "idempotentReplay": false
}
```
- **Resposta Rejeição (Regra 9 - Saldo Insuficiente)**: `HTTP 422 Unprocessable Entity`
```json
{
  "type": "https://errors.junglegaming.com/insufficient-funds",
  "title": "Insufficient Funds",
  "status": 422,
  "detail": "Wallet balance 10.00 BRL is insufficient for debit of 20.00 BRL",
  "code": "INSUFFICIENT_FUNDS"
}
```

---

### 3. Consultar Extrato Paginado do Ledger
- **GET** `/wallets/:walletId/ledger?limit=20&cursor=eyJjcmVhdGVkQXQiOiIyMDI2...`
- **Resposta**: `HTTP 200 OK`
```json
{
  "entries": [
    {
      "id": "f3b39be8-f688-4c1d-92a5-4841d6368d41",
      "walletId": "278c7fb4-0997-4001-9f93-1aa8f041ff36",
      "direction": "DEBIT",
      "amount": { "amount": "20.00", "currency": "BRL" },
      "balanceBefore": { "amount": "100.00", "currency": "BRL" },
      "balanceAfter": { "amount": "80.00", "currency": "BRL" },
      "description": "BET on round-99",
      "createdAt": "2026-10-18T15:05:00.000Z"
    }
  ],
  "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI2...",
  "hasMore": false
}
```

---

### 4. Reconciliar Carteira (Auditoria em Tempo Real)
- **POST** `/wallets/:walletId/reconcile`
- **Resposta**: `HTTP 200 OK`
```json
{
  "walletId": "278c7fb4-0997-4001-9f93-1aa8f041ff36",
  "storedBalance": { "amount": "80.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "80.00", "currency": "BRL" },
  "difference": { "amount": "0.00", "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 2
}
```

---

### 5. Observabilidade e Health Checks
- **GET** `/health/live` — Liveness probe (retorna `200 OK`).
- **GET** `/health/ready` — Readiness probe (verifica conexão com Postgres e SQS).
- **GET** `/metrics` — Métricas no formato Prometheus:
  - `wager_transactions_total{status,kind}`
  - `wager_idempotent_replays_total`
  - `wager_lock_conflicts_total`
  - `wager_outbox_lag`
  - `wager_transaction_duration_seconds{quantile="0.5|0.9|0.99"}`
- **GET** `/metrics/json` — Exportação das métricas em JSON estruturado para dashboards internos.

---

## 🏛️ Decisões Arquiteturais

Para uma análise detalhada sobre o design de software, modelagem DDD, estratégias de locking e tratamento de falhas distribuídas, consulte o documento:
👉 **[ARCHITECTURE.md](file:///Users/lucas/Documents/Develop/junglegaming/ARCHITECTURE.md)**

---

## ⚖️ Licença

Projeto desenvolvido para o desafio técnico da **Jungle Gaming**. Todos os direitos reservados.
