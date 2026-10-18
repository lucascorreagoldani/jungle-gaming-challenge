import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";

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

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
  console.log(`[JUNGLE_GAMING] Distributed Wagering Processor running on http://localhost:${port}`);
}

bootstrap();
