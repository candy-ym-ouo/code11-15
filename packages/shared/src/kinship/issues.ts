/**
 * 关系图谱矛盾检测（纯逻辑）。
 *
 * 分两级：
 * - error：结构/事实硬冲突（自环、代际环、性别与称呼相反、父母比孩子小），必须处理；
 * - warning：可疑但有可能真实存在（兄弟姐妹年龄差过大、缺性别导致称呼无法落实）。
 *
 * 检测只读输入，不改图。忽略状态由数据库保存，这里只负责「此刻有哪些问题」。
 */
import type {
  KinshipEdgeData,
  KinshipGraphInput,
  KinshipIssue,
  KinshipPerson,
} from './types';
import { KinshipEngine } from './engine';
import { parseLabel } from './labels';

/** 兄弟姐妹年龄差超过这个值（岁）给 warning：不是不可能（同父异母等），但值得复核。 */
const SIBLING_MAX_GAP = 25;
/** 父母与子女最小生育年龄，小于它基本就是方向/年份录错。 */
const PARENT_MIN_AGE = 12;
/** 父母与子女合理最大生育年龄，超过给 warning。 */
const PARENT_MAX_AGE = 70;

export function detectIssues(input: KinshipGraphInput): KinshipIssue[] {
  const issues: KinshipIssue[] = [];
  const people = new Map(input.people.map((p) => [p.id, p]));
  const engine = new KinshipEngine(input);

  const push = (issue: KinshipIssue) => {
    // 完全相同的问题去重（不同检查可能同时命中）
    const key = `${issue.kind}:${issue.edgeIds.join('|')}:${issue.personIds.join('|')}`;
    if (!issues.some((i) => `${i.kind}:${i.edgeIds.join('|')}:${i.personIds.join('|')}` === key)) issues.push(issue);
  };

  for (const edge of input.edges) {
    // 1. 自环
    if (edge.fromPersonId === edge.toPersonId) {
      push({
        kind: 'self_loop',
        severity: 'error',
        message: `${nameOf(people, edge.fromPersonId)} 不能与自己建立关系`,
        edgeIds: [edge.id],
        personIds: [edge.fromPersonId],
      });
      continue;
    }
    if (!people.has(edge.fromPersonId) || !people.has(edge.toPersonId)) continue;

    // 4/5. 生卒年
    checkYears(edge, people, push);
  }

  // 2. 性别与一级称呼不符。
  //    人物的 relation 是「相对锚点」的称呼（x 是我的妈妈），所以从锚点出发沿称呼步找人，
  //    走到的人若性别与称呼相反，就是冲突。
  const anchorId = input.anchorPersonId;
  if (anchorId) {
    for (const person of input.people) {
      if (!person.relation || person.id === anchorId) continue;
      const parsed = parseLabel(person.relation);
      if (!parsed || parsed.path.length !== 1) continue;
      const want = parsed.path[0]!;
      // 人物是锚点该类型关系上的直接邻居即可（方向录反由 title_conflict/年龄检查兜底），
      // 这里只负责「称呼性别 vs 本人性别」这一个事实。
      const isNeighbor = engine.neighbors(anchorId).some((t) => t.otherId === person.id && t.edge.type === want.type);
      if (!isNeighbor) continue;
      if (want.gender !== 'unknown' && person.gender !== 'unknown' && person.gender !== want.gender) {
        const edgeInvolved = engine.neighbors(anchorId).find((t) => t.otherId === person.id && t.edge.type === want.type);
        push({
          kind: 'gender_mismatch',
          severity: 'error',
          message: `${person.name} 的称呼「${person.relation}」应为${want.gender === 'female' ? '女性' : '男性'}，但登记为${person.gender === 'female' ? '女性' : '男性'}`,
          edgeIds: edgeInvolved ? [edgeInvolved.edge.id] : [],
          personIds: [anchorId, person.id],
        });
      }
    }
  }

  // 3. parent 边环检测（自己是自己的祖先）。
  //    partner/sibling 成环不算错（本就允许多配偶），只查 parent 有向图。
  checkParentCycle(input.edges, people, push);

  // 6. 同一对人之间存在多条同类型边（对称边正反向也算重复）
  checkDuplicateEdges(input.edges, people, push);

  // 7. 人物称呼 vs 图谱推导
  checkTitleConflicts(input, engine, people, push);

  return issues;
}

