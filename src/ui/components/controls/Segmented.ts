/**
 * Segmented — 排他選択(Phase 9b)。
 *
 * 選択の表現を「ボタンごとの背景の点滅」から**1 枚のピルが滑る**へ変えた。
 * 選択肢は等幅のヘアライン枠に並び、アクティブを示すのはその下を移動する
 * ピル 1 枚だけ ── どこから来てどこへ行ったかが目で追える。
 *
 * 滑りは FLIP: 移動前の矩形(前回書いた値をそのまま覚えている)から、
 * 新しい矩形へ WAAPI で 320ms / --ease-out-quint。
 * **計測は選択・リサイズ・フォント適用のときだけ**で、毎フレームは一切走らない。
 *
 * このファイルはピルの実装(createSlidingPill)も公開する ── タブ帯の下線と
 * 品質セレクタの選択肢が同じ動きを共有するため(見た目を真似るのではなく、
 * 同じ 1 本のコードを使う)。
 */

import { EASE, h, play, type Component } from '../component';

export interface SegmentedSpec {
  label: string;
  /** [値, 日本語ラベル] の並び */
  options: readonly (readonly [string, string])[];
  value: string;
  onSelect: (value: string) => void;
  key?: string;
}

export interface SegmentedControl extends Component {
  readonly kind: 'segmented';
  setDisabled(disabled: boolean): void;
  setValue(value: string): void;
  setOptionDisabled(option: string, disabled: boolean): void;
  /**
   * ピルの初期配置。**DOM へ挿し終えた直後に 1 度だけ**呼ぶ(Panel が呼ぶ)。
   * ResizeObserver の初回通知に任せない理由は、その配送が「描画の更新」段階に
   * 乗るため ── 非表示のタブでは配送されず、ピルが置かれないまま残る。
   */
  layout(): void;
}

/* ------------------------------------------------------- 滑るピル(共有) */

export interface PillOptions {
  /** ピル要素のクラス名 */
  readonly className: string;
  /** 左右の食い込み(px)。対象より内側へ縮めて置く(タブ下線など) */
  readonly insetX?: number;
  /** 縦位置と高さも対象へ合わせるか。false なら CSS が持つ */
  readonly matchY?: boolean;
  /** 滑りの尺(ms) */
  readonly duration?: number;
  readonly easing?: string;
}

export interface SlidingPill {
  readonly el: HTMLElement;
  /** 対象へ移す。animate=false なら瞬時(初期配置・リサイズ同期) */
  moveTo(target: HTMLElement | null, animate: boolean): void;
  /** いまの対象のまま測り直す(リサイズ・表示状態の変化) */
  sync(): void;
  destroy(): void;
}

/**
 * トラックの中を滑るピルを作る。`track` は position: relative であること。
 *
 * 位置は `translate`、幅は `width` のインラインスタイルで持つ ── どちらも
 * **前回書いた値を覚えている**ので、次の移動は測り直し 1 回だけで FLIP できる。
 * 表示されていない(幅 0)あいだは自分を伏せる: 畳んだボトムシートや
 * hidden なギャラリーの中で 0 幅のピルを焼き付けないため。
 */
export function createSlidingPill(track: HTMLElement, options: PillOptions): SlidingPill {
  const el = h('span', options.className, { 'aria-hidden': 'true' });
  el.dataset.on = 'false';
  track.append(el);

  const matchY = options.matchY === true;
  const inset = options.insetX ?? 0;
  const duration = options.duration ?? 320;
  const easing = options.easing ?? EASE.outQuint;

  let target: HTMLElement | null = null;
  let placed = false;
  let x = 0;
  let y = 0;
  let w = 0;
  let hgt = 0;

  const apply = (animate: boolean): void => {
    if (target === null) {
      el.dataset.on = 'false';
      placed = false;
      return;
    }
    const nx = target.offsetLeft + inset;
    const nw = target.offsetWidth - inset * 2;
    const ny = matchY ? target.offsetTop : 0;
    const nh = matchY ? target.offsetHeight : 0;
    if (nw <= 0) {
      // 非表示中は測れない。伏せておき、ResizeObserver の再通知で置き直す
      el.dataset.on = 'false';
      placed = false;
      return;
    }
    if (placed && nx === x && nw === w && ny === y && nh === hgt) {
      el.dataset.on = 'true';
      return; // 変化なし = DOM へ書かない
    }

    const from: Keyframe = { translate: `${x}px ${y}px`, width: `${w}px` };
    const to: Keyframe = { translate: `${nx}px ${ny}px`, width: `${nw}px` };
    if (matchY) {
      from.height = `${hgt}px`;
      to.height = `${nh}px`;
    }
    const moving = placed && animate;

    x = nx;
    y = ny;
    w = nw;
    hgt = nh;
    el.style.translate = `${nx}px ${ny}px`;
    el.style.width = `${nw}px`;
    if (matchY) el.style.height = `${nh}px`;
    el.dataset.on = 'true';
    placed = true;

    if (moving) play(el, [from, to], { duration, easing });
  };

  // 表示・リサイズ・フォント適用でだけ測り直す(毎フレームの計測はしない)
  const observer =
    typeof ResizeObserver === 'function' ? new ResizeObserver(() => apply(false)) : null;
  observer?.observe(track);
  void document.fonts?.ready.then(() => apply(false));

  return {
    el,
    moveTo(next: HTMLElement | null, animate: boolean): void {
      target = next;
      apply(animate);
    },
    sync(): void {
      apply(false);
    },
    destroy(): void {
      observer?.disconnect();
      el.remove();
    },
  };
}

/* ------------------------------------------------------------- Segmented */

export function createSegmented(spec: SegmentedSpec): SegmentedControl {
  const row = h('div', 'pn-row pn-row-seg');
  row.append(h('span', 'pn-label', { text: spec.label }));

  const track = h('div', 'pn-seg', { role: 'group', 'aria-label': spec.label });
  const pill = createSlidingPill(track, { className: 'pn-seg-pill', matchY: true });

  const buttons = new Map<string, HTMLButtonElement>();
  let current = spec.value;

  const paint = (value: string, animate: boolean): void => {
    current = value;
    let active: HTMLElement | null = null;
    for (const [key, button] of buttons) {
      const on = key === value;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) active = button;
    }
    pill.moveTo(active, animate);
  };

  for (const [value, jp] of spec.options) {
    const button = h('button', 'pn-seg-btn', { type: 'button', 'data-cursor': '' });
    button.dataset.value = value;
    button.textContent = jp;
    button.setAttribute('aria-pressed', value === spec.value ? 'true' : 'false');
    button.classList.toggle('is-active', value === spec.value);
    button.addEventListener('click', () => {
      if (button.disabled || value === current) return;
      paint(value, true);
      spec.onSelect(value);
    });
    track.append(button);
    buttons.set(value, button);
  }

  row.append(track);

  return {
    kind: 'segmented',
    el: row,
    layout(): void {
      // 選択中のボタンを引き直してピルを置く(動かさない)
      paint(current, false);
    },
    setDisabled(disabled: boolean): void {
      row.classList.toggle('is-disabled', disabled);
      for (const button of buttons.values()) button.disabled = disabled;
    },
    setValue(value: string): void {
      if (value === current) return;
      paint(value, true);
    },
    setOptionDisabled(option: string, disabled: boolean): void {
      const button = buttons.get(option);
      if (button === undefined) return;
      button.disabled = disabled;
      button.classList.toggle('is-disabled', disabled);
    },
    destroy(): void {
      pill.destroy();
      row.remove();
    },
  };
}
