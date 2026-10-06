import type { KinshipKind, KinshipSource, Prisma } from '@prisma/client';
import {
  composeChain,
  deriveChainHop,
  deriveFromAnchor,
  derivePair,
  edgeFingerprint,
  KINSHIP_KINDS,
  lookupTerm,
  splitCompound,
  type GraphPerson,
  type KinshipEdge,
} from '@heirloom/shared';
import { prisma } from '../db';
import { badRequest, conflict, notFound } from '../http/errors';
import * as audit from './auditService';
import { toRelationshipDto, toRelationshipVersionDto } from '../serializers';
import type { FamilyContext } from './permissionService';
import { detectIssues } from '@heirloom/shared';
import type { ActorMeta } from './personService';

export type { ActorMeta };

export interface RelationshipInput {
  fromPersonId: string;
  toPersonId: string;
  kind: KinshipKind;
  label?: string | null;
  note?: string | null;
  source?: Extract<KinshipSource, 'manual' | 'derived'>;
}

/** 无向边统一方向，保证 spouse/sibling 在库里始终是 id 小的一端在前。 */
function orient(kind: KinshipKind, a: string, b: string): [string, string] {
  if (kind === 'spouse' || kind === 'sibling') return [a, b].sort() as [string, string];
  return [a, b];
}

async function assertPeopleInFamily(ctx: FamilyContext, ids: string[]) {
  const uniq = [...new Set(ids)];
  const found = await prisma.person.findMany({
    where: { id: { in: uniq }, familyId: ctx.familyId, deletedAt: null },
    select: { id: true },
  });
  if (found.length !== uniq.length) throw notFound('人物不存在');
}

/** 找一对端点之间未删除、未忽略的同类型边（无向边会同时检查两个方向）。 */
async function findActiveEdge(familyId: string, kind: KinshipKind, a: string, b: string) {
  const [x, y] = orient(kind, a, b);
  const where: Prisma.RelationshipWhereInput = {
    familyId,
    deletedAt: null,
    source: { not: 'ignored' },
    kind,
    fromPersonId: x,
    toPersonId: y,
  };
  return prisma.relationship.findFirst({ where });
}

// ---------------------------------------------------------------------------
// 版本快照
// ---------------------------------------------------------------------------

interface SnapshotEdge {
  id: string;
  fromPersonId: string;
  toPersonId: string;
  kind: KinshipKind;
  label: string | null;
  note: string | null;
  source: KinshipSource;
  basis: Prisma.JsonValue | null;
  deleted: boolean;
}

async function buildSnapshot(familyId: string, db: Prisma.TransactionClient) {
  const [people, edges] = await Promise.all([
    db.person.findMany({
      where: { familyId, deletedAt: null },
      select: { id: true, name: true, relation: true, birthYear: true, deathYear: true },
    }),
    db.relationship.findMany({ where: { familyId } }),
  ]);
  return {
    at: new Date().toISOString(),
    people: people.map((p) => ({ ...p, birthYear: p.birthYear, deathYear: p.deathYear })),
    edges: edges.map<SnapshotEdge>((e) => ({
      id: e.id,
      fromPersonId: e.fromPersonId,
      toPersonId: e.toPersonId,
      kind: e.kind,
      label: e.label,
      note: e.note,
      source: e.source,
      basis: e.basis as Prisma.JsonValue | null,
      deleted: Boolean(e.deletedAt),
    })),
  };
}

type Snapshot = Awaited<ReturnType<typeof buildSnapshot>>;

