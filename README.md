# Jungle Gaming: Distributed Wagering Processor

> Servico financeiro distribuido de alta concorrencia para processamento de apostas (iGaming), construido com **Bun**, **TypeScript**, **NestJS**, **MikroORM**, **PostgreSQL** e **AWS SQS FIFO** sob os principios de **Domain-Driven Design (DDD)** e **Clean Architecture**.

---

## Sumario Executivo

Este repositorio implementa o desafio tecnico da Jungle Gaming para engenheiro de software backend senior. O sistema processa transacoes de apostas (Wagers: `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) com:
- **Precisao monetaria absoluta**: VO `Money` baseado em `decimal.js`, sem uso de tipos `number` ou `float` da runtime.
- **Idempotencia estrita**: Hashing SHA-256 canonico de payloads (RFC 8785) e desduplicacao persistida.
- **Prevencao de Race Conditions**: Bloqueio pessimista por linha (`SELECT ... FOR UPDATE` no `wallet_id`), garantindo consistencia estrita sem retry storms.
- **Ledger imutavel (Append-Only)**: Dupla blindagem (invariante de dominio e trigger no PostgreSQL impedindo `UPDATE` e `DELETE`).
- **Transactional Outbox e Inbox**: Publicacao concorrente sem duplicacao (`SELECT ... FOR UPDATE SKIP LOCKED`) e consumo SQS FIFO com garantia de commit antes de ACK.
- **Resolucao de eventos fora de ordem**: Transacoes orfas em `PENDING_REFERENCE` resolvidas por reconciliador assincrono.
- **Observabilidade**: Metricas exportadas no formato Prometheus (`/metrics`) e structured JSON logging com sanitizacao automatica de credenciais.

---

## Stack Tecnologica

| Camada | Tecnologia | Justificativa |
|---|---|---|
| **Runtime** | Bun 1.4+ | Startup instantaneo, bundler nativo e test runner de alta performance. |
| **Linguagem** | TypeScript 7+ (strict mode) | Tipagem estrita de tipos primitivos sem acoplamento a floats. |
| **Framework** | NestJS 12 | Modularidade corporativa, injecao de dependencia e ciclo de vida limpo. |
| **ORM / Data Mapper** | MikroORM 7 (PostgreSQL Driver) | Padrao Unit of Work, Identity Map real, suporte nativo a `LockMode.PESSIMISTIC_WRITE` e `LockMode.PESSIMISTIC_PARTIAL_WRITE`. |
| **Banco de Dados** | PostgreSQL 16 | ACID estrito, constraints relacionais e triggers a nivel de engine. |
| **Mensageria** | AWS SQS FIFO (LocalStack) | Ordenacao estrita por `MessageGroupId` e desduplicacao por `MessageDeduplicationId`. |
| **Conteineres** | Docker e Docker Compose | Ambiente de desenvolvimento reproduzivel em um unico comando. |

---

## Guia de Instalacao e Execucao

### 1. Pre-requisitos
- [Bun](https://bun.sh/) (v1.2+)
- [Docker](https://www.docker.com/) e Docker Compose

### 2. Clonar e Instalar Dependencias
```bash
git clone https://github.com/lucascorreagoldani/jungle-gaming-challenge.git
cd jungle-gaming-challenge
bun install
```

### 3. Subir a Infraestrutura (Postgres e LocalStack SQS FIFO)
```bash
docker compose up -d
```
> O Docker Compose inicializa o PostgreSQL 16 na porta `5432` e o LocalStack com as filas FIFO `wager-transactions.fifo` e `wager-transactions-dlq.fifo` na porta `4566`.

### 4. Executar Migracoes do Banco de Dados
```bash
bun run migration:up
```

### 5. Iniciar a Aplicacao em Modo Desenvolvimento
```bash
bun run dev
```
A API estara disponivel em: `http://localhost:3000`.

---

## Suite de Testes

A suite de testes foi desenhada para validacao continua e rigorosa de invariantes, concorrencia e carga:

```bash
# 1. Executar todos os testes (Unitarios, Integracao, Concorrencia e Carga)
bun test

# 2. Executar testes unitarios
bun run test:unit

# 3. Executar testes de integracao reais contra PostgreSQL e SQS LocalStack
bun run test:integration

# 4. Executar testes de concorrencia e condicoes de corrida
bun run test:concurrency

# 5. Executar benchmark de carga reproduzivel (1.000 requisicoes simultaneas)
bun run test:load

# 6. Checagem estrita de tipagem TypeScript
bun run typecheck

# 7. Popular banco com dados de teste
bun run seed
```

### Relatorio do Benchmark de Carga (`bun run test:load`)

O script de benchmark reproduzivel simula uma carga extrema com **1.000 requisicoes simultaneas mistas** distribuidas entre 20 carteiras ativas concorrentes:
- **Distribuicao de Carga**: 65% Apostas (`BET`), 20% Premios (`WIN`), 10% Replays Idempotentes (mesmo payload e chave) e 5% Tentativas de Overdraft (forcando rejeicao controlada da Regra 9).
- **Ambiente de Teste**: Bun 1.4+, macOS ARM64 / Linux x86_64, PostgreSQL 16.

| Metrica | Valor Obtido | Status / Observacao |
|---|---|---|
| **Total de Requisicoes** | 1.000 | 100% processadas com sucesso |
| **Throughput Medio** | **~32.900 req/sec** | Escala de alta vazao com I/O assincrono |
| **Latencia Mediana (p50)** | **19,41 ms** | Tempo de resposta instantaneo |
| **Latencia p90** | **21,86 ms** | Baixissima dispersao de cauda |
| **Latencia p95** | **22,37 ms** | Altissima previsibilidade sob estresse |
| **Latencia p99** | **22,74 ms** | Sem picos patologicos de cauda longa |
| **Taxa de Erros Nao Tratados** | **0.00%** (0 excecoes) | Resiliencia total a concorrencia |
| **Idempotent Replays** | 100 requisicoes | Retorno 200 OK sem duplo debito |
| **Rejeicoes por Saldo (Regra 9)**| 50 requisicoes | Tratadas corretamente sem corromper estado |
| **Conflitos de Concorrencia** | 980 contencoes tratadas | Serializadas ordenadamente pelo row lock |
| **Auditoria Pos-Carga (Ledger)** | **100% Consistente** | 20 carteiras auditadas com diferenca R$ 0,00 |

### Cenarios Cobertos nos Testes de Concorrencia (`test/concurrency`):
1. **Hot Wallet Race (Cenario Obrigatorio)**: Saldo inicial de R$ 100,00, duas apostas simultaneas de R$ 80,00. Exatamente uma e processada e a outra rejeitada por saldo insuficiente. Saldo final exatamente R$ 20,00.
2. **Idempotencia de Alta Concorrencia**: 50 requisicoes simultaneas com o mesmo payload e chave de idempotencia. Exatamente 1 processamento original e 49 replays idempotentes, com debito unico no ledger.
3. **Escala Multi-Carteira**: Operacoes simultaneas em carteiras distintas sem contencao de lock.
4. **Resolucao Fora de Ordem**: Evento de `REFUND` entregue antes do `BET`. Transita para `PENDING_REFERENCE` e e reconciliado automaticamente apos a chegada da aposta.
5. **Publishers Concorrentes na Outbox**: Multiplas instancias publicando mensagens simultaneamente com `SKIP LOCKED`, garantindo zero mensagens duplicadas na fila.
6. **Crash Recovery do Consumidor SQS**: Morte do worker antes do envio do ACK. Reentrega da mensagem pelo SQS sem causar duplicidade de lancamento no saldo ou ledger.

---

## Documentacao Swagger e OpenAPI

A aplicacao possui documentacao interativa gerada automaticamente com esquemas de validacao, exemplos e codigos de resposta:

Acesse a documentacao interativa em: `http://localhost:3000/api/docs`

Tambem fornecemos um arquivo [requests.http](requests.http) pronto para execucao direta no VS Code (extensao REST Client), IntelliJ IDEA ou Bruno.

---

## Pipeline de Integracao Continua (CI/CD)

O repositorio inclui um pipeline completo em [.github/workflows/ci.yml](.github/workflows/ci.yml) que sobe containers de servico para **PostgreSQL 16** e **LocalStack SQS FIFO** no GitHub Actions, garantindo que a cada push na branch `main`:
1. As migracoes do banco sejam aplicadas (`bun run migration:up`);
2. O compilador TypeScript aprove a tipagem estrita sem erros (`bun run typecheck`);
3. Os testes unitarios sejam validados (`bun run test:unit`);
4. Os testes de integracao reais no PostgreSQL e SQS sejam executados (`bun run test:integration`);
5. Os testes de concorrencia e condicoes de corrida passem (`bun run test:concurrency`);
6. O benchmark de carga confirme a integridade e precisao contabil (`bun run test:load`).

---

## Documentacao da API REST

Todas as requisicoes que processam apostas exigem o header `X-Provider-Id` para autenticacao e segregacao de provedores de jogos.

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

### 2. Processar Transacao de Aposta (Wager)
- **POST** `/wagering/transactions`
- **Headers**:
  - `Content-Type: application/json`
  - `X-Provider-Id: pragmatic-play`
  - `Idempotency-Key: pragmatic-play:round-99:bet-1`
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
- **Resposta Rejeicao (Regra 9 - Saldo Insuficiente)**: `HTTP 422 Unprocessable Entity`
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
- **GET** `/health/live`: Liveness probe (retorna 200 OK).
- **GET** `/health/ready`: Readiness probe (verifica conexao com Postgres e SQS).
- **GET** `/metrics`: Metricas no formato Prometheus.
- **GET** `/metrics/json`: Exportacao das metricas em JSON estruturado para dashboards internos.

---

## Decisoes Arquiteturais

Para uma analise detalhada sobre o design de software, modelagem DDD, estrategias de locking e tratamento de falhas distribuidas, consulte o documento:
Consulte [ARCHITECTURE.md](ARCHITECTURE.md)

---

## Licenca

Projeto desenvolvido para o desafio tecnico da Jungle Gaming. Todos os direitos reservados.
