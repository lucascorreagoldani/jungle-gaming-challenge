import { describe, it, expect } from "bun:test";
import { Money } from "../../../src/domain/value-objects/money.vo";
import { CurrencyMismatchError, InvalidMoneyAmountError } from "../../../src/domain/errors/domain.error";

describe("Money Value Object", () => {
  describe("Creation and Validations", () => {
    it("should successfully create a valid Money instance", () => {
      const money = Money.from({ amount: "100.50", currency: "BRL" });
      expect(money.toString()).toBe("100.50");
      expect(money.currency).toBe("BRL");
      expect(money.toJSON()).toEqual({ amount: "100.50", currency: "BRL" });
    });

    it("should create Money.zero", () => {
      const zero = Money.zero("BRL");
      expect(zero.isZero()).toBe(true);
      expect(zero.toString()).toBe("0.00");
      expect(zero.currency).toBe("BRL");
    });

    it("should reject negative amounts in input contracts", () => {
      expect(() => Money.from({ amount: "-10.00", currency: "BRL" })).toThrow(InvalidMoneyAmountError);
    });

    it("should reject more than 2 decimal places", () => {
      expect(() => Money.from({ amount: "25.005", currency: "BRL" })).toThrow(InvalidMoneyAmountError);
      expect(() => Money.from({ amount: "0.123", currency: "BRL" })).toThrow(InvalidMoneyAmountError);
    });

    it("should reject amounts missing decimal places or integer-only format without .xx", () => {
      expect(() => Money.from({ amount: "25", currency: "BRL" })).toThrow(InvalidMoneyAmountError);
      expect(() => Money.from({ amount: "25.1", currency: "BRL" })).toThrow(InvalidMoneyAmountError);
    });

    it("should reject empty string, NaN, Infinity and scientific notation", () => {
      expect(() => Money.from({ amount: "", currency: "BRL" })).toThrow(InvalidMoneyAmountError);
      expect(() => Money.from({ amount: "NaN", currency: "BRL" })).toThrow(InvalidMoneyAmountError);
      expect(() => Money.from({ amount: "Infinity", currency: "BRL" })).toThrow(InvalidMoneyAmountError);
      expect(() => Money.from({ amount: "1e5", currency: "BRL" })).toThrow(InvalidMoneyAmountError);
      expect(() => Money.from({ amount: "1.00e2", currency: "BRL" })).toThrow(InvalidMoneyAmountError);
    });

    it("should reject invalid currency codes", () => {
      expect(() => Money.from({ amount: "10.00", currency: "BR" })).toThrow(InvalidMoneyAmountError);
      expect(() => Money.from({ amount: "10.00", currency: "BRLA" })).toThrow(InvalidMoneyAmountError);
      expect(() => Money.from({ amount: "10.00", currency: "brl" })).toThrow(InvalidMoneyAmountError);
    });
  });

  describe("Arithmetic & Comparisons", () => {
    it("should correctly add two Money instances", () => {
      const a = Money.from({ amount: "10.25", currency: "BRL" });
      const b = Money.from({ amount: "20.50", currency: "BRL" });
      const sum = a.add(b);

      expect(sum.toString()).toBe("30.75");
      // Immutability check
      expect(a.toString()).toBe("10.25");
      expect(b.toString()).toBe("20.50");
    });

    it("should correctly subtract two Money instances", () => {
      const a = Money.from({ amount: "50.00", currency: "BRL" });
      const b = Money.from({ amount: "12.25", currency: "BRL" });
      const diff = a.subtract(b);

      expect(diff.toString()).toBe("37.75");
    });

    it("should negate a Money instance", () => {
      const a = Money.from({ amount: "50.00", currency: "BRL" });
      const neg = a.negate();

      expect(neg.toString()).toBe("-50.00");
      expect(neg.isNegative()).toBe(true);
    });

    it("should compare equals and isLessThan", () => {
      const a = Money.from({ amount: "10.00", currency: "BRL" });
      const b = Money.from({ amount: "10.00", currency: "BRL" });
      const c = Money.from({ amount: "15.00", currency: "BRL" });

      expect(a.equals(b)).toBe(true);
      expect(a.equals(c)).toBe(false);
      expect(a.isLessThan(c)).toBe(true);
      expect(c.isLessThan(a)).toBe(false);
    });

    it("should throw CurrencyMismatchError when operating on different currencies", () => {
      const brl = Money.from({ amount: "10.00", currency: "BRL" });
      const usd = Money.from({ amount: "10.00", currency: "USD" });

      expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
      expect(brl.equals(usd)).toBe(false);
    });
  });
});
