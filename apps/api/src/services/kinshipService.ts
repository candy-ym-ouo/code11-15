import type { KinConfidence, KinEdgeOrigin, KinEdgeType, Prisma } from '@prisma/client';
import {
  buildInferredEdges,
  createSnapshot,
  diffSnapshots,
  edgeExists,
  inferFromItemRoles,
  KinshipEngine,
  toDot,
  toEdgesCsv,
  toGedcom,
  type GraphSnapshot,
  type ItemRoleLink,
  type KinshipGraphInput,
} from '@heirloom/shared';import { prisma } from '../db';
import { conflict, notFound } from '../http/errors';
import * as audit from './auditService';
import type { ActorMeta } from './personService';
import type { FamilyContext } from './permissionService';
import {
  issueDto,
  loadGraph,
  syncIssues,
  toKinshipEdge,
  toKinshipPerson,
  type StoredIssue,
} from './kinshipGraph';

export interface EdgeInput {
  fromPersonId: string;
  toPersonId: string;
  type: KinEdgeType;
  note?: string | null;
  confirmed?: boolean;
}

const edgeDto = (e: {
  id: string;
  familyId: string;
  fromPersonId: string;
  toPersonId: string;
  type: KinEdgeType;
  origin: KinEdgeOrigin;
  confidence: KinConfidence;
  confirmed: boolean;
  note: string | null;
  evidence: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: e.id,
  fromPersonId: e.fromPersonId,
  toPersonId: e.toPersonId,
  type: e.type,
  origin: e.origin,
  confidence: e.confidence,
  confirmed: e.confirmed,
  note: e.note,
  evidence: e.evidence,
  createdAt: e.createdAt.toISOString(),
  updatedAt: e.updatedAt.toISOString(),
});

/**
 * 建一条版本快照（在写事务内调用）。
 * 若与最近一版内容完全一致（边和人物图谱字段都没变）就跳过，
 * 避免连续小改动留下一串雷同版本；首版始终保留（哪怕是空图谱，也代表「开始时的样子」）。
 */
async function snapshotVersion(
  tx: Prisma.TransactionClient,
  familyId: string,
  createdBy: string,
  reason: string,
): Promise<number | null> {
  const [people, edges, family] = await Promise.all([
    tx.person.findMany({ where: { familyId, deletedAt: null, mergedIntoId: null } }),
    tx.kinshipEdge.findMany({ where: { familyId, deletedAt: null } }),
    tx.family.findUniqueOrThrow({ where: { id: familyId } }),
  ]);
  const snapshot = createSnapshot({
    anchorPersonId: family.kinshipAnchorPersonId,
    people: people.map(toKinshipPerson),
    edges: edges.map(toKinshipEdge),
  });

  const last = await tx.kinshipVersion.findFirst({ where: { familyId }, orderBy: { version: 'desc' } });
  if (last) {
    const prev = last.snapshot as unknown as GraphSnapshot;
    const d = diffSnapshots(prev, snapshot);
    if (d.addedEdges.length === 0 && d.removedEdges.length === 0 && d.changedPeople.length === 0) {
      return null; // 与上版相同，不留痕
    }
  }

  const version = (last?.version ?? 0) + 1;
  await tx.kinshipVersion.create({
    data: { familyId, version, reason, snapshot: snapshot as unknown as Prisma.InputJsonValue, createdBy },
  });
  return version;
}

// ---------- 查询 ----------

export async function getGraph(ctx: FamilyContext) {
  const loaded = await loadGraph(ctx.familyId);
  const engine = new KinshipEngine(loaded.input);

  // 每个人相对锚点推导出的称呼（给卡片/详情用）
  const anchorId = loaded.family.kinshipAnchorPersonId;
  const derivedTitles = new Map<string, string | null>();
  if (anchorId) {
    for (const p of loaded.people) {
      if (p.id === anchorId) {
        derivedTitles.set(p.id, '本人');
        continue;
      }
      derivedTitles.set(p.id, engine.deriveRelation(anchorId, p.id)?.title ?? null);
    }
  }

  return {
    anchorPersonId: anchorId,
    people: loaded.people.map((p) => ({
      id: p.id,
      name: p.name,
      gender: p.gender,
      relation: p.relation,
      birthYear: p.birthYear,
      deathYear: p.deathYear,
      derivedTitle: derivedTitles.get(p.id) ?? null,
    })),
    edges: loaded.edges.map(edgeDto),
  };
}

