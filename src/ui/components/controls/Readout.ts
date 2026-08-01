/**
 * Readout — 読み取り専用の値表示(Phase 9b)。
 *
 * 展示から毎フレーム呼ばれても構わない部品にする、というのがこの部品の唯一の
 * 仕事 ── 更新関数は**前回と同じ文字列なら DOM を触らない**。ここに
 * アニメーションを足さないのは意図的で、頻繁に呼ばれる入口で Animation を
 * 作ると、そのままアロケーションの流量になるため。
 */

import { h, type Component } from '../component';

export interface ReadoutSpec {
  label: string;
  value?: string;
}

/** readout の更新関数。同じ文字列なら DOM を触らない */
export type ReadoutUpdate = (value: string) => void;

export interface ReadoutControl extends Component {
  readonly kind: 'readout';
  readonly update: ReadoutUpdate;
}

export function createReadout(spec: ReadoutSpec): ReadoutControl {
  const row = h('div', 'pn-row pn-row-readout');
  const valueEl = h('span', 'pn-readout-value', { text: spec.value ?? '—' });
  row.append(h('span', 'pn-label', { text: spec.label }), valueEl);

  let last = valueEl.textContent ?? '';

  return {
    kind: 'readout',
    el: row,
    update(value: string): void {
      if (value === last) return;
      last = value;
      valueEl.textContent = value;
    },
    destroy(): void {
      row.remove();
    },
  };
}
