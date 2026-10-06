import { describe, expect, it } from 'vitest';
import { deriveFromAnchor, derivePair } from './inference';
import { lookupTerm } from './terms';

const t = (s: string) => lookupTerm(s)!;

describe('称谓对推导 derivePair', () => {
  it('爷爷→爸爸：同系相邻两代 = parent', () => {
    const r = derivePair('g', t('爷爷'), 'd', t('爸爸'))!;
    expect(r.edge.kind).toBe('parent');
    expect(r.edge.fromId).toBe('g');
    expect(r.edge.toId).toBe('d');
    expect(r.edge.label).toBe('爷爷');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('外公→妈妈：母系相邻两代 = parent', () => {
    const r = derivePair('g', t('外公'), 'm', t('妈妈'))!;
    expect(r.edge.kind).toBe('parent');
    expect(r.edge.fromId).toBe('g');
  });

  it('爸爸↔妈妈：分属父系/母系同代异性 = spouse（优先于同胞）', () => {
    const r = derivePair('a', t('爸爸'), 'b', t('妈妈'))!;
    expect(r.edge.kind).toBe('spouse');
  });

  it('关键反例：妈妈↔叔叔不是同胞（妈妈属母系、叔叔属父系）', () => {
    expect(derivePair('a', t('妈妈'), 'b', t('叔叔'))).toBeNull();
  });

  it('关键反例：爸爸↔舅舅不是同胞（跨支）', () => {
    expect(derivePair('a', t('爸爸'), 'b', t('舅舅'))).toBeNull();
  });

  it('外婆→妈妈：跨支相邻两代 = parent', () => {
    const r = derivePair('g', t('外婆'), 'm', t('妈妈'))!;
    expect(r.edge.kind).toBe('parent');
    expect(r.edge.fromId).toBe('g');
  });

  it('外公→舅舅：母系 parent', () => {
    const r = derivePair('g', t('外公'), 'u', t('舅舅'))!;
    expect(r.edge.kind).toBe('parent');
  });

  it('关键反例：爷爷↔妈妈不跨支连 parent', () => {
    expect(derivePair('g', t('爷爷'), 'm', t('妈妈'))).toBeNull();
  });

  it('关键反例：爸爸↔女儿（gen 跨支）不连 parent（方向/称谓错位）', () => {
    expect(derivePair('d', t('爸爸'), 'g', t('女儿'))).toBeNull();
  });

  it('爷爷↔奶奶 = spouse', () => {
    expect(derivePair('a', t('爷爷'), 'b', t('奶奶'))!.edge.kind).toBe('spouse');
  });

  it('外婆↔外公 = spouse（母系）', () => {
    expect(derivePair('a', t('外婆'), 'b', t('外公'))!.edge.kind).toBe('spouse');
  });

  it('奶奶↔爸爸：ancestor_mate 与同系晚辈连 parent', () => {
    const r = derivePair('g', t('奶奶'), 'd', t('爸爸'))!;
    expect(r.edge.kind).toBe('parent');
    expect(r.edge.fromId).toBe('g');
  });

  it('伯伯↔叔叔：父系同胞', () => {
    expect(derivePair('a', t('伯伯'), 'b', t('叔叔'))!.edge.kind).toBe('sibling');
  });

  it('舅舅↔阿姨：母系同胞', () => {
    expect(derivePair('a', t('舅舅'), 'b', t('阿姨'))!.edge.kind).toBe('sibling');
  });

  it('叔叔↔爸爸：同胞与直系同代 = sibling', () => {
    expect(derivePair('a', t('叔叔'), 'b', t('爸爸'))!.edge.kind).toBe('sibling');
  });

  it('舅妈↔舅舅 = spouse（姻亲↔同胞）', () => {
    expect(derivePair('a', t('舅妈'), 'b', t('舅舅'))!.edge.kind).toBe('spouse');
  });

  it('嫂子↔哥哥 = spouse', () => {
    expect(derivePair('a', t('嫂子'), 'b', t('哥哥'))!.edge.kind).toBe('spouse');
  });

  it('姐夫↔姐姐 = spouse', () => {
    expect(derivePair('a', t('姐夫'), 'b', t('姐姐'))!.edge.kind).toBe('spouse');
  });

  it('儿媳↔儿子 = spouse', () => {
    expect(derivePair('a', t('儿媳'), 'b', t('儿子'))!.edge.kind).toBe('spouse');
  });

  it('女婿↔女儿 = spouse', () => {
    expect(derivePair('a', t('女婿'), 'b', t('女儿'))!.edge.kind).toBe('spouse');
  });

  it('关键反例：姐夫↔嫂子不是夫妻（姻家对姻家）', () => {
    expect(derivePair('a', t('姐夫'), 'b', t('嫂子'))).toBeNull();
  });

  it('关键反例：舅妈↔叔叔不是同胞（跨系）', () => {
    expect(derivePair('a', t('舅妈'), 'b', t('叔叔'))).toBeNull();
  });

  it('关键反例：爷爷↔外公不跨系强连', () => {
    expect(derivePair('a', t('爷爷'), 'b', t('外公'))).toBeNull();
  });

  it('关键反例：舅舅↔爸爸不跨系连同胞', () => {
    expect(derivePair('a', t('舅舅'), 'b', t('爸爸'))).toBeNull();
  });

  it('隔代直系给低置信度 kin 建议（爷爷↔我）', () => {
    const r = derivePair('g', t('爷爷'), 'me', t('本人'))!;
    expect(r.edge.kind).toBe('kin');
    expect(r.confidence).toBeLessThan(0.5);
  });

  it('堂表亲 = kin', () => {
    const r = derivePair('a', t('表哥'), 'b', t('表妹'))!;
    expect(r.edge.kind).toBe('kin');
    expect(r.edge.label).toBe('堂表亲');
  });

  it('儿子→孙子：子系相邻两代 = parent', () => {
    const r = derivePair('s', t('儿子'), 'g', t('孙子'))!;
    expect(r.edge.kind).toBe('parent');
    expect(r.edge.fromId).toBe('s');
    expect(r.edge.toId).toBe('g');
  });

  it('女儿→外孙：相邻两代直系，跨称呼系也成立', () => {
    const r = derivePair('d', t('女儿'), 'g', t('外孙'))!;
    expect(r.edge.kind).toBe('parent');
    expect(r.edge.fromId).toBe('d');
    expect(r.edge.toId).toBe('g');
  });

  it('反例：舅舅↔爸爸这种旁系跨系不连', () => {
    expect(derivePair('u', t('舅舅'), 'd', t('爸爸'))).toBeNull();
  });
});

describe('锚点直接推导 deriveFromAnchor', () => {
  it('本人↔爸爸：parent 方向是爸爸→本人', () => {
    const r = deriveFromAnchor('me', 'dad', t('爸爸'))!;
    expect(r.edge.kind).toBe('parent');
    expect(r.edge.fromId).toBe('dad');
    expect(r.edge.toId).toBe('me');
  });

  it('本人↔妻子 = spouse', () => {
    expect(deriveFromAnchor('me', 'w', t('妻子'))!.edge.kind).toBe('spouse');
  });

  it('本人↔儿子：parent 方向本人→儿子', () => {
    const r = deriveFromAnchor('me', 's', t('儿子'))!;
    expect(r.edge.kind).toBe('parent');
    expect(r.edge.fromId).toBe('me');
    expect(r.edge.toId).toBe('s');
  });

  it('本人↔哥哥 = sibling', () => {
    expect(deriveFromAnchor('me', 'b', t('哥哥'))!.edge.kind).toBe('sibling');
  });

  it('本人↔舅舅 = kin（姻亲/旁系不强行 parent）', () => {
    expect(deriveFromAnchor('me', 'u', t('舅舅'))!.edge.kind).toBe('kin');
  });
});
