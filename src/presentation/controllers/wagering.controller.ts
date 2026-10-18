import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  Param,
  Res,
  HttpStatus,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import type { Response } from "express";
import { SubmitWagerTransactionDto } from "../dtos/wagering.dtos";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { WagerTransactionStatus } from "../../domain/models/wager-transaction.entity";
import { MikrowagerTransactionRepository } from "../../infrastructure/database/repositories/mikro-wager-transaction.repository";
import { EntityManager } from "@mikro-orm/postgresql";

@Controller()
export class WageringController {
  constructor(
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly em: EntityManager,
  ) { }

  @Post("wagering/transactions")
  async submitTransaction(
    @Headers("idempotency-key") idempotencyKeyHeader: string | undefined,
    @Body() dto: SubmitWagerTransactionDto,
    @Res() res: Response,
  ) {
    const idempotencyKey =
      idempotencyKeyHeader || `${dto.providerId}:${dto.externalTransactionId}`;

    if (!idempotencyKey || idempotencyKey.trim() === "") {
      throw new BadRequestException("Header 'Idempotency-Key' is required");
    }

    const result = await this.processWagerUseCase.execute({
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      idempotencyKey,
      playerId: dto.playerId,
      walletId: dto.walletId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      money: dto.money,
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
    });

    let httpStatus = HttpStatus.OK;
    if (result.status === WagerTransactionStatus.PendingReference) {
      httpStatus = HttpStatus.ACCEPTED; // 202 Accepted
    } else if (result.status === WagerTransactionStatus.Rejected) {
      httpStatus = HttpStatus.UNPROCESSABLE_ENTITY; // 422 Unprocessable Entity
    }

    return res.status(httpStatus).json({
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
      idempotentReplay: result.idempotentReplay,
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    });
  }

  @Get("wagering/transactions/:transactionId")
  async getTransactionById(@Param("transactionId") transactionId: string) {
    const txRepo = new MikrowagerTransactionRepository(this.em);
    const tx = await txRepo.findById(transactionId);
    if (!tx) {
      throw new NotFoundException(`Transaction '${transactionId}' not found`);
    }

    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      status: tx.status,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      referenceTransactionId: tx.referenceTransactionId,
      failureCode: tx.failureCode,
      createdAt: tx.createdAt.toISOString(),
      processedAt: tx.processedAt?.toISOString(),
    };
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getTransactionByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    const txRepo = new MikrowagerTransactionRepository(this.em);
    const tx = await txRepo.findByExternalId(providerId, externalTransactionId);
    if (!tx) {
      throw new NotFoundException(
        `Transaction '${externalTransactionId}' not found for provider '${providerId}'`,
      );
    }

    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      status: tx.status,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      referenceTransactionId: tx.referenceTransactionId,
      failureCode: tx.failureCode,
      createdAt: tx.createdAt.toISOString(),
      processedAt: tx.processedAt?.toISOString(),
    };
  }
}
