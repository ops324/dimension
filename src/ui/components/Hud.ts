/**
 * Hud — 画面下辺の計器(Phase 9b)。
 *
 * 左下の読みは、モードによって**別のものを指す**:
 *   物語   … 「2.31 D」 スクロールが到達した次元(overlays.ts が毎フレーム書く)
 *   ギャラリー … 「EXHIBIT 02 / 04」 いま見ている展示の通し番号
 *
 * どちらを見せるかは body のクラス(mode-gallery)が CSS で決める ── JS の
 * 購読も毎フレームの分岐も持たない。この部品がするのは、器を 1 つ足すことと、
 * 番号が**変わったときにだけ** DOM へ書くことだけ。
 *
 * 右下の品質チップ(quality.ts)とは寸法を揃えてある: 高さ 34px、同じヘアライン、
 * --s4 の余白 ── 2 つで 1 本の計器の帯に見えるように。
 */

import { h, type Component } from './component';

export class Hud implements Component {
  readonly el: HTMLElement;

  private readonly indexEl: HTMLElement;
  private readonly totalEl: HTMLElement;
  private lastIndex = -1;
  private lastTotal = -1;

  constructor(root: HTMLElement) {
    this.el = root;

    const box = h('div', 'hud-ex');
    const row = h('span', 'hud-row');
    this.indexEl = h('span', 'hud-ex-index', { text: '01' });
    this.totalEl = h('span', 'hud-ex-total', { text: '/ 04' });
    row.append(
      h('span', 'hud-ex-label', { text: 'EXHIBIT' }),
      h('span', 'hud-sep'),
      this.indexEl,
      this.totalEl,
    );
    box.append(row);
    root.append(box);
  }

  /** 1 始まりの通し番号。値が変わったときだけ DOM を触る */
  setExhibit(index: number, total: number): void {
    if (index !== this.lastIndex) {
      this.lastIndex = index;
      this.indexEl.textContent = pad(index);
    }
    if (total !== this.lastTotal) {
      this.lastTotal = total;
      this.totalEl.textContent = `/ ${pad(total)}`;
    }
  }

  destroy(): void {
    this.el.querySelector('.hud-ex')?.remove();
  }
}

/**
 * #hud があれば計器を作る。単独展示ブート(?exhibit=…)では #hud ごと
 * 落としてあるので、無いことは異常ではない。
 */
export function createHud(): Hud | null {
  const root = document.getElementById('hud');
  return root instanceof HTMLElement ? new Hud(root) : null;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
