/**
 * LangToggle — 言語スイッチ(Phase 45)。
 *
 * 音のチップ・没入チップと**同じ寸法・同じヘアライン・同じ書体**の 1 個の
 * チップで、可視ラベルは**行き先の言語名**(英語で読んでいるときは「日本語」)。
 *
 * なぜ「行き先」を出すのか。2 つある:
 *   ① **1 タップで済む。** 選択肢が 2 つなら、開くメニューは 1 手ぶん無駄
 *   ② **いちばん目に入る。** 英語の画面で唯一の日本語、日本語の画面で唯一の
 *      「English」── 探している人にとって、画面の中でそこだけが読める字になる
 *
 * なぜ 2 段のピル(`日本語 | English`)にしなかったのか。**幅**である。
 * 130px のピルはギャラリーのどの空席にも収まらなかった ── 右下は操作卓の
 * ドックが占め、その左隣は PERSPECTIVE のキャプション(画面中央下・幅 296px)に
 * 食い込み、左の計器の柱に積むと品質チップのメニューが開いたときに重なる
 * (すべて実測で踏んだ)。幅 ~76px のチップなら、没入チップと同じ席に収まる。
 *
 * 3 言語目が来たら、`#quality` と同じ「チップ + 上へ開くメニュー」へ育てる
 * のが筋 ── そのときも席は変わらない。
 *
 * 押した先の実務は `i18n/lang.ts` の `setLang()` が全部持つ(記憶 → URL →
 * リロード)。ここは描くだけで、状態を持たない。
 */

import { LANG, LANGS, setLang, type Lang } from '../../i18n/lang';
import { UI } from '../../i18n';
import { h, type Component } from './component';
import { magnetize, type Magnet } from './MagneticButton';

/** 「切り替える」の記号。作品の他のチップと同じ幾何的な字面から採る */
const GLYPH = '⇄';

/**
 * 次の言語。**2 言語なら「もう片方」、3 言語以上なら「並びの次」**へ回る ──
 * 言語を足しても壊れないが、そのときはメニューへ育てるべき(上の注)。
 */
function nextLang(current: Lang): Lang {
  const i = LANGS.indexOf(current);
  return LANGS[(i + 1) % LANGS.length] ?? current;
}

export class LangToggle implements Component {
  readonly el: HTMLElement;

  private readonly magnet: Magnet;

  constructor() {
    const target = nextLang(LANG);
    const name = UI.langToggle.names[target] ?? target;

    this.el = h('div', 'lang', { id: 'lang' });

    const chip = h('button', 'l-chip', {
      id: 'lang-chip',
      type: 'button',
      'data-cursor': '',
      /*
        可視ラベルは行き先の言語名だけなので、**動詞は名前で足す** ──
        「日本語」だけでは、いまその言語なのか押すとそうなるのかが伝わらない。
      */
      'aria-label': UI.langToggle.switchTo(name),
    });
    chip.append(
      h('span', 'l-chip-glyph', { 'aria-hidden': 'true', text: GLYPH }),
      // ラベルには行き先の言語の `lang` を付ける。付けないと読み上げが
      // 画面の言語のまま「日本語」を綴り読みする(タブの欧文名と同じ理屈)
      h('span', 'l-chip-label', { text: name, lang: target }),
    );
    chip.addEventListener('click', () => setLang(target));
    this.el.append(chip);

    this.magnet = magnetize(chip, { radius: 60, max: 5, labelMax: 7 });
  }

  mount(parent: HTMLElement): void {
    parent.append(this.el);
    // 柱(#sound / #quality)が 1 段ずつ上がるのは、これが在るときだけ
    document.body.classList.add('has-lang');
  }

  destroy(): void {
    this.magnet.destroy();
    this.el.remove();
    document.body.classList.remove('has-lang');
  }
}

/** 差し込んで返す(`createSoundToggle` と同じ呼び出し方) */
export function createLangToggle(parent: HTMLElement): LangToggle {
  const toggle = new LangToggle();
  toggle.mount(parent);
  return toggle;
}
