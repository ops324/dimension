/**
 * PanelButton — パネルの実行ボタン(Phase 9b)。
 *
 * ギャラリー内のボタンの**語彙の基準**になる部品。1px のヘアラインの器に、
 * ホバーで左から掃くグラデーション ── ただし 9a の CTA のように文字色まで
 * 反転させない(パネルの中で 1 つだけ反転すると、そこが押し出されて見える)。
 * 掃くのは低い不透明度の塗りだけで、文字は明るくなるにとどめる。
 *
 * 掃きは CSS の transition(::before の scaleX)が持つ。JS が触るのは
 * `disabled` と押下のコールバックだけ ── 状態の少ない部品は CSS が速い。
 *
 * Phase 19 で「現在地」の状態が増えた(`setActive`)。プリセットのように
 * **押した結果がそのまま今の状態になる**ボタンは、押したあとどれが効いているのか
 * 分からないと、パラメータを直接動かした瞬間に迷子になる。
 *
 * 印は `aria-current="true"` である。`aria-pressed` にしないのは、それが
 * **トグルボタンを宣言してしまう**ため ── もう一度押しても解除されないので、
 * 支援技術に「押すと戻る」と約束することになり、それは嘘になる。
 * `aria-current` は「一組の中の今の項目」であり、まさにこれが言いたいこと。
 */

import { h, type Component } from '../component';

export interface ButtonSpec {
  label: string;
  onClick: () => void;
  key?: string;
}

export interface ButtonControl extends Component {
  readonly kind: 'button';
  readonly button: HTMLButtonElement;
  setDisabled(disabled: boolean): void;
  /** 「今この状態にある」印。押下可能なまま、見た目と AT 上の現在地だけが立つ */
  setActive(active: boolean): void;
}

export function createPanelButton(spec: ButtonSpec): ButtonControl {
  const row = h('div', 'pn-row pn-row-button');
  const button = h('button', 'pn-button', { type: 'button', 'data-cursor': '' });
  button.append(h('span', 'pn-button-label', { text: spec.label }));

  const onClick = (): void => {
    if (!button.disabled) spec.onClick();
  };
  button.addEventListener('click', onClick);
  row.append(button);

  return {
    kind: 'button',
    el: row,
    button,
    setDisabled(disabled: boolean): void {
      button.disabled = disabled;
      row.classList.toggle('is-disabled', disabled);
    },
    setActive(active: boolean): void {
      button.classList.toggle('is-current', active);
      // 属性は**立てるか消すか**で、`aria-current="false"` を置いてはいけない
      // (false は文字列として真と解釈される実装がある)
      if (active) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    },
    destroy(): void {
      button.removeEventListener('click', onClick);
      row.remove();
    },
  };
}