function nameOf(people: Map<string, KinshipPerson>, id: string): string {
  return people.get(id)?.name ?? '未知人物';
}

function checkYears(edge: KinshipEdgeData, people: Map<string, KinshipPerson>, push: (i: KinshipIssue) => void) {
  for (const person of [people.get(edge.fromPersonId), people.get(edge.toPersonId)]) {
    if (person?.birthYear != null && person.deathYear != null && person.deathYear < person.birthYear) {
      push({
        kind: 'death_before_birth',
        severity: 'error',
        message: `${person.name} 去世年份（${person.deathYear}）早于出生年份（${person.birthYear}）`,
        edgeIds: [edge.id],
        personIds: [person.id],
      });
    }
  }

  if (edge.type === 'parent') {
    const parent = people.get(edge.fromPersonId);
    const child = people.get(edge.toPersonId);
    if (parent?.birthYear != null && child?.birthYear != null) {
      const gap = child.birthYear - parent.birthYear;
      if (gap < PARENT_MIN_AGE) {
        push({
          kind: 'age_reversed',
          severity: 'error',
          message: `${parent.name}（${parent.birthYear} 生）比孩子 ${child.name}（${child.birthYear} 生）只大 ${gap} 岁，父母子女关系可能录反了`,
          edgeIds: [edge.id],
          personIds: [parent.id, child.id],
        });
      } else if (gap > PARENT_MAX_AGE) {
        push({
          kind: 'age_reversed',
          severity: 'warning',
          message: `${parent.name} 生 ${child.name} 时已 ${gap} 岁，请确认年份或关系是否有误`,
          edgeIds: [edge.id],
          personIds: [parent.id, child.id],
        });
      }
    }
  }

  if (edge.type === 'sibling') {
    const a = people.get(edge.fromPersonId);
    const b = people.get(edge.toPersonId);
    if (a?.birthYear != null && b?.birthYear != null && Math.abs(a.birthYear - b.birthYear) > SIBLING_MAX_GAP) {
      push({
        kind: 'sibling_age_gap',
        severity: 'warning',
        message: `${a.name} 与 ${b.name} 相差 ${Math.abs(a.birthYear - b.birthYear)} 岁，却记为兄弟姐妹，请复核`,
        edgeIds: [edge.id],
        personIds: [a.id, b.id],
      });
    }
  }
}

/** parent 有向图上的环：DFS 找回边。环里的边都列出来。 */
function checkParentCycle(
  edges: KinshipEdgeData[],
  people: Map<string, KinshipPerson>,
  push: (i: KinshipIssue) => void,
) {
  const parentEdges = edges.filter((e) => e.type === 'parent' && e.fromPersonId !== e.toPersonId);
  const outgoing = new Map<string, string[]>();
  const edgeById = new Map(parentEdges.map((e) => [e.id, e]));
  for (const e of parentEdges) {
    const list = outgoing.get(e.fromPersonId) ?? [];
    list.push(e.toPersonId);
    outgoing.set(e.fromPersonId, list);
  }

  const state = new Map<string, 0 | 1 | 2>(); // 0=未访问 1=在栈上 2=完成
  const stackEdges: string[] = [];
  const reportedCycles = new Set<string>();

  const visit = (node: string): void => {
    state.set(node, 1);
    for (const childId of outgoing.get(node) ?? []) {
      const edge = parentEdges.find((e) => e.fromPersonId === node && e.toPersonId === childId);
      if (!edge) continue;
      stackEdges.push(edge.id);
      const childState = state.get(childId) ?? 0;
      if (childState === 1) {
        // 找到环：从栈里截取
        const cycleEdgeIds: string[] = [edge.id];
        for (let i = stackEdges.length - 2; i >= 0; i -= 1) {
          cycleEdgeIds.unshift(stackEdges[i]!);
          const e = edgeById.get(stackEdges[i]!);
          if (e?.fromPersonId === childId) break;
        }
        const key = [...cycleEdgeIds].sort().join('|');
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          const personIds = [...new Set(cycleEdgeIds.flatMap((id) => [edgeById.get(id)?.fromPersonId, edgeById.get(id)?.toPersonId].filter(Boolean) as string[]))];
          push({
            kind: 'cycle',
            severity: 'error',
            message: `代际关系出现循环：${personIds.map((id) => nameOf(people, id)).join(' → ')}，有人同时是自己的祖先`,
            edgeIds: cycleEdgeIds,
            personIds,
          });
        }
      } else if (childState === 0) {
        visit(childId);
      }
      stackEdges.pop();
    }
    state.set(node, 2);
  };

  for (const id of people.keys()) {
    if ((state.get(id) ?? 0) === 0) visit(id);
  }
}

