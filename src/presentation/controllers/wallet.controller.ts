import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { CreateWalletDto } from "../dtos/wallet.dtos";
import { CreateWalletUseCase } from "../../application/use-cases/create-wallet.use-case";
import { GetWalletUseCase } from "../../application/use-cases/get-wallet.use-case";
import { GetWalletLedgerUseCase } from "../../application/use-cases/get-wallet-ledger.use-case";
import { ReconcileWalletUseCase } from "../../application/use-cases/reconcile-wallet.use-case";

@Controller("wallets")
export class WalletController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly getWalletUseCase: GetWalletUseCase,
    private readonly getWalletLedgerUseCase: GetWalletLedgerUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
  ) { }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createWallet(@Body() dto: CreateWalletDto) {
    return await this.createWalletUseCase.execute({
      playerId: dto.playerId,
      initialBalance: dto.initialBalance,
    });
  }

  @Get(":walletId")
  async getWallet(@Param("walletId") walletId: string) {
    return await this.getWalletUseCase.execute(walletId);
  }

  @Get(":walletId/ledger")
  async getLedger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 50;
    return await this.getWalletLedgerUseCase.execute(walletId, cursor, limitNum);
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  async reconcileWallet(@Param("walletId") walletId: string) {
    return await this.reconcileWalletUseCase.execute(walletId);
  }
}
