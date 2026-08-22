import { describe, expect, it } from 'vitest';

import {
  CHAPTERS,
  PERSPECTIVE_CAPTIONS,
  PERSPECTIVE_TAGLINES,
  perspectiveCaption,
  perspectiveTagline,
  polytopeName,
  polytopeTagline,
} from '../ui/content';

/** パネルで実際に選べる範囲(perspectiveExhibit の OBSERVER/TARGET と同じ) */
const OBSERVERS = [2, 3, 4];
const TARGETS = [2, 3, 4, 5, 6];
const MODES = ['slice', 'shadow', 'xray'];

/** m ≠ n の到達しうる全組 */
function reachable(): [number, number][] {
  const out: [number, number][] = [];
  for (const m of OBSERVERS) for (const n of TARGETS) if (m !== n) out.push([m, n]);
  return out;
}

describe('perspectiveTagline', () => {
  it('到達しうる 12 組すべてに専用の一文がある(フォールバックへ落ちない)', () => {
    const combos = reachable();
    expect(combos.length).toBe(12);
    for (const [m, n] of combos) {
      expect(PERSPECTIVE_TAGLINES[`${m}:${n}`], `m=${m} n=${n} の副題が無い`).toBeTypeOf('string');
    }
  });

  it('既定の入口(m=3 / n=4)の一文は変えない', () => {
    // この展示の核。設定に追従させても、既定ではこれが出ること
    expect(perspectiveTagline(3, 4)).toBe('あなたはテッセラクトに対して、二次元人だ');
  });

  it('組が違えば一文も違う ── 設定を変えたのに同じ文、が起きない', () => {
    const seen = new Set(reachable().map(([m, n]) => perspectiveTagline(m, n)));
    expect(seen.size).toBe(12);
  });

  it('表に無い組でも必ず何かを返し、見下ろす側かどうかで言い分ける', () => {
    expect(perspectiveTagline(5, 9)).toContain('9');
    expect(perspectiveTagline(9, 5)).toContain('見下ろ');
  });
});

describe('perspectiveCaption', () => {
  it('到達しうる全 (モード, m, n) で空文字にならない', () => {
    for (const mode of MODES) {
      for (const [m, n] of reachable()) {
        // モードの整合(低い側から = 断面/影、高い側から = X線)だけを見る
        if (mode === 'xray' ? m <= n : m >= n) continue;
        expect(perspectiveCaption(mode, m, n), `${mode}:${m}:${n}`).not.toBe('');
      }
    }
  });

  it('個別の組が無ければモード共通の一文へ落ちる', () => {
    expect(PERSPECTIVE_CAPTIONS['shadow:4:5']).toBeUndefined();
    expect(perspectiveCaption('shadow', 4, 5)).toBe(PERSPECTIVE_CAPTIONS['shadow']);
  });
});

/* --------------------------------------------------------------------- POLYTOPE */

/** パネルで実際に選べる範囲(polytopeExhibit の N_MIN / N_MAX と族) */
const FAMILIES = ['cube', 'simplex', 'orthoplex'];
const NS = [3, 4, 5, 6, 7, 8, 9, 10];

/** 展示が渡すのと同じ数え方(math/polytopes と一致していること) */
function counts(family: string, n: number): [number, number] {
  if (family === 'cube') return [1 << n, n * (1 << (n - 1))];
  if (family === 'simplex') return [n + 1, ((n + 1) * n) / 2];
  return [2 * n, 2 * n * (n - 1)];
}

describe('polytopeName', () => {
  it('3・4 次元には固有の名がある', () => {
    expect(polytopeName('cube', 3)).toBe('立方体');
    expect(polytopeName('cube', 4)).toBe('テッセラクト');
    expect(polytopeName('simplex', 3)).toBe('正四面体');
    expect(polytopeName('simplex', 4)).toBe('五胞体');
    expect(polytopeName('orthoplex', 3)).toBe('正八面体');
    expect(polytopeName('orthoplex', 4)).toBe('正十六胞体');
  });

  it('超立方体の名は 6 で尽き、7 から数で呼ぶ ── 終章「名前がまだ足りない」の実演', () => {
    // ここは作品上の判断。語を足して「直さない」こと(content.ts の CUBE_NAMES を参照)
    expect(polytopeName('cube', 5)).toBe('ペンテラクト');
    expect(polytopeName('cube', 6)).toBe('ヘクセラクト');
    expect(polytopeName('cube', 7)).toBe('七次元の超立方体');
    expect(polytopeName('cube', 10)).toBe('十次元の超立方体');
  });

  it('固有名を持たない次元は族の総称で呼ぶ', () => {
    expect(polytopeName('simplex', 7)).toBe('七次元の単体');
    expect(polytopeName('orthoplex', 9)).toBe('九次元の正軸体');
  });
});

describe('polytopeTagline', () => {
  it('着地(cube / n=7)の一文 ── 名前は言語、数は算術', () => {
    expect(polytopeTagline('cube', 7, 128, 448)).toBe('七次元の超立方体 ── 128 の頂点、448 の辺');
  });

  it('4 桁は 3 桁区切りにする', () => {
    expect(polytopeTagline('cube', 10, 1024, 5120)).toBe(
      '十次元の超立方体 ── 1,024 の頂点、5,120 の辺',
    );
  });

  it('到達しうる 24 組すべてで一文が違う ── 設定を変えたのに同じ文、が起きない', () => {
    const seen = new Set<string>();
    for (const family of FAMILIES) {
      for (const n of NS) {
        const [v, e] = counts(family, n);
        const line = polytopeTagline(family, n, v, e);
        expect(line, `${family} n=${n}`).not.toBe('');
        seen.add(line);
      }
    }
    expect(seen.size).toBe(FAMILIES.length * NS.length);
  });
});

describe('終章 → ギャラリーの受け渡し', () => {
  /**
   * CTA は「振り出した約束」、着地の副題は「渡すもの」。同じ数を名乗っていること。
   * 片方だけ書き換えると、押した先が約束と違う ── Phase 41 で直したのがこれ。
   */
  it('終章の CTA と、着地する展示の副題が同じ数を名乗る', () => {
    const epilogue = CHAPTERS[CHAPTERS.length - 1];
    expect(epilogue.id).toBe('epilogue');
    expect(epilogue.cta).toBeTypeOf('string');
    expect(epilogue.cta).toContain('七');
    // 着地は EXHIBIT_REGISTRY の先頭 = polytope / cube / n=7(gallery.ts)
    expect(polytopeTagline('cube', 7, 128, 448)).toContain('七');
  });

  it('終章の本文と座標が、その数を先に名指ししている', () => {
    const epilogue = CHAPTERS[CHAPTERS.length - 1];
    expect(epilogue.jp.body).toContain('七');
    expect(epilogue.coord).toContain('07');
  });
});
