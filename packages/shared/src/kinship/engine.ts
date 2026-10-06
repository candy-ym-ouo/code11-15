/**
 * 家族关系图谱引擎（纯逻辑，无数据库、无 IO）。
 *
 * 存储模型只有三种基础边：parent（有方向）、partner、sibling（对称）。
 * 所有更远的关系（祖孙/叔侄/表亲）都在查询时沿边推导，不落地——
 * 同一事实只存一份，才不会出现「父子边删了、祖孙边还在」的鬼图。
 */
import type {
  DerivedRelation,
  EdgeType,
  KinshipEdgeData,
  KinshipGraphInput,
  KinshipIssue,
  KinshipPerson,
  PathStep,
  RelationSuggestion,
} from './types';
import { parseLabel } from './labels';

interface TraversalEdge {
  edge: KinshipEdgeData;
  /** 这一步到达的对方人物。 */
  otherId: string;
  /** 这条边相对当前人物的方向：out=当前人物是 parent 边的 from（对方是孩子），in 反之。 */
  direction: 'out' | 'in';
}

export class KinshipEngine {
  private readonly people = new Map<string, KinshipPerson>();
  private readonly adj = new Map<string, TraversalEdge[]>();

  constructor(private readonly input: KinshipGraphInput) {
    for (const person of input.people) this.people.set(person.id, person);
    for (const edge of input.edges) {
      if (!this.people.has(edge.fromPersonId) || !this.people.has(edge.toPersonId)) continue;
      this.addAdj(edge);
    }
  }

  private addAdj(edge: KinshipEdgeData) {
    const symmetric = edge.type !== 'parent';
    const push = (a: string, b: string, direction: 'out' | 'in') => {
      const list = this.adj.get(a) ?? [];
      list.push({ edge, otherId: b, direction });
      this.adj.set(a, list);
    };
    if (symmetric) {
      push(edge.fromPersonId, edge.toPersonId, 'out');
      push(edge.toPersonId, edge.fromPersonId, 'out');
    } else {
      push(edge.fromPersonId, edge.toPersonId, 'out');
      push(edge.toPersonId, edge.fromPersonId, 'in');
    }
  }

  getPerson(id: string): KinshipPerson | undefined {
    return this.people.get(id);
  }

  /** 直接相邻的边（去重：对称边在两边各出现一次，但对同一个人只返回一次）。 */
  neighbors(personId: string): TraversalEdge[] {
    const seen = new Set<string>();
    return (this.adj.get(personId) ?? []).filter((t) => {
      if (seen.has(t.edge.id)) return false;
      seen.add(t.edge.id);
      return true;
    });
  }

  /** 父母（沿 parent 边反向）。 */
  parents(personId: string): KinshipPerson[] {
    return this.neighbors(personId)
      .filter((t) => t.edge.type === 'parent' && t.direction === 'in')
      .map((t) => this.people.get(t.otherId)!)
      .filter(Boolean);
  }

  /** 子女（沿 parent 边正向）。 */
  children(personId: string): KinshipPerson[] {
    return this.neighbors(personId)
      .filter((t) => t.edge.type === 'parent' && t.direction === 'out')
      .map((t) => this.people.get(t.otherId)!)
      .filter(Boolean);
  }

  /**
   * 解析人物档案上的「关系/称呼」原文，判断从锚点出发沿该路径能否走到本人。
   * - targetKnown=true：现有图谱与称呼一致；
   * - targetKnown=false：走不到（中间人物未建档，或关系方向不对）。
   */
  suggestForPerson(person: KinshipPerson): RelationSuggestion | null {
    if (!person.relation || !this.input.anchorPersonId) return null;
    if (person.id === this.input.anchorPersonId) return null;
    const parsed = parseLabel(person.relation);
    if (!parsed) return null;

    let currentIds = [this.input.anchorPersonId];
    for (const step of parsed.path) {
      const next = new Set<string>();
      for (const id of currentIds) {
        for (const cand of this.stepFrom(id, step)) next.add(cand);
      }
      currentIds = [...next];
    }
    // 路径的最后一步必须落在本人身上，才算「图里确实有这条关系」
    const targetKnown = currentIds.includes(person.id);
    return {
      label: parsed.label,
      path: parsed.path,
      targetKnown,
      targetPersonId: targetKnown ? person.id : undefined,
      confidence: targetKnown ? 'high' : parsed.path.length === 1 ? 'medium' : 'low',
      reason: targetKnown
        ? `称呼「${parsed.label}」与现有图谱一致`
        : `称呼「${parsed.label}」对应的亲属关系尚未在图谱中补全`,
    };
  }

  /** 从某个人物出发走一步，按边类型/方向/对方性别过滤。 */
  stepFromPublic(personId: string, step: PathStep): string[] {
    return this.stepFrom(personId, step);
  }

