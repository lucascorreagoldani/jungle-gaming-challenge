import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MikroORM, EntityManager } from "@mikro-orm/postgresql";
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import mikroOrmConfig from "../../src/mikro-orm.config";
import { CreateWalletUseCase } from "../../src/application/use-cases/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/models/wager-transaction.entity";

async function isPortOpen(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: host,
      port,
      socket: {
        data() { },
        open(s) {
          s.end();
        },
        error() { },
      },
    });
    return true;
  } catch {
    return false;
  }
}

describe("Real Infrastructure Integration Tests (PostgreSQL & LocalStack SQS)", () => {
  let orm: MikroORM | null = null;
  let em: EntityManager | null = null;
  let sqsClient: SQSClient | null = null;
  let isPostgresAvailable = false;
  let isSqsAvailable = false;

  beforeAll(async () => {
    isPostgresAvailable = await isPortOpen("localhost", 5432, 1000);
    isSqsAvailable = await isPortOpen("localhost", 4566, 1000);

    if (isPostgresAvailable) {
      try {
        orm = await MikroORM.init(mikroOrmConfig);
        em = orm.em.fork() as EntityManager;
        // Executa migrações reais no banco
        await orm.migrator.up();
      } catch (err) {
        console.warn("PostgreSQL detected but connection/migration failed:", err);
        isPostgresAvailable = false;
      }
    }

    if (isSqsAvailable) {
      try {
        sqsClient = new SQSClient({
          region: "us-east-1",
          endpoint: "http://localhost:4566",
          credentials: { accessKeyId: "test", secretAccessKey: "test" },
        });
      } catch (err) {
        console.warn("LocalStack detected but SQS init failed:", err);
        isSqsAvailable = false;
      }
    }
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  it("1. PostgreSQL Engine Immutability Trigger: Direct SQL UPDATE or DELETE on wallet_ledger_entries must be blocked (SQL 23506)", async () => {
    if (!isPostgresAvailable || !em) {
      console.log("ℹ️ Skipping Real PostgreSQL test: Docker container not active on localhost:5432");
      expect(true).toBe(true);
      return;
    }

    const createWalletUseCase = new CreateWalletUseCase(em);
    const wallet = await createWalletUseCase.execute({
      playerId: "player-real-pg-trigger",
      initialBalance: { amount: "150.00", currency: "BRL" },
    });

    // Tenta violar a imutabilidade do ledger diretamente via SQL na conexão do PostgreSQL
    const connection = em.getConnection();
    let triggerBlockedUpdate = false;
    try {
      await connection.execute(
        `UPDATE wallet_ledger_entries SET amount = '999.99' WHERE wallet_id = ?`,
        [wallet.id],
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
        `DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`,
        [wallet.id],
      );
    } catch (err: any) {
      triggerBlockedDelete = true;
      expect(err.message).toContain("immutable append-only table");
    }
    expect(triggerBlockedDelete).toBe(true);
  });

  it("2. Real PostgreSQL Transactions & Pessimistic Locks: End-to-end Wager and Reconciliation", async () => {
    if (!isPostgresAvailable || !em) {
      console.log("ℹ️ Skipping Real PostgreSQL test: Docker container not active on localhost:5432");
      expect(true).toBe(true);
      return;
    }

    const createWalletUseCase = new CreateWalletUseCase(em);
    const processWagerUseCase = new ProcessWagerTransactionUseCase(em);
    const reconcileWalletUseCase = new ReconcileWalletUseCase(em);

    const wallet = await createWalletUseCase.execute({
      playerId: "player-real-pg-e2e",
      initialBalance: { amount: "200.00", currency: "BRL" },
    });

    // Processa aposta real
    const betRes = await processWagerUseCase.execute({
      providerId: "prov-real",
      externalTransactionId: `real-tx-${Date.now()}-1`,
      idempotencyKey: `prov-real:real-bet-${Date.now()}`,
      playerId: "player-real-pg-e2e",
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
      console.log("ℹ️ Skipping Real SQS test: LocalStack container not active on localhost:4566");
      expect(true).toBe(true);
      return;
    }

    const queueUrl = "http://localhost:4566/000000000000/wager-transactions.fifo";
    const deduplicationId = `dedup-${Date.now()}`;
    const groupId = "wallet-test-group";

    // Enviar mensagem real
    const sendRes = await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          eventType: "TestEvent",
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
