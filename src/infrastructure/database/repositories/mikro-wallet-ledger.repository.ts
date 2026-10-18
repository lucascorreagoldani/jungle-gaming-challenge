import { EntityManager, QueryOrder } from "@mikro-orm/postgresql";
import {
  ILedgerPaginationResult,
  ILedgerSumResult,
  IWalletLedgerRepository,
} from "../../../domain/repositories/repository.ports";
import { LedgerDirection, WalletLedgerEntry } from "../../../domain/models/wallet-ledger-entry.entity";
import { WalletLedgerEntryOrmEntity } from "../entities/wallet-ledger-entry.orm-entity";
import { Money } from "../../../domain/value-objects/money.vo";

interface CursorData {
  createdAt: string;
  id: string;
}

export class MikroWalletLedgerRepository implements IWalletLedgerRepository {
  constructor(private readonly em: EntityManager) { }

  async save(entry: WalletLedgerEntry): Promise<void> {
    const entity = WalletLedgerEntryOrmEntity.fromDomain(entry);
    this.em.persist(entity);
  }

  async findByWalletId(
    walletId: string,
    cursor?: string,
    limit = 50,
  ): Promise<ILedgerPaginationResult> {
    const qb = this.em.createQueryBuilder(WalletLedgerEntryOrmEntity, "l");
    qb.where({ walletId });

    if (cursor) {
      try {
        const decoded: CursorData = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
        qb.andWhere({
          $or: [
            { createdAt: { $lt: new Date(decoded.createdAt) } },
            { createdAt: new Date(decoded.createdAt), id: { $lt: decoded.id } },
          ],
        });
      } catch {
        // Ignora cursor malformado e começa do início
      }
    }

    qb.orderBy({ createdAt: QueryOrder.DESC, id: QueryOrder.DESC });
    qb.limit(limit + 1);

    const entities = await qb.getResult();
    const hasMore = entities.length > limit;
    const resultEntities = hasMore ? entities.slice(0, limit) : entities;

    let nextCursor: string | undefined;
    if (hasMore && resultEntities.length > 0) {
      const last = resultEntities[resultEntities.length - 1]!;
      const cursorPayload: CursorData = {
        createdAt: last.createdAt.toISOString(),
        id: last.id,
      };
      nextCursor = Buffer.from(JSON.stringify(cursorPayload), "utf-8").toString("base64url");
    }

    return {
      entries: resultEntities.map((e) => e.toDomain()),
      nextCursor,
      hasMore,
    };
  }

  async sumByWalletId(walletId: string, currency: string): Promise<ILedgerSumResult> {
    const connection = this.em.getConnection();
    const result: Array<{
      total_credits: string | null;
      total_debits: string | null;
      total_count: string;
    }> = await connection.execute(
      `SELECT
        COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0)::text as total_credits,
        COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0)::text as total_debits,
        COUNT(*)::text as total_count
       FROM wallet_ledger_entries
       WHERE wallet_id = ?`,
      [walletId],
    );

    const row = result[0];
    const totalCreditsStr = row?.total_credits ?? "0.00";
    const totalDebitsStr = row?.total_debits ?? "0.00";
    const count = Number(row?.total_count ?? "0");

    return {
      totalCredits: Money.rehydrate(totalCreditsStr, currency),
      totalDebits: Money.rehydrate(totalDebitsStr, currency),
      count,
    };
  }
}
