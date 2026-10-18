import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import {
  WalletOrmEntity,
  WalletLedgerEntryOrmEntity,
  WagerTransactionOrmEntity,
  InboxMessageOrmEntity,
  OutboxMessageOrmEntity,
} from "./infrastructure/database/entities";

export default defineConfig({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || "jungle",
  password: process.env.DB_PASSWORD || "jungle_secret",
  dbName: process.env.DB_NAME || "jungle_gaming",
  entities: [
    WalletOrmEntity,
    WalletLedgerEntryOrmEntity,
    WagerTransactionOrmEntity,
    InboxMessageOrmEntity,
    OutboxMessageOrmEntity,
  ],
  extensions: [Migrator],
  migrations: {
    path: "./src/infrastructure/database/migrations",
    pathTs: "./src/infrastructure/database/migrations",
    glob: "!(*.d).{js,ts}",
    transactional: true,
    disableForeignKeys: false,
    allOrNothing: true,
    emit: "ts",
  },
  debug: process.env.NODE_ENV === "development" && process.env.DB_DEBUG === "true",
});
