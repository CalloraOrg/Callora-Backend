import { mockDeep, DeepMockProxy } from "jest-mock-extended";
import { PrismaClient, Settlement, SettlementStatus } from "@prisma/client";
import { SettlementRepository } from "./settlements.repository";
import { Decimal } from "@prisma/client/runtime/library";

const makeSettlement = (overrides: Partial<Settlement> = {}): Settlement => ({
	id: "settle-1",
	developerId: "dev-1",
	amountUsdc: new Decimal("100.00"),
	status: SettlementStatus.pending,
	stellarTxHash: null,
	completedAt: null,
	createdAt: new Date("2024-01-01"),
	updatedAt: new Date("2024-01-01"),
	...overrides,
});

describe("SettlementRepository", () => {
	let db: DeepMockProxy<PrismaClient>;
	let repo: SettlementRepository;

	beforeEach(() => {
		db = mockDeep<PrismaClient>();
		repo = new SettlementRepository(db);
	});

	// -------------------------------------------------------------------------
	// create
	// -------------------------------------------------------------------------
	describe("create", () => {
		it("creates a settlement with default pending status", async () => {
			const s = makeSettlement();
			db.settlement.create.mockResolvedValue(s);

			const result = await repo.create("dev-1", "100.00");

			expect(db.settlement.create).toHaveBeenCalledWith({
				data: {
					developerId: "dev-1",
					amountUsdc: "100.00",
					status: SettlementStatus.pending,
				},
			});
			expect(result).toEqual(s);
		});

		it("creates a settlement with an explicit status", async () => {
			const s = makeSettlement({ status: SettlementStatus.completed });
			db.settlement.create.mockResolvedValue(s);

			await repo.create("dev-1", "50.00", SettlementStatus.completed);

			expect(db.settlement.create).toHaveBeenCalledWith({
				data: {
					developerId: "dev-1",
					amountUsdc: "50.00",
					status: SettlementStatus.completed,
				},
			});
		});

		it("propagates Prisma errors", async () => {
			db.settlement.create.mockRejectedValue(new Error("db error"));
			await expect(repo.create("dev-1", "100.00")).rejects.toThrow(
				"db error",
			);
		});
	});

	// -------------------------------------------------------------------------
	// findById
	// -------------------------------------------------------------------------
	describe("findById", () => {
		it("returns a settlement when found", async () => {
			const s = makeSettlement();
			db.settlement.findUnique.mockResolvedValue(s);

			const result = await repo.findById("settle-1");

			expect(db.settlement.findUnique).toHaveBeenCalledWith({
				where: { id: "settle-1" },
			});
			expect(result).toEqual(s);
		});

		it("returns null when not found", async () => {
			db.settlement.findUnique.mockResolvedValue(null);
			const result = await repo.findById("missing");
			expect(result).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// listByDeveloper
	// -------------------------------------------------------------------------
	describe("listByDeveloper", () => {
		it("returns paginated settlements ordered by createdAt desc", async () => {
			const settlements = [
				makeSettlement(),
				makeSettlement({ id: "settle-2" }),
			];
			db.settlement.findMany.mockResolvedValue(settlements);

			const result = await repo.listByDeveloper("dev-1", 10, 0);

			expect(db.settlement.findMany).toHaveBeenCalledWith({
				where: { developerId: "dev-1" },
				orderBy: { createdAt: "desc" },
				take: 10,
				skip: 0,
			});
			expect(result).toHaveLength(2);
		});

		it("applies limit and offset correctly", async () => {
			db.settlement.findMany.mockResolvedValue([]);
			await repo.listByDeveloper("dev-1", 5, 20);
			expect(db.settlement.findMany).toHaveBeenCalledWith(
				expect.objectContaining({ take: 5, skip: 20 }),
			);
		});

		it("returns empty array when developer has no settlements", async () => {
			db.settlement.findMany.mockResolvedValue([]);
			const result = await repo.listByDeveloper("dev-nobody", 10, 0);
			expect(result).toEqual([]);
		});
	});

	// -------------------------------------------------------------------------
	// updateStatus
	// -------------------------------------------------------------------------
	describe("updateStatus", () => {
		it("updates status to failed and clears completion metadata", async () => {
			const s = makeSettlement({ status: SettlementStatus.failed });
			db.settlement.update.mockResolvedValue(s);

			await repo.updateStatus("settle-1", SettlementStatus.failed);

			expect(db.settlement.update).toHaveBeenCalledWith({
				where: { id: "settle-1" },
				data: {
					status: SettlementStatus.failed,
					completedAt: null,
					stellarTxHash: null,
				},
			});
		});

		it("sets completedAt and stellarTxHash when completing", async () => {
			const completedAt = new Date();
			const s = makeSettlement({
				status: SettlementStatus.completed,
				stellarTxHash: "tx-abc",
				completedAt,
			});
			db.settlement.update.mockResolvedValue(s);

			await repo.updateStatus(
				"settle-1",
				SettlementStatus.completed,
				"tx-abc",
			);

			const call = db.settlement.update.mock.calls[0][0];
			expect(call.data.status).toBe(SettlementStatus.completed);
			expect(call.data.stellarTxHash).toBe("tx-abc");
			expect(call.data.completedAt).toBeInstanceOf(Date);
		});

		it("throws when completing without a txHash", async () => {
			await expect(
				repo.updateStatus("settle-1", SettlementStatus.completed),
			).rejects.toThrow("txHash is required when status is completed");
			expect(db.settlement.update).not.toHaveBeenCalled();
		});
	});

	// -------------------------------------------------------------------------
	// getPendingSettlementTotal
	// -------------------------------------------------------------------------
	describe("getPendingSettlementTotal", () => {
		it("returns the sum of pending settlements as a string", async () => {
			db.settlement.aggregate.mockResolvedValue({
				_sum: { amountUsdc: new Decimal("350.50") },
			} as any);

			const total = await repo.getPendingSettlementTotal("dev-1");

			expect(db.settlement.aggregate).toHaveBeenCalledWith({
				where: { developerId: "dev-1", status: SettlementStatus.pending },
				_sum: { amountUsdc: true },
			});
			expect(total).toBe("350.5");
		});

		it('returns "0" when there are no pending settlements', async () => {
			db.settlement.aggregate.mockResolvedValue({
				_sum: { amountUsdc: null },
			} as any);

			const total = await repo.getPendingSettlementTotal("dev-1");
			expect(total).toBe("0");
		});
	});
});
