import { Module, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { APP_GUARD, APP_FILTER } from "@nestjs/core";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { EntityManager } from "@mikro-orm/postgresql";
import mikroOrmConfig from "./mikro-orm.config";
import { WalletController } from "./presentation/controllers/wallet.controller";
import { WageringController } from "./presentation/controllers/wagering.controller";
import { HealthController } from "./presentation/controllers/health.controller";
import { MetricsController } from "./presentation/controllers/metrics.controller";
import { ProviderAuthGuard } from "./presentation/guards/auth.guard";
import { GlobalExceptionFilter } from "./presentation/filters/http-exception.filter";
import {
  CreateWalletUseCase,
  ProcessWagerTransactionUseCase,
  GetWalletUseCase,
  GetWalletLedgerUseCase,
  ReconcileWalletUseCase,
  ReprocessPendingReferencesUseCase,
} from "./application/use-cases";
import {
  createSqsClient,
  TransactionalOutboxPublisher,
  SqsWagerConsumer,
  PendingReferenceWorker,
} from "./infrastructure/messaging";
import { MetricsService } from "./infrastructure/observability/metrics.service";
import { StructuredLoggerService } from "./infrastructure/observability/structured-logger.service";
import { SQSClient } from "@aws-sdk/client-sqs";

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
  ],
  controllers: [
    WalletController,
    WageringController,
    HealthController,
    MetricsController,
  ],
  providers: [
    // Observability & Metrics
    MetricsService,
    StructuredLoggerService,

    // SQS Client
    {
      provide: SQSClient,
      useFactory: () => createSqsClient(),
    },

    // Global Guards and Filters
    {
      provide: APP_GUARD,
      useClass: ProviderAuthGuard,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },

    // Application Use Cases
    {
      provide: CreateWalletUseCase,
      useFactory: (em: EntityManager) => new CreateWalletUseCase(em),
      inject: [EntityManager],
    },
    {
      provide: ProcessWagerTransactionUseCase,
      useFactory: (
        em: EntityManager,
        metricsService: MetricsService,
        logger: StructuredLoggerService,
      ) => new ProcessWagerTransactionUseCase(em, metricsService, logger),
      inject: [EntityManager, MetricsService, StructuredLoggerService],
    },
    {
      provide: GetWalletUseCase,
      useFactory: (em: EntityManager) => new GetWalletUseCase(em),
      inject: [EntityManager],
    },
    {
      provide: GetWalletLedgerUseCase,
      useFactory: (em: EntityManager) => new GetWalletLedgerUseCase(em),
      inject: [EntityManager],
    },
    {
      provide: ReconcileWalletUseCase,
      useFactory: (em: EntityManager) => new ReconcileWalletUseCase(em),
      inject: [EntityManager],
    },
    {
      provide: ReprocessPendingReferencesUseCase,
      useFactory: (em: EntityManager) => new ReprocessPendingReferencesUseCase(em),
      inject: [EntityManager],
    },

    // Background Workers and Outbox Publisher
    {
      provide: TransactionalOutboxPublisher,
      useFactory: (
        em: EntityManager,
        sqsClient: SQSClient,
        metricsService: MetricsService,
        logger: StructuredLoggerService,
      ) => new TransactionalOutboxPublisher(em, sqsClient, undefined, metricsService, logger),
      inject: [EntityManager, SQSClient, MetricsService, StructuredLoggerService],
    },
    {
      provide: SqsWagerConsumer,
      useFactory: (sqsClient: SQSClient, useCase: ProcessWagerTransactionUseCase) =>
        new SqsWagerConsumer(sqsClient, useCase),
      inject: [SQSClient, ProcessWagerTransactionUseCase],
    },
    {
      provide: PendingReferenceWorker,
      useFactory: (useCase: ReprocessPendingReferencesUseCase) =>
        new PendingReferenceWorker(useCase),
      inject: [ReprocessPendingReferencesUseCase],
    },
  ],
})
export class AppModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly outboxPublisher: TransactionalOutboxPublisher,
    private readonly sqsConsumer: SqsWagerConsumer,
    private readonly pendingRefWorker: PendingReferenceWorker,
  ) { }

  onApplicationBootstrap() {
    // Inicia os background workers apenas se configurado
    if (process.env.DISABLE_BACKGROUND_WORKERS !== "true") {
      this.outboxPublisher.start();
      this.pendingRefWorker.start();
      this.sqsConsumer.start().catch((err) => {
        console.warn("[SQS_CONSUMER_START_NOTICE] SQS consumer not running:", err?.message || err);
      });
    }
  }

  async onApplicationShutdown() {
    this.outboxPublisher.stop();
    this.pendingRefWorker.stop();
    await this.sqsConsumer.stop();
  }
}
