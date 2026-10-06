import { describe, expect, it } from 'vitest';
import {
  buildInferredEdges,
  detectIssues,
  inferFromItemRoles,
  KinshipEngine,
  parseLabel,
  toDot,
  toEdgesCsv,
  toGedcom,
  type KinshipEdgeData,
  type KinshipGraphInput,
  type KinshipPerson,
} from './index';

let seq = 0;
const edge = (
  fromPersonId: string,
  toPersonId: string,
  type: KinshipEdgeData['type'],
  extra: Partial<KinshipEdgeData> = {},
): KinshipEdgeData => ({
  id: `e${(seq += 1)}`,
  fromPersonId,
  toPersonId,
  type,
  origin: 'manual',
  confidence: 'high',
  confirmed: true,
  note: null,
  evidence: null,
  ...extra,
});

const person = (id: string, name: string, extra: Partial<KinshipPerson> = {}): KinshipPerson => ({
  id,
  name,
  gender: 'unknown',
  birthYear: null,
  deathYear: null,
  relation: null,
  ...extra,
});

const family: KinshipPerson[] = [
  person('me', '我', { gender: 'unknown' }),
  person('dad', '爸爸', { gender: 'male', birthYear: 1955, relation: '爸爸' }),
  person('mom', '妈妈', { gender: 'female', birthYear: 1958, relation: '妈妈' }),
  person('wf', '外公', { gender: 'male', birthYear: 1930, relation: '外公' }),
  person('wm', '外婆', { gender: 'female', birthYear: 1932, relation: '外婆' }),
  person('son', '儿子', { gender: 'male', birthYear: 1990, relation: '儿子' }),
];

const baseEdges: KinshipEdgeData[] = [
  edge('dad', 'me', 'parent'),
  edge('mom', 'me', 'parent'),
  edge('wf', 'mom', 'parent'),
  edge('wm', 'mom', 'parent'),
  edge('me', 'son', 'parent'),
];

describe('称呼解析', () => {
  it('归一化口语变体', () => {
    expect(parseLabel('老爸')?.label).toBe('爸爸');
    expect(parseLabel('姥姥')?.label).toBe('外婆');
    expect(parseLabel('我老公')?.label).toBe('丈夫');
  });

  it('一级称呼是单步路径且带性别', () => {
    expect(parseLabel('妈妈')?.path).toEqual([
      { type: 'parent', direction: 'in', gender: 'female', index: 1 },
    ]);
    expect(parseLabel('儿子')?.path[0]).toMatchObject({ type: 'parent', direction: 'out', gender: 'male' });
    expect(parseLabel('姐姐')?.path[0]).toMatchObject({ type: 'sibling', direction: 'out', gender: 'female' });
  });

  it('祖辈路径两步，且区分父系/母系', () => {
    expect(parseLabel('爷爷')?.path.map((s) => s.type)).toEqual(['parent', 'parent']);
    expect(parseLabel('外公')?.path[0]).toMatchObject({ type: 'parent', direction: 'in', gender: 'female' });
    expect(parseLabel('外公')?.path[1]).toMatchObject({ type: 'parent', direction: 'in', gender: 'male' });
  });

  it('不认识的称呼返回 null', () => {
    expect(parseLabel('老战友')).toBeNull();
    expect(parseLabel('三表妹的二舅公')).toBeNull();
  });
});

describe('图谱推导', () => {
  const input: KinshipGraphInput = { people: family, edges: baseEdges, anchorPersonId: 'me' };

  it('沿 parent 边找父母子女', () => {
    const engine = new KinshipEngine(input);
    expect(engine.parents('me').map((p) => p.id).sort()).toEqual(['dad', 'mom']);
    expect(engine.children('me').map((p) => p.id)).toEqual(['son']);
  });

  it('反推祖辈称呼（爷爷/外公靠中间一代性别区分）', () => {
    const engine = new KinshipEngine(input);
    expect(engine.deriveRelation('me', 'wf')?.title).toBe('外公');
    expect(engine.deriveRelation('me', 'wm')?.title).toBe('外婆');
    expect(engine.deriveRelation('me', 'son')?.title).toBe('儿子');
    expect(engine.deriveRelation('me', 'dad')?.title).toBe('爸爸');
  });

  it('从妈妈反推她的父亲是外公，而不是爷爷', () => {
    const engine = new KinshipEngine(input);
    const rel = engine.deriveRelation('me', 'wf');
    expect(rel?.type).toBe('grandparent');
  });

  it('叔侄与兄弟姐妹', () => {
    const people = [
      ...family,
      person('uncle', '舅舅', { gender: 'male', relation: '舅舅' }),
      person('sister', '姐姐', { gender: 'female', birthYear: 1980, relation: '姐姐' }),
      person('nephew', '外甥', { gender: 'male', relation: '外甥' }),
    ];
    const edges = [
      ...baseEdges,
      edge('wf', 'uncle', 'parent'),
      edge('mom', 'uncle', 'sibling'),
      edge('mom', 'sister', 'parent'),
      edge('sister', 'nephew', 'parent'),
    ];
    const engine = new KinshipEngine({ people, edges, anchorPersonId: 'me' });
    expect(engine.deriveRelation('me', 'uncle')?.title).toBe('舅舅');
    expect(engine.deriveRelation('me', 'sister')?.title).toBe('姐妹');
    expect(engine.deriveRelation('me', 'nephew')?.title).toBe('外甥');
  });
});

