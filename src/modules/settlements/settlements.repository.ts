import { PrismaClient, Settlement, SettlementStatus } from "@prisma/client";
import { prisma as defaultClient } from "../../db";

export class SettlementRepository {
	constructor(private readonly db: PrismaClient = defaultClient) {}

	/**
	 * Creates a new settlement record.
	 * @param developerId  - ID of the developer being settled
	 * @param amountUsdc   - Amount in USDC (decimal string, e.g. "100.50")
	 * @param status       - Initial status (defaults to pending)
	 */
	async create(
		developerId: string,
		amountUsdc: string,
		status: SettlementStatus = SettlementStatus.pending,
	): Promise<Settlement> {
		return this.db.settlement.create({
			data: { developerId, amountUsdc, status },
		});
	}

	/**
	 * Finds a settlement by its ID. Returns null if not found.
	 */
	async findById(id: string): Promise<Settlement | null> {
		return this.db.settlement.findUnique({ where: { id } });
	}

	/**
	 * Lists settlements for a developer with pagination.
	 * @param developerId
	 * @param limit   - Max records to return
	 * @param offset  - Records to skip
	 */
	async listByDeveloper(
		developerId: string,
		limit: number,
		offset: number,
	): Promise<Settlement[]> {
		return this.db.settlement.findMany({
			where: { developerId },
			orderBy: { createdAt: "desc" },
			take: limit,
			skip: offset,
		});
	}

	/**
	 * Updates the status of a settlement.
	 * When status is `completed`, sets completedAt and stellarTxHash.
	 * @param id       - Settlement ID
	 * @param status   - New status
	 * @param txHash   - Stellar transaction hash (required when completing)
	 */
	async updateStatus(
		id: string,
		status: SettlementStatus,
		txHash?: string,
	): Promise<Settlement> {
		if (status === SettlementStatus.completed && !txHash?.trim()) {
			throw new Error("txHash is required when status is completed");
		}

		const completedAt =
			status === SettlementStatus.completed ? new Date() : null;
		const stellarTxHash =
			status === SettlementStatus.completed ? txHash : null;

		return this.db.settlement.update({
			where: { id },
			data: { status, completedAt, stellarTxHash },
		});
	}

	/**
	 * Returns the total pending USDC amount for a developer.
	 * Returns "0" if there are no pending settlements.
	 */
	async getPendingSettlementTotal(developerId: string): Promise<string> {
		const result = await this.db.settlement.aggregate({
			where: { developerId, status: SettlementStatus.pending },
			_sum: { amountUsdc: true },
		});
		return result._sum.amountUsdc?.toString() ?? "0";
	}
}
