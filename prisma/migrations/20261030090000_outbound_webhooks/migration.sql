-- AlterTable
ALTER TABLE "integrations" ADD COLUMN     "conditions" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "name" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "outbound_deliveries" ADD COLUMN     "duration_ms" INTEGER;

-- CreateIndex
CREATE INDEX "integrations_client_id_type_idx" ON "integrations"("client_id", "type");

-- CreateIndex
CREATE INDEX "outbound_deliveries_integration_id_created_at_idx" ON "outbound_deliveries"("integration_id", "created_at");

-- CreateIndex
CREATE INDEX "outbound_deliveries_lead_id_idx" ON "outbound_deliveries"("lead_id");

