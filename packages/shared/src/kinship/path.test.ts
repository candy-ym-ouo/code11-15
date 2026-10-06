import { describe, expect, it } from 'vitest';
import { findPath } from './path';
import type { KinshipEdge } from './graph';

const names = new Map([
  ['me', '本人'],
  ['dad', '爸爸'],
  ['uncle', '叔叔'],
  ['cousin', '堂弟'],
  ['mom', '妈妈'],
]);
const nameOf = (id: string) => names.get(id) ?? id;
const e = (id: string, kind: KinshipEdge['kind'], from: string, to: string): KinshipEdge => ({
  id,
  kind,
  fromId: from,
  toId: to,
  label: null,
  source: 'manual',
});

describe('亲属路径 findPath', () => {
  it('本人→爸爸→叔叔', () => {
    const edges = [e('e1', 'parent', 'dad', 'me'), e('e2', 'sibling', 'dad', 'uncle')];
    const path = findPath(edges, 'me', 'uncle', nameOf)!;
    expect(path.personIds).toEqual(['me', 'dad', 'uncle']);
    expect(path.hops).toHaveLength(2);
    expect(path.text).toContain('叔叔');
  });

  it('parent 边双向可走：叔叔→本人', () => {
    const edges = [e('e1', 'parent', 'dad', 'me'), e('e2', 'sibling', 'dad', 'uncle')];
    const path = findPath(edges, 'uncle', 'me', nameOf)!;
    expect(path.personIds[0]).toBe('uncle');
    expect(path.personIds.at(-1)).toBe('me');
  });

  it('不连通返回 null', () => {
    const edges = [e('e1', 'parent', 'dad', 'me')];
    expect(findPath(edges, 'me', 'cousin', nameOf)).toBeNull();
  });

  it('本人到自己', () => {
    const path = findPath([], 'me', 'me', nameOf)!;
    expect(path.personIds).toEqual(['me']);
    expect(path.hops).toEqual([]);
  });

  it('忽略的边不可走', () => {
    const edges = [{ ...e('e2', 'sibling', 'dad', 'uncle'), source: 'ignored' as const }, e('e1', 'parent', 'dad', 'me')];
    expect(findPath(edges, 'me', 'uncle', nameOf)).toBeNull();
  });

  it('有直连时走直连（最短路径）', () => {
    const edges = [
      e('e1', 'parent', 'dad', 'me'),
      e('e2', 'parent', 'mom', 'me'),
      e('e3', 'spouse', 'dad', 'mom'),
    ];
    const path = findPath(edges, 'dad', 'mom', nameOf)!;
    expect(path.personIds).toEqual(['dad', 'mom']);
  });
});
