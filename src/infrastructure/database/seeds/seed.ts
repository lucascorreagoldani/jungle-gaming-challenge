import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import mikroOrmConfig from "../../../mikro-orm.config";
import { CreateWalletUseCase } from "../../../application/use-cases/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../../application/use-cases/process-wager-transaction.use-case";
import { WagerTransactionKind } from "../../../domain/models/wager-transaction.entity";

async function runSeed() {
  console.log("[seed] initializing database seed...");
  const orm = await MikroORM.init(mikroOrmConfig);
  const em = orm.em.fork();

  const createWalletUseCase = new CreateWalletUseCase(em);
  const processWagerUseCase = new ProcessWagerTransactionUseCase(em);

  // 1. Criar Carteira Demo 1 (BRL)
  let wallet1;
  try {
    wallet1 = await createWalletUseCase.execute({
      playerId: "player-demo-brl",
      initialBalance: { amount: "1000.00", currency: "BRL" },
    });
    console.log(`[seed] wallet BRL created: ${wallet1.id}`);

    // Processa aposta de teste
    await processWagerUseCase.execute({
      providerId: "pragmatic-play",
      externalTransactionId: `seed-bet-${Date.now()}`,
      idempotencyKey: `pragmatic-play:seed-bet-${Date.now()}`,
      playerId: "player-demo-brl",
      walletId: wallet1.id,
      roundId: "seed-round-1",
      gameId: "gates-of-olympus",
      kind: WagerTransactionKind.Bet,
      money: { amount: "50.00", currency: "BRL" },
    });
    console.log(`[seed] initial BET 50.00 BRL processed for wallet: ${wallet1.id}`);
  } catch (err: any) {
    console.log(`[seed] wallet 1 notice: ${err.message}`);
  }

  // 2. Criar Carteira Demo 2 (USD)
  let wallet2;
  try {
    wallet2 = await createWalletUseCase.execute({
      playerId: "player-demo-usd",
      initialBalance: { amount: "500.00", currency: "USD" },
    });
    console.log(`[seed] wallet USD created: ${wallet2.id}`);
  } catch (err: any) {
    console.log(`[seed] wallet 2 notice: ${err.message}`);
  }

  await orm.close(true);
  console.log(`[seed] completed. Wallet BRL: ${wallet1 ? wallet1.id : "existing"}, Wallet USD: ${wallet2 ? wallet2.id : "existing"}`);
}

runSeed().catch((err) => {
  console.error("[seed] error during execution:", err);
  process.exit(1);
});
