import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import mikroOrmConfig from "../../mikro-orm.config";

const action = process.argv[2] || "up";

async function run() {
  console.log(`[MIKRO-ORM] Initializing programmatic migrator (action: ${action})...`);
  const orm = await MikroORM.init(mikroOrmConfig);
  try {
    if (action === "down") {
      await orm.migrator.down();
      console.log("[MIKRO-ORM] Migration reverted successfully!");
    } else {
      await orm.migrator.up();
      console.log("[MIKRO-ORM] Migrations applied successfully!");
    }
  } finally {
    await orm.close(true);
  }
}

run().catch((err) => {
  console.error("[MIKRO-ORM] Migration failed:", err);
  process.exit(1);
});