describe('从人物称呼推导边', () => {
  it('缺中间人物时不造边，只报 unresolved', () => {
    // 只给「我」和「外公」，没有妈妈：外公路径落不下去
    const people = [person('me', '我'), person('wf', '外公', { gender: 'male', relation: '外公' })];
    const result = buildInferredEdges({ people, edges: [], anchorPersonId: 'me' });
    expect(result.edges).toEqual([]);
    expect(result.unresolved[0]?.personId).toBe('wf');
  });

  it('路径完整时补出缺失边，且不重复已有边', () => {
    const people = [
      person('me', '我'),
      person('mom', '妈妈', { gender: 'female', relation: '妈妈' }),
      person('wf', '外公', { gender: 'male', relation: '外公' }),
    ];
    // 只有 妈妈→我，缺 外公→妈妈
    const result = buildInferredEdges({ people, edges: [edge('mom', 'me', 'parent')], anchorPersonId: 'me' });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({ type: 'parent', fromPersonId: 'wf', toPersonId: 'mom' });
    expect(result.edges[0]!.evidence.source).toBe('person_label');
  });

  it('从物品「继承」角色只给低置信度建议，不自动造边', () => {
    const people = [person('a', '长辈'), person('b', '晚辈')];
    const result = inferFromItemRoles(
      [
        { itemId: 'i1', personId: 'a', role: 'gifted' },
        { itemId: 'i1', personId: 'b', role: 'inherited' },
        { itemId: 'i2', personId: 'a', role: 'source' },
        { itemId: 'i2', personId: 'b', role: 'inherited' },
      ],
      people,
    );
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({
      type: 'parent',
      fromPersonId: 'a',
      toPersonId: 'b',
      confidence: 'low',
    });
    expect(result.suggestions[0]!.evidence.itemIds).toEqual(['i1', 'i2']);
  });
});

describe('矛盾检测', () => {
  it('自环报错', () => {
    const issues = detectIssues({ people: family, edges: [edge('me', 'me', 'parent')], anchorPersonId: 'me' });
    expect(issues.some((i) => i.kind === 'self_loop' && i.severity === 'error')).toBe(true);
  });

  it('parent 代际环报错', () => {
    const issues = detectIssues({
      people: family,
      edges: [edge('dad', 'me', 'parent'), edge('me', 'son', 'parent'), edge('son', 'dad', 'parent')],
    });
    expect(issues.some((i) => i.kind === 'cycle')).toBe(true);
  });

  it('父母比孩子小报错（年龄倒挂）', () => {
    const people = [
      person('p', '父', { gender: 'male', birthYear: 1990 }),
      person('c', '子', { gender: 'male', birthYear: 1960 }),
    ];
    const issues = detectIssues({ people, edges: [edge('p', 'c', 'parent')] });
    expect(issues.find((i) => i.kind === 'age_reversed')?.severity).toBe('error');
  });

  it('去世早于出生报错', () => {
    const people = [
      person('p', '父', { gender: 'male', birthYear: 1950, deathYear: 1940 }),
      person('c', '子', { gender: 'male', birthYear: 1980 }),
    ];
    const issues = detectIssues({ people, edges: [edge('p', 'c', 'parent')] });
    expect(issues.some((i) => i.kind === 'death_before_birth')).toBe(true);
  });

  it('兄弟姐妹年龄差过大给 warning', () => {
    const people = [
      person('a', '甲', { birthYear: 1900 }),
      person('b', '乙', { birthYear: 1980 }),
    ];
    const issues = detectIssues({ people, edges: [edge('a', 'b', 'sibling')] });
    expect(issues.find((i) => i.kind === 'sibling_age_gap')?.severity).toBe('warning');
  });

  it('称呼与图谱冲突：写外公却从爸爸那边连来', () => {
    // 外公挂在爸爸下面（错误地），应报 title_conflict
    const people = [
      person('me', '我'),
      person('dad', '爸', { gender: 'male', relation: '爸爸' }),
      person('wf', '外公', { gender: 'male', relation: '外公' }),
    ];
    const edges = [edge('dad', 'me', 'parent'), edge('wf', 'dad', 'parent')];
    const issues = detectIssues({ people, edges, anchorPersonId: 'me' });
    expect(issues.some((i) => i.kind === 'title_conflict')).toBe(true);
  });

  it('正常家庭不报错', () => {
    const issues = detectIssues({ people: family, edges: baseEdges, anchorPersonId: 'me' });
    expect(issues).toEqual([]);
  });

  it('性别与一级称呼相反时报 gender_mismatch', () => {
    const people = [
      person('me', '我'),
      person('x', '某人', { gender: 'male', relation: '妈妈' }),
    ];
    const issues = detectIssues({ people, edges: [edge('x', 'me', 'parent')], anchorPersonId: 'me' });
    expect(issues.some((i) => i.kind === 'gender_mismatch')).toBe(true);
  });
});

