/**
 * 关系图谱快照：版本留痕用。
 * 每次写操作前把「当时的全量人物+边」冻结成不可变 JSON；回滚就是读出快照整体重建。
 * 人物字段只拷与图谱相关的列，避免把小传等无关变更也算成关系版本。
 */
import type { Gender, KinshipEdgeData, KinshipPerson } from './types';

export const SNAPSHOT_VERSION = 1;

export interface SnapshotPerson {
  id: string;
  name: string;
  gender: Gender;
  birthYear: number | null;
  deathYear: number | null;
  relation: string | null;
}

export interface SnapshotEdge {
  id: string;
  fromPersonId: string;
  toPersonId: string;
  type: KinshipEdgeData['type'];
  origin: KinshipEdgeData['origin'];
  confidence: KinshipEdgeData['confidence'];
  confirmed: boolean;
  note: string | null;
  evidence: unknown;
}

export interface GraphSnapshot {
  version: typeof SNAPSHOT_VERSION;
  anchorPersonId: string | null;
  people: SnapshotPerson[];
  edges: SnapshotEdge[];
}

export interface SnapshotInput {
  anchorPersonId?: string | null;
  people: Array<Pick<KinshipPerson, 'id' | 'name' | 'gender' | 'birthYear' | 'deathYear' | 'relation'>>;
  edges: KinshipEdgeData[];
}

export function createSnapshot(input: SnapshotInput): GraphSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    anchorPersonId: input.anchorPersonId ?? null,
    people: input.people.map((p) => ({
      id: p.id,
      name: p.name,
      gender: p.gender,
      birthYear: p.birthYear,
      deathYear: p.deathYear,
      relation: p.relation,
    })),
    edges: input.edges.map((e) => ({
      id: e.id,
      fromPersonId: e.fromPersonId,
      toPersonId: e.toPersonId,
      type: e.type,
      origin: e.origin,
      confidence: e.confidence,
      confirmed: e.confirmed,
      note: e.note,
      evidence: e.evidence,
    })),
  };
}

/** 统计两个快照之间的增删，供版本列表展示「这版改了什么」。 */
export function diffSnapshots(
  before: GraphSnapshot | null,
  after: GraphSnapshot,
): { addedEdges: SnapshotEdge[]; removedEdges: SnapshotEdge[]; changedPeople: string[] } {
  if (!before) return { addedEdges: after.edges, removedEdges: [], changedPeople: [] };
  const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
  const afterEdges = new Map(after.edges.map((e) => [e.id, e]));
  const addedEdges = after.edges.filter((e) => !beforeEdges.has(e.id));
  const removedEdges = before.edges.filter((e) => !afterEdges.has(e.id));

  const beforePeople = new Map(before.people.map((p) => [p.id, p]));
  const changedPeople = after.people
    .filter((p) => {
      const b = beforePeople.get(p.id);
      if (!b) return false;
      return b.gender !== p.gender || b.relation !== p.relation || b.birthYear !== p.birthYear || b.deathYear !== p.deathYear;
    })
    .map((p) => p.id);

  return { addedEdges, removedEdges, changedPeople };
}

/** 便捷封装：从引擎输入直接造快照。 */
export function snapshotGraph(input: SnapshotInput): GraphSnapshot {
  return createSnapshot(input);
}
