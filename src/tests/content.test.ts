import { describe, expect, it } from 'vitest';

import { DICTS } from '../i18n';
import { LANGS, type Lang } from '../i18n/lang';
import {
  perspectiveCaptionIn,
  perspectiveTaglineIn,
  polytopeNameIn,
  polytopeTaglineIn,
} from '../i18n/lookup';
import type { Copy } from '../i18n/types';
import { reachablePairs } from '../ui/perspectiveRange';

const MODES = ['slice', 'shadow', 'xray'];

/**
 * 到達しうる全組は**実装から導出する**(Phase 42)。
 *
 * ここには以前 `const OBSERVERS = [2,3,4]` と手で写した定数が置いてあり、
 * コメントで「perspectiveExhibit と同じ」と宣言していた。写しは写し元が動いた
 * 瞬間に嘘になる ── m の上限を 5 へ上げても、テストは古い 12 組を見たまま
 * **緑で通り続ける**。範囲と規則は `ui/perspectiveRange.ts` の 1 本だけが持つ。
 */
const reachable = reachablePairs;

/**
 * **全言語を回す**(Phase 45)。
 *
 * 多言語化でいちばん起きやすい壊れ方は「片方の言語にだけ穴が空く」ことで、
 * しかも既定言語しか見ないテストはそれを緑で通す ── `ui/content.ts` は
 * `LANG` に束ねた関数しか出さないので、ここでは `i18n/lookup.ts` の
 * **辞書を引数に取る純関数**を直接突く(あちらのモジュール注の②)。
 *
 * 辞書の一覧は `DICTS` から導出する。言語を足したら、この試験は
 * **何も書き換えなくても新しい言語を見はじめる**。
 */
const dicts: readonly [Lang, Copy][] = LANGS.map((lang) => [lang, DICTS[lang]]);

describe('辞書の登録', () => {
  it('LANGS のすべてに辞書がある', () => {
    for (const lang of LANGS) expect(DICTS[lang], `${lang} の辞書が無い`).toBeDefined();
  });
});

/* --------------------------------------------------- 言語を跨いで同一であるもの */

describe('言語を跨ぐ同一性', () => {
  const [, base] = dicts[0];

  it('章の id・順序・次元・計器の読みは言語に依らない', () => {
    for (const [lang, copy] of dicts) {
      expect(copy.chapters.map((c) => c.id), lang).toEqual(base.chapters.map((c) => c.id));
      expect(copy.chapters.map((c) => c.dim), lang).toEqual(base.chapters.map((c) => c.dim));
      expect(copy.chapters.map((c) => c.role), lang).toEqual(base.chapters.map((c) => c.role));
      // 欧文ディスプレイ・章番号・次元ラベル・座標は組版であって文章ではない
      expect(copy.chapters.map((c) => c.en), lang).toEqual(base.chapters.map((c) => c.en));
      expect(copy.chapters.map((c) => c.index), lang).toEqual(base.chapters.map((c) => c.index));
      expect(copy.chapters.map((c) => c.unit), lang).toEqual(base.chapters.map((c) => c.unit));
      expect(copy.chapters.map((c) => c.coord), lang).toEqual(base.chapters.map((c) => c.coord));
    }
  });

  it('展示の id・順序・英字名は言語に依らない', () => {
    for (const [lang, copy] of dicts) {
      expect(copy.exhibits.map((e) => e.id), lang).toEqual(base.exhibits.map((e) => e.id));
      expect(copy.exhibits.map((e) => e.en), lang).toEqual(base.exhibits.map((e) => e.en));
    }
  });

  it('図鑑データの label は欧文モノなので言語に依らない', () => {
    for (const [lang, copy] of dicts) {
      for (let i = 0; i < copy.exhibits.length; i++) {
        expect(copy.exhibits[i].codex.stats.map((s) => s.label), `${lang} / ${copy.exhibits[i].id}`)
          .toEqual(base.exhibits[i].codex.stats.map((s) => s.label));
      }
    }
  });
});

/* ------------------------------------------------------- どの言語でも埋まっている */

