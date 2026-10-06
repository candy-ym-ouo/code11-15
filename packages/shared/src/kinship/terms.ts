/**
 * 中文亲属称谓词典。
 *
 * 系统里的 Person 只有一个自由文本 relation（如「外公」「二舅」），
 * 这里把常见称谓解析成结构化特征，供「从共现人物推导亲属关系」使用：
 *
 * - gen：相对于「本人/我」这一代的代数差（父辈 1、祖辈 2、子辈 -1 ……）
 * - gender：称谓所指人物的性别
 * - cls：lineal 直系 / sibling 同胞 / cousin 堂表 / spouse 配偶 / inlaw 姻亲 / ancestor_mate 祖辈配偶
 * - side：父系/母系/子系/平辈（用于「爷爷→爸爸→我」这类同链推导，不做现实宗族判断）
 *
 * 词典刻意保持克制：收录常见称谓，少见/歧义称谓宁可不推，也不乱推
 * （推导结果本来就需要人工确认）。
 */

export type TermGender = 'male' | 'female';
/** 关系类别：直系 / 同胞 / 堂表 / 配偶 / 姻亲 / 祖辈配偶（奶奶、外婆） */
export type TermClass = 'lineal' | 'sibling' | 'cousin' | 'spouse' | 'inlaw' | 'ancestor_mate';
export type TermSide = 'father' | 'mother' | 'son' | 'self';

export interface TermFeature {
  /** 规范化后的称谓（匹配时先剥前缀排行） */
  term: string;
  /** 相对「本人」的代数差 */
  gen: number;
  gender: TermGender;
  cls: TermClass;
  side: TermSide;
  /** 直系时距本人的跨度（爷爷=2、爸爸=1、儿子=1、孙子=2）；非直系为 0 */
  depth: number;
}

type Entry = Omit<TermFeature, 'term'>;

const L = (gen: number, gender: TermGender, side: TermSide, depth: number): Entry => ({
  gen,
  gender,
  cls: 'lineal',
  side,
  depth,
});
const S = (gen: number, gender: TermGender, side: TermSide): Entry => ({ gen, gender, cls: 'sibling', side, depth: 0 });
const C = (gen: number, gender: TermGender, side: TermSide): Entry => ({ gen, gender, cls: 'cousin', side, depth: 0 });
const I = (gen: number, gender: TermGender, side: TermSide): Entry => ({ gen, gender, cls: 'inlaw', side, depth: 0 });

