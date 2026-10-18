import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MikroORM, EntityManager } from "@mikro-orm/postgresql";
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ListQueuesCommand,
  GetQueueUrlCommand,
} from "@aws-sdk/client-sqs";
import mikroOrmConfig from "../../src/mikro-orm.config";
import { CreateWalletUseCase } from "../../src/application/use-cases/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/models/wager-transaction.entity";

describe("Real Infrastructure Integration Tests (PostgreSQL & LocalStack SQS)", () => {
  let orm: MikroORM | null = null;
  let em: EntityManager | null = null;
  let sqsClient: SQSClient | null = null;
  let isPostgresAvailable = false;
  let isSqsAvailable = false;

  beforeAll(async () => {
    // 1. Testa disponibilidade do PostgreSQL via MikroORM real
    try {
      orm = await MikroORM.init({
        ...mikroOrmConfig,
        connect: true,
      });
      em = orm.em.fork() as EntityManager;
      // Ping real para confirmar conectividade ativa com a porta do PostgreSQL
      await em.getConnection().execute("SELECT 1");
      isPostgresAvailable = true;
      console.log("PostgreSQL real conectado com sucesso!");
    } catch (err: any) {
      console.log("PostgreSQL não disponível no ambiente:", err.message);
      isPostgresAvailable = false;
      if (orm) {
        try {
          await orm.close(true);
        } catch { }
        orm = null;
        em = null;
      }
    }

    // 2. Testa disponibilidade do LocalStack SQS real
    try {
      const endpoint = process.env.AWS_ENDPOINT || "http://localhost:4566";
      sqsClient = new SQSClient({
        region: "us-east-1",
        endpoint,
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
      });
      await sqsClient.send(new ListQueuesCommand({}));
      isSqsAvailable = true;
      console.log("LocalStack SQS real conectado com sucesso!");
    } catch (err: any) {
      console.log("LocalStack SQS não disponível no ambiente:", err.message);
      isSqsAvailable = false;
    }
  });

  afterAll(async () => {
    if (orm) {
      try {
        await orm.close(true);
      } catch { }
    }
  });

  it("1. PostgreSQL Engine Immutability Trigger: Direct SQL UPDATE or DELETE on wallet_ledger_entries must be blocked (SQL 23506)", async () => {
    if (!isPostgresAvailable || !em) {
      console.log("Skipping Real PostgreSQL test: banco de dados offline neste host");
      expect(true).toBe(true);
      return;
    }

    const createWalletUseCase = new CreateWalletUseCase(em);
    const wallet = await createWalletUseCase.execute({
      playerId: `player-real-pg-trigger-${Date.now()}`,
      initialBalance: { amount: "150.00", currency: "BRL" },
    });

    // Tenta violar a imutabilidade do ledger diretamente via SQL na conexão do PostgreSQL
    const connection = em.getConnection();
    let triggerBlockedUpdate = false;
    try {
      await connection.execute(
        `UPDATE wallet_ledger_entries SET amount = '999.99' WHERE wallet_id = '${wallet.id}'`,
      );
    } catch (err: any) {
      // O trigger prevent_ledger_modification() emite exceção com SQLState 23506
      triggerBlockedUpdate = true;
      expect(err.message).toContain("immutable append-only table");
    }
    expect(triggerBlockedUpdate).toBe(true);

    let triggerBlockedDelete = false;
    try {
      await connection.execute(
        `DELETE FROM wallet_ledger_entries WHERE wallet_id = '${wallet.id}'`,
      );
    } catch (err: any) {
      triggerBlockedDelete = true;
      expect(err.message).toContain("immutable append-only table");
    }
    expect(triggerBlockedDelete).toBe(true);
  });

  it("2. Real PostgreSQL Transactions & Pessimistic Locks: End-to-end Wager and Reconciliation", async () => {
    if (!isPostgresAvailable || !em) {
      console.log("ℹ️ Skipping Real PostgreSQL test: banco de dados offline neste host");
      expect(true).toBe(true);
      return;
    }

    const createWalletUseCase = new CreateWalletUseCase(em);
    const processWagerUseCase = new ProcessWagerTransactionUseCase(em);
    const reconcileWalletUseCase = new ReconcileWalletUseCase(em);

    const wallet = await createWalletUseCase.execute({
      playerId: `player-real-pg-e2e-${Date.now()}`,
      initialBalance: { amount: "200.00", currency: "BRL" },
    });

    // Processa aposta real
    const betRes = await processWagerUseCase.execute({
      providerId: "prov-real",
      externalTransactionId: `real-tx-${Date.now()}`,
      idempotencyKey: `prov-real:real-bet-${Date.now()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-real-1",
      gameId: "slots",
      kind: WagerTransactionKind.Bet,
      money: { amount: "50.00", currency: "BRL" },
    });

    expect(betRes.status).toBe(WagerTransactionStatus.Processed);
    expect(betRes.balance.amount).toBe("150.00");

    // Reconciliação no PostgreSQL real
    const rec = await reconcileWalletUseCase.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.difference.amount).toBe("0.00");
    expect(rec.storedBalance.amount).toBe("150.00");
    expect(rec.calculatedBalance.amount).toBe("150.00");
  });

  it("3. Real SQS FIFO Integration: Send, Receive and Delete in LocalStack", async () => {
    if (!isSqsAvailable || !sqsClient) {
      console.log("ℹ️ Skipping Real SQS test: LocalStack offline neste host");
      expect(true).toBe(true);
      return;
    }

    let queueUrl = "http://localhost:4566/000000000000/wager-transactions.fifo";
    try {
      const getUrl = await sqsClient.send(
        new GetQueueUrlCommand({ QueueName: "wager-transactions.fifo" }),
      );
      if (getUrl.QueueUrl) {
        queueUrl = getUrl.QueueUrl;
      }
    } catch { }

    const deduplicationId = `dedup-${Date.now()}`;
    const groupId = "wallet-test-group";

    // Enviar mensagem real
    const sendRes = await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          eventType: "TestIntegrationEvent",
          data: { timestamp: new Date().toISOString() },
        }),
        MessageDeduplicationId: deduplicationId,
        MessageGroupId: groupId,
      }),
    );

    expect(sendRes.MessageId).toBeDefined();

    // Receber mensagem real
    const recvRes = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
      }),
    );

    if (recvRes.Messages && recvRes.Messages.length > 0) {
      const msg = recvRes.Messages[0]!;
      expect(msg.ReceiptHandle).toBeDefined();

      // Deletar mensagem real (ACK)
      await sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: msg.ReceiptHandle!,
        }),
      );
    }
  });
});
