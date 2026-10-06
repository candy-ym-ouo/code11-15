import { KINSHIP_KIND_LABELS, type KinshipKind } from '@heirloom/shared';
import { prisma } from '../db';
import * as audit from './auditService';
import type { FamilyContext } from './permissionService';
import type { ActorMeta } from './kinshipService';

export type KinshipExportFormat = 'json' | 'csv' | 'graphml';

async function loadPeople(familyId: string) {
  return prisma.person.findMany({
    where: { familyId, deletedAt: null, mergedIntoId: null },
    select: { id: true, name: true, relation: true, birthYear: true, deathYear: true, bio: true },
    orderBy: { name: 'asc' },
  });
}

async function loadEdges(familyId: string) {
  return prisma.relationship.findMany({
    where: { familyId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
}

export async function renderKinshipExport(ctx: FamilyContext, format: KinshipExportFormat): Promise<{ filename: string; contentType: string; body: string }> {
  const [people, edges] = await Promise.all([loadPeople(ctx.familyId), loadEdges(ctx.familyId)]);
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === 'json') {
    return {
      filename: `kinship-${stamp}.json`,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(
        {
          app: '家中物品来历册',
          kind: 'kinship-graph',
          version: 1,
          exportedAt: new Date().toISOString(),
          familyId: ctx.familyId,
          people: people.map((p) => ({
            id: p.id,
            name: p.name,
            relation: p.relation,
            birthYear: p.birthYear,
            deathYear: p.deathYear,
            bio: p.bio,
          })),
          relationships: edges.map((e) => ({
            id: e.id,
            fromPersonId: e.fromPersonId,
            toPersonId: e.toPersonId,
            kind: e.kind,
            kindLabel: KINSHIP_KIND_LABELS[e.kind as KinshipKind],
            label: e.label,
            note: e.note,
            source: e.source,
            createdAt: e.createdAt.toISOString(),
          })),
        },
        null,
        2,
      ),
    };
  }

  if (format === 'csv') {
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return `"${s.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
    };
    const rows = [
      '关系ID,类型,人物A,人物A称谓,人物B,人物B称谓,方向说明,自定义称谓,来源,建立时间,备注',
      ...edges.map((e) => {
        const from = people.find((p) => p.id === e.fromPersonId);
        const to = people.find((p) => p.id === e.toPersonId);
        const direction =
          e.kind === 'parent'
            ? `${from?.name ?? e.fromPersonId} 是 ${to?.name ?? e.toPersonId} 的父母/长辈`
            : e.kind === 'spouse'
              ? '配偶（无向）'
              : e.kind === 'sibling'
                ? '同胞（无向）'
                : e.label
                  ? e.label
                  : '其他亲属（无向）';
        return [
          e.id,
          cell(KINSHIP_KIND_LABELS[e.kind as KinshipKind]),
          cell(from?.name),
          cell(from?.relation),
          cell(to?.name),
          cell(to?.relation),
          cell(direction),
          cell(e.label),
          cell({ manual: '手工', derived: '推导采纳', suggested: '待确认', ignored: '已忽略' }[e.source]),
          e.createdAt.toISOString(),
          cell(e.note),
        ].join(',');
      }),
      '',
      `# 共 ${people.length} 人、${edges.length} 条关系；导出时间 ${new Date().toISOString()}`,
    ];
    return { filename: `kinship-${stamp}.csv`, contentType: 'text/csv; charset=utf-8', body: '﻿' + rows.join('\n') };
  }

  // graphml：可直接导入 Gephi / yEd / Cytoscape
  const esc = (s: unknown) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <key id="name" for="node" attr.name="name" attr.type="string"/>',
    '  <key id="relation" for="node" attr.name="relation" attr.type="string"/>',
    '  <key id="birthYear" for="node" attr.name="birthYear" attr.type="int"/>',
    '  <key id="deathYear" for="node" attr.name="deathYear" attr.type="int"/>',
    '  <key id="kind" for="edge" attr.name="kind" attr.type="string"/>',
    '  <key id="label" for="edge" attr.name="label" attr.type="string"/>',
    '  <key id="source" for="edge" attr.name="source" attr.type="string"/>',
    `  <graph id="family" edgedefault="undirected">`,
    ...people.map(
      (p) =>
        `    <node id="${esc(p.id)}"><data key="name">${esc(p.name)}</data><data key="relation">${esc(p.relation ?? '')}</data>${p.birthYear ? `<data key="birthYear">${p.birthYear}</data>` : ''}${p.deathYear ? `<data key="deathYear">${p.deathYear}</data>` : ''}</node>`,
    ),
    ...edges.map(
      (e, i) =>
        `    <edge id="e${i}" source="${esc(e.fromPersonId)}" target="${esc(e.toPersonId)}"${e.kind === 'parent' ? ' directed="true"' : ''}><data key="kind">${esc(KINSHIP_KIND_LABELS[e.kind as KinshipKind])}</data><data key="label">${esc(e.label ?? '')}</data><data key="source">${esc(e.source)}</data></edge>`,
    ),
    '  </graph>',
    '</graphml>',
  ];
  return { filename: `kinship-${stamp}.graphml`, contentType: 'application/xml; charset=utf-8', body: lines.join('\n') };
}

export async function auditKinshipExport(actorId: string, ctx: FamilyContext, format: KinshipExportFormat, meta: ActorMeta) {
  await audit.record({
    familyId: ctx.familyId,
    actorId,
    action: 'kinship.export',
    targetType: 'relationship',
    diff: { format } as never,
    ...meta,
  });
}

