import { createHash } from 'node:crypto';
import type { Family, KinshipEdge, Person, Prisma } from '@prisma/client';
import {
  detectIssues,
  type KinshipEdgeData,
  type KinshipGraphInput,
  type KinshipIssue,
  type KinshipPerson,
} from '@heirloom/shared';
import { prisma } from '../db';

/** 把 DB 人物映射成引擎需要的最小视图。已删除/已合并的人物不进图。 */
export function toKinshipPerson(p: Person): KinshipPerson {
  return {
    id: p.id,
    name: p.name,
    gender: p.gender.toLowerCase() as KinshipPerson['gender'],
    birthYear: p.birthYear,
    deathYear: p.deathYear,
    relation: p.relation,
  };
}

export function toKinshipEdge(e: KinshipEdge): KinshipEdgeData {
  return {
    id: e.id,
    fromPersonId: e.fromPersonId,
    toPersonId: e.toPersonId,
    type: e.type.toLowerCase() as KinshipEdgeData['type'],
    origin: e.origin.toLowerCase() as KinshipEdgeData['origin'],
    confidence: e.confidence.toLowerCase() as KinshipEdgeData['confidence'],
    confirmed: e.confirmed,
    note: e.note,
    evidence: e.evidence ?? null,
  };
}

export interface LoadedGraph {
  family: Family;
  people: Person[];
  edges: KinshipEdge[];
  input: KinshipGraphInput;
}

/** 加载一个家庭的完整图谱（人物 + 有效边 + 锚点）。 */
export async function loadGraph(familyId: string): Promise<LoadedGraph> {
  const [family, people, edges] = await Promise.all([
    prisma.family.findUniqueOrThrow({ where: { id: familyId } }),
    prisma.person.findMany({ where: { familyId, deletedAt: null, mergedIntoId: null }, orderBy: { name: 'asc' } }),
    prisma.kinshipEdge.findMany({ where: { familyId, deletedAt: null } }),
  ]);
  return {
    family,
    people,
    edges,
    input: {
      people: people.map(toKinshipPerson),
      edges: edges.map(toKinshipEdge),
      anchorPersonId: family.kinshipAnchorPersonId,
    },
  };
}

export interface StoredIssue extends KinshipIssue {
  id: string;
  status: 'open' | 'ignored' | 'resolved';
}

/** 问题指纹：同一语义的问题（边可能重建换 id）反复检测时能对上。 */
export function issueFingerprint(familyId: string, issue: KinshipIssue): string {
  const payload = [
    issue.kind,
    issue.message,
    [...issue.edgeIds].sort().join(','),
    [...issue.personIds].sort().join(','),
  ].join('|');
  return createHash('sha256').update(`${familyId}:${payload}`).digest('hex').slice(0, 32);
}

/**
 * 跑一遍矛盾检测，把结果同步进 kinship_issues：
 * - 新出现的问题插库（默认 open）；
 * - 已消失的问题标记 resolved；
 * - 被用户手动忽略的指纹保持 ignored。
 * 返回时带上数据库里的忽略状态，供接口直接展示。
 */
export async function syncIssues(familyId: string, input: KinshipGraphInput): Promise<StoredIssue[]> {
  const detected = detectIssues(input);
  const existing = await prisma.kinshipIssue.findMany({ where: { familyId } });
  const existingByFp = new Map(existing.map((i) => [i.fingerprint, i]));
  const seenFps = new Set<string>();

  for (const issue of detected) {
    const fingerprint = issueFingerprint(familyId, issue);
    seenFps.add(fingerprint);
    const row = existingByFp.get(fingerprint);
    if (row) {
      if (row.status === 'resolved') {
        // 问题重新出现，重新打开（用户手动忽略的不动）
        await prisma.kinshipIssue.update({ where: { id: row.id }, data: { status: 'open', severity: issue.severity, message: issue.message } });
      } else {
        await prisma.kinshipIssue.update({ where: { id: row.id }, data: { severity: issue.severity, message: issue.message } });
      }
    } else {
      await prisma.kinshipIssue.create({
        data: {
          familyId,
          fingerprint,
          kind: issue.kind,
          severity: issue.severity,
          message: issue.message,
          edgeIds: issue.edgeIds,
          personIds: issue.personIds,
        },
      });
    }
  }

  // 检测不到了的旧问题 → resolved（保留记录留痕）
  for (const row of existing) {
    if (!seenFps.has(row.fingerprint) && row.status === 'open') {
      await prisma.kinshipIssue.update({ where: { id: row.id }, data: { status: 'resolved' } });
    }
  }

  const rows = await prisma.kinshipIssue.findMany({ where: { familyId }, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }] });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as KinshipIssue['kind'],
    severity: r.severity as KinshipIssue['severity'],
    message: r.message,
    edgeIds: r.edgeIds,
    personIds: r.personIds,
    status: r.status.toLowerCase() as StoredIssue['status'],
  }));
}

/** 计算下一个图谱版本号。 */
export async function nextVersionNo(tx: Prisma.TransactionClient, familyId: string): Promise<number> {
  const last = await tx.kinshipVersion.findFirst({ where: { familyId }, orderBy: { version: 'desc' } });
  return (last?.version ?? 0) + 1;
}

export function issueDto(i: StoredIssue) {
  return {
    id: i.id,
    kind: i.kind,
    severity: i.severity,
    message: i.message,
    edgeIds: i.edgeIds,
    personIds: i.personIds,
    status: i.status,
  };
}
