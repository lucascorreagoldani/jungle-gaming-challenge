import { Decimal } from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyAmountError } from "../errors/domain.error";

export interface MoneyProps {
  amount: string;   // decimal string, ex: "25.00"
  currency: string; // ISO-4217, ex: "BRL"
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) { }

  /**
   * Factory para contratos de entrada e criação segura de Money.
   * Rejeita NaN, Infinity, notação científica, string vazia, mais de 2 casas decimais e valores negativos.
   */
  public static from(props: MoneyProps): Money {
    if (!props) {
      throw new InvalidMoneyAmountError("Money props cannot be undefined or null");
    }

    const { amount, currency } = props;

    if (!currency || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
      throw new InvalidMoneyAmountError(`Invalid ISO-4217 currency: '${currency}'`);
    }

    if (typeof amount !== "string" || amount.trim() === "") {
      throw new InvalidMoneyAmountError("Money amount must be a non-empty string");
    }

    // Valida formato rigoroso: apenas dígitos com exatamente 2 casas decimais, positivo (ex.: "0.00", "25.00", "100.50")
    const strictDecimalPattern = /^\d+\.\d{2}$/;
    if (!strictDecimalPattern.test(amount)) {
      throw new InvalidMoneyAmountError(
        `Invalid money amount format: '${amount}'. Must be a positive decimal string with exactly 2 decimal places (e.g. '25.00'). Negative values, scientific notation and more than 2 decimal places are not allowed.`,
      );
    }

    let dec: Decimal;
    try {
      dec = new Decimal(amount);
    } catch {
      throw new InvalidMoneyAmountError(`Failed to parse decimal value: '${amount}'`);
    }

    if (dec.isNaN() || !dec.isFinite()) {
      throw new InvalidMoneyAmountError(`Invalid decimal amount: '${amount}'`);
    }

    if (dec.isNegative()) {
      throw new InvalidMoneyAmountError(`Contract input money amount cannot be negative: '${amount}'`);
    }

    return new Money(dec, currency);
  }

  /**
   * Factory para reconstrução a partir do banco de dados (rehydrate).
   * Não revalida regras de contrato de entrada (permite saldo negativo caso reconstruído de snapshot histórico).
   */
  public static rehydrate(amount: string | number | Decimal, currency: string): Money {
    const dec = new Decimal(amount);
    return new Money(dec, currency);
  }

  public static zero(currency: string): Money {
    if (!currency || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
      throw new InvalidMoneyAmountError(`Invalid ISO-4217 currency: '${currency}'`);
    }
    return new Money(new Decimal(0), currency);
  }

  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  public negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  public isZero(): boolean {
    return this.value.isZero();
  }

  public isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  public isNegative(): boolean {
    return this.value.isNegative();
  }

  public isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  public isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThan(other.value);
  }

  public equals(other: Money): boolean {
    if (this.currency !== other.currency) {
      return false;
    }
    return this.value.equals(other.value);
  }

  public toJSON(): MoneyProps {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  public toString(): string {
    return this.value.toFixed(2);
  }

  public toDecimal(): Decimal {
    return this.value;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(
        `Currency mismatch: cannot operate between '${this.currency}' and '${other.currency}'`,
      );
    }
  }
}