describe('非标准家庭结构', () => {
  it('两个父母（不依赖配偶边）都能推到祖辈', () => {
    const people = [
      person('me', '我'),
      person('dad', '爸', { gender: 'male' }),
      person('mom', '妈', { gender: 'female' }),
      person('gf', '奶奶', { gender: 'female' }),
      person('wf', '外公', { gender: 'male' }),
    ];
    const edges = [edge('dad', 'me', 'parent'), edge('mom', 'me', 'parent'), edge('gf', 'dad', 'parent'), edge('wf', 'mom', 'parent')];
    const engine = new KinshipEngine({ people, edges, anchorPersonId: 'me' });
    expect(engine.deriveRelation('me', 'gf')?.title).toBe('奶奶');
    expect(engine.deriveRelation('me', 'wf')?.title).toBe('外公');
  });

  it('共享父母自动算兄弟姐妹，不需要再手画 sibling 边', () => {
    const people = [person('me', '我'), person('mom', '妈', { gender: 'female' }), person('bro', '哥', { gender: 'male' })];
    const edges = [edge('mom', 'me', 'parent'), edge('mom', 'bro', 'parent')];
    const engine = new KinshipEngine({ people, edges, anchorPersonId: 'me' });
    expect(engine.deriveRelation('me', 'bro')?.title).toBe('兄弟');
  });

  it('两个配偶（再婚）不报配偶环', () => {
    const people = [person('a', '甲'), person('b', '乙'), person('c', '丙')];
    const edges = [edge('a', 'b', 'partner'), edge('a', 'c', 'partner')];
    const issues = detectIssues({ people, edges });
    expect(issues.filter((i) => i.kind === 'cycle')).toEqual([]);
  });
});

describe('导出', () => {  const input: KinshipGraphInput = { people: family, edges: baseEdges, anchorPersonId: 'me' };

  it('CSV 含表头与每条边', () => {
    const csv = toEdgesCsv(input);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('关系类型');
    expect(lines).toHaveLength(baseEdges.length + 1);
  });

  it('DOT 含节点与 parent 有向边', () => {
    const dot = toDot(input);
    expect(dot).toContain('digraph');
    expect(dot).toContain('->');
  });

  it('GEDCOM 结构合法：HEAD/INDI/FAM/TRLR，父母带 FAMS、子女带 FAMC', () => {
    const ged = toGedcom(input, '张家');
    expect(ged).toContain('0 HEAD');
    expect(ged).toContain('0 TRLR');
    expect(ged).toMatch(/0 @P\d+@ INDI/);
    expect(ged).toMatch(/1 SEX M/);
    // 爸爸是某个家庭的丈夫
    expect(ged).toMatch(/1 HUSB @P\d+@/);
    // 「我」作为某人子女出现 CHIL，同时作为儿子的家长出现 FAMS
    expect(ged).toMatch(/1 CHIL @P1@/);
    // 一人一块 INDI
    const indiCount = (ged.match(/0 @P\d+@ INDI/g) ?? []).length;
    expect(indiCount).toBe(family.length);
  });
});
