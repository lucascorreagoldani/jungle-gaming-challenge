import { Money } from "../value-objects/money.vo";
import { UnbalancedLedgerEntryError } from "../errors/domain.error";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) { }

  public static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt ?? new Date(),
    );

    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError(
        `Ledger entry arithmetic error: balanceBefore (${props.balanceBefore.toString()}) ` +
        `${props.direction === LedgerDirection.Credit ? "+" : "-"} amount (${props.money.toString()}) ` +
        `does not equal balanceAfter (${props.balanceAfter.toString()})`,
      );
    }

    return entry;
  }

  public static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /**
   * balanceBefore ± money === balanceAfter. Verificada na factory.
   */
  public isBalanced(): boolean {
    if (this.direction === LedgerDirection.Credit) {
      return this.balanceBefore.add(this.money).equals(this.balanceAfter);
    } else {
      return this.balanceBefore.subtract(this.money).equals(this.balanceAfter);
    }
  }
}
