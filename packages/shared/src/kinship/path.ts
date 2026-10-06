/**
 * 图谱上的亲属路径：在已确认的边里找两个人之间最短的连接链，
 * 用来回答「我和他是怎么连上的」。姻亲/堂表（kin）默认也可走，但权重更高。
 */
import type { KinshipEdge } from './graph';

export interface RelationPath {
  personIds: string[];
  /** 每一跳的描述，长度 = personIds.length - 1 */
  hops: { edgeId: string | null; kind: KinshipEdge['kind']; label: string | null }[];
  /** 人话版链条，如「爸爸 →（同胞）→ 叔叔」 */
  text: string;
}

const KIND_WEIGHT: Record<KinshipEdge['kind'], number> = {
  parent: 1,
  sibling: 2,
  spouse: 2,
  kin: 4,
};

export function findPath(
  edges: KinshipEdge[],
  fromId: string,
  toId: string,
  nameOf: (id: string) => string,
): RelationPath | null {
  if (fromId === toId) return { personIds: [fromId], hops: [], text: nameOf(fromId) };

  const active = edges.filter((e) => e.source !== 'ignored');
  const adj = new Map<string, { next: string; edge: KinshipEdge }[]>();
  for (const e of active) {
    add(adj, e.fromId, { next: e.toId, edge: e });
    add(adj, e.toId, { next: e.fromId, edge: e });
  }

  // Dijkstra（权重都很小，普通 BFS 循环即可）
  const dist = new Map<string, number>([[fromId, 0]]);
  const prev = new Map<string, { via: string; edge: KinshipEdge }>();
  const queue = new Set<string>([fromId]);

  while (queue.size) {
    let cur = '';
    let curDist = Infinity;
    for (const id of queue) {
      const d = dist.get(id) ?? Infinity;
      if (d < curDist) {
        cur = id;
        curDist = d;
      }
    }
    queue.delete(cur);
    if (cur === toId) break;

    for (const { next, edge } of adj.get(cur) ?? []) {
      const nd = curDist + KIND_WEIGHT[edge.kind];
      if (nd < (dist.get(next) ?? Infinity)) {
        dist.set(next, nd);
        prev.set(next, { via: cur, edge });
        queue.add(next);
      }
    }
  }

  if (!prev.has(toId)) return null;

  const personIds: string[] = [toId];
  const hops: RelationPath['hops'] = [];
  let cur = toId;
  while (cur !== fromId) {
    const step = prev.get(cur)!;
    const e = step.edge;
    const kindText =
      e.kind === 'parent'
        ? e.fromId === step.via
          ? '的子女'
          : '的父母'
        : e.kind === 'spouse'
          ? '的配偶'
          : e.kind === 'sibling'
            ? '的同胞'
            : e.label
              ? `（${e.label}）`
              : '的亲属';
    hops.unshift({ edgeId: e.id ?? null, kind: e.kind, label: kindText });
    cur = step.via;
    personIds.unshift(cur);
  }

  const text = personIds
    .map((id, i) => (i === 0 ? nameOf(id) : `${hops[i - 1]!.label}→${nameOf(id)}`))
    .join(' ');

  return { personIds, hops, text };
}

function add<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}