export async function listIssues(ctx: FamilyContext, includeResolved = false) {
  const loaded = await loadGraph(ctx.familyId);
  // 每次打开图谱都顺手检测一遍，保证「新录入立刻看到矛盾」
  const synced = await syncIssues(ctx.familyId, loaded.input);
  return {
    issues: synced
      .filter((i) => includeResolved || i.status !== 'resolved')
      .map(issueDto),
  };
}

// ---------- 边的增删改 ----------

async function assertPeopleInFamily(tx: Prisma.TransactionClient, familyId: string, ids: string[]) {
  const people = await tx.person.findMany({
    where: { id: { in: ids }, familyId, deletedAt: null },
  });
  if (people.length !== new Set(ids).size) throw notFound('人物不存在或已删除');
}

export async function createEdge(actorId: string, ctx: FamilyContext, input: EdgeInput, meta: ActorMeta) {
  if (input.fromPersonId === input.toPersonId) throw conflict('不能与自己建立亲属关系');
  await assertPeopleInFamily(prisma, ctx.familyId, [input.fromPersonId, input.toPersonId]);

  const created = await prisma.$transaction(async (tx) => {
    // 对称边不允许反向重复；parent 边正向重复由唯一索引兜底
    const duplicate = await tx.kinshipEdge.findFirst({
      where: {
        familyId: ctx.familyId,
        deletedAt: null,
        type: input.type,
        OR: [
          { fromPersonId: input.fromPersonId, toPersonId: input.toPersonId },
          ...(input.type === 'parent'
            ? []
            : [{ fromPersonId: input.toPersonId, toPersonId: input.fromPersonId }]),
        ],
      },
    });
    if (duplicate) throw conflict('这两个人之间已经存在相同关系');

    await snapshotVersion(tx, ctx.familyId, actorId, '校正前自动留痕');
    const edge = await tx.kinshipEdge.create({
      data: {
        familyId: ctx.familyId,
        fromPersonId: input.fromPersonId,
        toPersonId: input.toPersonId,
        type: input.type,
        origin: 'manual',
        confidence: 'high',
        confirmed: input.confirmed ?? true,
        note: input.note ?? null,
        createdBy: actorId,
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'kinship.edge.create',
        targetType: 'kinship_edge',
        targetId: edge.id,
        diff: { type: edge.type, from: edge.fromPersonId, to: edge.toPersonId } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return edge;
  });

  // 事务外做检测（避免长事务），再回写
  const loaded = await loadGraph(ctx.familyId);
  await syncIssues(ctx.familyId, loaded.input);
  return { edge: edgeDto(created) };
}

export async function updateEdge(
  actorId: string,
  ctx: FamilyContext,
  edgeId: string,
  input: { note?: string | null; confirmed?: boolean; confidence?: KinConfidence },
  meta: ActorMeta,
) {
  const before = await prisma.kinshipEdge.findFirst({ where: { id: edgeId, familyId: ctx.familyId, deletedAt: null } });
  if (!before) throw notFound('关系不存在');

  const updated = await prisma.$transaction(async (tx) => {
    await snapshotVersion(tx, ctx.familyId, actorId, '校正前自动留痕');
    const edge = await tx.kinshipEdge.update({
      where: { id: edgeId },
      data: {
        note: input.note === undefined ? undefined : input.note,
        confirmed: input.confirmed ?? undefined,
        confidence: input.confidence ?? undefined,
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'kinship.edge.update',
        targetType: 'kinship_edge',
        targetId: edgeId,
        diff: audit.diffOf(
          { confirmed: before.confirmed, confidence: before.confidence, note: before.note },
          { confirmed: edge.confirmed, confidence: edge.confidence, note: edge.note },
        ),
        ...meta,
      },
      tx,
    );
    return edge;
  });
  return { edge: edgeDto(updated) };
}

export async function deleteEdge(actorId: string, ctx: FamilyContext, edgeId: string, meta: ActorMeta) {
  const edge = await prisma.kinshipEdge.findFirst({ where: { id: edgeId, familyId: ctx.familyId, deletedAt: null } });
  if (!edge) throw notFound('关系不存在');

  await prisma.$transaction(async (tx) => {
    await snapshotVersion(tx, ctx.familyId, actorId, '删除关系前自动留痕');
    await tx.kinshipEdge.update({ where: { id: edgeId }, data: { deletedAt: new Date() } });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'kinship.edge.delete',
        targetType: 'kinship_edge',
        targetId: edgeId,
        diff: { type: edge.type, from: edge.fromPersonId, to: edge.toPersonId } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
  });
  const loaded = await loadGraph(ctx.familyId);
  await syncIssues(ctx.familyId, loaded.input);
}

// ---------- 推导 ----------

/** 预览：从人物称呼 + 物品角色能推出什么，不落库。 */
export async function previewInference(ctx: FamilyContext) {
  const loaded = await loadGraph(ctx.familyId);
  const labelResult = buildInferredEdges(loaded.input);

  // 物品角色线索（只取 inherited vs source/gifted/owner）
  const links: ItemRoleLink[] = await prisma.itemPerson.findMany({
    where: {
      item: { familyId: ctx.familyId, deletedAt: null, status: { not: 'trashed' } },
      role: { in: ['inherited', 'source', 'gifted', 'owner'] },
    },
    select: { itemId: true, personId: true, role: true },
  }).then((rows) => rows.map((r) => ({ itemId: r.itemId, personId: r.personId, role: r.role as ItemRoleLink['role'] })));
  const roleResult = inferFromItemRoles(links, loaded.input.people);

  // 已被现有边覆盖的角色线索不展示
  const roleSuggestions = roleResult.suggestions.filter(
    (s) => !edgeExists(loaded.input.edges, s.type, s.fromPersonId, s.toPersonId),
  );

  return {
    labelEdges: labelResult.edges.map((d) => ({
      ...d,
      fromName: loaded.input.people.find((p) => p.id === d.fromPersonId)?.name ?? '',
      toName: loaded.input.people.find((p) => p.id === d.toPersonId)?.name ?? '',
    })),
    roleSuggestions: roleSuggestions.map((s) => ({
      ...s,
      fromName: loaded.input.people.find((p) => p.id === s.fromPersonId)?.name ?? '',
      toName: loaded.input.people.find((p) => p.id === s.toPersonId)?.name ?? '',
    })),
    unresolved: labelResult.unresolved,
  };
}

/**
 * 采纳推导：把预览里的称呼边一次性落库（人工边不受影响，重复边跳过）。
 * 角色线索是 low confidence，默认只建「未确认」边，等用户在界面上逐条确认。
 */
export async function applyInference(
  actorId: string,
  ctx: FamilyContext,
  body: { includeRoleSuggestions?: boolean },
  meta: ActorMeta,
) {
  const preview = await previewInference(ctx);
  let createdCount = 0;

  await prisma.$transaction(async (tx) => {
    await snapshotVersion(tx, ctx.familyId, actorId, '采纳自动推导前留痕');

    for (const draft of preview.labelEdges) {
      const dup = await tx.kinshipEdge.findFirst({
        where: {
          familyId: ctx.familyId,
          deletedAt: null,
          type: draft.type,
          OR: draft.type === 'parent'
            ? [{ fromPersonId: draft.fromPersonId, toPersonId: draft.toPersonId }]
            : [
                { fromPersonId: draft.fromPersonId, toPersonId: draft.toPersonId },
                { fromPersonId: draft.toPersonId, toPersonId: draft.fromPersonId },
              ],
        },
      });
      if (dup) continue;
      await tx.kinshipEdge.create({
        data: {
          familyId: ctx.familyId,
          fromPersonId: draft.fromPersonId,
          toPersonId: draft.toPersonId,
          type: draft.type,
          origin: 'inferred',
          confidence: draft.confidence,
          confirmed: false,
          evidence: draft.evidence as unknown as Prisma.InputJsonValue,
          createdBy: actorId,
        },
      });
      createdCount += 1;
    }

    if (body.includeRoleSuggestions) {
      for (const draft of preview.roleSuggestions) {
        const dup = await tx.kinshipEdge.findFirst({
          where: {
            familyId: ctx.familyId,
            deletedAt: null,
            type: 'parent',
            fromPersonId: draft.fromPersonId,
            toPersonId: draft.toPersonId,
          },
        });
        if (dup) continue;
        await tx.kinshipEdge.create({
          data: {
            familyId: ctx.familyId,
            fromPersonId: draft.fromPersonId,
            toPersonId: draft.toPersonId,
            type: 'parent',
            origin: 'inferred',
            confidence: 'low',
            confirmed: false,
            evidence: draft.evidence as unknown as Prisma.InputJsonValue,
            createdBy: actorId,
          },
        });
        createdCount += 1;
      }
    }

    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'kinship.infer',
        targetType: 'family',
        targetId: ctx.familyId,
        diff: { createdCount, includeRoleSuggestions: Boolean(body.includeRoleSuggestions) } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
  });

  const loaded = await loadGraph(ctx.familyId);
  await syncIssues(ctx.familyId, loaded.input);
  return { createdCount };
}

// ---------- 锚点 ----------

export async function setAnchor(actorId: string, ctx: FamilyContext, personId: string | null, meta: ActorMeta) {
  if (personId) {
    const person = await prisma.person.findFirst({ where: { id: personId, familyId: ctx.familyId, deletedAt: null } });
    if (!person) throw notFound('人物不存在');
  }
  await prisma.$transaction(async (tx) => {
    await tx.family.update({ where: { id: ctx.familyId }, data: { kinshipAnchorPersonId: personId } });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'kinship.anchor',
        targetType: 'family',
        targetId: ctx.familyId,
        diff: { anchorPersonId: personId } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
  });
  const loaded = await loadGraph(ctx.familyId);
  await syncIssues(ctx.familyId, loaded.input);
  return { anchorPersonId: personId };
}

// ---------- 矛盾忽略 ----------

export async function setIssueIgnored(
  actorId: string,
  ctx: FamilyContext,
  issueId: string,
  ignore: boolean,
  meta: ActorMeta,
) {
  const issue = await prisma.kinshipIssue.findFirst({ where: { id: issueId, familyId: ctx.familyId } });
  if (!issue) throw notFound('问题不存在');
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.kinshipIssue.update({
      where: { id: issueId },
      data: ignore
        ? { status: 'ignored', ignoredBy: actorId, ignoredAt: new Date() }
        : { status: 'open', ignoredBy: null, ignoredAt: null },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'kinship.issue.ignore',
        targetType: 'kinship_issue',
        targetId: issueId,
        diff: { ignore, kind: issue.kind } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return row;
  });
  const synced: StoredIssue = {
    id: updated.id,
    kind: updated.kind as never,
    severity: updated.severity as never,
    message: updated.message,
    edgeIds: updated.edgeIds,
    personIds: updated.personIds,
    status: updated.status.toLowerCase() as StoredIssue['status'],
  };
  return { issue: issueDto(synced) };
}

// ---------- 版本 ----------

export async function listVersions(ctx: FamilyContext) {
  const rows = await prisma.kinshipVersion.findMany({
    where: { familyId: ctx.familyId },
    orderBy: { version: 'desc' },
    take: 50,
    include: { creator: { select: { displayName: true, avatarColor: true } } },
  });
  return {
    versions: rows.map((v) => ({
      id: v.id,
      version: v.version,
      reason: v.reason,
      createdAt: v.createdAt.toISOString(),
      creator: { displayName: v.creator.displayName, avatarColor: v.creator.avatarColor },
    })),
  };
}

export async function getVersion(ctx: FamilyContext, versionId: string) {
  const v = await prisma.kinshipVersion.findFirst({ where: { id: versionId, familyId: ctx.familyId } });
  if (!v) throw notFound('版本不存在');
  return { id: v.id, version: v.version, reason: v.reason, createdAt: v.createdAt.toISOString(), snapshot: v.snapshot };
}

/**
 * 回滚：读出目标版本的快照，把当前边集合整体对齐到快照：
 * - 快照里有的边（按 id）恢复/更新；快照里没有的有效边软删；
 * - 回滚本身也留一个新版本，保证「后悔了还能回来」。
 * 锚点人物也回到快照时的设置。
 */
export async function revertVersion(actorId: string, ctx: FamilyContext, versionId: string, meta: ActorMeta) {
  const target = await prisma.kinshipVersion.findFirst({ where: { id: versionId, familyId: ctx.familyId } });
  if (!target) throw notFound('版本不存在');
  const snapshot = target.snapshot as unknown as GraphSnapshot;
  if (!snapshot || snapshot.version !== 1) throw conflict('版本快照格式不支持');

  await prisma.$transaction(async (tx) => {
    const current = await tx.kinshipEdge.findMany({ where: { familyId: ctx.familyId, deletedAt: null } });
    const snapIds = new Set(snapshot.edges.map((e) => e.id));

    // 软删快照里不存在的当前边
    for (const e of current) {
      if (!snapIds.has(e.id)) {
        await tx.kinshipEdge.update({ where: { id: e.id }, data: { deletedAt: new Date() } });
      }
    }

    // 恢复快照里的边：被软删的复活并覆盖字段，存在的对齐内容
    for (const se of snapshot.edges) {
      const existing = await tx.kinshipEdge.findUnique({ where: { id: se.id } });
      const data = {
        type: se.type as KinEdgeType,
        origin: se.origin as KinEdgeOrigin,
        confidence: se.confidence as KinConfidence,
        confirmed: se.confirmed,
        note: se.note,
        evidence: se.evidence === null ? undefined : (se.evidence as Prisma.InputJsonValue),
        deletedAt: null,
      };
      if (existing) {
        await tx.kinshipEdge.update({ where: { id: se.id }, data });
      } else {
        // 边可能被硬清理过；无法按 id 复活时，按人物对重建一条
        const personOk = await tx.person.count({
          where: { id: { in: [se.fromPersonId, se.toPersonId] }, familyId: ctx.familyId, deletedAt: null },
        });
        if (personOk === 2) {
          const dup = await tx.kinshipEdge.findFirst({
            where: {
              familyId: ctx.familyId,
              deletedAt: null,
              type: se.type as KinEdgeType,
              fromPersonId: se.fromPersonId,
              toPersonId: se.toPersonId,
            },
          });
          if (!dup) {
            await tx.kinshipEdge.create({
              data: {
                familyId: ctx.familyId,
                fromPersonId: se.fromPersonId,
                toPersonId: se.toPersonId,
                type: se.type as KinEdgeType,
                origin: se.origin as KinEdgeOrigin,
                confidence: se.confidence as KinConfidence,
                confirmed: se.confirmed,
                note: se.note,
                evidence: se.evidence === null ? undefined : (se.evidence as Prisma.InputJsonValue),
                createdBy: actorId,
              },
            });
          }
        }
      }
    }

    if (snapshot.anchorPersonId) {
      const anchor = await tx.person.findFirst({ where: { id: snapshot.anchorPersonId, familyId: ctx.familyId, deletedAt: null } });
      await tx.family.update({
        where: { id: ctx.familyId },
        data: { kinshipAnchorPersonId: anchor ? snapshot.anchorPersonId : null },
      });
    } else {
      await tx.family.update({ where: { id: ctx.familyId }, data: { kinshipAnchorPersonId: null } });
    }

    // 回滚后的现状也存一个版本
    await snapshotVersion(tx, ctx.familyId, actorId, `回滚到第 ${target.version} 版后的留痕`);
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'kinship.revert',
        targetType: 'family',
        targetId: ctx.familyId,
        diff: { revertedTo: target.version } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
  });

  const loaded = await loadGraph(ctx.familyId);
  await syncIssues(ctx.familyId, loaded.input);
  return { revertedTo: target.version };
}

// ---------- 导出 ----------

export async function exportKinship(ctx: FamilyContext, format: 'gedcom' | 'dot' | 'csv', actorId: string, meta: ActorMeta) {
  const loaded = await loadGraph(ctx.familyId);
  const input: KinshipGraphInput = loaded.input;
  await audit.recordSoft({    familyId: ctx.familyId,
    actorId,
    action: 'kinship.export',
    targetType: 'family',
    targetId: ctx.familyId,
    diff: { format } as Prisma.InputJsonValue,
    ...meta,
  });
  if (format === 'gedcom') {
    return { filename: `kinship-${ctx.familyId}.ged`, contentType: 'text/x-gedcom; charset=utf-8', content: toGedcom(input, loaded.family.name) };
  }
  if (format === 'dot') {
    return { filename: `kinship-${ctx.familyId}.dot`, contentType: 'text/vnd.graphviz; charset=utf-8', content: toDot(input, `${loaded.family.name} · 家族关系图谱`) };
  }
  return { filename: `kinship-${ctx.familyId}.csv`, contentType: 'text/csv; charset=utf-8', content: toEdgesCsv(input) };
}
