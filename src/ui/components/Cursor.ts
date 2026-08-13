/**
 * Cursor — 計器としてのカーソル(Phase 9a)。
 *
 * 5px の実点(遅れなし・mix-blend-mode: difference)と、10/s で遅れて追う 32px の
 * ヘアラインリング。リングの状態(idle / hover / drag / down)は data 属性 →
 * CSS カスタムプロパティ → `scale` の遷移で表現し、**JS は translate しか書かない**。
 *
 * 実装上の約束:
 * - デスクトップの細いポインタ専用。`(pointer: fine)` かつ `(hover: hover)` かつ
 *   reduced-motion でないときだけ mount する。それ以外ではネイティブカーソルに
 *   一切触れない(`html { cursor: none }` も付けない)。
 * - 3 要素は **body 直下の兄弟**として置く。共通の親に z-index を与えると
 *   スタッキングコンテキストが分離して `mix-blend-mode: difference` が背景を
 *   見なくなるため、包む div は position: static のままにしてある。
 * - rAF ループは落ち着いたら自分で止まる。毎フレームの新規オブジェクト生成なし
 *   (スタイル文字列だけは DOM 書き込みに不可避)。
 */

import { h, prefersReducedMotion, type Component } from './component';

/** リングの追従レート(1/s)。1 - exp(-rate·dt) で寄せる */
const FOLLOW_RATE = 10;
/** これ以下の残差になったら rAF を止める(px) */
const SETTLE_PX = 0.05;

/** hover 状態にする対象。data-cursor は任意の要素へ後付けできる逃げ道 */
const HOVER_SELECTOR =
  'a[href], button, input, select, textarea, summary, [data-cursor],' +
  '[role="button"], [role="switch"], [role="tab"], [contenteditable="true"]';

type CursorState = 'idle' | 'hover' | 'drag';

export class Cursor implements Component {
  /** Component 契約の代表要素(状態を持つ静的ラッパ)*/
  readonly el: HTMLElement;

  private readonly ring: HTMLElement;
  private readonly label: HTMLElement;
  private readonly dot: HTMLElement;

  private px = -100;
  private py = -100;
  private rx = -100;
  private ry = -100;

  private state: CursorState = 'idle';
  private down = false;
  private visible = false;
  private rafId = 0;
  private prevTime = 0;

  /** 直近に評価した pointermove の target。参照比較だけで再評価を間引く */
  private lastTarget: EventTarget | null = null;
  private lastGallery = false;

  constructor() {
    this.el = h('div', 'dc', { 'aria-hidden': 'true' });
    this.el.dataset.state = 'idle';
    this.ring = h('div', 'dc-ring');
    this.label = h('span', 'dc-label', { text: 'DRAG' });
    this.dot = h('div', 'dc-dot');
    this.el.append(this.ring, this.label, this.dot);
  }

  mount(parent: HTMLElement): void {
    parent.append(this.el);
    document.documentElement.classList.add('has-dimension-cursor');

    window.addEventListener('pointermove', this.onMove, { passive: true });
    window.addEventListener('pointerdown', this.onDown, { passive: true });
    window.addEventListener('pointerup', this.onUp, { passive: true });
    window.addEventListener('pointerout', this.onOut, { passive: true });
    window.addEventListener('blur', this.onLeave);
  }

  destroy(): void {
    if (this.rafId !== 0) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointerout', this.onOut);
    window.removeEventListener('blur', this.onLeave);
    document.documentElement.classList.remove('has-dimension-cursor');
    this.el.remove();
  }

  // --- 入力 ------------------------------------------------------------------

  private readonly onMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;

    this.px = event.clientX;
    this.py = event.clientY;
    // 実点は遅れなし。ここで直接書く(rAF を待たない)
    this.dot.style.translate = `${this.px}px ${this.py}px`;

    if (!this.visible) {
      this.visible = true;
      this.el.dataset.visible = 'true';
      document.documentElement.classList.add('has-dimension-cursor');
      // 初回はリングを実点へ瞬時に合わせる(画面の隅から飛んでこない)
      this.rx = this.px;
      this.ry = this.py;
    }

    const gallery = document.body.classList.contains('mode-gallery');
    if (event.target !== this.lastTarget || gallery !== this.lastGallery) {
      this.lastTarget = event.target;
      this.lastGallery = gallery;
      this.evaluate(event.target, gallery);
    }

    this.request();
  };

  private readonly onDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    if (this.down) return;
    this.down = true;
    this.el.dataset.down = 'true';
  };

  private readonly onUp = (): void => {
    if (!this.down) return;
    this.down = false;
    this.el.dataset.down = 'false';
  };

  /** relatedTarget が null = ポインタがウィンドウの外へ出た */
  private readonly onOut = (event: PointerEvent): void => {
    if (event.relatedTarget === null) this.onLeave();
  };

  private readonly onLeave = (): void => {
    if (!this.visible) return;
    this.visible = false;
    this.el.dataset.visible = 'false';
    // ネイティブカーソルへ即座に返す(ウィンドウ外・フォーカス喪失)
    document.documentElement.classList.remove('has-dimension-cursor');
  };

  /** 状態決定。DOM 書き込みは値が変わったときだけ */
  private evaluate(target: EventTarget | null, _gallery: boolean): void {
    let next: CursorState = 'idle';
    if (target instanceof Element) {
      /*
        キャンバスは**どちらのモードでも**掴める(Phase 16 で物語側にも見回しが
        付いた)。モードで出し分けていた頃の名残で引数は残してあるが、
        判定は「キャンバスの上か」だけ ── デスクトップではこのラベルが、
        物語の図を回せることを知らせる唯一の合図になる。
      */
      if (target.id === 'gl') next = 'drag';
      else if (target.closest(HOVER_SELECTOR) !== null) next = 'hover';
    }
    if (next === this.state) return;
    this.state = next;
    this.el.dataset.state = next;
  }

  // --- 追従 ------------------------------------------------------------------

  private request(): void {
    if (this.rafId !== 0) return;
    this.prevTime = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    const dt = Math.min((now - this.prevTime) / 1000, 0.1);
    this.prevTime = now;

    const k = 1 - Math.exp(-FOLLOW_RATE * dt);
    this.rx += (this.px - this.rx) * k;
    this.ry += (this.py - this.ry) * k;

    const value = `${this.rx.toFixed(2)}px ${this.ry.toFixed(2)}px`;
    this.ring.style.translate = value;
    this.label.style.translate = value;

    if (Math.abs(this.px - this.rx) < SETTLE_PX && Math.abs(this.py - this.ry) < SETTLE_PX) {
      this.rafId = 0; // 落ち着いたら止める。次の pointermove が起こす
      return;
    }
    this.rafId = requestAnimationFrame(this.tick);
  };
}

/**
 * 環境を見てカーソルを作る。作らない条件では **null** を返し、
 * ネイティブカーソルには一切触れない(タッチ端末 / reduced-motion / 粗いポインタ)。
 */
export function createCursor(parent: HTMLElement): Cursor | null {
  if (prefersReducedMotion()) return null;
  if (typeof window.matchMedia !== 'function') return null;
  if (!window.matchMedia('(pointer: fine)').matches) return null;
  if (!window.matchMedia('(hover: hover)').matches) return null;

  const cursor = new Cursor();
  cursor.mount(parent);
  return cursor;
}