describe('訳の穴', () => {
  it('章のタイトルと本文が空でない', () => {
    for (const [lang, copy] of dicts) {
      for (const c of copy.chapters) {
        expect(c.text.title, `${lang} / ${c.id}`).not.toBe('');
        expect(c.text.body, `${lang} / ${c.id}`).not.toBe('');
        expect(c.caption, `${lang} / ${c.id}`).not.toBe('');
      }
    }
  });

  it('序章はスクロール誘導を、終章は CTA を持つ', () => {
    for (const [lang, copy] of dicts) {
      const first = copy.chapters[0];
      const last = copy.chapters[copy.chapters.length - 1];
      expect(first.role, lang).toBe('prologue');
      expect(first.hint, lang).toBeTypeOf('string');
      expect(last.role, lang).toBe('epilogue');
      expect(last.cta, lang).toBeTypeOf('string');
    }
  });

  it('展示の副題・惹句・解説が空でない', () => {
    for (const [lang, copy] of dicts) {
      for (const e of copy.exhibits) {
        /*
          `sub` は**どの言語でも空にしない**。ExhibitHeader は
          `[subEl, taglineEl]` をまとめて行分割するので、空文字を渡すと
          分割器に空の要素が流れる(`i18n/types.ts` の注)。
        */
        expect(e.sub, `${lang} / ${e.id}`).not.toBe('');
        expect(e.tagline, `${lang} / ${e.id}`).not.toBe('');
        expect(e.explanation, `${lang} / ${e.id}`).not.toBe('');
      }
    }
  });

  it('codex の各層が埋まっている(観察 3 / クエスト 3 / 図鑑 4)', () => {
    for (const [lang, copy] of dicts) {
      for (const e of copy.exhibits) {
        const c = e.codex;
        const where = `${lang} / ${e.id}`;
        expect(c.hook, where).not.toBe('');
        expect(c.intro, where).not.toBe('');
        expect(c.metaphorTitle, where).not.toBe('');
        expect(c.metaphor, where).not.toBe('');
        // 数は原作の構成に合わせて固定する ── 訳で層が減るのを防ぐ
        expect(c.observe.length, where).toBe(3);
        expect(c.quests.length, where).toBe(3);
        expect(c.stats.length, where).toBe(4);
        for (const q of c.quests) {
          expect(q.title, where).not.toBe('');
          expect(q.body, where).not.toBe('');
        }
        for (const stat of c.stats) expect(stat.value, where).not.toBe('');
      }
    }
  });

  it('二段組みのラベルは、少なくとも片方が埋まっている', () => {
    /*
      英語では片方が空文字になる(`i18n/en.ts` の UI の注)── それは意図だが、
      **両方が空になったら見出しが消える**。`style.css` の `:empty` は
      空の側を畳むだけで、両方空のときは何も残らない。
    */
    for (const [lang, copy] of dicts) {
      const pairs = {
        ...copy.ui.drawer,
        navNarrative: copy.ui.chrome.navNarrative,
        navGallery: copy.ui.chrome.navGallery,
        about: copy.ui.chrome.about,
      };
      for (const [key, pair] of Object.entries(pairs)) {
        expect(pair.text !== '' || pair.latin !== '', `${lang} / ${key}`).toBe(true);
      }
    }
  });
});

/* --------------------------------------------------------------- PERSPECTIVE */

describe('perspectiveTagline', () => {
  it('到達しうる全組に専用の一文がある(フォールバックへ落ちない)', () => {
    const combos = reachable();
    // 数は書かない ── 範囲を広げたときに「数を直す」で済ませられると、
    // 一文を足し忘れたことに気づけなくなる。個数の主張は下の「全部違う」が担う
    expect(combos.length).toBeGreaterThan(0);
    for (const [lang, copy] of dicts) {
      for (const [m, n] of combos) {
        expect(
          copy.perspective.taglines[`${m}:${n}`],
          `${lang} / m=${m} n=${n} の副題が無い`,
        ).toBeTypeOf('string');
      }
    }
  });

  it('組が違えば一文も違う ── 設定を変えたのに同じ文、が起きない', () => {
    const combos = reachable();
    for (const [lang, copy] of dicts) {
      const seen = new Set(combos.map(([m, n]) => perspectiveTaglineIn(copy, m, n)));
      expect(seen.size, lang).toBe(combos.length);
    }
  });

  it('表に無い組でも必ず何かを返し、見下ろす側かどうかで言い分ける', () => {
    for (const [lang, copy] of dicts) {
      // 対象の次元は必ず名乗る(どちらの言語も算用数字で書く)
      expect(perspectiveTaglineIn(copy, 5, 9), lang).toContain('9');
      // 見下ろす側とそうでない側で、同じ文にならない
      expect(perspectiveTaglineIn(copy, 9, 5), lang).not.toBe(
        perspectiveTaglineIn(copy, 5, 9),
      );
      expect(perspectiveTaglineIn(copy, 9, 5), lang).not.toBe('');
    }
  });

  /** この展示の核。設定に追従させても、既定ではこれが出ること */
  it('既定の入口(m=3 / n=4)の一文は変えない', () => {
    expect(perspectiveTaglineIn(DICTS.ja, 3, 4)).toBe('あなたはテッセラクトに対して、二次元人だ');
    expect(perspectiveTaglineIn(DICTS.en, 3, 4)).toBe('To a tesseract, you are a two-dimensional being');
  });
});

