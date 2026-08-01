/**
 * Toggle — 二値スイッチ(Phase 9b)。
 *
 * 34×18 の器の中を 14px のつまみが 16px だけ滑る。滑りは WAAPI(play)で
 * --ease-out-quint、到達状態は CSS(`.is-on`)が持つ ── アニメーションが
 * 終わったところに、ちょうど CSS の最終状態が待っている形にしてあるので、
 * fill を残さない(reduced-motion では play が尺を 0 にするだけで結果は同じ)。
 *
 * ON のときだけ器がシアン→バイオレットのグラデーションで満ち、外側に淡い
 * 光がにじむ。ラベルは変えない ── 状態は色と位置が語る。
 */

import { EASE, h, play, type Component } from '../component';

export interface ToggleSpec {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  key?: string;
}

export interface ToggleControl extends Component {
  readonly kind: 'toggle';
  setDisabled(disabled: boolean): void;
  setValue(value: boolean): void;
}

/** つまみの移動距離(px)。style.css の `.pn-switch` 系の寸法と対になる値 */
const TRAVEL = 16;
/** 滑りの尺(ms) */
const SLIDE_MS = 320;

export function createToggle(spec: ToggleSpec): ToggleControl {
  const row = h('div', 'pn-row pn-row-toggle');
  const label = h('span', 'pn-label', { text: spec.label });

  const switchEl = h('button', 'pn-switch', {
    type: 'button',
    role: 'switch',
    'aria-label': spec.label,
    'aria-checked': spec.value ? 'true' : 'false',
    'data-cursor': '',
  });
  const knob = h('span', 'pn-switch-knob');
  switchEl.append(knob);
  switchEl.classList.toggle('is-on', spec.value);

  let on = spec.value;

  const paint = (next: boolean, animate: boolean): void => {
    if (next === on) return;
    on = next;
    switchEl.setAttribute('aria-checked', next ? 'true' : 'false');
    switchEl.classList.toggle('is-on', next);
    if (!animate) return;
    const from = next ? 0 : TRAVEL;
    const to = next ? TRAVEL : 0;
    play(knob, [{ translate: `${from}px 0` }, { translate: `${to}px 0` }], {
      duration: SLIDE_MS,
      easing: EASE.outQuint,
    });
  };

  const onClick = (): void => {
    if (switchEl.disabled) return;
    paint(!on, true);
    spec.onChange(on);
  };
  switchEl.addEventListener('click', onClick);

  row.append(label, switchEl);

  return {
    kind: 'toggle',
    el: row,
    setDisabled(disabled: boolean): void {
      switchEl.disabled = disabled;
      row.classList.toggle('is-disabled', disabled);
    },
    setValue(value: boolean): void {
      paint(value, true);
    },
    destroy(): void {
      switchEl.removeEventListener('click', onClick);
      row.remove();
    },
  };
}
