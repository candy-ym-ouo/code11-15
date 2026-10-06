/**
 * 亲属关系边模型与规范化。
 * 推导引擎、矛盾检测、前后端 API 共用这一套类型，保证口径一致。
 */
export { KINSHIP_KINDS, KINSHIP_SOURCES, KINSHIP_KIND_LABELS } from '../enums';
import type { KinshipKind, KinshipSource } from '../enums';
import type { TermGender } from './terms';

/** 基础关系类型：父母 / 子女（有向）、配偶、同胞、其他亲属（自定义称谓） */
export type { KinshipKind, KinshipSource };

export interface KinshipEdge {
  id?: string;
  fromId: string;
  toId: string;
  kind: KinshipKind;
  /** 关系称谓，方向语义：「from 是 to 的 label」。例如 from=爸爸,to=我,label=父亲 */
  label: string | null;
  source: KinshipSource;
}

export interface GraphPerson {
  id: string;
  name: string;
  relation: string | null;
  birthYear: number | null;
  deathYear: number | null;
}

/**
 * 把边规范化成「有序端点 + 类型」的指纹。
 * - parent 有方向：from 是父母，to 是子女，不翻转；
 * - spouse / sibling 无方向：端点按字典序排列，保证夫妻、兄妹只存一条；
 * - kin（其他亲属）按称谓方向存，调用方负责语义，规范化时保留方向。
 */
export function edgeFingerprint(kind: KinshipKind, aId: string, bId: string, directed = false) {
  if (directed || kind === 'parent' || kind === 'kin') {
    return `${kind}:${aId}→${bId}`;
  }
  const [x, y] = [aId, bId].sort();
  return `${kind}:${x}↔${y}`;
}

/** 无向边在展示时统一成 id 较小的一端在前。 */
export function canonicalUndirected(a: { id: string }, b: { id: string }): [string, string] {
  return [a.id, b.id].sort() as [string, string];
}

/** 配偶称谓 → 反向称谓（仅展示用，不参与推导）。 */
export function reverseGender(g: TermGender): TermGender {
  return g === 'male' ? 'female' : 'male';
}