  /**
   * 从某个人物出发走一步，按边类型/方向/对方性别过滤。
   * sibling 步除了显式的 sibling 边，还认「共享父母」：两个人有同一位父母即为兄弟姐妹，
   * 不必要求用户把同辈关系再录一遍。
   */
  private stepFrom(personId: string, step: PathStep): string[] {
    const viaEdges = this.neighbors(personId)
      .filter((t) => {
        if (t.edge.type !== step.type) return false;
        if (t.direction !== step.direction) return false;
        const other = this.people.get(t.otherId);
        if (!other) return false;
        if (step.gender !== 'unknown' && other.gender !== 'unknown' && other.gender !== step.gender) return false;
        return true;
      })
      .map((t) => t.otherId);

    if (step.type !== 'sibling') return viaEdges;

    // 隐式：沿 parent 反向找到父母，再沿 parent 正向找到其子女
    const implicit = new Set(viaEdges);
    for (const parent of this.parents(personId)) {
      for (const sibling of this.children(parent.id)) {
        if (sibling.id === personId) continue;
        if (step.gender !== 'unknown' && sibling.gender !== 'unknown' && sibling.gender !== step.gender) continue;
        implicit.add(sibling.id);
      }
    }
    return [...implicit];
  }

  /**
   * 沿称呼路径，把缺失的边「补」出来会涉及哪些人物对。
   * 逐步从锚点出发：这一步能在图里走到唯一候选就走过去；走不到时——
   * 最后一步直接连到本人，中间步骤说明中间人物未建档，用 null 占位（调用方跳过并提示）。
   */
  edgesToRealize(person: KinshipPerson): { type: EdgeType; fromId: string | null; toId: string | null; gender: KinshipPerson['gender'] }[] {
    if (!person.relation || !this.input.anchorPersonId) return [];
    const parsed = parseLabel(person.relation);
    if (!parsed) return [];

    let currentId: string | null = this.input.anchorPersonId;
    const result: { type: EdgeType; fromId: string | null; toId: string | null; gender: KinshipPerson['gender'] }[] = [];
    const isLast = (i: number) => i === parsed.path.length - 1;

    parsed.path.forEach((step, i) => {
      if (!currentId) {
        result.push({ type: step.type, fromId: null, toId: null, gender: step.gender });
        return;
      }

      // 能走通：优先复用现有的唯一候选边
      const cands = this.stepFrom(currentId, step);
      let nextId: string | null = null;
      if (cands.includes(person.id)) {
        nextId = person.id;
      } else if (cands.length === 1) {
        nextId = cands[0]!;
      } else if (isLast(i)) {
        // 最后一步：边还不存在，直接连到本人
        nextId = person.id;
      } else {
        // 中间人物缺失
        currentId = null;
        result.push({ type: step.type, fromId: null, toId: null, gender: step.gender });
        return;
      }

      // parent 边永远从「长辈」指向「晚辈」
      const fromId = step.type === 'parent' ? (step.direction === 'in' ? nextId : currentId) : currentId;
      const toId = step.type === 'parent' ? (step.direction === 'in' ? currentId : nextId) : nextId;
      result.push({ type: step.type, fromId, toId, gender: step.gender });
      currentId = nextId;
    });
    return result;
  }

  /** 与某人相邻的「步」：真实边 + 由共享父母推出的虚拟 sibling 步。供路径推导/BFS 使用。 */
  private stepNeighbors(personId: string): TraversalEdge[] {
    const result = [...this.neighbors(personId)];
    const seen = new Set(result.map((t) => t.otherId));
    const myParents = this.parents(personId);
    for (const parent of myParents) {
      for (const sib of this.children(parent.id)) {
        if (sib.id === personId || seen.has(sib.id)) continue;
        seen.add(sib.id);
        // 挂在一条真实的 parent 边下仅作溯源；展示层知道 virtual 即可
        const sourceEdge = this.adj.get(personId)?.find((t) => t.edge.type === 'parent' && t.direction === 'in')?.edge;
        if (sourceEdge) {
          result.push({ edge: { ...sourceEdge, id: `virtual:${personId}:${sib.id}`, type: 'sibling', confirmed: false, origin: 'inferred' }, otherId: sib.id, direction: 'out' });
        }
      }
    }
    return result;
  }

  /** 两点间最短路径（BFS，基础边序列；允许虚拟 sibling 步）。找不到返回 null。 */
  shortestPath(fromId: string, toId: string, maxHops = 6): { personIds: string[]; edges: KinshipEdgeData[]; directions: ('out' | 'in')[] } | null {
    if (fromId === toId) return { personIds: [fromId], edges: [], directions: [] };
    const visited = new Map<string, { prev: string; edge: KinshipEdgeData; direction: 'out' | 'in' }>();
    const queue: string[] = [fromId];
    let found = false;
    for (let depth = 0; queue.length && depth <= maxHops; depth += 1) {
      const size = queue.length;
      for (let i = 0; i < size; i += 1) {
        const cur = queue.shift()!;
        if (cur === toId) {
          found = true;
          break;
        }
        for (const t of this.stepNeighbors(cur)) {
          if (visited.has(t.otherId) || t.otherId === fromId) continue;
          visited.set(t.otherId, { prev: cur, edge: t.edge, direction: t.direction });
          queue.push(t.otherId);
        }
      }
      if (found) break;
    }
    if (!visited.has(toId) && fromId !== toId) return null;

    const personIds: string[] = [toId];
    const edges: KinshipEdgeData[] = [];
    const directions: ('out' | 'in')[] = [];
    let cur = toId;
    while (cur !== fromId) {
      const node = visited.get(cur);
      if (!node) return null;
      edges.unshift(node.edge);
      directions.unshift(node.direction);
      cur = node.prev;
      personIds.unshift(cur);
    }
    return { personIds, edges, directions };
  }

