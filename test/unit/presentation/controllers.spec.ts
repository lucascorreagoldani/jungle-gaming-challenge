import { describe, it, expect, mock, beforeEach } from "bun:test";
import { WalletController } from "../../../src/presentation/controllers/wallet.controller";
import { WageringController } from "../../../src/presentation/controllers/wagering.controller";
import { HealthController } from "../../../src/presentation/controllers/health.controller";
import { WagerTransactionStatus } from "../../../src/domain/models/wager-transaction.entity";
import { BadRequestException, HttpStatus, NotFoundException } from "@nestjs/common";

describe("Presentation Layer Controllers Unit Tests", () => {
  describe("WalletController", () => {
    let controller: WalletController;
    let mockCreateWallet: any;
    let mockGetWallet: any;
    let mockGetLedger: any;
    let mockReconcile: any;

    beforeEach(() => {
      mockCreateWallet = {
        execute: mock(async () => ({
          id: "w-100",
          playerId: "p-100",
          balance: { amount: "100.00", currency: "BRL" },
          version: 1,
        })),
      };
      mockGetWallet = {
        execute: mock(async () => ({
          id: "w-100",
          playerId: "p-100",
          balance: { amount: "100.00", currency: "BRL" },
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
      };
      mockGetLedger = {
        execute: mock(async () => ({
          items: [],
          nextCursor: undefined,
          hasMore: false,
        })),
      };
      mockReconcile = {
        execute: mock(async () => ({
          walletId: "w-100",
          storedBalance: { amount: "100.00", currency: "BRL" },
          calculatedBalance: { amount: "100.00", currency: "BRL" },
          difference: { amount: "0.00", currency: "BRL" },
          consistent: true,
          checkedEntries: 1,
        })),
      };

      controller = new WalletController(
        mockCreateWallet,
        mockGetWallet,
        mockGetLedger,
        mockReconcile,
      );
    });

    it("should create a wallet and return created wallet data", async () => {
      const res = await controller.createWallet({
        playerId: "p-100",
        initialBalance: { amount: "100.00", currency: "BRL" },
      });

      expect(res.id).toBe("w-100");
      expect(mockCreateWallet.execute).toHaveBeenCalledTimes(1);
    });

    it("should get wallet by id", async () => {
      const res = await controller.getWallet("w-100");
      expect(res.id).toBe("w-100");
      expect(mockGetWallet.execute).toHaveBeenCalledWith("w-100");
    });

    it("should get wallet ledger with pagination parameters", async () => {
      const res = await controller.getLedger("w-100", "cursor-123", "20");
      expect(mockGetLedger.execute).toHaveBeenCalledWith("w-100", "cursor-123", 20);
      expect(res.items).toBeDefined();
    });

    it("should reconcile wallet", async () => {
      const res = await controller.reconcileWallet("w-100");
      expect(res.consistent).toBe(true);
      expect(mockReconcile.execute).toHaveBeenCalledWith("w-100");
    });
  });

  describe("WageringController", () => {
    let controller: WageringController;
    let mockProcessWager: any;
    let mockEm: any;

    beforeEach(() => {
      mockProcessWager = {
        execute: mock(async () => ({
          transactionId: "tx-200",
          status: WagerTransactionStatus.Processed,
          balance: { amount: "75.00", currency: "BRL" },
          idempotentReplay: false,
        })),
      };
      mockEm = {};
      controller = new WageringController(mockProcessWager, mockEm);
    });

    it("should return HTTP 200 OK for PROCESSED transaction", async () => {
      let capturedStatus = 0;
      let capturedJson: any = null;

      const mockRes: any = {
        status: (s: number) => {
          capturedStatus = s;
          return mockRes;
        },
        json: (j: any) => {
          capturedJson = j;
          return mockRes;
        },
      };

      await controller.submitTransaction(
        "prov-1:tx-200",
        {
          providerId: "prov-1",
          externalTransactionId: "tx-200",
          playerId: "p-1",
          walletId: "w-1",
          roundId: "r-1",
          gameId: "g-1",
          kind: "BET" as any,
          money: { amount: "25.00", currency: "BRL" },
        },
        mockRes,
      );

      expect(capturedStatus).toBe(HttpStatus.OK);
      expect(capturedJson.status).toBe(WagerTransactionStatus.Processed);
      expect(capturedJson.transactionId).toBe("tx-200");
    });

    it("should return HTTP 202 ACCEPTED for PENDING_REFERENCE transaction", async () => {
      mockProcessWager.execute = mock(async () => ({
        transactionId: "tx-pending",
        status: WagerTransactionStatus.PendingReference,
        balance: { amount: "100.00", currency: "BRL" },
        idempotentReplay: false,
      }));

      let capturedStatus = 0;
      const mockRes: any = {
        status: (s: number) => {
          capturedStatus = s;
          return mockRes;
        },
        json: () => mockRes,
      };

      await controller.submitTransaction(
        "prov-1:tx-pending",
        {
          providerId: "prov-1",
          externalTransactionId: "tx-pending",
          playerId: "p-1",
          walletId: "w-1",
          roundId: "r-1",
          gameId: "g-1",
          kind: "REFUND" as any,
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: "not-yet",
        },
        mockRes,
      );

      expect(capturedStatus).toBe(HttpStatus.ACCEPTED);
    });

    it("should return HTTP 422 UNPROCESSABLE_ENTITY for REJECTED transaction", async () => {
      mockProcessWager.execute = mock(async () => ({
        transactionId: "tx-rejected",
        status: WagerTransactionStatus.Rejected,
        balance: { amount: "10.00", currency: "BRL" },
        idempotentReplay: false,
        failureCode: "INSUFFICIENT_FUNDS",
      }));

      let capturedStatus = 0;
      let capturedJson: any = null;
      const mockRes: any = {
        status: (s: number) => {
          capturedStatus = s;
          return mockRes;
        },
        json: (j: any) => {
          capturedJson = j;
          return mockRes;
        },
      };

      await controller.submitTransaction(
        "prov-1:tx-rejected",
        {
          providerId: "prov-1",
          externalTransactionId: "tx-rejected",
          playerId: "p-1",
          walletId: "w-1",
          roundId: "r-1",
          gameId: "g-1",
          kind: "BET" as any,
          money: { amount: "100.00", currency: "BRL" },
        },
        mockRes,
      );

      expect(capturedStatus).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(capturedJson.status).toBe(WagerTransactionStatus.Rejected);
      expect(capturedJson.failureCode).toBe("INSUFFICIENT_FUNDS");
    });
  });

  describe("HealthController", () => {
    it("should return live health status", () => {
      const mockEm: any = {};
      const controller = new HealthController(mockEm);

      let capturedStatus = 0;
      let capturedJson: any = null;
      const mockRes: any = {
        status: (s: number) => {
          capturedStatus = s;
          return mockRes;
        },
        json: (j: any) => {
          capturedJson = j;
          return mockRes;
        },
      };

      controller.live(mockRes);
      expect(capturedStatus).toBe(HttpStatus.OK);
      expect(capturedJson.status).toBe("UP");
    });
  });
});
