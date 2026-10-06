/**
 * 中文亲属称呼 → 关系路径。
 *
 * 设计原则：
 * - 只做「称呼 → 相对锚点人物的路径」的归一化，不碰数据库。
 * - 路径用「步」表示：每一步是一条 parent / partner / sibling 边 + 相对方向 + 对方性别。
 *   祖辈/叔侄/表亲等不设基础边，全部落到两步路径上。
 * - 支持口语里常见的变体（老爸↔爸爸、外婆↔姥姥、老公↔丈夫……），用归一化处理而不是堆词典条目。
 * - 覆盖常见一/二级亲属；三级以上（堂姑表舅的配偶等）只给保守的 null，不硬猜。
 */
import type { Gender, PathStep } from './types';

/** 用「关系路径片段」表示一个称呼，比手写 step 对象省一半篇幅。[边类型, 相对方向, 对方性别] */
type PathSpec = [type: PathStep['type'], direction: PathStep['direction'], gender?: Gender][];

// p=父母（向上，边方向朝我，direction=in）；c=子女（向下）；m=配偶；s=兄弟姐妹
const p = (gender: Gender = 'unknown'): PathSpec[number] => ['parent', 'in', gender];
const c = (gender: Gender = 'unknown'): PathSpec[number] => ['parent', 'out', gender];
const m = (gender: Gender = 'unknown'): PathSpec[number] => ['partner', 'out', gender];
const s = (gender: Gender = 'unknown'): PathSpec[number] => ['sibling', 'out', gender];

function toSteps(spec: PathSpec): PathStep[] {
  return spec.map(([type, direction, gender], i) => ({ type, direction, gender: gender ?? 'unknown', index: i + 1 }));
}

/**
 * 称呼归一化：去口语前缀、统一同义字。
 */
export function normalizeLabel(raw: string): string {
  let t = raw.trim();
  // 去掉「我」前缀与称呼后缀
  t = t.replace(/^我/, '');
  t = t.replace(/(老人家|大人)$/, '');
  // 同义归一
  const alias: Record<string, string> = {
    老爸: '爸爸', 老爹: '爸爸', 爹: '爸爸', 父亲: '爸爸', 爸: '爸爸', 爸比: '爸爸',
    老妈: '妈妈', 娘: '妈妈', 母亲: '妈妈', 妈: '妈妈', 妈咪: '妈妈',
    老公: '丈夫', 先生: '丈夫', 男人: '丈夫', 外子: '丈夫',
    老婆: '妻子', 太太: '妻子', 夫人: '妻子', 内人: '妻子', 女人: '妻子', 爱人: '配偶',
    // 「媳妇/媳妇儿」在多数方言里指儿子的妻子；丈夫对妻子的称呼用「老婆/妻子」
    媳妇: '儿媳', 媳妇儿: '儿媳',
    闺女: '女儿', 姑娘: '女儿', 千金: '女儿', 女: '女儿', 儿: '儿子',
    哥: '哥哥', 兄长: '哥哥',
    弟: '弟弟',
    姐: '姐姐', 姊姊: '姐姐',
    妹: '妹妹',
    祖父: '爷爷', 奶爷: '爷爷',
    祖母: '奶奶',
    姥爷: '外公', 外祖父: '外公',
    姥姥: '外婆', 外祖母: '外婆', 姥娘: '外婆',
    孙: '孙子',
    孙媳: '孙媳妇',
    伯父: '伯伯', 大伯: '伯伯',
    叔: '叔叔', 叔父: '叔叔',
    姑母: '姑姑', 姑妈: '姑姑', 姑: '姑姑',
    舅父: '舅舅', 舅: '舅舅',
    姨母: '阿姨', 姨妈: '阿姨', 姨: '阿姨',
    大妈: '伯母', 大娘: '伯母',
    婶母: '婶婶', 婶子: '婶婶', 婶: '婶婶',
    舅母: '舅妈',
    姨夫: '姨父', 姨丈: '姨父',
    姑夫: '姑父', 姑丈: '姑父',
    侄儿: '侄子',
    儿媳妇: '儿媳',
    嫂嫂: '嫂子', 嫂: '嫂子',
    弟妇: '弟媳',
    妹婿: '妹夫',
    岳丈: '岳父', 老丈人: '岳父', 丈人: '岳父',
    丈母娘: '岳母',
  };
  return alias[t] ?? t;
}

/**
 * 称呼词典：归一化称呼 → 路径。
 * 路径从「锚点人物」出发。p=父母(向上) c=子女(向下) m=配偶 s=兄弟姐妹。
 */
const LABEL_PATHS: Record<string, PathSpec> = {
  // 一级直系
  爸爸: [p('male')],
  妈妈: [p('female')],
  儿子: [c('male')],
  女儿: [c('female')],
  丈夫: [m('male')],
  妻子: [m('female')],
  配偶: [m('unknown')],
  哥哥: [s('male')],
  弟弟: [s('male')],
  姐姐: [s('female')],
  妹妹: [s('female')],

  // 二级：祖辈（第二个父/母的性别决定父系/母系）
  爷爷: [p('unknown'), p('male')],
  奶奶: [p('unknown'), p('female')],
  外公: [p('female'), p('male')],
  外婆: [p('female'), p('female')],

  // 二级：子女的子女
  孙子: [c('unknown'), c('male')],
  孙女: [c('unknown'), c('female')],
  孙媳妇: [c('unknown'), c('male'), m('female')],
  孙女婿: [c('unknown'), c('female'), m('male')],

  // 二级：父母的兄弟姐妹（伯伯/叔叔同路径，年龄长幼需靠生卒年区分）
  伯伯: [p(), s('male')],
  叔叔: [p(), s('male')],
  姑姑: [p(), s('female')],
  舅舅: [p('female'), s('male')],
  阿姨: [p('female'), s('female')],

  // 二级：父母的兄弟姐妹的配偶
  伯母: [p(), s('male'), m('female')],
  婶婶: [p(), s('male'), m('female')],
  姑父: [p(), s('female'), m('male')],
  舅妈: [p('female'), s('male'), m('female')],
  姨父: [p('female'), s('female'), m('male')],

  // 二级：兄弟姐妹的子女（侄=兄弟的孩子，外甥=姐妹的孩子）
  侄子: [s('male'), c('male')],
  侄女: [s('male'), c('female')],
  外甥: [s('female'), c('male')],
  外甥女: [s('female'), c('female')],

  // 二级：子女的配偶
  儿媳: [c('male'), m('female')],
  女婿: [c('female'), m('male')],

  // 二级：兄弟姐妹的配偶
  嫂子: [s('male'), m('female')],
  弟媳: [s('male'), m('female')],
  姐夫: [s('female'), m('male')],
  妹夫: [s('female'), m('male')],

  // 二级：配偶的父母
  公公: [m('male'), c('male')],
  婆婆: [m('male'), c('female')],
  岳父: [m('female'), c('male')],
  岳母: [m('female'), c('female')],
};

/** 所有能解析的称呼（归一化后），供前端自动补全。 */
export function knownLabels(): string[] {
  return Object.keys(LABEL_PATHS);
}

/**
 * 解析一个口语称呼。
 * @returns 归一化称呼 + 路径；词典里没有时返回 null（三级以上亲属、非亲属称呼等）。
 */
export function parseLabel(raw: string): { label: string; path: PathStep[] } | null {
  const label = normalizeLabel(raw);
  const spec = LABEL_PATHS[label];
  if (!spec) return null;
  return { label, path: toSteps(spec) };
}
