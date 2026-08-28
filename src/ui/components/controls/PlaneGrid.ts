/**
 * PlaneGrid — 回転平面の升目(Phase 43)。
 *
 * n 次元の回転は「2 次元平面の中の回転」の合成で表せる。平面は C(n,2) 枚あり、
 * それが**この形状の自由度そのもの**である。それまで展示はその中から 3〜9 枚を
 * 自分で選んで回していたので、自由度は数式の中にだけあった。ここはそれを
 * 手に渡すための升目で、行 i・列 j の交点が平面 (i, j) を指す。
 *
 * ## 升目は 3 状態を持つ
 *
 *   ・回っている(選択され、列に載った)       … 塗り + 光
 *   ・**凍結**(基底だが選択されていない)     … 枠だけ + 中央の点
 *   ・**保留**(選択したが上限で列に載れない) … 破線の枠
 *   ・止まっている(未選択の追加平面)         … 空
 *
 * 「保留」を分けるのは、**升目が嘘をつかないため**である。一度は選択をそのまま
 * 点灯させていたが、n=7 で「全部まわす」を押すと 21 枚すべてが点いて、実際に
 * 回っているのは 16 枚だった ── 計器だけが正しいことを言っている状態になる。
 *
 * 「凍結」が要。`math/tumble.ts` の `planRotations` にあるとおり、基底の平面は
 * 選択から外れても列から消えず ω = 0 になる ── ユーザーは回転を止められるが、
 * 軸の混ざりは取り上げられない。**升目の意味が「有る/無い」ではなく
 * 「動く/止まる」である**ことを、状態の名前と見た目の両方で言う。
 *
 * ## 升目は作り直さない
 *
 * N は 3..10 で動くが、部品は**常に最大の 10 軸ぶんを組んでおき**、範囲外の升と
 * 軸ラベルを `is-hidden`(display:none)で畳む。上三角なので隠れるのは
 * 各行の末尾の列と末尾の行だけ ── CSS グリッドは残った要素だけで正しく流れる。
 * パネルはタブ切替でしか作り直されないので、N を動かすたびに部品を作り直す
 * 設計にすると、そこだけ別の寿命を持つことになる。
 *
 * ## 触れる大きさ
 *
 * 升は 44px を満たさない(n=10 なら 9 列で ~33px)。だから**この部品は
 * ボトムシート版レイアウトとタッチ環境では CSS で隠す**(`style.css` の
 * `.pn-grid`)── 代わりにプリセットのボタンが同じことをする。
 * 幅で判定しないのと同じ理由で `(hover: none)` も見る:
 * タッチスクリーン付きのデスクトップは `(hover: hover)` を返すので升目が出る。
 */

import { h, type Component } from '../component';

export interface PlaneGridCell {
  readonly i: number;
  readonly j: number;
  /** **実際に回転列へ載って回っているか。**「選んだか」ではない */
  readonly spinning: boolean;
  /** 選ばれてはいるが、上限で列へ載らなかったか(保留) */
  readonly pending: boolean;
  /** 既定の組(= 外しても凍結として残る平面)か */
  readonly base: boolean;
  /** これ以上増やせない(上限に達していて、いま OFF)か */
  readonly blocked: boolean;
}

export interface PlaneGridSpec {
  label: string;
  /** 軸の本数の上限。升目はこの数で一度だけ組む */
  maxAxes: number;
  /** いま有効な軸の本数 n(≤ maxAxes) */
  axes: number;
  cells: readonly PlaneGridCell[];
  onToggle: (i: number, j: number) => void;
  key?: string;
}

export interface PlaneGridControl extends Component {
  readonly kind: 'planeGrid';
  setDisabled(disabled: boolean): void;
  /** 有効な軸数と升目の状態を塗り替える */
  paint(axes: number, cells: readonly PlaneGridCell[]): void;
}

const cellKey = (i: number, j: number): string => `${i}-${j}`;

