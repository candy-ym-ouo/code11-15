import { describe, expect, it } from 'vitest';
import { lookupTerm, splitCompound } from './terms';

describe('称谓词典 lookupTerm', () => {
  it('识别常见直系称谓', () => {
    expect(lookupTerm('爷爷')?.gen).toBe(2);
    expect(lookupTerm('爷爷')?.side).toBe('father');
    expect(lookupTerm('外公')?.side).toBe('mother');
    expect(lookupTerm('爸爸')?.depth).toBe(1);
    expect(lookupTerm('孙子')?.gen).toBe(-2);
  });

  it('剥掉排行前缀：二舅/三叔/大哥', () => {
    expect(lookupTerm('二舅')?.term).toBe('舅舅');
    expect(lookupTerm('三叔')?.term).toBe('叔叔');
    expect(lookupTerm('大哥')?.term).toBe('哥哥');
    expect(lookupTerm('小阿姨')?.term).toBe('阿姨');
  });

  it('单字称呼走别名', () => {
    expect(lookupTerm('舅')?.term).toBe('舅舅');
    expect(lookupTerm('哥')?.term).toBe('哥哥');
  });

  it('识别不了的自由文本返回 null，而不是瞎猜', () => {
    expect(lookupTerm('王阿姨')).toBeNull();
    expect(lookupTerm('老邻居')).toBeNull();
    expect(lookupTerm('')).toBeNull();
    expect(lookupTerm(null)).toBeNull();
  });

  it('拆分复合称谓', () => {
    expect(splitCompound('外公的弟弟')).toEqual(['外公', '弟弟']);
    expect(splitCompound('祖父之妹')).toEqual(['祖父', '妹']);
    expect(splitCompound('舅舅')).toBeNull();
  });
});
