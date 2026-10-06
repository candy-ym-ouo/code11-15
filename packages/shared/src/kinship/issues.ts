/**
 * 亲属关系矛盾检测（纯逻辑，服务端每次实时计算，不落库）。
 *
 * 检测九类问题：
 *  1. 父母年龄矛盾（子女出生年份早于/过晚于父母，或父母 12 岁以下生育）
 *  2. 配偶年龄差过大（默认 50 年）
 *  3. 父母代数环（A 的祖辈链绕回自己）
 *  4. 一个人超过 2 个父/母（多父母，过继/收养也可能，只是提醒）
 *  5. 同两人存在互相冲突的已确认边（兄弟 + 父子 / 两条方向相反的父母边）
 *  6. 已确认边与系统建议冲突
 *  7. 同胞年龄差过大（默认 40 年，多为把不同代人误记成同胞）
 *  8. 人物称谓文本与图谱边不一致（relation 写着「外公」却没有对应父母链）
 *  9. 成环的父母边导致的重复祖先之外的异常（并入 3）
 */
import { lookupTerm } from './terms';
import { deriveFromAnchor } from './inference';
import type { GraphPerson, KinshipEdge, KinshipKind } from './graph';

export type IssueSeverity = 'error' | 'warning';
export type IssueCode =
  | 'parent_age'
  | 'spouse_age_gap'
  | 'parent_cycle'
  | 'too_many_parents'
  | 'edge_conflict'
  | 'inferred_conflict'
  | 'sibling_age_gap'
  | 'relation_text_mismatch';

export interface KinshipIssue {
  code: IssueCode;
  severity: IssueSeverity;
  message: string;
  edgeIds: string[];
  personIds: string[];
  /** 服务端用来挂「建议的修复动作」，前端可据此提供一键处理 */
  suggestion?: { type: 'delete_edge' | 'ignore_edge' | 'edit_relation'; targetId?: string };
}

interface Options {
  maxParentChildGap?: number;
  maxSpouseGap?: number;
  maxSiblingGap?: number;
  minParentAge?: number;
}

const DEFAULTS = { maxParentChildGap: 80, maxSpouseGap: 50, maxSiblingGap: 40, minParentAge: 12 };

