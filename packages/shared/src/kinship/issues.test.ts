import { describe, expect, it } from 'vitest';
import { detectIssues, type KinshipIssue } from './issues';
import type { GraphPerson, KinshipEdge } from './graph';

const people = (rows: Array<[string, string, string | null, number | null, number | null]>): GraphPerson[] =>
  rows.map(([id, name, relation, birthYear, deathYear]) => ({ id, name, relation, birthYear, deathYear }));

const edge = (
  id: string,
  kind: KinshipEdge['kind'],
  fromId: string,
  toId: string,
  source: KinshipEdge['source'] = 'manual',
): KinshipEdge => ({ id, kind, fromId, toId, label: null, source });

const codes = (issues: KinshipIssue[]) => issues.map((i) => i.code);

describe('矛盾检测 detectIssues', () => {
  it('子女出生年份早于父母 → parent_age error', () => {
    const ps = people([
      ['a', '爸爸', null, 1960, null],
      ['b', '儿子', null, 1955, null],
    ]);
    const issues = detectIssues(ps, [edge('e1', 'parent', 'a', 'b')]);
    expect(codes(issues)).toContain('parent_age');
    expect(issues.find((i) => i.code === 'parent_age')?.severity).toBe('error');
  });

  it('父母 8 岁生育 → parent_age error', () => {
    const ps = people([
      ['a', '爸爸', null, 2000, null],
      ['b', '儿子', null, 2008, null],
    ]);
    expect(codes(detectIssues(ps, [edge('e1', 'parent', 'a', 'b')]))).toContain('parent_age');
  });

  it('正常父子年龄不报矛盾', () => {
    const ps = people([
      ['a', '爸爸', null, 1960, null],
      ['b', '儿子', null, 1990, null],
    ]);
    expect(codes(detectIssues(ps, [edge('e1', 'parent', 'a', 'b')]))).not.toContain('parent_age');
  });

  it('配偶年龄差 60 岁 → spouse_age_gap warning', () => {
    const ps = people([
      ['a', '爷爷', null, 1920, null],
      ['b', '奶奶', null, 1980, null],
    ]);
    expect(codes(detectIssues(ps, [edge('e1', 'spouse', 'a', 'b')]))).toContain('spouse_age_gap');
  });

  it('同胞年龄差 50 岁 → sibling_age_gap warning', () => {
    const ps = people([
      ['a', '哥', null, 1930, null],
      ['b', '弟', null, 1980, null],
    ]);
    expect(codes(detectIssues(ps, [edge('e1', 'sibling', 'a', 'b')]))).toContain('sibling_age_gap');
  });

  it('父母链成环 A→B→C→A → parent_cycle', () => {
    const ps = people([
      ['a', 'A', null, null, null],
      ['b', 'B', null, null, null],
      ['c', 'C', null, null, null],
    ]);
    const issues = detectIssues(ps, [
      edge('e1', 'parent', 'a', 'b'),
      edge('e2', 'parent', 'b', 'c'),
      edge('e3', 'parent', 'c', 'a'),
    ]);
    expect(codes(issues)).toContain('parent_cycle');
  });

  it('一个人有 3 个父母 → too_many_parents', () => {
    const ps = people([
      ['c', '我', null, null, null],
      ['p1', '爸', null, null, null],
      ['p2', '妈', null, null, null],
      ['p3', '继父', null, null, null],
    ]);
    const issues = detectIssues(ps, [
      edge('e1', 'parent', 'p1', 'c'),
      edge('e2', 'parent', 'p2', 'c'),
      edge('e3', 'parent', 'p3', 'c'),
    ]);
    expect(codes(issues)).toContain('too_many_parents');
  });

  it('同两人既是兄弟又是父子 → edge_conflict', () => {
    const ps = people([
      ['a', '甲', null, null, null],
      ['b', '乙', null, null, null],
    ]);
    const issues = detectIssues(ps, [edge('e1', 'sibling', 'a', 'b'), edge('e2', 'parent', 'a', 'b')]);
    expect(codes(issues)).toContain('edge_conflict');
  });

  it('双向 parent（互为父子）→ edge_conflict', () => {
    const ps = people([
      ['a', '甲', null, null, null],
      ['b', '乙', null, null, null],
    ]);
    const issues = detectIssues(ps, [edge('e1', 'parent', 'a', 'b'), edge('e2', 'parent', 'b', 'a')]);
    expect(codes(issues)).toContain('edge_conflict');
  });

  it('建议边与已确认边冲突 → inferred_conflict', () => {
    const ps = people([
      ['a', '甲', null, null, null],
      ['b', '乙', null, null, null],
    ]);
    const issues = detectIssues(
      ps,
      [edge('e1', 'sibling', 'a', 'b')],
      [{ id: 's1', kind: 'parent', fromId: 'a', toId: 'b', label: null, source: 'suggested' }],
    );
    expect(codes(issues)).toContain('inferred_conflict');
  });

  it('被忽略的边不参与矛盾检测', () => {
    const ps = people([
      ['a', '甲', null, 1920, null],
      ['b', '乙', null, 1990, null],
    ]);
    const issues = detectIssues(ps, [edge('e1', 'sibling', 'a', 'b', 'ignored')]);
    expect(codes(issues)).not.toContain('sibling_age_gap');
  });

  it('称谓文本与图谱不一致 → relation_text_mismatch（爸爸没有连边）', () => {
    const ps = people([
      ['me', '本人', '本人', 1990, null],
      ['dad', '爸爸', '爸爸', 1960, null],
    ]);
    const issues = detectIssues(ps, []);
    expect(codes(issues)).toContain('relation_text_mismatch');
  });

  it('称谓文本已与图谱一致时不报 mismatch', () => {
    const ps = people([
      ['me', '本人', '本人', 1990, null],
      ['dad', '爸爸', '爸爸', 1960, null],
    ]);
    const issues = detectIssues(ps, [edge('e1', 'parent', 'dad', 'me')]);
    expect(codes(issues)).not.toContain('relation_text_mismatch');
  });

  it('error 排在 warning 前面', () => {
    const ps = people([
      ['a', '甲', null, 1960, null],
      ['b', '乙', null, 1955, null],
      ['c', '丙', null, 1900, null],
    ]);
    const issues = detectIssues(ps, [
      edge('e1', 'parent', 'a', 'b'),
      edge('e2', 'spouse', 'a', 'c'),
    ]);
    const firstWarn = issues.findIndex((i) => i.severity === 'warning');
    const lastError = issues.map((i) => i.severity).lastIndexOf('error');
    expect(lastError < (firstWarn === -1 ? 999 : firstWarn)).toBe(true);
  });
});
