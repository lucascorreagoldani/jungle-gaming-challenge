import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import mikroOrmConfig from "../../mikro-orm.config";

const action = process.argv[2] || "up";

async function run() {
  console.log(`[migrator] initializing (action: ${action})...`);
  const orm = await MikroORM.init(mikroOrmConfig);
  try {
    if (action === "down") {
      await orm.migrator.down();
      console.log("[migrator] migration reverted successfully");
    } else {
      await orm.migrator.up();
      console.log("[migrator] migrations applied successfully");
    }
  } finally {
    await orm.close(true);
  }
}

run().catch((err) => {
  console.error("[migrator] migration failed:", err);
  process.exit(1);
});
