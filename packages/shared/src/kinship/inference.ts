/**
 * 称谓推导规则。
 *
 * 输入：同一件物品上共现的两个人，各自相对同一「锚点（本人）」的称谓特征，
 * 例如「外公的樟木箱」上同时出现 外公(anchor 之外的人?)——实际推导由 service
 * 负责找人，这里只做纯逻辑：两个称谓之间最可能是什么关系。
 *
 * 输出 0~1 条建议边 + 置信度 + 人话理由。宁可不推，也不乱推：
 * 跨父系/母系、姻家对姻家（姐夫↔嫂子不是夫妻！）这类情况一律跳过。
 */
import type { TermFeature } from './terms';
import type { KinshipEdge } from './graph';

export interface DerivedEdge {
  edge: Omit<KinshipEdge, 'id' | 'source'>;
  confidence: number;
  reason: string;
}

type Side = TermFeature['side'];
type Cls = TermFeature['cls'];

const BLOOD: Cls[] = ['lineal', 'ancestor_mate'];

function parentEdge(parentId: string, childId: string, label: string | null, confidence: number, reason: string): DerivedEdge {
  return { edge: { fromId: parentId, toId: childId, kind: 'parent', label }, confidence, reason };
}

function undirected(kind: 'spouse' | 'sibling' | 'kin', x: string, y: string, label: string | null, confidence: number, reason: string): DerivedEdge {
  const [a, b] = [x, y].sort();
  return { edge: { fromId: a!, toId: b!, kind, label }, confidence, reason };
}

function oppositeGender(a: TermFeature, b: TermFeature): boolean {
  return a.gender !== b.gender;
}

/**
 * 从两个称谓推导一条关系边（或无）。
 * aTerm 是 person a 相对锚点的称谓，bTerm 同理。
 */
export function derivePair(
  aId: string,
  aTerm: TermFeature,
  bId: string,
  bTerm: TermFeature,
): DerivedEdge | null {
  const a = aTerm;
  const b = bTerm;

  // 同一个人不推
  if (aId === bId) return null;

  // —— 规则 1：配偶（优先级最高，避免「爸爸↔妈妈」被误判成同胞）——
  // 1a. 父母一辈直系跨支异性：爸爸(father) ↔ 妈妈(mother)
  if (
    a.cls === 'lineal' &&
    b.cls === 'lineal' &&
    a.gen === b.gen &&
    a.gen !== 0 &&
    oppositeGender(a, b) &&
    new Set([a.side, b.side]).size === 2
  ) {
    return undirected('spouse', aId, bId, null, 0.9, `${a.term}与${b.term}分属父系/母系且同代异性`);
  }
  // 1b. 同代直系同性（不会出现，跳过）；祖辈/同系直系不配对
  // 1c. 祖辈配偶：爷爷 ↔ 奶奶、外公 ↔ 外婆（ancestor_mate 必须与同系直系同代）
  const matePair = orderMate(a, b);
  if (matePair) {
    const [mate, blood] = matePair;
    return undirected('spouse', aId, bId, null, 0.9, `${mate.term}是${blood.term}的配偶`);
  }
  // 1c. 姻亲 ↔ 同胞（异性、同系、同代）：舅妈↔舅舅、姑父↔姑姑、嫂子↔哥哥、姐夫↔姐姐
  const inlawSibling = orderInlawSibling(a, b);
  if (inlawSibling) {
    const [, sib] = inlawSibling;
    return undirected('spouse', aId, bId, null, 0.88, `按称谓是${sib.term}的配偶`);
  }
  // 1d. 儿媳 ↔ 儿子 / 女婿 ↔ 女儿（子系，异性同代）
  const childPair = orderChildInlaw(a, b);
  if (childPair) {
    const [inlaw] = childPair;
    return undirected('spouse', aId, bId, null, 0.88, `按称谓${inlaw.term}与直系子女配对`);
  }

  // —— 规则 2：父母（相邻两代）——
  const chain = orderChain(a, b);
  if (chain) {
    const [elder, younger] = chain;
    const elderId = elder.idx === 0 ? aId : bId;
    const youngerId = younger.idx === 0 ? aId : bId;
    // label：长辈本人就是用这个称谓被记录的（爷爷/爸爸/外公/奶奶…）
    return parentEdge(elderId, youngerId, elder.term, 0.9,
      `${elder.term}比${younger.term}长一辈`);
  }

  // —— 规则 3：同胞 ——
  // 3a. 两个同胞称谓同系同代：伯伯↔叔叔、舅舅↔阿姨、侄子↔侄女
  if (a.cls === 'sibling' && b.cls === 'sibling' && a.side === b.side && a.gen === b.gen) {
    return undirected('sibling', aId, bId, null, 0.9, `${a.term}与${b.term}同系同代，按称谓是同胞`);
  }
  // 3b. 叔姑舅姨 ↔ 爸妈：叔叔↔爸爸（父系）、舅舅↔妈妈（母系）
  const sibParent = orderSiblingParent(a, b);
  if (sibParent) {
    return undirected('sibling', aId, bId, null, 0.85, `${a.term}与${b.term}同系同辈`);
  }

  // —— 规则 4：隔代直系（中间代可能还没建档），低置信度 ——
  const gap = orderGap(a, b);
  if (gap) {
    const [elder, younger] = gap;
    const label = elder.gen > 0 ? elder.term : younger.term;
    return undirected('kin', aId, bId, label, 0.4,
      `${elder.term}与${younger.term}隔代直系，建议补出中间代或人工确认`);
  }

  // —— 规则 5：堂表亲 ——
  if (a.cls === 'cousin' && b.cls === 'cousin' && a.gen === b.gen) {
    return undirected('kin', aId, bId, '堂表亲', 0.55, `${a.term}与${b.term}按称谓是堂表亲`);
  }

  return null;
}

