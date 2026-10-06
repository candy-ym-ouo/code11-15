/**
 * 家族关系图谱：领域类型。
 * 纯类型、零依赖，前端后端共用，禁止在这里引入 Prisma / React。
 * 枚举常量统一从 enums 模块导出，这里只做类型引用，避免重复定义。
 */
import type {
  Gender,
  KinConfidence as Confidence,
  KinEdgeOrigin as EdgeOrigin,
  KinEdgeType as EdgeType,
  KinIssueSeverity as IssueSeverity,
} from '../enums';

export type { Gender, EdgeType, EdgeOrigin, Confidence, IssueSeverity };

/** 矛盾的处理状态（数据库里持久化）。 */
export const ISSUE_STATUSES = ['open', 'ignored', 'resolved'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_KINDS = [
  'self_loop',
  'cycle',
  'gender_mismatch',
  'age_reversed',
  'death_before_birth',
  'duplicate_parent_conflict',
  'sibling_age_gap',
  'title_conflict',
  'inferred_label_conflict',
  'duplicate_edge',
] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

export const ISSUE_KIND_LABELS: Record<IssueKind, string> = {
  self_loop: '自己连到自己',
  cycle: '关系出现循环',
  gender_mismatch: '性别与称呼不符',
  age_reversed: '生卒年倒挂',
  death_before_birth: '去世早于出生',
  duplicate_parent_conflict: '重复父母边冲突',
  sibling_age_gap: '兄弟姐妹年龄差偏大',
  title_conflict: '人物称呼与图谱推导出的称呼冲突',
  inferred_label_conflict: '称呼只能推到未知人物',
  duplicate_edge: '重复关系边',
};

/** 推导时用到的最简人物视图（DB 行先映射成它再喂给引擎）。 */
export interface KinshipPerson {
  id: string;
  name: string;
  gender: Gender;
  birthYear: number | null;
  deathYear: number | null;
  /** 人物档案上的自由文本称呼，如「外公」。 */
  relation: string | null;
}

/** 推导时用到的最简边视图。 */
export interface KinshipEdgeData {
  id: string;
  fromPersonId: string;
  toPersonId: string;
  type: EdgeType;
  origin: EdgeOrigin;
  confidence: Confidence;
  confirmed: boolean;
  note: string | null;
  /** 推导读据：命中的人物称呼原文等。 */
  evidence: unknown;
}

export interface KinshipGraphInput {
  people: KinshipPerson[];
  edges: KinshipEdgeData[];
  /** 以谁为中心解读人物档案里的称呼（一般是建档人本人）。 */
  anchorPersonId?: string | null;
}

/** 解析称呼得到的候选（可能对应多位重名/模糊人物）。 */
export interface RelationSuggestion {
  /** 归一化后的称呼原文，如「外公」。 */
  label: string;
  /** 从锚点人物出发的路径：step 里只出现必须经过的中间人物。 */
  path: PathStep[];
  /** 终点人物是否已在档案里明确找到（false 时只给路径，落库时需要用户选人）。 */
  targetKnown: boolean;
  /** 终点人物若能唯一匹配则带上。 */
  targetPersonId?: string;
  confidence: Confidence;
  reason: string;
}

export interface PathStep {
  type: EdgeType;
  /** 相对路径上一步人物的方向：out=from=我，in=to=我。 */
  direction: 'out' | 'in';
  /** 这一步期望的对方性别；unknown 表示不限定。 */
  gender: Gender;
  /** 这一步的序号（从 1 开始），仅用于展示。 */
  index: number;
}

export interface KinshipIssue {
  kind: IssueKind;
  severity: IssueSeverity;
  message: string;
  edgeIds: string[];
  personIds: string[];
}

/** 某两个人之间推导出的关系（含直接边与传递关系）。 */
export interface DerivedRelation {
  type: EdgeType | 'grandparent' | 'child' | 'grandchild' | 'uncle_aunt' | 'nephew_niece' | 'cousin' | 'self';
  /** 路径上边的类型序列，如 ['parent','parent']。 */
  path: EdgeType[];
  /** 中文称呼（相对锚点或查询起点）。 */
  title: string | null;
  shortest: boolean;
}
