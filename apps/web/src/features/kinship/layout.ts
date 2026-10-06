import type { KinshipGraph, KinshipKind } from '../../api/types';

export interface LaidNode {
  id: string;
  row: number;
  col: number;
}

export interface Layout {
  nodes: Map<string, LaidNode>;
  rows: number[];
  width: number;
  height: number;
}

const NODE_W = 128;
const NODE_H = 64;
const COL_GAP = 32;
const ROW_GAP = 56;

/**
 * 按「父母→子女」约束做代数分层：
 * 1. 有 parent 边时，子女行 = 父母行 + 1（多父取平均并传播，解简单线性松弛）；
 * 2. 环里放不下的边只画线不参与定层；
 * 3. 没有任何 parent 约束的连通块，退化为按出生年份相对排序；
 * 4. 同一行内按「配偶相邻、同胞相邻」的贪心序排列。
 */
export function layoutGraph(graph: KinshipGraph, opts: { showSuggested: boolean } = { showSuggested: true }): Layout {
  const people = graph.people;
  const active = graph.edges.filter(
    (e) => e.source !== 'ignored' && (opts.showSuggested || e.source !== 'suggested'),
  );

  const ids = people.map((p) => p.id);
  const birth = new Map(people.map((p) => [p.id, p.birthYear ?? null]));

  // —— 第 1 步：parent 约束传播 ——
  // row(child) = row(parent) + 1。迭代松弛，最多迭代 N 轮，环上冲突的边跳过。
  const row = new Map<string, number>();
  const parentEdges = active.filter((e) => e.kind === 'parent');
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const e of parentEdges) {
    incoming.set(e.toPersonId, [...(incoming.get(e.toPersonId) ?? []), e.fromPersonId]);
    outgoing.set(e.fromPersonId, [...(outgoing.get(e.fromPersonId) ?? []), e.toPersonId]);
  }

  // 找出没有父母的根，从根开始 BFS
  const roots = ids.filter((id) => !incoming.has(id));
  const queue: string[] = [];
  for (const r of roots) {
    row.set(r, 0);
    queue.push(r);
  }
  // 环中节点（没有根可达）按 0 起步
  for (const id of ids) if (!row.has(id)) {
    row.set(id, 0);
    queue.push(id);
  }

  const inDegree = new Map<string, number>();
  for (const id of ids) inDegree.set(id, incoming.get(id)?.filter((p) => ids.includes(p)).length ?? 0);
  const seen = new Set<string>();
  let guard = 0;
  while (queue.length && guard < ids.length * ids.length + 10) {
    guard += 1;
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    // 父母都定过层再定自己（环里永远等不齐，就不强等）
    const parents = incoming.get(cur) ?? [];
    const known = parents.filter((p) => seen.has(p));
    if (parents.length > 0 && known.length === 0) {
      queue.push(cur);
      continue;
    }
    if (known.length > 0) {
      const avg = known.reduce((s, p) => s + (row.get(p) ?? 0), 0) / known.length;
      row.set(cur, Math.max(row.get(cur) ?? -Infinity, Math.round(avg) + 1));
    }
    seen.add(cur);
    for (const child of outgoing.get(cur) ?? []) {
      if (!seen.has(child)) queue.push(child);
    }
  }
  for (const id of ids) if (!row.has(id)) row.set(id, 0);

  // —— 第 2 步：无 parent 约束时用出生年份微调同层归属 ——
  const hasParentLink = new Set<string>();
  for (const e of parentEdges) {
    hasParentLink.add(e.fromPersonId);
    hasParentLink.add(e.toPersonId);
  }
  // 计算被 parent 边覆盖人群的「年份→行」映射，未覆盖的人按相对年代挂靠
  const yearRows: number[] = [];
  for (const p of people) {
    if (hasParentLink.has(p.id) && p.birthYear != null) {
      yearRows.push(p.birthYear);
    }
  }
  if (yearRows.length >= 2) {
    yearRows.sort((a, b) => a - b);
    for (const p of people) {
      if (hasParentLink.has(p.id) || p.birthYear == null) continue;
      // 按与各层中位年份的距离归类到最接近的代
      const byRow = new Map<number, number[]>();
      for (const q of people) {
        if (q.birthYear != null && hasParentLink.has(q.id)) {
          const r = row.get(q.id)!;
          byRow.set(r, [...(byRow.get(r) ?? []), q.birthYear]);
        }
      }
      let best = row.get(p.id)!;
      let bestDist = Infinity;
      for (const [r, years] of byRow) {
        const med = years.sort((a, b) => a - b)[Math.floor(years.length / 2)]!;
        const d = Math.abs(med - p.birthYear);
        if (d < bestDist) {
          bestDist = d;
          best = r;
        }
      }
      row.set(p.id, best);
    }
  }

  // —— 第 3 步：行内排序：配偶/同胞尽量相邻 ——
  const byRow = new Map<number, string[]>();
  for (const id of ids) {
    const r = row.get(id)!;
    byRow.set(r, [...(byRow.get(r) ?? []), id]);
  }

  const spouseOf = new Map<string, Set<string>>();
  for (const e of active) {
    if (e.kind === 'spouse') addPair(spouseOf, e.fromPersonId, e.toPersonId);
  }

  const sortedRows = [...byRow.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, members] of sortedRows) {
    // 先按出生年排，再把配偶拽到旁边
    members.sort((a, b) => (birth.get(a) ?? 9999) - (birth.get(b) ?? 9999));
    for (let i = 0; i < members.length; i += 1) {
      const p = members[i]!;
      const sp = [...(spouseOf.get(p) ?? [])].find((q) => members.includes(q));
      if (sp) {
        const j = members.indexOf(sp);
        if (j > i + 1) {
          members.splice(j, 1);
          members.splice(i + 1, 0, sp);
        }
      }
    }
  }

  const nodes = new Map<string, LaidNode>();
  const rowValues = sortedRows.map(([r]) => r);
  const minRow = Math.min(...rowValues, 0);
  let maxCols = 1;
  for (const [r, members] of sortedRows) {
    maxCols = Math.max(maxCols, members.length);
    members.forEach((id, col) => nodes.set(id, { id, row: r - minRow, col }));
  }

  const rowCount = Math.max(...[...nodes.values()].map((n) => n.row), 0) + 1;

  return {
    nodes,
    rows: Array.from({ length: rowCount }, (_, i) => i + minRow),
    width: maxCols * NODE_W + (maxCols - 1) * COL_GAP + 80,
    height: rowCount * NODE_H + (rowCount - 1) * ROW_GAP + 80,
  };
}

function addPair(m: Map<string, Set<string>>, a: string, b: string) {
  if (!m.has(a)) m.set(a, new Set());
  if (!m.has(b)) m.set(b, new Set());
  m.get(a)!.add(b);
  m.get(b)!.add(a);
}

export const NODE_WIDTH = NODE_W;
export const NODE_HEIGHT = NODE_H;

export function edgeIsDirected(kind: KinshipKind): boolean {
  return kind === 'parent';
}