const RAW: Record<string, Entry> = {
  // —— 本人与配偶 ——
  本人: { gen: 0, gender: 'male', cls: 'lineal', side: 'self', depth: 0 },
  我: { gen: 0, gender: 'male', cls: 'lineal', side: 'self', depth: 0 },
  丈夫: { gen: 0, gender: 'male', cls: 'spouse', side: 'self', depth: 0 },
  先生: { gen: 0, gender: 'male', cls: 'spouse', side: 'self', depth: 0 },
  老公: { gen: 0, gender: 'male', cls: 'spouse', side: 'self', depth: 0 },
  妻子: { gen: 0, gender: 'female', cls: 'spouse', side: 'self', depth: 0 },
  太太: { gen: 0, gender: 'female', cls: 'spouse', side: 'self', depth: 0 },
  老婆: { gen: 0, gender: 'female', cls: 'spouse', side: 'self', depth: 0 },
  爱人: { gen: 0, gender: 'male', cls: 'spouse', side: 'self', depth: 0 },

  // —— 祖辈（父系 / 母系；奶奶、外婆是祖辈配偶）——
  爷爷: L(2, 'male', 'father', 2),
  祖父: L(2, 'male', 'father', 2),
  奶奶: { gen: 2, gender: 'female', cls: 'ancestor_mate', side: 'father', depth: 2 },
  祖母: { gen: 2, gender: 'female', cls: 'ancestor_mate', side: 'father', depth: 2 },
  外公: L(2, 'male', 'mother', 2),
  外祖父: L(2, 'male', 'mother', 2),
  姥姥: { gen: 2, gender: 'female', cls: 'ancestor_mate', side: 'mother', depth: 2 },
  外婆: { gen: 2, gender: 'female', cls: 'ancestor_mate', side: 'mother', depth: 2 },
  外祖母: { gen: 2, gender: 'female', cls: 'ancestor_mate', side: 'mother', depth: 2 },

  // —— 曾祖辈 ——
  太爷爷: L(3, 'male', 'father', 3),
  曾祖父: L(3, 'male', 'father', 3),
  太奶奶: { gen: 3, gender: 'female', cls: 'ancestor_mate', side: 'father', depth: 3 },
  曾祖母: { gen: 3, gender: 'female', cls: 'ancestor_mate', side: 'father', depth: 3 },
  太外公: L(3, 'male', 'mother', 3),
  外曾祖父: L(3, 'male', 'mother', 3),
  太外婆: { gen: 3, gender: 'female', cls: 'ancestor_mate', side: 'mother', depth: 3 },
  外曾祖母: { gen: 3, gender: 'female', cls: 'ancestor_mate', side: 'mother', depth: 3 },

  // —— 父辈 ——
  爸爸: L(1, 'male', 'father', 1),
  父亲: L(1, 'male', 'father', 1),
  爸: L(1, 'male', 'father', 1),
  // 妈妈本人来自母系血亲支（外婆→妈妈）；与爸爸跨支配对为配偶
  妈: L(1, 'female', 'mother', 1),
  妈妈: L(1, 'female', 'mother', 1),
  母亲: L(1, 'female', 'mother', 1),
  公公: L(1, 'male', 'father', 1),
  婆婆: { gen: 1, gender: 'female', cls: 'ancestor_mate', side: 'father', depth: 1 },
  岳父: L(1, 'male', 'mother', 1),
  岳母: { gen: 1, gender: 'female', cls: 'ancestor_mate', side: 'mother', depth: 1 },
  老丈人: L(1, 'male', 'mother', 1),
  丈母娘: { gen: 1, gender: 'female', cls: 'ancestor_mate', side: 'mother', depth: 1 },

  伯伯: S(1, 'male', 'father'),
  大爷: S(1, 'male', 'father'),
  叔叔: S(1, 'male', 'father'),
  叔父: S(1, 'male', 'father'),
  姑姑: S(1, 'female', 'father'),
  姑妈: S(1, 'female', 'father'),
  姑母: S(1, 'female', 'father'),
  舅舅: S(1, 'male', 'mother'),
  舅父: S(1, 'male', 'mother'),
  舅妈: I(1, 'female', 'mother'),
  舅母: I(1, 'female', 'mother'),
  阿姨: S(1, 'female', 'mother'),
  姨妈: S(1, 'female', 'mother'),
  姨母: S(1, 'female', 'mother'),
  伯母: I(1, 'female', 'father'),
  大妈: I(1, 'female', 'father'),
  婶婶: I(1, 'female', 'father'),
  婶子: I(1, 'female', 'father'),
  姨父: I(1, 'male', 'mother'),
  姨夫: I(1, 'male', 'mother'),
  姑父: I(1, 'male', 'father'),

  // —— 平辈 ——
  哥哥: S(0, 'male', 'self'),
  兄长: S(0, 'male', 'self'),
  弟弟: S(0, 'male', 'self'),
  姐姐: S(0, 'female', 'self'),
  妹妹: S(0, 'female', 'self'),
  嫂子: I(0, 'female', 'self'),
  弟媳: I(0, 'female', 'self'),
  弟妹: I(0, 'female', 'self'),
  姐夫: I(0, 'male', 'self'),
  妹夫: I(0, 'male', 'self'),
  堂兄: C(0, 'male', 'father'),
  堂弟: C(0, 'male', 'father'),
  堂姐: C(0, 'female', 'father'),
  堂妹: C(0, 'female', 'father'),
  表兄: C(0, 'male', 'father'),
  表哥: C(0, 'male', 'father'),
  表弟: C(0, 'male', 'father'),
  表姐: C(0, 'female', 'father'),
  表妹: C(0, 'female', 'father'),

  // —— 子辈 ——
  儿子: L(-1, 'male', 'son', 1),
  女儿: L(-1, 'female', 'son', 1),
  儿媳: I(-1, 'female', 'son'),
  儿媳妇: I(-1, 'female', 'son'),
  女婿: I(-1, 'male', 'son'),
  侄子: S(-1, 'male', 'father'),
  侄女: S(-1, 'female', 'father'),
  外甥: S(-1, 'male', 'mother'),
  外甥女: S(-1, 'female', 'mother'),
  侄媳: I(-1, 'female', 'father'),
  侄女婿: I(-1, 'male', 'father'),
  外甥媳: I(-1, 'female', 'mother'),
  外甥女婿: I(-1, 'male', 'mother'),

  // —— 孙辈 ——
  孙子: L(-2, 'male', 'son', 2),
  孙女: L(-2, 'female', 'son', 2),
  外孙: L(-2, 'male', 'mother', 2),
  外孙女: L(-2, 'female', 'mother', 2),
  孙媳妇: I(-2, 'female', 'son'),
  外孙媳妇: I(-2, 'female', 'mother'),
  孙女婿: I(-2, 'male', 'son'),
  外孙女婿: I(-2, 'male', 'mother'),
};

/** 需要剥掉的排行/前缀：「二舅」→「舅舅」之前先试「舅」 */
const RANK_PREFIX = ['大', '二', '三', '四', '五', '六', '七', '八', '九', '十', '小', '老'];

/**
 * 把 Person.relation / Person.name 里的自由文本解析成称谓特征。
 * 解析不了返回 null——调用方应当跳过，而不是瞎猜。
 */
export function lookupTerm(raw: string | null | undefined): TermFeature | null {
  if (!raw) return null;
  let text = raw.trim();
  if (!text) return null;

  const direct = RAW[text];
  if (direct) return { term: text, ...direct };

  // 剥排行：「二舅」「三叔」「大哥」「小阿姨」
  if (RANK_PREFIX.includes(text[0]!)) {
    const rest = text.slice(1);
    const hit = RAW[rest];
    if (hit) return { term: rest, ...hit };
  }
  // 「大舅」「二姨」这类单字称谓 + 排行，词典用的是全称
  if (RANK_PREFIX.includes(text[0]!)) {
    const aliases: Record<string, string> = {
      舅: '舅舅', 叔: '叔叔', 伯: '伯伯', 姑: '姑姑', 姨: '阿姨', 哥: '哥哥', 姐: '姐姐',
    };
    const alias = aliases[text.slice(1)];
    if (alias && RAW[alias]) return { term: alias, ...RAW[alias]! };
  }
  // 「舅舅」可写作「舅」，「伯伯」可写作「伯」
  const single: Record<string, string> = {
    舅: '舅舅', 叔: '叔叔', 伯: '伯伯', 姑: '姑姑', 姨: '阿姨',
    哥: '哥哥', 姐: '姐姐', 弟: '弟弟', 妹: '妹妹',
  };
  const alias = single[text];
  if (alias && RAW[alias]) return { term: alias, ...RAW[alias]! };

  return null;
}

/** 「外公的弟弟」「叔叔的儿子」这类「X 的 Y」复合称谓里的「的」（含口语变体）。 */
export function splitCompound(text: string | null | undefined): string[] | null {
  if (!text) return null;
  const parts = text
    .trim()
    .split(/的|之/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length >= 2 ? parts : null;
}