  /** 推导两个人物之间的关系（走最短路径，给中文称呼）。 */
  deriveRelation(fromId: string, toId: string): DerivedRelation | null {
    const found = this.shortestPath(fromId, toId);
    if (!found) return null;
    if (found.edges.length === 0) return { type: 'self', path: [], title: null, shortest: true };
    const path = found.edges.map((e) => e.type);
    return {
      type: classifyPath(path, found.directions),
      path,
      title: titleForPath(found.edges, found.directions, found.personIds, this.people),
      shortest: true,
    };
  }
}

/** 把边序列分类成粗粒度关系（用于统计/展示）。 */
export function classifyPath(
  path: EdgeType[],
  directions: ('out' | 'in')[],
): DerivedRelation['type'] {
  if (path.length === 1) {
    if (path[0] === 'parent') return directions[0] === 'out' ? 'child' : 'parent';
    return path[0]!;
  }
  if (path.length === 2) {
    if (path[0] === 'parent' && path[1] === 'parent') {
      return directions[0] === 'in' && directions[1] === 'in' ? 'grandparent' : 'grandchild';
    }
    // parent + sibling：先上后平=叔姑舅姨；先平后下=侄甥
    if ((path[0] === 'parent' || path[1] === 'parent') && (path[0] === 'sibling' || path[1] === 'sibling')) {
      return directions[0] === 'in' ? 'uncle_aunt' : 'nephew_niece';
    }
  }
  // 三代以内旁系：上-平-下 或 上-上-平-下-下
  if (path.includes('sibling') && path.filter((t) => t === 'parent').length >= 2) return 'cousin';
  return 'cousin';
}

/**
 * 由实际路径反推中文称呼。
 * 一/二级亲属直接给标准称呼；三级以上给泛称（表亲/长辈等），不硬造。
 * @param personIds 路径上的人物，personIds[i+1] 是第 i 步到达的人。
 */
export function titleForPath(
  edges: KinshipEdgeData[],
  directions: ('out' | 'in')[],
  personIds: string[],
  people: Map<string, KinshipPerson>,
): string | null {
  const genderAt = (stepIdx: number) => people.get(personIds[stepIdx + 1]!)?.gender ?? 'unknown';

  if (edges.length === 0) return '本人';
  if (edges.length === 1) {
    const e = edges[0]!;
    const g = genderAt(0);
    if (e.type === 'parent') return directions[0] === 'in' ? (g === 'female' ? '妈妈' : '爸爸') : g === 'female' ? '女儿' : '儿子';
    if (e.type === 'partner') return g === 'female' ? '妻子' : g === 'male' ? '丈夫' : '配偶';
    if (e.type === 'sibling') return g === 'female' ? '姐妹' : '兄弟';
  }
  if (edges.length === 2) {
    const types = edges.map((e) => e.type);
    // 祖辈 / 孙辈（genderAt(0)=父母那一代性别，决定父系/母系）
    if (types[0] === 'parent' && types[1] === 'parent' && directions[0] === 'in' && directions[1] === 'in') {
      return genderAt(1) === 'female' ? (genderAt(0) === 'female' ? '外婆' : '奶奶') : genderAt(0) === 'female' ? '外公' : '爷爷';
    }
    if (types[0] === 'parent' && types[1] === 'parent' && directions[0] === 'out' && directions[1] === 'out') {
      return genderAt(1) === 'female' ? '孙女' : '孙子';
    }
    // 叔姑舅姨：genderAt(0)=父母（女→姨/舅），genderAt(1)=平辈本人
    if (types[0] === 'parent' && types[1] === 'sibling' && directions[0] === 'in') {
      if (genderAt(1) === 'female') return genderAt(0) === 'female' ? '阿姨' : '姑姑';
      return genderAt(0) === 'female' ? '舅舅' : '伯伯/叔叔';
    }
    // 侄甥：genderAt(0)=平辈兄弟姐妹（女→外甥），genderAt(1)=孩子
    if (types[0] === 'sibling' && types[1] === 'parent' && directions[1] === 'out') {
      if (genderAt(0) === 'female') return genderAt(1) === 'female' ? '外甥女' : '外甥';
      return genderAt(1) === 'female' ? '侄女' : '侄子';
    }
  }
  // 更长的路径：区分辈分给泛称
  const ups = directions.filter((_, i) => edges[i]!.type === 'parent' && directions[i] === 'in').length;
  const downs = directions.filter((_, i) => edges[i]!.type === 'parent' && directions[i] === 'out').length;
  if (ups > downs) return '长辈';
  if (ups < downs) return '晚辈';
  return '平辈亲属';
}

export { parseLabel };
