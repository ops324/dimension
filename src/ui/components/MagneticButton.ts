/**
 * MagneticButton — 磁力を持つ操作要素(Phase 9a)。
 *
 * ポインタが半径内へ入ると要素がわずかにカーソルへ寄り(最大 8px)、内側の
 * ラベルはそれより少し多く動く(視差、最大 12px)。離れると --ease-out-quint で
 * 500ms かけて戻る。
 *
 * コストの設計:
 * - pointermove リスナーは**モジュールに 1 本だけ**。登録された磁石を配列で回す。
 * - 矩形はキャッシュした数値。再計測は scroll / resize と、200ms を超えて古く
 *   なったときだけ ── 毎フレームのレイアウト読みも DOMRect 生成もしない。
 *   古さの上限を設けているのは、モード切替で `display: none` から現れる要素
 *   (トップナビ)や、左右へ引っ越す要素(品質チップ)があるため。
 *   一度きりの計測では、生まれる前の 0×0 の矩形を握ったままになる。
 * - reduced-motion では磁石そのものを付けない(何も動かない)。
 */

import { EASE, prefersReducedMotion } from './component';

export interface MagnetOptions {
  /** カーソルへ寄る強さ(0-1)。既定 0.3 */
  readonly strength?: number;
  /** 影響半径(px)。要素の外側にどれだけ届くか。既定 90 */
  readonly radius?: number;
  /** 要素本体の最大移動量(px)。既定 8 */
  readonly max?: number;
  /** 内側ラベルの最大移動量(px)。既定 12 */
  readonly labelMax?: number;
  /** 視差させる内側要素のセレクタ(省略時は動かさない) */
  readonly labelSelector?: string;
}

export interface Magnet {
  destroy(): void;
}

interface Entry {
  readonly el: HTMLElement;
  readonly label: HTMLElement | null;
  readonly strength: number;
  readonly radius: number;
  readonly max: number;
  readonly labelMax: number;
  /** キャッシュした中心と大きさ(dirty のときだけ測り直す) */
  cx: number;
  cy: number;
  reach: number;
  /** 表示されていない(0×0)ものは磁石として働かせない */
  hidden: boolean;
  /** 現在適用中のオフセット */
  ox: number;
  oy: number;
  engaged: boolean;
  spring: Animation | null;
  labelSpring: Animation | null;
}

const NOOP: Magnet = { destroy: () => undefined };

const entries: Entry[] = [];
let pointerX = 0;
let pointerY = 0;
let dirty = true;
let rafId = 0;
let listening = false;
/** 最後に矩形を測った時刻(ms)。これより古くなったら測り直す */
let measuredAt = 0;

/** 戻りのばね(ms) */
const SPRING_MS = 500;
/** これ以下の差なら DOM へ書かない(px) */
const WRITE_EPSILON = 0.05;
/** 矩形キャッシュの寿命(ms)。毎フレームではなく、この間隔でだけ測り直す */
const REMEASURE_MS = 200;

export function magnetize(el: HTMLElement, options: MagnetOptions = {}): Magnet {
  if (prefersReducedMotion()) return NOOP;

  const label =
    options.labelSelector !== undefined
      ? el.querySelector<HTMLElement>(options.labelSelector)
      : null;

  const entry: Entry = {
    el,
    label,
    strength: options.strength ?? 0.3,
    radius: options.radius ?? 90,
    max: options.max ?? 8,
    labelMax: options.labelMax ?? 12,
    cx: 0,
    cy: 0,
    reach: 0,
    hidden: true,
    ox: 0,
    oy: 0,
    engaged: false,
    spring: null,
    labelSpring: null,
  };

  entries.push(entry);
  dirty = true;
  ensureListening();

  return {
    destroy(): void {
      const at = entries.indexOf(entry);
      if (at >= 0) entries.splice(at, 1);
      release(entry, false);
      if (entries.length === 0) stopListening();
    },
  };
}

/* ------------------------------------------------------------------ 内部 */

