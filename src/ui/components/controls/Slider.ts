/**
 * Slider — パネルの数値制御(Phase 9b)。
 *
 * ネイティブの `input[type=range]` を捨てない。キーボード(矢印 / Home / End /
 * PageUp・Down)も、支援技術への値の伝達も、ブラウザの実装がいちばん正しい ──
 * ここがするのは**見た目と、掴んでいるあいだの手応え**だけ。
 *
 *   トラック  … 2px の線。塗られた側だけがシアン→バイオレットのグラデーション
 *               (`--fill` を background-size に渡す = 1 プロパティで塗り分かる)
 *   サム      … 14px。押しているあいだは外側に発光リングが灯る(CSS)
 *   値バブル  … 掴んでいるあいだだけサムの上へ立ち上がる Space Mono のピル。
 *               160ms の pop-in は WAAPI(play)で、以後は translate だけを書く
 *
 * コストの設計:
 * - **レイアウト読みはドラッグ開始の 1 回だけ**(`clientWidth`)。以後は
 *   値からサムの x を算術で出す ── 動かしているあいだ DOM を測り直さない。
 * - キーフレームはモジュール定数。ドラッグのたびに配列を作らない。
 */

import { EASE, h, play, type Component } from '../component';

export interface SliderSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** 値表示の整形。既定は String(v) */
  format?: (value: number) => string;
  onInput: (value: number) => void;
  key?: string;
  disabled?: boolean;
}

export interface SliderControl extends Component {
  readonly kind: 'slider';
  setDisabled(disabled: boolean): void;
  setValue(value: number): void;
}

/** サムの直径(px)。style.css の `.pn-range::-webkit-slider-thumb` と対になる値 */
const THUMB = 14;
/** バブルの立ち上がり(ms) */
const POP_MS = 160;

/**
 * バブルの pop-in。`translateX(-50%)` を**キーフレームにも書く**のは、
 * transform を上書きするあいだも中央合わせを失わないため
 * (x 位置そのものは CSS の transform ではなく `translate` が持つ)。
 */
const POP_IN: Keyframe[] = [
  { opacity: 0, transform: 'translateX(-50%) translateY(5px) scale(0.92)' },
  { opacity: 1, transform: 'translateX(-50%) translateY(0) scale(1)' },
];

/** バブルを出すキー。値が動くものだけ(Tab や修飾キーでは出さない) */
const VALUE_KEYS = /^(Arrow(Left|Right|Up|Down)|Home|End|Page(Up|Down))$/;

export function createSlider(spec: SliderSpec): SliderControl {
  const format = spec.format ?? defaultFormat;

  const row = h('div', 'pn-row pn-row-slider');
  const head = h('div', 'pn-head');
  const valueEl = h('span', 'pn-value', { text: format(spec.value) });
  head.append(h('span', 'pn-label', { text: spec.label }), valueEl);

  const track = h('div', 'pn-track');
  const input = h('input', 'pn-range', {
    type: 'range',
    'aria-label': spec.label,
    'data-cursor': '',
  });
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  input.value = String(spec.value);

  const bubble = h('span', 'pn-bubble', { 'aria-hidden': 'true', text: format(spec.value) });
  bubble.dataset.on = 'false';

  track.append(input, bubble);
  row.append(head, track);
  applyFill(input);

  /** 掴んでいるか(ポインタでも、キーボードでも) */
  let holding = false;
  /** ドラッグ開始時に 1 回だけ測るトラック幅(px) */
  let trackWidth = 0;

  const placeBubble = (value: number): void => {
    if (trackWidth <= 0) return;
    const span = spec.max - spec.min;
    const t = span > 0 ? (value - spec.min) / span : 0;
    // サムの中心は [THUMB/2, width - THUMB/2] を動く
    const x = THUMB / 2 + t * (trackWidth - THUMB);
    bubble.style.translate = `${x.toFixed(1)}px 0`;
  };

  const hold = (): void => {
    if (holding || input.disabled) return;
    holding = true;
    trackWidth = input.clientWidth;
    const value = Number(input.value);
    bubble.textContent = format(value);
    placeBubble(value);
    bubble.dataset.on = 'true';
    row.classList.add('is-dragging');
    play(bubble, POP_IN, { duration: POP_MS, easing: EASE.outQuint, fill: 'backwards' });
    window.addEventListener('pointerup', release, { passive: true });
    window.addEventListener('pointercancel', release, { passive: true });
  };

  function release(): void {
    if (!holding) return;
    holding = false;
    bubble.dataset.on = 'false';
    row.classList.remove('is-dragging');
    window.removeEventListener('pointerup', release);
    window.removeEventListener('pointercancel', release);
  }

  const onInput = (): void => {
    const value = Number(input.value);
    applyFill(input);
    const text = format(value);
    valueEl.textContent = text;
    if (holding) {
      bubble.textContent = text;
      placeBubble(value);
    }
    spec.onInput(value);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (VALUE_KEYS.test(event.key)) hold();
  };

  input.addEventListener('input', onInput);
  input.addEventListener('pointerdown', hold);
  input.addEventListener('keydown', onKeyDown);
  input.addEventListener('blur', release);

  const control: SliderControl = {
    kind: 'slider',
    el: row,
    setDisabled(disabled: boolean): void {
      input.disabled = disabled;
      row.classList.toggle('is-disabled', disabled);
      if (disabled) release();
    },
    setValue(value: number): void {
      if (Number(input.value) === value) return;
      input.value = String(value);
      applyFill(input);
      valueEl.textContent = format(value);
      if (holding) placeBubble(value);
    },
    destroy(): void {
      release();
      input.removeEventListener('input', onInput);
      input.removeEventListener('pointerdown', hold);
      input.removeEventListener('keydown', onKeyDown);
      input.removeEventListener('blur', release);
      row.remove();
    },
  };

  if (spec.disabled === true) control.setDisabled(true);
  return control;
}

/* ------------------------------------------------------------------ 内部 */

function defaultFormat(value: number): string {
  return String(value);
}

/** 塗り分けの比率。CSS 側は `--fill` を background-size に受けて左からの塗りにする */
function applyFill(input: HTMLInputElement): void {
  const min = Number(input.min);
  const max = Number(input.max);
  const span = max - min;
  const t = span > 0 ? (Number(input.value) - min) / span : 0;
  input.style.setProperty('--fill', `${(t * 100).toFixed(2)}%`);
}
