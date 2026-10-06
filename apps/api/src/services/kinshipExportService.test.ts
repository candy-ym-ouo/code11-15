import { beforeEach, describe, expect, it, vi } from 'vitest';

// 渲染导出不应该真的连数据库：mock 掉 prisma 的读方法
vi.mock('../db', () => ({
  prisma: {
    person: { findMany: vi.fn() },
    relationship: { findMany: vi.fn() },
  },
}));

import { prisma } from '../db';
import { renderKinshipExport } from './kinshipExportService';
import type { FamilyContext } from './permissionService';

const ctx: FamilyContext = { familyId: 'fam1', role: 'admin', memberId: 'm1' };

const people = [
  { id: 'p1', name: '爸爸', relation: '爸爸', birthYear: 1955, deathYear: null, bio: null },
  { id: 'p2', name: '本人', relation: '本人', birthYear: 1985, deathYear: null, bio: null },
];
const edges = [
  {
    id: 'r1',
    familyId: 'fam1',
    fromPersonId: 'p1',
    toPersonId: 'p2',
    kind: 'parent' as const,
    label: '爸爸',
    note: null,
    source: 'manual' as const,
    basis: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    deletedAt: null,
  },
];

beforeEach(() => {
  vi.mocked(prisma.person.findMany).mockResolvedValue(people as never);
  vi.mocked(prisma.relationship.findMany).mockResolvedValue(edges as never);
});

describe('家族图谱导出', () => {
  it('JSON 包含人物与关系', async () => {
    const out = await renderKinshipExport(ctx, 'json');
    expect(out.filename).toMatch(/^kinship-.*\.json$/);
    const data = JSON.parse(out.body);
    expect(data.kind).toBe('kinship-graph');
    expect(data.people).toHaveLength(2);
    expect(data.relationships[0]).toMatchObject({ kind: 'parent', fromPersonId: 'p1', toPersonId: 'p2' });
  });

  it('CSV 含 BOM 与表头，中文不丢', async () => {
    const out = await renderKinshipExport(ctx, 'csv');
    expect(out.body.startsWith('﻿')).toBe(true);
    expect(out.body).toContain('关系ID,类型,人物A');
    expect(out.body).toContain('爸爸');
    expect(out.body).toContain('爸爸 是 本人 的父母/长辈');
  });

  it('GraphML 是合法 XML 结构，parent 边带 directed', async () => {
    const out = await renderKinshipExport(ctx, 'graphml');
    expect(out.body).toContain('<graphml');
    expect(out.body).toContain('<node id="p1"');
    expect(out.body).toMatch(/<edge[^>]*source="p1"[^>]*directed="true"/);
  });
});