/** 在事务里写一版全量快照；任何写操作都必须经过它。 */
async function recordVersion(
  tx: Prisma.TransactionClient,
  familyId: string,
  actorId: string,
  action: string,
  reason: string | null,
) {
  const last = await tx.relationshipVersion.findFirst({
    where: { familyId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const snapshot = await buildSnapshot(familyId, tx);
  return tx.relationshipVersion.create({
    data: {
      familyId,
      version: (last?.version ?? 0) + 1,
      action,
      reason,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      createdBy: actorId,
    },
  });
}

// ---------------------------------------------------------------------------
// 读：图谱
// ---------------------------------------------------------------------------

async function graphData(familyId: string) {
  const [people, edges] = await Promise.all([
    prisma.person.findMany({
      where: { familyId, deletedAt: null, mergedIntoId: null },
      select: { id: true, name: true, relation: true, birthYear: true, deathYear: true },
      orderBy: { name: 'asc' },
    }),
    prisma.relationship.findMany({
      where: { familyId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  return { people, edges };
}

export async function getGraph(ctx: FamilyContext) {
  const { people, edges } = await graphData(ctx.familyId);
  const graphPeople: GraphPerson[] = people.map((p) => ({
    id: p.id,
    name: p.name,
    relation: p.relation,
    birthYear: p.birthYear,
    deathYear: p.deathYear,
  }));
  const active = edges.filter((e) => e.source !== 'ignored');
  const suggested = edges.filter((e) => e.source === 'suggested');
  // 已落库的建议边也是图上的线，参与全部矛盾检测；inferred_conflict 仅用于未落库的实时建议
  const issues = detectIssues(graphPeople, active as unknown as KinshipEdge[], []);

  return {
    people: graphPeople,
    edges: edges.map(toRelationshipDto),
    counts: {
      people: people.length,
      edges: active.length,
      manual: active.filter((e) => e.source === 'manual').length,
      derived: active.filter((e) => e.source === 'derived').length,
      suggested: suggested.length,
      issues: issues.length,
      errors: issues.filter((i) => i.severity === 'error').length,
    },
    issues,
  };
}

// ---------------------------------------------------------------------------
// 写：手工边
// ---------------------------------------------------------------------------

export async function createEdge(actorId: string, ctx: FamilyContext, input: RelationshipInput, meta: ActorMeta) {
  if (input.fromPersonId === input.toPersonId) throw badRequest('不能把一个人与自己建立亲属关系');
  await assertPeopleInFamily(ctx, [input.fromPersonId, input.toPersonId]);

  const [fromId, toId] = orient(input.kind, input.fromPersonId, input.toPersonId);
  const existing = await findActiveEdge(ctx.familyId, input.kind, fromId, toId);
  if (existing) {
    throw conflict('这两人之间已经存在同类关系，如需修改请直接编辑原关系', { relationshipId: existing.id });
  }

  const rel = await prisma.$transaction(async (tx) => {
    // 存在「已忽略」的同形状边时不能再建（部分唯一索引会拦截），直接手工复活
    const ignored = await tx.relationship.findFirst({
      where: { familyId: ctx.familyId, deletedAt: null, source: 'ignored', kind: input.kind, fromPersonId: fromId, toPersonId: toId },
    });
    const created = ignored
      ? await tx.relationship.update({
          where: { id: ignored.id },
          data: { label: input.label ?? null, note: input.note ?? null, source: input.source ?? 'manual' },
        })
      : await tx.relationship.create({
          data: {
            familyId: ctx.familyId,
            fromPersonId: fromId,
            toPersonId: toId,
            kind: input.kind,
            label: input.label ?? null,
            note: input.note ?? null,
            source: input.source ?? 'manual',
            createdBy: actorId,
          },
        });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'kinship.edge.create',
        targetType: 'relationship',
        targetId: created.id,
        diff: { kind: created.kind, from: created.fromPersonId, to: created.toPersonId, label: created.label } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    await recordVersion(tx, ctx.familyId, actorId, 'edge.create', null);
    return created;
  });
  return toRelationshipDto(rel);
}

export async function updateEdge(
  actorId: string,
  ctx: FamilyContext,
  edgeId: string,
  patch: { kind?: KinshipKind; label?: string | null; note?: string | null; source?: KinshipSource },
  meta: ActorMeta,
) {
  const before = await prisma.relationship.findFirst({ where: { id: edgeId, familyId: ctx.familyId, deletedAt: null } });
  if (!before) throw notFound('关系不存在');

  let fromId = before.fromPersonId;
  let toId = before.toPersonId;
  const kind = patch.kind ?? before.kind;
  if (patch.kind) {
    [fromId, toId] = orient(patch.kind, before.fromPersonId, before.toPersonId);
    const dup = await prisma.relationship.findFirst({
      where: {
        id: { not: edgeId },
        familyId: ctx.familyId,
        deletedAt: null,
        source: { not: 'ignored' },
        kind,
        fromPersonId: fromId,
        toPersonId: toId,
      },
    });
    if (dup) throw conflict('改成该关系类型会与已有关系重复');
  }

  const rel = await prisma.$transaction(async (tx) => {
    const updated = await tx.relationship.update({
      where: { id: edgeId },
      data: {
        kind,
        fromPersonId: fromId,
        toPersonId: toId,
        label: patch.label === undefined ? undefined : patch.label,
        note: patch.note === undefined ? undefined : patch.note,
        source: patch.source ?? before.source,
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'kinship.edge.update',
        targetType: 'relationship',
        targetId: edgeId,
        diff: audit.diffOf(
          { kind: before.kind, label: before.label, source: before.source },
          { kind: updated.kind, label: updated.label, source: updated.source },
        ),
        ...meta,
      },
      tx,
    );
    await recordVersion(tx, ctx.familyId, actorId, 'edge.update', null);
    return updated;
  });
  return toRelationshipDto(rel);
}

export async function deleteEdge(actorId: string, ctx: FamilyContext, edgeId: string, meta: ActorMeta) {
  const before = await prisma.relationship.findFirst({ where: { id: edgeId, familyId: ctx.familyId, deletedAt: null } });
  if (!before) throw notFound('关系不存在');

  await prisma.$transaction(async (tx) => {
    await tx.relationship.update({ where: { id: edgeId }, data: { deletedAt: new Date() } });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'kinship.edge.delete',
        targetType: 'relationship',
        targetId: edgeId,
        diff: { kind: before.kind, from: before.fromPersonId, to: before.toPersonId } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    await recordVersion(tx, ctx.familyId, actorId, 'edge.delete', null);
  });
}

// ---------------------------------------------------------------------------
// 推导
// ---------------------------------------------------------------------------

interface RawSuggestion {
  edge: Omit<KinshipEdge, 'id' | 'source'>;
  confidence: number;
  reason: string;
  basis: { type: string; detail: unknown };
}

/**
 * 从物品的共现人物 + PersonRole + 称谓文本推导候选关系。
 * 纯读操作：只返回建议，不落库——用户点「采纳」前图谱不变。
 */
export async function inferSuggestions(ctx: FamilyContext): Promise<{ suggestions: unknown[]; skipped: number }> {
  const familyId = ctx.familyId;
  const people = await prisma.person.findMany({
    where: { familyId, deletedAt: null, mergedIntoId: null },
    select: { id: true, name: true, relation: true },
  });
  const personById = new Map(people.map((p) => [p.id, p]));

  // 拉全部物品的人物关联（单家庭规模下一次拿完最简单，上限 5000 条保护）
  const links = await prisma.itemPerson.findMany({
    where: { item: { familyId, deletedAt: null } },
    take: 5000,
    select: { itemId: true, personId: true, role: true, item: { select: { title: true } } },
  });

  const byItem = new Map<string, typeof links>();
  for (const l of links) {
    const arr = byItem.get(l.itemId);
    if (arr) arr.push(l);
    else byItem.set(l.itemId, [l]);
  }

  // 本人锚点：relation/name 明确写「本人/我」的人物
  const selfIds = people.filter((p) => p.relation === '本人' || p.name === '本人' || p.relation === '我').map((p) => p.id);

  const raw: RawSuggestion[] = [];
  const pushSuggestion = (s: RawSuggestion | null) => {
    if (s) raw.push(s);
  };

  // —— 物品共现两两推导 ——
  for (const [itemId, group] of byItem) {
    const title = group[0]!.item.title;
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const la = group[i]!;
        const lb = group[j]!;
        const pa = personById.get(la.personId);
        const pb = personById.get(lb.personId);
        if (!pa || !pb) continue;

        const ta = lookupTerm(pa.relation ?? pa.name);
        const tb = lookupTerm(pb.relation ?? pb.name);

        if (ta && tb) {
          const r = derivePair(pa.id, ta, pb.id, tb);
          if (r) {
            pushSuggestion({
              ...r,
              basis: {
                type: 'item_cooccur',
                detail: { itemId, itemTitle: title, termA: ta.term, termB: tb.term, roleA: la.role, roleB: lb.role },
              },
            });
          }
        }

        // 本人 ↔ 带称谓的人
        if (selfIds.includes(la.personId) && tb) {
          const r = deriveFromAnchor(la.personId, lb.personId, tb);
          if (r) {
            pushSuggestion({
              ...r,
              basis: { type: 'anchor', detail: { itemId, itemTitle: title, term: tb.term, role: lb.role } },
            });
          }
        }
        if (selfIds.includes(lb.personId) && ta) {
          const r = deriveFromAnchor(lb.personId, la.personId, ta);
          if (r) {
            pushSuggestion({
              ...r,
              basis: { type: 'anchor', detail: { itemId, itemTitle: title, term: ta.term, role: la.role } },
            });
          }
        }

        // 无称谓时的弱信号：继承/赠送角色与来源角色，只在双方都没有称谓时才用
        if (!ta && !tb) {
          const weak = roleOnlyHint(la.role, lb.role, pa.id, pb.id);
          if (weak) {
            pushSuggestion({
              ...weak,
              basis: {
                type: 'item_roles',
                detail: { itemId, itemTitle: title, roleA: la.role, roleB: lb.role },
              },
            });
          }
        }
      }
    }
  }

  // —— 复合称谓：「外公 的 弟弟」——
  for (const p of people) {
    const text = p.relation ?? p.name;
    const parts = splitCompound(text);
    if (!parts) continue;
    const chain = composeChain(parts, (s) => lookupTerm(s));
    if (!chain) continue;
    // 找与「X 的 Y」中 X 同名/同称谓的已建档人物
    const owner = people.find((q) => q.id !== p.id && (q.relation === parts[0] || q.name === parts[0]));
    if (!owner) continue;
    const tail = chain[chain.length - 1]!;
    const hop = deriveChainHop(owner.id, p.id, tail);
    if (hop) {
      pushSuggestion({
        ...hop,
        basis: { type: 'compound_term', detail: { personId: p.id, text } },
      });
    }
  }

  // 与现存有效边去重，同一指纹只保留置信度最高的一条
  const existing = await prisma.relationship.findMany({
    where: { familyId, deletedAt: null, source: { not: 'ignored' } },
    select: { fromPersonId: true, toPersonId: true, kind: true },
  });
  const have = new Set(existing.map((e) => edgeFingerprint(e.kind, e.fromPersonId, e.toPersonId)));

  const best = new Map<string, RawSuggestion>();
  let skipped = 0;
  for (const s of raw) {
    const fp = edgeFingerprint(s.edge.kind, s.edge.fromId, s.edge.toId);
    if (have.has(fp)) {
      skipped += 1;
      continue;
    }
    const cur = best.get(fp);
    if (!cur || s.confidence > cur.confidence) best.set(fp, s);
  }

  const suggestions = [...best.values()]
    .sort((a, b) => b.confidence - a.confidence)
    .map((s) => ({
      fromPersonId: s.edge.fromId,
      toPersonId: s.edge.toId,
      kind: s.edge.kind,
      label: s.edge.label,
      confidence: Math.round(s.confidence * 100) / 100,
      reason: s.reason,
      basis: s.basis,
    }));

  return { suggestions, skipped };
}

/** 没有称谓、只有条目角色时的弱信号（0.4 置信度，仅作提示）。 */
function roleOnlyHint(
  roleA: string,
  roleB: string,
  idA: string,
  idB: string,
): RawSuggestion | null {
  const inherited = new Set(['inherited', 'gifted']);
  // 同一物品上一个「继承/受赠」、一个「来源/原主」——可能是两代人，但不能断定，给 kin 弱建议
  if (
    (inherited.has(roleA) && (roleB === 'source' || roleB === 'owner')) ||
    (inherited.has(roleB) && (roleA === 'source' || roleA === 'owner'))
  ) {
    const [x, y] = [idA, idB].sort();
    return {
      edge: { fromId: x!, toId: y!, kind: 'kin', label: null },
      confidence: 0.4,
      reason: '同一物品的继承/受赠与来源角色，可能是两代亲属',
      basis: { type: 'item_roles', detail: null },
    };
  }
  return null;
}

/** 把一条推导建议落库为 suggested 边；persist=true 时直接采纳为 derived。 */
export async function persistSuggestion(
  actorId: string,
  ctx: FamilyContext,
  s: { fromPersonId: string; toPersonId: string; kind: KinshipKind; label?: string | null; basis?: unknown; confidence?: number },
  adopt: boolean,
  meta: ActorMeta,
) {
  await assertPeopleInFamily(ctx, [s.fromPersonId, s.toPersonId]);
  const [fromId, toId] = orient(s.kind, s.fromPersonId, s.toPersonId);
  const dup = await findActiveEdge(ctx.familyId, s.kind, fromId, toId);
  if (dup) throw conflict('这两人之间已有同类关系', { relationshipId: dup.id });
  if (!KINSHIP_KINDS.includes(s.kind)) throw badRequest('关系类型不合法');

  const rel = await prisma.$transaction(async (tx) => {
    // 已忽略的同形状边不新建（唯一索引会拦截），直接复活并改状态
    const ignored = await tx.relationship.findFirst({
      where: { familyId: ctx.familyId, deletedAt: null, source: 'ignored', kind: s.kind, fromPersonId: fromId, toPersonId: toId },
    });
    const created = ignored
      ? await tx.relationship.update({
          where: { id: ignored.id },
          data: {
            source: adopt ? 'derived' : 'suggested',
            label: s.label ?? ignored.label,
            basis: (s.basis ?? { confidence: s.confidence ?? null }) as Prisma.InputJsonValue,
          },
        })
      : await tx.relationship.create({
          data: {
            familyId: ctx.familyId,
            fromPersonId: fromId,
            toPersonId: toId,
            kind: s.kind,
            label: s.label ?? null,
            source: adopt ? 'derived' : 'suggested',
            basis: (s.basis ?? { confidence: s.confidence ?? null }) as Prisma.InputJsonValue,
            createdBy: actorId,
          },
        });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'kinship.edge.create',
        targetType: 'relationship',
        targetId: created.id,
        diff: { kind: created.kind, source: created.source, inferred: true } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    await recordVersion(tx, ctx.familyId, actorId, adopt ? 'infer.adopt' : 'infer.suggest', null);
    return created;
  });
  return toRelationshipDto(rel);
}

/** 批量把建议落库（infer/persist）：suggested 状态的进图谱待确认区。 */
export async function persistAllSuggestions(
  actorId: string,
  ctx: FamilyContext,
  items: Array<{ fromPersonId: string; toPersonId: string; kind: KinshipKind; label?: string | null; reason?: string; basis?: unknown; confidence?: number }>,
  adopt: boolean,
  meta: ActorMeta,
) {
  let created = 0;
  let duplicates = 0;
  await prisma.$transaction(async (tx) => {
    for (const s of items) {
      const [fromId, toId] = orient(s.kind, s.fromPersonId, s.toPersonId);
      const dup = await tx.relationship.findFirst({
        where: { familyId: ctx.familyId, deletedAt: null, source: { not: 'ignored' }, kind: s.kind, fromPersonId: fromId, toPersonId: toId },
      });
      if (dup) {
        duplicates += 1;
        continue;
      }
      // 同形状的「已忽略」边：直接复活为新状态，而不是再建一条（无向唯一索引会拦截）
      const ignored = await tx.relationship.findFirst({
        where: { familyId: ctx.familyId, deletedAt: null, source: 'ignored', kind: s.kind, fromPersonId: fromId, toPersonId: toId },
      });
      if (ignored) {
        await tx.relationship.update({
          where: { id: ignored.id },
          data: {
            source: adopt ? 'derived' : 'suggested',
            label: s.label ?? ignored.label,
            basis: (s.basis ?? { reason: s.reason, confidence: s.confidence ?? null }) as Prisma.InputJsonValue,
          },
        });
        created += 1;
        continue;
      }
      await tx.relationship.create({
        data: {
          familyId: ctx.familyId,
          fromPersonId: fromId,
          toPersonId: toId,
          kind: s.kind,
          label: s.label ?? null,
          source: adopt ? 'derived' : 'suggested',
          basis: (s.basis ?? { reason: s.reason, confidence: s.confidence ?? null }) as Prisma.InputJsonValue,
          createdBy: actorId,
        },
      });
      created += 1;
    }
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'kinship.infer',
        targetType: 'relationship',
        diff: { created, duplicates, adopted: adopt } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    if (created > 0) await recordVersion(tx, ctx.familyId, actorId, adopt ? 'infer.adopt_all' : 'infer.persist_all', null);
  });
  return { created, duplicates };
}

// ---------------------------------------------------------------------------
// 版本历史与回滚
// ---------------------------------------------------------------------------

export async function listVersions(ctx: FamilyContext) {
  const rows = await prisma.relationshipVersion.findMany({
    where: { familyId: ctx.familyId },
    orderBy: { version: 'desc' },
    take: 200,
  });
  return rows.map(toRelationshipVersionDto);
}

export async function getVersion(ctx: FamilyContext, version: number) {
  const row = await prisma.relationshipVersion.findFirst({ where: { familyId: ctx.familyId, version } });
  if (!row) throw notFound('版本不存在');
  return toRelationshipVersionDto(row);
}

/**
 * 回滚：把整个家庭的关系边集合恢复成某一版快照。
 * 快照之后新建的边软删除、删掉的边恢复、改过的字段还原；按边 id 对齐，
 * 快照里没有的 id（当版之后才出现的边）软删除。
 */
export async function rollback(actorId: string, ctx: FamilyContext, version: number, reason: string | null, meta: ActorMeta) {
  const target = await prisma.relationshipVersion.findFirst({ where: { familyId: ctx.familyId, version } });
  if (!target) throw notFound('版本不存在');
  const snapshot = target.snapshot as unknown as Snapshot;

  const stats = { restored: 0, deleted: 0, changed: 0 };

  await prisma.$transaction(async (tx) => {
    const current = await tx.relationship.findMany({ where: { familyId: ctx.familyId } });
    const byId = new Map(current.map((e) => [e.id, e]));
    const snapIds = new Set(snapshot.edges.map((e) => e.id));

    for (const s of snapshot.edges) {
      const exist = byId.get(s.id);
      if (!exist) {
        // 边被彻底物理删除（一般不会，软删都保留行）——无法恢复，跳过
        continue;
      }
      if (
        exist.deletedAt !== null ||
        exist.kind !== s.kind ||
        exist.fromPersonId !== s.fromPersonId ||
        exist.toPersonId !== s.toPersonId ||
        exist.label !== s.label ||
        exist.note !== s.note ||
        exist.source !== s.source
      ) {
        if (exist.deletedAt !== null) stats.restored += 1;
        else stats.changed += 1;
        await tx.relationship.update({
          where: { id: s.id },
          data: {
            kind: s.kind,
            fromPersonId: s.fromPersonId,
            toPersonId: s.toPersonId,
            label: s.label,
            note: s.note,
            source: s.source,
            basis: (s.basis ?? undefined) as Prisma.InputJsonValue | undefined,
            deletedAt: s.deleted ? exist.deletedAt : null,
          },
        });
      }
    }

    for (const e of current) {
      if (!snapIds.has(e.id) && !e.deletedAt) {
        await tx.relationship.update({ where: { id: e.id }, data: { deletedAt: new Date() } });
        stats.deleted += 1;
      }
    }

    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'kinship.rollback',
        targetType: 'relationship_version',
        targetId: target.id,
        diff: { toVersion: version, ...stats, reason } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    await recordVersion(tx, ctx.familyId, actorId, `rollback:v${version}`, reason);
  });

  return stats;
}
