import { Money } from "../value-objects/money.vo";
import { CurrencyMismatchError, InsufficientFundsError } from "../errors/domain.error";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry.entity";

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  createdAt?: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) { }

  public static open(props: OpenWalletProps): Wallet {
    const now = props.createdAt ?? new Date();
    // A version inicia em 1 após a criação
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  /**
   * Reconstrução a partir da persistência, sem revalidar transições de abertura.
   */
  public static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  public get balance(): Money {
    return this._balance;
  }

  public get version(): number {
    return this._version;
  }

  public get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Aplica débito mantendo saldo e ledger consistentes entre si.
   * Lança InsufficientFundsError se o saldo for insuficiente.
   */
  public debit(
    money: Money,
    transactionId: string,
    entryId: string,
    now: Date = new Date(),
  ): WalletLedgerEntry {
    this.assertSameCurrency(money);

    if (this._balance.isLessThan(money)) {
      throw new InsufficientFundsError(this.id, this._balance.toString(), money.toString());
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.subtract(money);

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = now;

    return WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Debit,
      money,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });
  }

  /**
   * Aplica crédito mantendo saldo e ledger consistentes entre si.
   */
  public credit(
    money: Money,
    transactionId: string,
    entryId: string,
    now: Date = new Date(),
  ): WalletLedgerEntry {
    this.assertSameCurrency(money);

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.add(money);

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = now;

    return WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Credit,
      money,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(
        `Wallet currency '${this.currency}' does not match operation currency '${money.currency}'`,
      );
    }
  }
}
