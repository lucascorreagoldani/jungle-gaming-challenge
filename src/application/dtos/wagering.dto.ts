import { MoneyProps } from "../../domain/value-objects/money.vo";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/models/wager-transaction.entity";
import { FailureCode } from "../../domain/errors/domain.error";

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface CreateWalletOutput {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface ProcessWagerTransactionInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  inboxMessageId?: string;
  consumerName?: string;
  correlationId?: string;
  causationId?: string;
}

export interface ProcessWagerTransactionOutput {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

export interface ReconciliationOutput {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}