function ensureListening(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('scroll', markDirty, { passive: true });
  window.addEventListener('resize', markDirty);
}

function stopListening(): void {
  if (!listening) return;
  listening = false;
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('scroll', markDirty);
  window.removeEventListener('resize', markDirty);
  if (rafId !== 0) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

function markDirty(): void {
  dirty = true;
}

function onPointerMove(event: PointerEvent): void {
  if (event.pointerType === 'touch') return;
  pointerX = event.clientX;
  pointerY = event.clientY;
  if (rafId === 0) rafId = requestAnimationFrame(step);
}

function step(now: number): void {
  rafId = 0;

  if (dirty || now - measuredAt > REMEASURE_MS) {
    dirty = false;
    measuredAt = now;
    for (let i = 0; i < entries.length; i++) measure(entries[i]);
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.hidden) continue;
    const dx = pointerX - entry.cx;
    const dy = pointerY - entry.cy;

    // 矩形判定で先に落とす(平方根を避ける)
    if (dx > entry.reach || dx < -entry.reach || dy > entry.reach || dy < -entry.reach) {
      if (entry.engaged) release(entry, true);
      continue;
    }

    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > entry.reach) {
      if (entry.engaged) release(entry, true);
      continue;
    }

    // なめらかな減衰。中心では 1、届く縁では 0
    const t = 1 - d / entry.reach;
    const falloff = t * t * (3 - 2 * t);
    const ox = clamp(dx * entry.strength * falloff, entry.max);
    const oy = clamp(dy * entry.strength * falloff, entry.max);

    if (!entry.engaged) {
      entry.engaged = true;
      cancelSprings(entry);
    }
    if (Math.abs(ox - entry.ox) < WRITE_EPSILON && Math.abs(oy - entry.oy) < WRITE_EPSILON) {
      continue;
    }
    entry.ox = ox;
    entry.oy = oy;
    entry.el.style.translate = `${ox.toFixed(2)}px ${oy.toFixed(2)}px`;
    if (entry.label !== null) {
      const k = entry.labelMax / entry.max;
      entry.label.style.translate = `${(ox * k).toFixed(2)}px ${(oy * k).toFixed(2)}px`;
    }
  }
}

function measure(entry: Entry): void {
  const rect = entry.el.getBoundingClientRect();
  entry.hidden = rect.width === 0 && rect.height === 0;
  entry.cx = rect.left + rect.width / 2;
  entry.cy = rect.top + rect.height / 2;
  entry.reach = entry.radius + Math.sqrt(rect.width * rect.width + rect.height * rect.height) / 2;
}

/** 磁力から解放する。animated=false なら即座に素の位置へ戻す */
function release(entry: Entry, animated: boolean): void {
  entry.engaged = false;
  const { ox, oy } = entry;
  entry.ox = 0;
  entry.oy = 0;
  entry.el.style.translate = '';
  if (entry.label !== null) entry.label.style.translate = '';
  if (!animated || (ox === 0 && oy === 0)) {
    cancelSprings(entry);
    return;
  }

  cancelSprings(entry);
  entry.spring = entry.el.animate(
    [{ translate: `${ox.toFixed(2)}px ${oy.toFixed(2)}px` }, { translate: '0px 0px' }],
    { duration: SPRING_MS, easing: EASE.outQuint },
  );
  if (entry.label !== null) {
    const k = entry.labelMax / entry.max;
    entry.labelSpring = entry.label.animate(
      [
        { translate: `${(ox * k).toFixed(2)}px ${(oy * k).toFixed(2)}px` },
        { translate: '0px 0px' },
      ],
      { duration: SPRING_MS, easing: EASE.outQuint },
    );
  }
}

function cancelSprings(entry: Entry): void {
  entry.spring?.cancel();
  entry.spring = null;
  entry.labelSpring?.cancel();
  entry.labelSpring = null;
}

function clamp(value: number, limit: number): number {
  if (value > limit) return limit;
  if (value < -limit) return -limit;
  return value;
}
