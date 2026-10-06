-- 家族关系图谱模块
-- 设计要点：只存 parent/partner/sibling 三种基础边；祖辈/叔侄等在查询时沿边推导。
-- 人物性别、家庭锚点人物用于解读人物档案里的中文称呼（「外公」「舅妈」等）。

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('unknown', 'male', 'female');

-- CreateEnum
CREATE TYPE "KinEdgeType" AS ENUM ('parent', 'partner', 'sibling');

-- CreateEnum
CREATE TYPE "KinEdgeOrigin" AS ENUM ('manual', 'inferred');

-- CreateEnum
CREATE TYPE "KinConfidence" AS ENUM ('high', 'medium', 'low');

-- CreateEnum
CREATE TYPE "KinIssueStatus" AS ENUM ('open', 'ignored', 'resolved');

-- AlterTable: 人物加性别，家庭加锚点人物
ALTER TABLE "people" ADD COLUMN "gender" "Gender" NOT NULL DEFAULT 'unknown';
ALTER TABLE "families" ADD COLUMN "kinship_anchor_person_id" TEXT;

-- CreateTable: 亲属边
CREATE TABLE "kinship_edges" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "from_person_id" TEXT NOT NULL,
    "to_person_id" TEXT NOT NULL,
    "type" "KinEdgeType" NOT NULL,
    "origin" "KinEdgeOrigin" NOT NULL DEFAULT 'manual',
    "confidence" "KinConfidence" NOT NULL DEFAULT 'high',
    "confirmed" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "evidence" JSONB,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "kinship_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable: 图谱版本快照
CREATE TABLE "kinship_versions" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "reason" TEXT,
    "snapshot" JSONB NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kinship_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable: 矛盾记录
CREATE TABLE "kinship_issues" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "edge_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "person_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" "KinIssueStatus" NOT NULL DEFAULT 'open',
    "ignored_by" TEXT,
    "ignored_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kinship_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- 只对未删除的边唯一，允许「删除后重建」同一段关系
CREATE UNIQUE INDEX "kinship_edges_from_person_id_to_person_id_type_key" ON "kinship_edges"("from_person_id", "to_person_id", "type") WHERE "deleted_at" IS NULL;
CREATE INDEX "kinship_edges_family_id_type_idx" ON "kinship_edges"("family_id", "type");
CREATE INDEX "kinship_edges_to_person_id_idx" ON "kinship_edges"("to_person_id");

CREATE UNIQUE INDEX "kinship_versions_family_id_version_key" ON "kinship_versions"("family_id", "version");
CREATE INDEX "kinship_versions_family_id_created_at_idx" ON "kinship_versions"("family_id", "created_at");

CREATE UNIQUE INDEX "kinship_issues_family_id_fingerprint_key" ON "kinship_issues"("family_id", "fingerprint");
CREATE INDEX "kinship_issues_family_id_status_idx" ON "kinship_issues"("family_id", "status");

-- AddForeignKey
ALTER TABLE "kinship_edges" ADD CONSTRAINT "kinship_edges_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "kinship_edges" ADD CONSTRAINT "kinship_edges_from_person_id_fkey" FOREIGN KEY ("from_person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "kinship_edges" ADD CONSTRAINT "kinship_edges_to_person_id_fkey" FOREIGN KEY ("to_person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "kinship_versions" ADD CONSTRAINT "kinship_versions_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "kinship_versions" ADD CONSTRAINT "kinship_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "kinship_issues" ADD CONSTRAINT "kinship_issues_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
