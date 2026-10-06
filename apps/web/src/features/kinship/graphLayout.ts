import type { KinEdge, KinGraphPerson } from '../../api/types';

export interface PositionedPerson extends KinGraphPerson {
  x: number;
  y: number;
  /** 以锚点为基准的代际：0=本人/同辈，负数=长辈，正数=晚辈。 */
  generation: number;
}

export interface GraphLayout {
  people: PositionedPerson[];
  width: number;
  height: number;
  byId: Map<string, PositionedPerson>;
}

const LEVEL_GAP = 130;
const NODE_W = 118;
const NODE_H = 64;
const H_GAP = 36;

/**
 * 极简分层布局：
 * - 从锚点（无锚点则取入度为零的人物）出发沿 parent 边定代际；
 * - 同一代按姓名排序后横向排开；
 * - 走不到（只有配偶/兄弟姐妹相连）的人物放到锚点同代。
 * 不做力导向——家谱的可读性靠「长幼上下有序」，不需要物理模拟。
 */
export function layoutGraph(
  people: KinGraphPerson[],
  edges: KinEdge[],
  anchorPersonId: string | null,
): GraphLayout {
  const generation = new Map<string, number>();
  const childToParents = new Map<string, string[]>();
  const parentToChildren = new Map<string, string[]>();
  for (const e of edges) {
    if (e.type !== 'parent') continue;
    const ps = childToParents.get(e.toPersonId) ?? [];
    ps.push(e.fromPersonId);
    childToParents.set(e.toPersonId, ps);
    const cs = parentToChildren.get(e.fromPersonId) ?? [];
    cs.push(e.toPersonId);
    parentToChildren.set(e.fromPersonId, cs);
  }

  const roots = anchorPersonId && people.some((p) => p.id === anchorPersonId)
    ? [anchorPersonId]
    : people.filter((p) => (childToParents.get(p.id)?.length ?? 0) === 0).map((p) => p.id);

  // BFS：向上（父母）一代 -1，向下（子女）一代 +1
  const queue: { id: string; gen: number }[] = roots.map((id) => ({ id, gen: 0 }));
  while (queue.length) {
    const { id, gen } = queue.shift()!;
    if (generation.has(id)) continue;
    generation.set(id, gen);
    for (const parent of childToParents.get(id) ?? []) queue.push({ id: parent, gen: gen - 1 });
    for (const child of parentToChildren.get(id) ?? []) queue.push({ id: child, gen: gen + 1 });
  }
  // 与 parent 图不连通的人（只有配偶/兄弟姐妹边）放第 0 代
  for (const p of people) if (!generation.has(p.id)) generation.set(p.id, 0);

  const byGen = new Map<number, KinGraphPerson[]>();
  for (const p of people) {
    const g = generation.get(p.id) ?? 0;
    const list = byGen.get(g) ?? [];
    list.push(p);
    byGen.set(g, list);
  }

  const gens = [...byGen.keys()].sort((a, b) => a - b);
  const positioned: PositionedPerson[] = [];
  const maxCount = Math.max(1, ...[...byGen.values()].map((l) => l.length));
  const width = Math.max(720, maxCount * (NODE_W + H_GAP) + 80);

  gens.forEach((g, row) => {
    const list = [...(byGen.get(g) ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    const rowWidth = list.length * NODE_W + (list.length - 1) * H_GAP;
    const startX = (width - rowWidth) / 2;
    list.forEach((p, i) => {
      positioned.push({ ...p, x: startX + i * (NODE_W + H_GAP), y: 60 + row * LEVEL_GAP, generation: g });
    });
  });

  return {
    people: positioned,
    width,
    height: gens.length * LEVEL_GAP + 40,
    byId: new Map(positioned.map((p) => [p.id, p])),
  };
}

export const NODE_SIZE = { width: NODE_W, height: NODE_H };

/** 边的起止坐标（从节点边缘出发，简化为节点中心上下/左右连接）。 */
export function edgeEndpoints(edge: KinEdge, layout: GraphLayout) {
  const from = layout.byId.get(edge.fromPersonId);
  const to = layout.byId.get(edge.toPersonId);
  return { from, to };
}
