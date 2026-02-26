-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('pending', 'completed', 'failed');

-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "developerId" TEXT NOT NULL,
    "amountUsdc" DECIMAL(20,6) NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'pending',
    "stellarTxHash" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "settlements_developerId_idx" ON "settlements"("developerId");

-- CreateIndex
CREATE INDEX "settlements_status_idx" ON "settlements"("status");