function orderMate(x: TermFeature, y: TermFeature): [TermFeature, TermFeature] | null {
  if (x.cls === 'ancestor_mate' && y.cls === 'lineal' && x.gen === y.gen && x.side === y.side) return [x, y];
  if (y.cls === 'ancestor_mate' && x.cls === 'lineal' && x.gen === y.gen && x.side === y.side) return [y, x];
  return null;
}

function orderInlawSibling(x: TermFeature, y: TermFeature): [TermFeature, TermFeature] | null {
  if (x.cls === 'inlaw' && y.cls === 'sibling' && x.gen === y.gen && x.side === y.side && x.gender !== y.gender) return [x, y];
  if (y.cls === 'inlaw' && x.cls === 'sibling' && x.gen === y.gen && x.side === y.side && x.gender !== y.gender) return [y, x];
  return null;
}

function orderChildInlaw(x: TermFeature, y: TermFeature): [TermFeature, TermFeature] | null {
  const isChildLineal = (t: TermFeature) => t.cls === 'lineal' && t.gen === -1 && t.side === 'son';
  if (x.cls === 'inlaw' && isChildLineal(y) && x.gen === -1 && x.side === 'son' && x.gender !== y.gender) return [x, y];
  if (y.cls === 'inlaw' && isChildLineal(x) && x.gen === -1 && x.side === 'son' && x.gender !== y.gender) return [y, x];
  return null;
}

interface IndexedTerm extends TermFeature {
  idx: 0 | 1;
}

/**
 * 相邻两代的直系链：
 * - 同系血亲：爷爷→爸爸、奶奶→爸爸、外公→舅舅、爸爸→我、儿子→孙子；
 * - 跨支直系：外婆/外公→妈妈（妈妈虽来自母系，但「我」对她的称呼落在 father 侧家庭）；
 * - 子女跨称：女儿→外孙（lineal 之间允许跨 side，旁系 sibling 仍须同系）。
 */
function orderChain(x: TermFeature, y: TermFeature): [IndexedTerm, IndexedTerm] | null {
  const xi: IndexedTerm = { ...x, idx: 0 };
  const yi: IndexedTerm = { ...y, idx: 1 };

  const tryPair = (elder: IndexedTerm, younger: IndexedTerm): boolean => {
    if (elder.gen - younger.gen !== 1) return false;
    if (!BLOOD.includes(elder.cls)) return false;
    // 晚辈可以是直系/祖辈配偶/同胞（爷爷→叔叔 成立），但不能是姻亲——舅妈不是爷爷的女儿
    if (![...BLOOD, 'sibling'].includes(younger.cls)) return false;
    // 两个都是直系时：同系自然成立；跨支只承认两种经典跨称：
    //  ① 外婆/外公 → 妈妈（妈妈本人来自母系血亲）
    //  ② 女儿(子系) → 外孙(母系称呼)
    if (elder.cls === 'lineal' && younger.cls === 'lineal') {
      if (elder.side === younger.side) return true;
      if (younger.term === '妈妈' && ['外公', '外祖父', '外婆', '外祖母'].includes(elder.term)) return true;
      if (elder.term === '女儿' && younger.side === 'mother' && younger.gen === -2) return true;
      return false;
    }
    // 直系 ↔ 祖辈配偶（奶奶→爸爸、外婆→妈妈）按同系连
    if (BLOOD.includes(younger.cls) && (elder.cls === 'ancestor_mate' || younger.cls === 'ancestor_mate')) {
      return elder.side === younger.side;
    }
    // 晚辈是旁系同胞时必须同系（爷爷→叔叔成立，外公→叔叔不成立）
    if (younger.cls === 'sibling') return elder.side === younger.side;
    return true;
  };

  if (tryPair(xi, yi)) return [xi, yi];
  if (tryPair(yi, xi)) return [yi, xi];
  return null;
}

