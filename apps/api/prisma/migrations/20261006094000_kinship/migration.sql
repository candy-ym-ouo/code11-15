-- CreateEnum
CREATE TYPE "KinshipKind" AS ENUM ('parent', 'spouse', 'sibling', 'kin');

-- CreateEnum
CREATE TYPE "KinshipSource" AS ENUM ('manual', 'derived', 'suggested', 'ignored');

-- CreateTable
CREATE TABLE "relationships" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "from_person_id" TEXT NOT NULL,
    "to_person_id" TEXT NOT NULL,
    "kind" "KinshipKind" NOT NULL,
    "label" TEXT,
    "note" TEXT,
    "source" "KinshipSource" NOT NULL DEFAULT 'manual',
    "basis" JSONB,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relationship_versions" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "snapshot" JSONB NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relationship_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "relationships_family_id_idx" ON "relationships"("family_id");

-- CreateIndex
CREATE INDEX "relationships_from_person_id_idx" ON "relationships"("from_person_id");

-- CreateIndex
CREATE INDEX "relationships_to_person_id_idx" ON "relationships"("to_person_id");

-- 部分唯一索引：同一对活人之间，同一类型的有效边只能有一条。
-- 无向类型（配偶/同胞）两端按固定顺序排列，重复插入会被数据库直接拦下。
CREATE UNIQUE INDEX "relationships_unique_directed"
    ON "relationships"("from_person_id", "to_person_id", "kind")
    WHERE "deleted_at" IS NULL AND "kind" IN ('parent', 'kin');

CREATE UNIQUE INDEX "relationships_unique_undirected"
    ON "relationships"(LEAST("from_person_id", "to_person_id"), GREATEST("from_person_id", "to_person_id"), "kind")
    WHERE "deleted_at" IS NULL AND "kind" IN ('spouse', 'sibling');

-- CreateIndex
CREATE INDEX "relationship_versions_family_id_created_at_idx"
    ON "relationship_versions"("family_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "relationship_versions_family_id_version_key"
    ON "relationship_versions"("family_id", "version");

-- AddForeignKey
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "relationships" ADD CONSTRAINT "relationships_from_person_id_fkey"
    FOREIGN KEY ("from_person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "relationships" ADD CONSTRAINT "relationships_to_person_id_fkey"
    FOREIGN KEY ("to_person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "relationship_versions" ADD CONSTRAINT "relationship_versions_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
