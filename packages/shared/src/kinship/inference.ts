/**
 * 关系推导：把散落在人物档案、物品关联里的线索变成「候选边」。
 *
 * 线索分两种：
 * 1. 人物档案上的称呼（「外公」「舅妈」）→ 沿路径落成 parent/partner/sibling 边，
 *    中间人物必须已建档，落不下去的跳过（issues 会提示缺谁）。
 * 2. 物品上的角色：同一件物品 A「继承自」B，通常意味着 B 是 A 的长辈（parent 方向待人工定）。
 *    这只是弱线索，只产 low confidence 的「疑似长辈」建议，绝不自动造边，
 *    因为「继承」在生活里也可能来自叔伯、前夫家——系统不替用户拍板。
 */
import type {
  Confidence,
  EdgeType,
  KinshipEdgeData,
  KinshipGraphInput,
  KinshipPerson,
} from './types';
import { KinshipEngine } from './engine';

export interface InferredEdgeDraft {
  type: EdgeType;
  fromPersonId: string;
  toPersonId: string;
  confidence: Confidence;
  evidence: { source: 'person_label' | 'item_role'; label?: string; itemIds?: string[]; reason: string };
}

export interface InferenceResult {
  edges: InferredEdgeDraft[];
  /** 无法落地的称呼（缺中间人物等），供接口提示。 */
  unresolved: { personId: string; label: string; reason: string }[];
}

function edgeKey(type: EdgeType, a: string, b: string): string {
  const pair = type === 'parent' ? `${a}>${b}` : [a, b].sort().join('|');
  return `${type}:${pair}`;
}

/**
 * 从人物称呼推导候选边。
 * 已被现有边覆盖的不重复产出；产出的边都是 inferred / 未确认。
 */
export function buildInferredEdges(input: KinshipGraphInput): InferenceResult {
  const engine = new KinshipEngine(input);
  const drafts = new Map<string, InferredEdgeDraft>();
  const unresolved: InferenceResult['unresolved'] = [];

  const existingKeys = new Set(input.edges.map((e) => edgeKey(e.type, e.fromPersonId, e.toPersonId)));

  for (const person of input.people) {
    if (!person.relation || !input.anchorPersonId || person.id === input.anchorPersonId) continue;
    const suggestion = engine.suggestForPerson(person);
    if (!suggestion) continue;

    // 不管整路径在图里走不走得通：逐段落地，已有的边跳过，缺的边就是推导结果。
    // （中间人物未建档的段 from/to 为 null，无法落地，只在 unresolved 里提示。）
    const realization = engine.edgesToRealize(person);
    let hasGap = false;
    for (const seg of realization) {
      if (!seg.fromId || !seg.toId) {
        hasGap = true;
        continue;
      }
      const key = edgeKey(seg.type, seg.fromId, seg.toId);
      if (existingKeys.has(key) || drafts.has(key)) continue;
      drafts.set(key, {
        type: seg.type,
        fromPersonId: seg.fromId,
        toPersonId: seg.toId,
        confidence: suggestion.confidence,
        evidence: {
          source: 'person_label',
          label: suggestion.label,
          reason: `由 ${person.name} 的称呼「${suggestion.label}」推得`,
        },
      });
    }
    if (hasGap) {
      unresolved.push({ personId: person.id, label: suggestion.label, reason: '路径上有中间人物尚未建档' });
    }
  }

  return { edges: [...drafts.values()], unresolved };
}

/** 物品关联角色（去隐私后的最小视图）。 */
export interface ItemRoleLink {
  itemId: string;
  personId: string;
  role: 'source' | 'gifted' | 'inherited' | 'owner' | 'mentioned';
}

export interface RoleInferenceResult {
  suggestions: {
    type: EdgeType;
    fromPersonId: string;
    toPersonId: string;
    confidence: Confidence;
    evidence: { source: 'item_role'; itemIds: string[]; reason: string };
  }[];
}

/**
 * 从物品角色找弱线索：同一件物品上同时出现 inherited（继承的人）与 source/gifted/owner（上一手），
 * 提示「疑似长辈→晚辈」。只给建议、不自动建边。
 */
export function inferFromItemRoles(links: ItemRoleLink[], people: KinshipPerson[]): RoleInferenceResult {
  const byItem = new Map<string, ItemRoleLink[]>();
  for (const link of links) {
    const list = byItem.get(link.itemId) ?? [];
    list.push(link);
    byItem.set(link.itemId, list);
  }
  const known = new Set(people.map((p) => p.id));
  const merged = new Map<string, { from: string; to: string; itemIds: Set<string> }>();

  for (const list of byItem.values()) {
    const heirs = list.filter((l) => l.role === 'inherited' && known.has(l.personId));
    const seniors = list.filter(
      (l) => (l.role === 'source' || l.role === 'gifted' || l.role === 'owner') && known.has(l.personId),
    );
    for (const heir of heirs) {
      for (const senior of seniors) {
        if (heir.personId === senior.personId) continue;
        const key = `${senior.personId}>${heir.personId}`;
        const cur = merged.get(key) ?? { from: senior.personId, to: heir.personId, itemIds: new Set<string>() };
        cur.itemIds.add(heir.itemId);
        merged.set(key, cur);
      }
    }
  }

  return {
    suggestions: [...merged.values()].map((v) => ({
      type: 'parent' as EdgeType,
      fromPersonId: v.from,
      toPersonId: v.to,
      confidence: 'low' as Confidence,
      evidence: {
        source: 'item_role' as const,
        itemIds: [...v.itemIds],
        reason: `${v.itemIds.size} 件物品记录为「继承自」对方，可能是长辈，需人工确认`,
      },
    })),
  };
}

/** 判断一条候选边是否已被现有边覆盖（含反向的对称边）。 */
export function edgeExists(edges: KinshipEdgeData[], type: EdgeType, fromId: string, toId: string): boolean {
  return edges.some((e) => {
    if (e.type !== type) return false;
    if (type === 'parent') return e.fromPersonId === fromId && e.toPersonId === toId;
    return (
      (e.fromPersonId === fromId && e.toPersonId === toId) ||
      (e.fromPersonId === toId && e.toPersonId === fromId)
    );
  });
}
