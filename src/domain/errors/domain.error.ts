export enum FailureCode {
  INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS",
  REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE = "REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE",
  REFERENCE_NOT_FOUND = "REFERENCE_NOT_FOUND",
  REFERENCE_ALREADY_REVERSED = "REFERENCE_ALREADY_REVERSED",
  REFERENCE_MISMATCH = "REFERENCE_MISMATCH",
  REFERENCE_INVALID_STATE = "REFERENCE_INVALID_STATE",
  INVALID_PAYLOAD = "INVALID_PAYLOAD",
  IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT",
  CURRENCY_MISMATCH = "CURRENCY_MISMATCH",
  WALLET_NOT_FOUND = "WALLET_NOT_FOUND",
  INVALID_OPERATION = "INVALID_OPERATION",
}

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: FailureCode,
  ) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WalletNotFoundError extends DomainError {
  constructor(walletId: string) {
    super(`Wallet '${walletId}' not found`, FailureCode.WALLET_NOT_FOUND);
  }
}

export class InvalidMoneyAmountError extends DomainError {
  constructor(message: string) {
    super(message, FailureCode.INVALID_PAYLOAD);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(message: string) {
    super(message, FailureCode.CURRENCY_MISMATCH);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(walletId: string, currentBalance: string, requestedAmount: string) {
    super(
      `Wallet '${walletId}' has insufficient funds (${currentBalance}) for debit (${requestedAmount})`,
      FailureCode.INSUFFICIENT_FUNDS,
    );
  }
}

export class ReversalNegativeBalanceError extends DomainError {
  constructor(walletId: string, currentBalance: string, requestedReversal: string) {
    super(
      `Reversal of '${requestedReversal}' would cause negative balance in wallet '${walletId}' (current: ${currentBalance})`,
      FailureCode.REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE,
    );
  }
}

export class ReferenceNotFoundError extends DomainError {
  constructor(referenceExternalId: string, providerId: string) {
    super(
      `Referenced transaction '${referenceExternalId}' not found for provider '${providerId}'`,
      FailureCode.REFERENCE_NOT_FOUND,
    );
  }
}

export class ReferenceMismatchError extends DomainError {
  constructor(message: string) {
    super(message, FailureCode.REFERENCE_MISMATCH);
  }
}

export class ReferenceAlreadyReversedError extends DomainError {
  constructor(referenceExternalId: string, operation: string) {
    super(
      `Referenced transaction '${referenceExternalId}' has already been reversed by a ${operation}`,
      FailureCode.REFERENCE_ALREADY_REVERSED,
    );
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(key: string) {
    super(
      `Idempotency key '${key}' was previously used with a different request payload`,
      FailureCode.IDEMPOTENCY_CONFLICT,
    );
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super(message, FailureCode.INVALID_OPERATION);
  }
}

export class UnbalancedLedgerEntryError extends DomainError {
  constructor(message: string) {
    super(message, FailureCode.INVALID_OPERATION);
  }
}