function orderSiblingParent(x: TermFeature, y: TermFeature): boolean {
  const test = (sib: TermFeature, parent: TermFeature) =>
    sib.cls === 'sibling' && BLOOD.includes(parent.cls) && sib.gen === parent.gen && sib.gen === 1 && sib.side === parent.side;
  return test(x, y) || test(y, x);
}

/** 隔两代及以上的同系直系：爷爷↔我、太爷爷↔爷爷、我↔孙子（只给低置信度 kin 建议）。 */
function orderGap(x: TermFeature, y: TermFeature): [IndexedTerm, IndexedTerm] | null {
  const xi: IndexedTerm = { ...x, idx: 0 };
  const yi: IndexedTerm = { ...y, idx: 1 };
  const test = (elder: IndexedTerm, younger: IndexedTerm): boolean => {
    if (elder.gen <= younger.gen) return false;
    if (!BLOOD.includes(elder.cls) || !BLOOD.includes(younger.cls)) return false;
    if (elder.gen - younger.gen < 2) return false;
    if (younger.gen < 0 && elder.side !== 'son') return false;
    // 「本人」不系于任何一支，与任一系的直系祖辈/晚辈可隔代相连
    if ([elder.side, younger.side].includes('self')) return true;
    // 其余隔代直系必须同系（爷爷↔爸爸←我 走中间代，不跨支硬连）
    return elder.side === younger.side;
  };
  if (test(xi, yi)) return [xi, yi];
  if (test(yi, xi)) return [yi, xi];
  return null;
}

/**
 * 锚点（本人）↔ 某个称谓的直接边。
 * 用于「我」与带亲属称谓的人在同一件物品共现、或复合称谓链解析。
 */
export function deriveFromAnchor(
  anchorId: string,
  otherId: string,
  t: TermFeature,
): DerivedEdge | null {
  if (anchorId === otherId) return null;
  switch (t.cls) {
    case 'spouse':
      return undirected('spouse', anchorId, otherId, null, 0.95, `称谓「${t.term}」相对本人`);
    case 'lineal':
    case 'ancestor_mate': {
      if (t.gen === 1) return parentEdge(otherId, anchorId, t.term, 0.9, `称谓「${t.term}」是本人的长辈`);
      if (t.gen === -1 && t.side === 'son') return parentEdge(anchorId, otherId, null, 0.9, `称谓「${t.term}」是本人的晚辈`);
      return undirected('kin', anchorId, otherId, t.gen > 0 ? t.term : null, 0.5, `称谓「${t.term}」与本人隔代`);
    }
    case 'sibling':
      // 父辈的叔舅（gen=1）相对本人不是同胞，只是旁系长辈
      return t.gen === 0
        ? undirected('sibling', anchorId, otherId, null, 0.85, `称谓「${t.term}」是本人的同胞`)
        : undirected('kin', anchorId, otherId, t.term, 0.6, `称谓「${t.term}」是本人的旁系长辈`);
    case 'inlaw':
    case 'cousin':
      return undirected('kin', anchorId, otherId, t.term, 0.6, `称谓「${t.term}」是本人的姻亲/堂表亲`);
    default:
      return null;
  }
}

/**
 * 复合称谓链解析：「外公 的 弟弟」。
 * 返回称谓特征链（每一跳相对上一跳），找不到的称谓返回 null。
 * 第一个称谓相对锚点（本人），后续每个相对上一个人。
 */
export function composeChain(parts: string[], lookup: (s: string) => TermFeature | null): TermFeature[] | null {
  if (parts.length < 2) return null;
  const chain: TermFeature[] = [];
  for (const part of parts) {
    const f = lookup(part);
    if (!f) return null;
    chain.push(f);
  }
  return chain;
}

/**
 * 复合称谓里相邻两跳的关系（用于给已建档的中间人物连边）。
 * 规则只覆盖「配偶 / 同胞 / 长一辈直系」三种明确写法。
 */
export function deriveChainHop(
  ownerId: string,
  relativeId: string,
  relative: TermFeature,
): DerivedEdge | null {
  // 「X 的弟弟/妹妹/哥哥/姐姐」——relative 是 X 的同胞（平辈词）
  if (relative.cls === 'sibling' && relative.gen === 0) {
    return undirected('sibling', ownerId, relativeId, null, 0.85, `复合称谓中的同胞关系`);
  }
  // 「X 的儿子/女儿」
  if (relative.cls === 'lineal' && relative.gen === -1 && relative.side === 'son') {
    return parentEdge(ownerId, relativeId, null, 0.85, `复合称谓中的子女关系`);
  }
  // 「X 的妻子/丈夫」
  if (relative.cls === 'spouse') {
    return undirected('spouse', ownerId, relativeId, null, 0.9, `复合称谓中的配偶关系`);
  }
  return null;
}
