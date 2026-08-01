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
    destroy(): void {
      button.removeEventListener('click', onClick);
      row.remove();
    },
  };
}
