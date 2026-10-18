import { IsNotEmpty, IsString, Matches } from "class-validator";

export class MoneyDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d+\.\d{2}$/, {
    message: "amount must be a positive decimal string with exactly 2 decimal places (e.g. '25.00')",
  })
  amount!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z]{3}$/, {
    message: "currency must be a valid 3-letter ISO-4217 code (e.g. 'BRL')",
  })
  currency!: string;
}