/** 同一对人之间重复的同类型边。父母边正反向重复同时意味着代际冲突。 */
function checkDuplicateEdges(edges: KinshipEdgeData[], people: Map<string, KinshipPerson>, push: (i: KinshipIssue) => void) {
  const seen = new Map<string, KinshipEdgeData[]>();
  for (const edge of edges) {
    if (edge.fromPersonId === edge.toPersonId) continue;
    const key = `${edge.type}:${[edge.fromPersonId, edge.toPersonId].sort().join('|')}`;
    const list = seen.get(key) ?? [];
    list.push(edge);
    seen.set(key, list);
  }
  for (const [, list] of seen) {
    if (list.length < 2) continue;
    const kinds = new Set(list.map((e) => `${e.fromPersonId}>${e.toPersonId}`));
    const conflict = list[0]!.type === 'parent' && kinds.size > 1;
    push({
      kind: conflict ? 'duplicate_parent_conflict' : 'duplicate_edge',
      severity: conflict ? 'error' : 'warning',
      message: conflict
        ? `${nameOf(people, list[0]!.fromPersonId)} 与 ${nameOf(people, list[0]!.toPersonId)} 之间同时存在两个方向的父母关系`
        : `${nameOf(people, list[0]!.fromPersonId)} 与 ${nameOf(people, list[0]!.toPersonId)} 之间有重复的关系记录`,
      edgeIds: list.map((e) => e.id),
      personIds: [list[0]!.fromPersonId, list[0]!.toPersonId],
    });
  }
}

/**
 * 人物档案上的称呼 vs 图谱实际路径（相对锚点）。
 * 例如档案写「外公」，图里却只有从「爸爸」能走到他 → title_conflict。
 * 用性别感知的路径匹配，而不是 BFS 最短路径，否则「外公/爷爷」会互相误伤。
 */
function checkTitleConflicts(
  input: KinshipGraphInput,
  engine: KinshipEngine,
  people: Map<string, KinshipPerson>,
  push: (i: KinshipIssue) => void,
) {
  const anchorId = input.anchorPersonId;
  if (!anchorId) return;
  for (const person of input.people) {
    if (!person.relation || person.id === anchorId) continue;
    const parsed = parseLabel(person.relation);
    if (!parsed) continue;
    const suggestion = engine.suggestForPerson(person);
    if (suggestion?.targetKnown) continue;

    const edgeIds = engine.shortestPath(anchorId, person.id)?.edges.map((e) => e.id) ?? [];
    if (edgeIds.length > 0) {
      const derived = engine.deriveRelation(anchorId, person.id);
      push({
        kind: 'title_conflict',
        severity: 'error',
        message: `${person.name} 的称呼是「${person.relation}」，但按现有关系推算是「${derived?.title ?? '亲属'}」，请校正称呼或关系`,
        edgeIds,
        personIds: [anchorId, person.id],
      });
    } else if (parsed.path.length > 1) {
      // 图里根本走不到：称呼对应的中间人物缺失，给提示而非错误
      push({
        kind: 'inferred_label_conflict',
        severity: 'warning',
        message: `${person.name} 的称呼「${person.relation}」暂时落不到图谱上（中间的亲属还没建档，或关系未补全）`,
        edgeIds: [],
        personIds: [person.id],
      });
    }
  }
}
