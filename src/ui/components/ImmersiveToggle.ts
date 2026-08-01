/**
 * ImmersiveToggle — 作品だけを見るためのチップ(Phase 11)。
 *
 * ギャラリーの画面は、タブ帯・見出し・操作卓・計器・ナビで四辺が埋まっている。
 * 狭い画面ではそれが「作品を見る」ことそのものを妨げるので、**すべてのクロームを
 * 一息で退かせる**口をひとつ置く。退いたあとに残るのはこのチップ 1 個だけで、
 * それも opacity .45 まで引いて、絵の邪魔をしない濃さで待つ。
 *
 * 器を #hud の**外**に置くのは意図的: #hud は aria-hidden="true" の装飾レイヤで、
 * その中に入れた操作子は支援技術から永久に見えなくなる。
 *
 * 寸法・ヘアライン・書体は品質チップ / 音チップと完全に同じ(高さ 34px)──
 * 3 つで 1 本の計器の語彙になる。
 */

import { h, type Component } from './component';
import { magnetize, type Magnet } from './MagneticButton';

/** クロームが出ている / 退いている の記号 */
const GLYPH_SHOWN = '◉';
const GLYPH_HIDDEN = '◎';

export class ImmersiveToggle implements Component {
  readonly el: HTMLElement;

  private readonly chip: HTMLButtonElement;
  private readonly glyph: HTMLElement;
  private readonly magnet: Magnet;
  private readonly onToggle: () => void;

  constructor(onToggle: () => void) {
    this.onToggle = onToggle;

    this.el = h('div', 'immersive', { id: 'immersive' });

    this.chip = h('button', 'i-chip', {
      id: 'immersive-chip',
      type: 'button',
      'data-cursor': '',
      'aria-label': 'UI を隠して作品だけを見る',
      'aria-pressed': 'false',
    });

    this.glyph = h('span', 'i-chip-glyph', { 'aria-hidden': 'true', text: GLYPH_SHOWN });
    this.chip.append(this.glyph, h('span', 'i-chip-label', { text: 'UI' }));
    this.el.append(this.chip);

    this.chip.addEventListener('click', this.onClick);
    this.magnet = magnetize(this.chip, { radius: 60, max: 5, labelMax: 7 });
  }

  mount(parent: HTMLElement): void {
    parent.append(this.el);
  }

  /** クロームが退いているか。押した結果は呼び出し側(gallery)が一元管理する */
  setHidden(hidden: boolean): void {
    this.chip.setAttribute('aria-pressed', hidden ? 'true' : 'false');
    const glyph = hidden ? GLYPH_HIDDEN : GLYPH_SHOWN;
    if (this.glyph.textContent !== glyph) this.glyph.textContent = glyph;
  }

  destroy(): void {
    this.magnet.destroy();
    this.chip.removeEventListener('click', this.onClick);
    this.el.remove();
  }

  private readonly onClick = (): void => {
    this.onToggle();
  };
}