export function detectIssues(
  people: GraphPerson[],
  edges: KinshipEdge[],
  rawSuggestions: KinshipEdge[] = [],
  opts: Options = {},
): KinshipIssue[] {
  const o = { ...DEFAULTS, ...opts };
  const issues: KinshipIssue[] = [];
  const personById = new Map(people.map((p) => [p.id, p]));
  const name = (id: string) => personById.get(id)?.name ?? '未知人物';

  const active = edges.filter((e) => e.source !== 'ignored');
  const confirmed = active.filter((e) => e.source === 'manual' || e.source === 'derived');

  // 端点索引
  const parentChildren = new Map<string, Set<string>>();
  const childParents = new Map<string, Set<string>>();
  const undirectedPairs = new Map<string, KinshipEdge[]>();
  const allPairs = new Map<string, KinshipEdge[]>();

  const undKey = (a: string, b: string) => [a, b].sort().join('|');
  const pairKey = (a: string, b: string) => `${a}→${b}`;
  for (const e of active) {
    pushMap(allPairs, pairKey(e.fromId, e.toId), e);
    pushMap(allPairs, pairKey(e.toId, e.fromId), e);
    pushMap(undirectedPairs, undKey(e.fromId, e.toId), e);
    if (e.kind === 'parent') {
      pushSet(parentChildren, e.fromId, e.toId);
      pushSet(childParents, e.toId, e.fromId);
    }
  }

  // —— 1 & 2 & 7：年份类 ——
  for (const e of confirmed) {
    const from = personById.get(e.fromId);
    const to = personById.get(e.toId);
    if (!from || !to) continue;

    if (e.kind === 'parent' && from.birthYear && to.birthYear) {
      const age = to.birthYear - from.birthYear;
      if (age <= 0) {
        issues.push({
          code: 'parent_age',
          severity: 'error',
          message: `「${from.name}」(${from.birthYear}) 是「${to.name}」(${to.birthYear}) 的长辈，但出生年份更早的是后者`,
          edgeIds: [e.id!].filter(Boolean),
          personIds: [from.id, to.id],
          suggestion: { type: 'delete_edge', targetId: e.id },
        });
      } else if (age < o.minParentAge) {
        issues.push({
          code: 'parent_age',
          severity: 'error',
          message: `「${from.name}」${age} 岁就有了孩子「${to.name}」，低于 ${o.minParentAge} 岁，请核对关系或出生年份`,
          edgeIds: [e.id!].filter(Boolean),
          personIds: [from.id, to.id],
          suggestion: { type: 'delete_edge', targetId: e.id },
        });
      } else if (age > o.maxParentChildGap) {
        issues.push({
          code: 'parent_age',
          severity: 'warning',
          message: `「${from.name}」与「${to.name}」相差 ${age} 岁，超过常见的 ${o.maxParentChildGap} 岁亲子年龄差`,
          edgeIds: [e.id!].filter(Boolean),
          personIds: [from.id, to.id],
        });
      }
    }

    if (e.kind === 'spouse' && from.birthYear && to.birthYear) {
      const gap = Math.abs(from.birthYear - to.birthYear);
      if (gap > o.maxSpouseGap) {
        issues.push({
          code: 'spouse_age_gap',
          severity: 'warning',
          message: `配偶「${from.name}」与「${to.name}」年龄相差 ${gap} 岁，超过 ${o.maxSpouseGap} 岁，请核对`,
          edgeIds: [e.id!].filter(Boolean),
          personIds: [from.id, to.id],
        });
      }
    }

    if (e.kind === 'sibling' && from.birthYear && to.birthYear) {
      const gap = Math.abs(from.birthYear - to.birthYear);
      if (gap > o.maxSiblingGap) {
        issues.push({
          code: 'sibling_age_gap',
          severity: 'warning',
          message: `同胞「${from.name}」与「${to.name}」年龄相差 ${gap} 岁，超过 ${o.maxSiblingGap} 岁，可能不是同一代`,
          edgeIds: [e.id!].filter(Boolean),
          personIds: [from.id, to.id],
        });
      }
    }
  }

  // —— 3：父母链成环 ——
  for (const start of childParents.keys()) {
    const path: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = start;
    while (cur) {
      if (seen.has(cur)) {
        issues.push({
          code: 'parent_cycle',
          severity: 'error',
          message: `长辈关系成环：${[...path.slice(path.indexOf(cur)), cur].map(name).join(' → ')}，请删除其中一条错误的父母边`,
          edgeIds: [],
          personIds: [...seen],
        });
        break;
      }
      seen.add(cur);
      path.push(cur);
      const ps = childParents.get(cur);
      cur = ps && ps.size > 0 ? [...ps][0] : undefined;
    }
  }

  // —— 4：超过 2 个父母 ——
  for (const [childId, parents] of childParents) {
    if (parents.size > 2) {
      issues.push({
        code: 'too_many_parents',
        severity: 'warning',
        message: `「${name(childId)}」在图谱里有 ${parents.size} 个父母/长辈（过继、收养或重复建档都有可能），请核对`,
        edgeIds: [],
        personIds: [childId, ...parents],
      });
    }
  }

  // —— 5：同两人之间的已确认边互相冲突 ——
  for (const [key, group] of undirectedPairs) {
    const kinds = new Set(group.map((e) => e.kind));
    const conflicting =
      kinds.size > 1 ||
      // 两条方向相反的 parent
      (kinds.has('parent') && group.some((e) => e.kind === 'parent' && allPairs.get(pairKey(e.toId, e.fromId))?.some((x) => x.kind === 'parent')));
    if (conflicting && group.every((e) => e.source === 'manual' || e.source === 'derived')) {
      const [a, b] = key.split('|');
      issues.push({
        code: 'edge_conflict',
        severity: 'error',
        message: `「${name(a!)}」与「${name(b!)}」同时被记成 ${[...kinds].map(kindLabel).join('、')}，关系互相矛盾`,
        edgeIds: group.map((e) => e.id!).filter(Boolean),
        personIds: [a!, b!],
      });
    }
  }

  // —— 6：建议边与已确认边冲突 ——
  const confirmedPairKinds = new Map<string, Set<KinshipKind>>();
  for (const e of confirmed) {
    const s = confirmedPairKinds.get(undKey(e.fromId, e.toId)) ?? new Set<KinshipKind>();
    s.add(e.kind);
    confirmedPairKinds.set(undKey(e.fromId, e.toId), s);
  }
  for (const s of rawSuggestions) {
    const exist = confirmedPairKinds.get(undKey(s.fromId, s.toId));
    if (exist && !exist.has(s.kind)) {
      issues.push({
        code: 'inferred_conflict',
        severity: 'warning',
        message: `系统从称谓推导出「${name(s.fromId)}」与「${name(s.toId)}」是${kindLabel(s.kind)}，但图谱里已记为 ${[...exist].map(kindLabel).join('、')}`,
        edgeIds: [],
        personIds: [s.fromId, s.toId],
        suggestion: { type: 'ignore_edge', targetId: s.id },
      });
    }
  }

  // —— 8：人物 relation 文本与图谱不一致 ——
  // 以「本人/我」为锚点：relation 能推出一条明确边（父母/配偶/同胞），
  // 但现存图里这个人与本人之间完全没有该类关系。
  const self = people.find((p) => p.relation === '本人' || p.name === '本人' || p.relation === '我' || p.name === '我');
  if (self) {
    for (const p of people) {
      if (p.id === self.id) continue;
      const term = lookupTerm(p.relation ?? p.name);
      if (!term) continue;
      const derived = deriveFromAnchor(self.id, p.id, term);
      if (!derived) continue;
      if (derived.edge.kind === 'kin') continue; // 姻亲/堂表不做强校验
      const pair = undirectedPairs.get(undKey(self.id, p.id));
      const hasKind = pair?.some((e) => e.kind === derived.edge.kind);
      const hasParent =
        derived.edge.kind === 'parent' &&
        (allPairs.get(pairKey(p.id, self.id))?.some((e) => e.kind === 'parent') ||
          allPairs.get(pairKey(self.id, p.id))?.some((e) => e.kind === 'parent'));
      if (!hasKind && !hasParent) {
        issues.push({
          code: 'relation_text_mismatch',
          severity: 'warning',
          message: `「${p.name}」的称谓写的是「${term.term}」，但图谱里还没有与本人的${kindLabel(derived.edge.kind)}关系，可运行推导或手工补边`,
          edgeIds: [],
          personIds: [self.id, p.id],
        });
      }
    }
  }

  return dedupeIssues(issues);
}

function kindLabel(k: KinshipKind): string {
  return k === 'parent' ? '父母/子女' : k === 'spouse' ? '配偶' : k === 'sibling' ? '同胞' : '亲属';
}

function pushMap<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

function pushSet<K>(m: Map<K, Set<string>>, k: K, v: string) {
  const s = m.get(k);
  if (s) s.add(v);
  else m.set(k, new Set([v]));
}

function dedupeIssues(issues: KinshipIssue[]): KinshipIssue[] {
  const seen = new Set<string>();
  const out: KinshipIssue[] = [];
  for (const i of issues) {
    const key = `${i.code}:${[...i.personIds].sort().join('|')}:${i.edgeIds.join('|')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  // error 排前面，方便界面优先处理
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}