describe('perspectiveCaption', () => {
  it('到達しうる全 (モード, m, n) で空文字にならない', () => {
    for (const [lang, copy] of dicts) {
      for (const mode of MODES) {
        for (const [m, n] of reachable()) {
          // モードの整合(低い側から = 断面/影、高い側から = X線)だけを見る
          if (mode === 'xray' ? m <= n : m >= n) continue;
          expect(perspectiveCaptionIn(copy, mode, m, n), `${lang} / ${mode}:${m}:${n}`).not.toBe('');
        }
      }
    }
  });

  it('個別の組が無ければモード共通の一文へ落ちる', () => {
    for (const [lang, copy] of dicts) {
      expect(copy.perspective.captions['shadow:4:5'], lang).toBeUndefined();
      expect(perspectiveCaptionIn(copy, 'shadow', 4, 5), lang).toBe(
        copy.perspective.captions['shadow'],
      );
    }
  });

  it('断面は m ごとに専用の一文を持つ ── 画面へ載るまでの段数が違う', () => {
    // m=4 は一段、m=5 は二段の影を挟んでようやく 3D に載る。そこを言う文がある
    for (const [lang, copy] of dicts) {
      expect(copy.perspective.captions['slice:4:6'], lang).toBeTypeOf('string');
      expect(copy.perspective.captions['slice:5:6'], lang).toBeTypeOf('string');
      expect(perspectiveCaptionIn(copy, 'slice', 5, 6), lang).not.toBe(
        perspectiveCaptionIn(copy, 'slice', 4, 6),
      );
    }
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
  it('3・4 次元には固有の名がある(どの言語でも)', () => {
    for (const [lang, copy] of dicts) {
      for (const family of FAMILIES) {
        for (const n of [3, 4]) {
          expect(copy.polytope.names[family]?.[n], `${lang} / ${family} n=${n}`).toBeTypeOf('string');
        }
      }
    }
  });

  it('日本語の固有名', () => {
    const ja = DICTS.ja;
    expect(polytopeNameIn(ja, 'cube', 3)).toBe('立方体');
    expect(polytopeNameIn(ja, 'cube', 4)).toBe('テッセラクト');
    expect(polytopeNameIn(ja, 'simplex', 3)).toBe('正四面体');
    expect(polytopeNameIn(ja, 'simplex', 4)).toBe('五胞体');
    expect(polytopeNameIn(ja, 'orthoplex', 3)).toBe('正八面体');
    expect(polytopeNameIn(ja, 'orthoplex', 4)).toBe('正十六胞体');
  });

  it('英語の固有名 ── 3・4 は**名前**であること(数で呼ばない)', () => {
    // `5-cell` / `16-cell` を採らないのは、名前が尽きる瞬間を作るために
    // 3・4 が名前でなければならないから(`i18n/en.ts` の注)
    const en = DICTS.en;
    expect(polytopeNameIn(en, 'cube', 3)).toBe('cube');
    expect(polytopeNameIn(en, 'cube', 4)).toBe('tesseract');
    expect(polytopeNameIn(en, 'simplex', 4)).toBe('pentachoron');
    expect(polytopeNameIn(en, 'orthoplex', 4)).toBe('hexadecachoron');
    for (const family of FAMILIES) {
      for (const n of [3, 4]) {
        expect(polytopeNameIn(en, family, n), `${family} n=${n}`).not.toMatch(/\d/);
      }
    }
  });

  it('超立方体の名は 6 で尽き、7 から数で呼ぶ ── 終章「名前がまだ足りない」の実演', () => {
    // ここは作品上の判断。語を足して「直さない」こと(各言語の名前表を参照)
    expect(polytopeNameIn(DICTS.ja, 'cube', 5)).toBe('ペンテラクト');
    expect(polytopeNameIn(DICTS.ja, 'cube', 6)).toBe('ヘクセラクト');
    expect(polytopeNameIn(DICTS.ja, 'cube', 7)).toBe('七次元の超立方体');
    expect(polytopeNameIn(DICTS.ja, 'cube', 10)).toBe('十次元の超立方体');
    expect(polytopeNameIn(DICTS.en, 'cube', 5)).toBe('penteract');
    expect(polytopeNameIn(DICTS.en, 'cube', 6)).toBe('hexeract');
    expect(polytopeNameIn(DICTS.en, 'cube', 7)).toBe('seven-dimensional hypercube');
    expect(polytopeNameIn(DICTS.en, 'cube', 10)).toBe('ten-dimensional hypercube');

    // 規則として: 7 以上には固有名が**無い**(表に足されていない)
    for (const [lang, copy] of dicts) {
      for (const n of [7, 8, 9, 10]) {
        expect(copy.polytope.names['cube']?.[n], `${lang} / cube n=${n}`).toBeUndefined();
      }
    }
  });

  it('固有名を持たない次元は族の総称で呼ぶ', () => {
    expect(polytopeNameIn(DICTS.ja, 'simplex', 7)).toBe('七次元の単体');
    expect(polytopeNameIn(DICTS.ja, 'orthoplex', 9)).toBe('九次元の正軸体');
    expect(polytopeNameIn(DICTS.en, 'simplex', 7)).toBe('seven-dimensional simplex');
    expect(polytopeNameIn(DICTS.en, 'orthoplex', 9)).toBe('nine-dimensional orthoplex');
  });
});

describe('polytopeTagline', () => {
  it('着地(cube / n=7)の一文 ── 名前は言語、数は算術', () => {
    expect(polytopeTaglineIn(DICTS.ja, 'cube', 7, 128, 448)).toBe(
      '七次元の超立方体 ── 128 の頂点、448 の辺',
    );
    expect(polytopeTaglineIn(DICTS.en, 'cube', 7, 128, 448)).toBe(
      'seven-dimensional hypercube — 128 vertices, 448 edges',
    );
  });

  it('4 桁は 3 桁区切りにする(どの言語でも)', () => {
    for (const [lang, copy] of dicts) {
      const line = polytopeTaglineIn(copy, 'cube', 10, 1024, 5120);
      expect(line, lang).toContain('1,024');
      expect(line, lang).toContain('5,120');
    }
  });

  it('到達しうる 24 組すべてで一文が違う ── 設定を変えたのに同じ文、が起きない', () => {
    for (const [lang, copy] of dicts) {
      const seen = new Set<string>();
      for (const family of FAMILIES) {
        for (const n of NS) {
          const [v, e] = counts(family, n);
          const line = polytopeTaglineIn(copy, family, n, v, e);
          expect(line, `${lang} / ${family} n=${n}`).not.toBe('');
          seen.add(line);
        }
      }
      expect(seen.size, lang).toBe(FAMILIES.length * NS.length);
    }
  });
});

describe('終章 → ギャラリーの受け渡し', () => {
  /**
   * CTA は「振り出した約束」、着地の副題は「渡すもの」。同じ数を名乗っていること。
   * 片方だけ書き換えると、押した先が約束と違う ── Phase 41 で直したのがこれ。
   *
   * 「同じ数」の綴りは言語ごとに違う(漢数字 / 綴った数)ので、**その言語の
   * 数の綴りを辞書から取り出して**両側に含まれていることを見る ── 文字列を
   * ここへ手で写すと、訳を直した瞬間に嘘になる。
   */
  it('終章の CTA と本文が、着地する展示の副題と同じ数を名乗る', () => {
    for (const [lang, copy] of dicts) {
      const epilogue = copy.chapters[copy.chapters.length - 1];
      expect(epilogue.id, lang).toBe('epilogue');
      expect(epilogue.cta, lang).toBeTypeOf('string');

      // その言語の 7 の綴り(ja なら「七」、en なら「seven」)。辞書から取る ──
      // ここへ手で写すと、訳を直した瞬間に嘘になる
      const word = copy.polytope.numeral(7);
      expect(word, `${lang} / 7 の綴りが取れない`).not.toBe('');

      const lower = (v: string): string => v.toLowerCase();
      expect(lower(epilogue.cta ?? ''), `${lang} / CTA`).toContain(lower(word));
      expect(lower(epilogue.text.body), `${lang} / 終章の本文`).toContain(lower(word));
      // 着地は EXHIBIT_REGISTRY の先頭 = polytope / cube / n=7(gallery.ts)
      expect(
        lower(polytopeTaglineIn(copy, 'cube', 7, 128, 448)),
        `${lang} / 着地の副題`,
      ).toContain(lower(word));
      expect(epilogue.coord, lang).toContain('07');
    }
  });
});
