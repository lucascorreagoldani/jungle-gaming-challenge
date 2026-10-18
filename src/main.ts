import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";

import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Validação estrita de contratos de entrada DTO
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Habilita captura de sinais SIGTERM/SIGINT para shutdown gracioso
  app.enableShutdownHooks();

  // Documentação OpenAPI / Swagger interativa em /api/docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle("Jungle Gaming: Distributed Wagering Processor")
    .setDescription(
      "High-concurrency financial wagering processing microservice with strict idempotency, pessimistic row locking, and immutable ledger.",
    )
    .setVersion("1.0.0")
    .addApiKey(
      { type: "apiKey", name: "X-Provider-Id", in: "header" },
      "X-Provider-Id",
    )
    .addTag("Wallets", "Wallet creation, balance querying, ledger extract, and reconciliation")
    .addTag("Wagering", "Financial wager transactions (BET, WIN, LOSS, REFUND, ROLLBACK)")
    .addTag("Health", "Service health check probes")
    .addTag("Metrics", "Prometheus and JSON operational metrics")
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("api/docs", app, document);

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
  console.log(`[server] distributed wagering processor running on port ${port}`);
  console.log(`[server] swagger documentation on http://localhost:${port}/api/docs`);
}

bootstrap();