export function createPlaneGrid(spec: PlaneGridSpec): PlaneGridControl {
  const root = h('div', 'pn-grid');
  const label = h('span', 'pn-label', { text: spec.label });

  const max = spec.maxAxes;
  const table = h('div', 'pn-grid-table', { role: 'group', 'aria-label': spec.label });

  const buttons = new Map<string, HTMLButtonElement>();
  /**
   * 升目の全要素と、それが属する行 / 列。
   *
   * **行と列を別々に畳んではいけない。** 一度そう書いて実物で数えたら、
   * n=7 のとき見えている升が 21 ではなく 39 になった ── 列を隠したあとで
   * 行のループが同じ要素へ `is-hidden = false` を書き、隠したはずの列を
   * 開け直していた。判定は要素ごとに 1 回、行 **または** 列で決める。
   *
   * row / col の −1 は「その軸に属さない」= 常に見える(左上の角)。
   */
  const parts: { el: HTMLElement; row: number; col: number }[] = [];

  // 見出し行: 空 + 軸 1..max−1
  const corner = h('span', 'pn-grid-axis pn-grid-corner', { 'aria-hidden': 'true' });
  parts.push({ el: corner, row: -1, col: -1 });
  table.append(corner);
  for (let j = 1; j < max; j++) {
    const head = h('span', 'pn-grid-axis', { text: String(j), 'aria-hidden': 'true' });
    parts.push({ el: head, row: -1, col: j });
    table.append(head);
  }

  for (let i = 0; i < max - 1; i++) {
    const axis = h('span', 'pn-grid-axis', { text: String(i), 'aria-hidden': 'true' });
    parts.push({ el: axis, row: i, col: -1 });
    table.append(axis);
    for (let j = 1; j < max; j++) {
      // 下三角は (j,i) と同じ平面。空きを埋めるだけの升を置く
      const cell =
        j <= i
          ? h('span', 'pn-grid-blank', { 'aria-hidden': 'true' })
          : (h('button', 'pn-grid-cell', {
              type: 'button',
              'aria-pressed': 'false',
              // 読み上げは「平面 0-3」。升目そのものに可視の文字は置かない
              'aria-label': `平面 ${i}-${j}`,
              'data-cursor': '',
            }) as HTMLButtonElement);
      if (cell instanceof HTMLButtonElement) buttons.set(cellKey(i, j), cell);
      parts.push({ el: cell, row: i, col: j });
      table.append(cell);
    }
  }

  const onClick = (event: Event): void => {
    const target = (event.target as HTMLElement | null)?.closest('.pn-grid-cell');
    if (!(target instanceof HTMLButtonElement) || target.disabled) return;
    for (const [key, button] of buttons) {
      if (button !== target) continue;
      const dash = key.indexOf('-');
      spec.onToggle(Number(key.slice(0, dash)), Number(key.slice(dash + 1)));
      return;
    }
  };
  table.addEventListener('click', onClick);

  const paint = (axes: number, cells: readonly PlaneGridCell[]): void => {
    table.style.setProperty('--pn-grid-cols', String(axes));
    for (const part of parts) {
      const hidden = (part.col >= 0 && part.col >= axes) || (part.row >= 0 && part.row >= axes - 1);
      part.el.classList.toggle('is-hidden', hidden);
    }
    for (const cell of cells) {
      const button = buttons.get(cellKey(cell.i, cell.j));
      if (button === undefined) continue;
      button.setAttribute('aria-pressed', cell.spinning ? 'true' : 'false');
      button.classList.toggle('is-on', cell.spinning);
      button.classList.toggle('is-pending', cell.pending);
      button.classList.toggle('is-frozen', cell.base && !cell.spinning && !cell.pending);
      button.disabled = cell.blocked;
      button.classList.toggle('is-blocked', cell.blocked);
    }
  };
  paint(spec.axes, spec.cells);

  root.append(label, table);

  return {
    kind: 'planeGrid',
    el: root,
    setDisabled(disabled: boolean): void {
      root.classList.toggle('is-disabled', disabled);
      for (const button of buttons.values()) button.disabled = disabled;
    },
    paint,
    destroy(): void {
      table.removeEventListener('click', onClick);
      root.remove();
    },
  };
}
