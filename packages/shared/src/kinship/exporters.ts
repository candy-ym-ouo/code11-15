/**
 * 关系图谱导出：三种离线格式。
 * - GEDCOM 5.5.1：家谱软件（Gramps / MyHeritage / FamilySearch）可导入的事实标准；
 * - Graphviz DOT：一行 dot 命令渲染成图片，适合打印；
 * - CSV：Excel/WPS 直接打开核对。
 * 全部是纯函数，不做 IO。
 */
import type { KinshipGraphInput } from './types';

interface Normalized {
  people: NonNullable<KinshipGraphInput['people']>;
  edges: NonNullable<KinshipGraphInput['edges']>;
}

function normalize(input: KinshipGraphInput): Normalized {
  return { people: input.people, edges: input.edges.filter((e) => e.fromPersonId !== e.toPersonId) };
}

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return `"${s.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

/** 亲属边 CSV：每行一条父母/配偶/兄弟姐妹关系。 */
export function toEdgesCsv(input: KinshipGraphInput): string {
  const { people, edges } = normalize(input);
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const rows = ['关系类型,人物A,人物A_性别,人物A_生年,人物B,人物B_性别,人物B_生年,来源,已确认,备注'];
  const genderText = (id: string) => ({ unknown: '未知', male: '男', female: '女' })[nameOfGender(input, id)];
  const birthOf = new Map(people.map((p) => [p.id, p.birthYear ?? '']));
  for (const e of edges) {
    rows.push(
      [
        csvCell({ parent: '父母', partner: '配偶', sibling: '兄弟姐妹' }[e.type]),
        csvCell(nameOf.get(e.fromPersonId) ?? ''),
        csvCell(genderText(e.fromPersonId)),
        csvCell(birthOf.get(e.fromPersonId) ?? ''),
        csvCell(nameOf.get(e.toPersonId) ?? ''),
        csvCell(genderText(e.toPersonId)),
        csvCell(birthOf.get(e.toPersonId) ?? ''),
        csvCell(e.origin === 'manual' ? '人工' : '推导'),
        e.confirmed ? '是' : '否',
        csvCell(e.note ?? ''),
      ].join(','),
    );
  }
  return rows.join('\n');
}

function nameOfGender(input: KinshipGraphInput, id: string): 'unknown' | 'male' | 'female' {
  return input.people.find((p) => p.id === id)?.gender ?? 'unknown';
}

/** Graphviz DOT：parent 边有方向（黑），配偶（红）、兄弟姐妹（蓝）区分样式。 */
export function toDot(input: KinshipGraphInput, title = '家族关系图谱'): string {
  const { people, edges } = normalize(input);
  const lines: string[] = [];
  lines.push(`digraph ${dotId(title)} {`);
  lines.push('  rankdir=BT;');
  lines.push('  graph [fontname="sans-serif", labelloc=t, label=' + JSON.stringify(title) + '];');
  lines.push('  node [shape=box, style="rounded,filled", fillcolor="#f5f1e8", fontname="sans-serif"];');
  lines.push('  edge [fontname="sans-serif"];');

  for (const p of people) {
    const years = [p.birthYear, p.deathYear].filter(Boolean).join('–');
    const label = years ? `${p.name}\\n${years}` : p.name;
    const fill = p.id === input.anchorPersonId ? '#ffe9c2' : '#f5f1e8';
    lines.push(`  ${dotId(p.id)} [label=${JSON.stringify(label)}, fillcolor="${fill}"];`);
  }

  for (const e of edges) {
    const a = dotId(e.fromPersonId);
    const b = dotId(e.toPersonId);
    if (e.type === 'parent') {
      lines.push(`  ${a} -> ${b} [color="#2F4858"${e.confirmed ? '' : ', style=dashed'}];`);
    } else if (e.type === 'partner') {
      lines.push(`  ${a} -> ${b} [dir=none, color="#b05a4a", style=${e.confirmed ? 'solid' : 'dashed'}, label="配偶"];`);
    } else {
      lines.push(`  ${a} -> ${b} [dir=none, color="#4a6fa5", style=${e.confirmed ? 'solid' : 'dashed'}, label="兄弟姐妹"];`);
    }
  }
  lines.push('}');
  return lines.join('\n');
}

function dotId(raw: string): string {
  return `n_${raw.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

/**
 * GEDCOM 5.5.1 子集。
 * 用 FAM/FAMC/FAMS/HUSB/WIFE/CHIL 表达父母/配偶/兄弟姐妹（兄弟姐妹通过共同 FAM 隐式表达）。
 * 两遍构建：先把边归并成家庭单元，再输出完整 INDI 块，保证一人一块、记录合法。
 */
export function toGedcom(input: KinshipGraphInput, familyName = '家族'): string {
  const { people, edges } = normalize(input);
  const xref = new Map<string, string>();
  people.forEach((p, i) => xref.set(p.id, `@P${i + 1}@`));

  const units = buildFamilyUnits(edges);
  // 每个人出现在哪些家庭、扮演什么角色
  const spouseIn = new Map<string, string[]>();
  const childIn = new Map<string, string[]>();
  units.forEach((unit, i) => {
    const fx = `@F${i + 1}@`;
    for (const pid of unit.parents) pushMap(spouseIn, pid, fx);
    for (const pid of unit.children) pushMap(childIn, pid, fx);
  });

  const lines: string[] = [];
  lines.push('0 HEAD');
  lines.push('1 SOUR Heirloom');
  lines.push('2 NAME 家中物品来历册');
  lines.push('1 GEDC');
  lines.push('2 VERS 5.5.1');
  lines.push('2 FORM LINEAGE-LINKED');
  lines.push('1 CHAR UTF-8');

  for (const p of people) {
    lines.push(`0 ${xref.get(p.id)} INDI`);
    lines.push(`1 NAME ${p.name}`);
    lines.push(`1 SURN ${familyName}`);
    if (p.gender !== 'unknown') lines.push(`1 SEX ${p.gender === 'male' ? 'M' : 'F'}`);
    if (p.birthYear) {
      lines.push('1 BIRT');
      lines.push(`2 DATE ${p.birthYear}`);
    }
    if (p.deathYear) {
      lines.push('1 DEAT');
      lines.push(`2 DATE ${p.deathYear}`);
    }
    for (const fx of spouseIn.get(p.id) ?? []) lines.push(`1 FAMS ${fx}`);
    for (const fx of childIn.get(p.id) ?? []) lines.push(`1 FAMC ${fx}`);
    if (p.relation) lines.push(`1 NOTE 称呼：${p.relation}`);
  }

  units.forEach((unit, i) => {
    const fx = `@F${i + 1}@`;
    lines.push(`0 ${fx} FAM`);
    for (const pid of unit.parents) {
      const person = people.find((p) => p.id === pid);
      if (person?.gender === 'female') lines.push(`1 WIFE ${xref.get(pid)}`);
      else lines.push(`1 HUSB ${xref.get(pid)}`);
    }
    for (const pid of unit.children) lines.push(`1 CHIL ${xref.get(pid)}`);
  });

  lines.push('0 TRLR');
  return lines.join('\r\n');
}

function pushMap<K>(map: Map<K, string[]>, key: K, value: string): void {
  const list = map.get(key) ?? [];
  if (!list.includes(value)) list.push(value);
  map.set(key, list);
}

interface FamilyUnit {
  parents: string[];
  children: string[];
}

/** 把 parent 边归并成「父母 → 孩子」单元；partner 边负责把两个父母并到同一单元（或建空单元）。 */
function buildFamilyUnits(edges: Normalized['edges']): FamilyUnit[] {
  const units: FamilyUnit[] = [];
  const unitOfParent = new Map<string, FamilyUnit>();

  // 先处理 parent 边：同一孩子的所有父母并入同一单元（即使漏录配偶边）
  const unitOfChild = new Map<string, FamilyUnit>();
  for (const e of edges.filter((x) => x.type === 'parent')) {
    let unit = unitOfChild.get(e.toPersonId);
    if (!unit) {
      // 孩子没有自己的单元时，挂靠到父母已有的单元，否则新建
      unit = unitOfParent.get(e.fromPersonId) ?? { parents: [], children: [] };
      if (!units.includes(unit)) units.push(unit);
      unitOfChild.set(e.toPersonId, unit);
    }
    if (!unit.parents.includes(e.fromPersonId)) unit.parents.push(e.fromPersonId);
    unitOfParent.set(e.fromPersonId, unit);
    if (!unit.children.includes(e.toPersonId)) unit.children.push(e.toPersonId);
  }

  // 再用 partner 边合并父母单元
  for (const e of edges.filter((x) => x.type === 'partner')) {
    const ua = unitOfParent.get(e.fromPersonId);
    const ub = unitOfParent.get(e.toPersonId);
    if (ua && ub && ua !== ub) {
      for (const p of ub.parents) {
        if (!ua.parents.includes(p)) ua.parents.push(p);
        unitOfParent.set(p, ua);
      }
      for (const c of ub.children) if (!ua.children.includes(c)) ua.children.push(c);
      units.splice(units.indexOf(ub), 1);
    } else if (ua) {
      if (!ua.parents.includes(e.toPersonId)) ua.parents.push(e.toPersonId);
      unitOfParent.set(e.toPersonId, ua);
    } else if (ub) {
      if (!ub.parents.includes(e.fromPersonId)) ub.parents.push(e.fromPersonId);
      unitOfParent.set(e.fromPersonId, ub);
    } else {
      const unit: FamilyUnit = { parents: [e.fromPersonId, e.toPersonId], children: [] };
      units.push(unit);
      unitOfParent.set(e.fromPersonId, unit);
      unitOfParent.set(e.toPersonId, unit);
    }
  }

  return units;
}
