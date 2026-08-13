/**
 * Cursor — 計器としてのカーソル(Phase 9a / Phase 18 で回転子へ)。
 *
 * 5px の実点(遅れなし・mix-blend-mode: difference)と、10/s で遅れて追う 32px の
 * ヘアラインリング。リングの状態(idle / hover / drag / down)は data 属性 →
 * CSS カスタムプロパティ → `scale` の遷移で表現し、**JS は translate しか書かない**。
 *
 * Phase 18 で変わったこと:
 * - リングが **SVG** になった。理由は 2 つあり、どちらも div + border では届かない:
 *   ① `scale` は border ごと拡大するので、drag(×2.2)のとき線が **2.2px** に
 *      太っていた ── この作品がトークンで守っている 1px のヘアラインが、
 *      カーソルが最も大きく見える瞬間にだけ破れていた。`vector-effect:
 *      non-scaling-stroke` の一語で、どの倍率でも 1px に固定される。
 *   ② キャンバスの上では環が **2 本の弧へ割れて回る**(= ここは回る、という
 *      予告を形そのものが担う)。割れる過程は `stroke-dasharray` の補間で、
 *      弧の端の丸みは `stroke-linecap` で ── いずれも border では表現できない。
 * - 「DRAG」の文字を**捨てた**。カーソルの真芯にあって、指している対象そのものを
 *   隠していた。回る弧が同じことを、文字を読ませずに言う。
 *
 * 実装上の約束:
 * - デスクトップの細いポインタ専用。`(pointer: fine)` かつ `(hover: hover)` かつ
 *   reduced-motion でないときだけ mount する。それ以外ではネイティブカーソルに
 *   一切触れない(`html { cursor: none }` も付けない)。
 * - 2 要素は **body 直下の兄弟**として置く。共通の親に z-index を与えると
 *   スタッキングコンテキストが分離して `mix-blend-mode: difference` が背景を
 *   見なくなるため、包む div は position: static のままにしてある。
 * - rAF ループは落ち着いたら自分で止まる。毎フレームの新規オブジェクト生成なし
 *   (スタイル文字列だけは DOM 書き込みに不可避)。
 */

import { h, s, prefersReducedMotion, type Component } from './component';

/** リングの追従レート(1/s)。1 - exp(-rate·dt) で寄せる */
const FOLLOW_RATE = 10;
/** これ以下の残差になったら rAF を止める(px) */
const SETTLE_PX = 0.05;

/** hover 状態にする対象。data-cursor は任意の要素へ後付けできる逃げ道 */
const HOVER_SELECTOR =
  'a[href], button, input, select, textarea, summary, [data-cursor],' +
  '[role="button"], [role="switch"], [role="tab"], [contenteditable="true"]';

type CursorState = 'idle' | 'hover' | 'drag';

/**
 * 環の幾何(SVG ユーザー単位 = CSS px)。
 *
 * viewBox を**原点中心**に取ると、SVG 要素の CSS `transform-origin` の既定値
 * `0 0` がそのまま環の中心になる ── `scale` も `rotate` も余計な指定なしに
 * 中心基準で効く。半径 16 は Phase 9a の 32px 環と 1px も違わない。
 *
 * viewBox の広さは最大到達半径から決める: 16 × 2.2(drag)= 35.2px。40 で足りる。
 * `<svg>` の既定は `overflow: hidden` なので、ここが足りないと拡大した環が
 * 四角く切り落とされる(そして「なぜか環の上下が欠ける」に見える)。
 */
const RING_RADIUS = 16;
const RING_EXTENT = 40;

export class Cursor implements Component {
  /** Component 契約の代表要素(状態を持つ静的ラッパ)*/
  readonly el: HTMLElement;

  private readonly ring: SVGSVGElement;
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
    this.ring = buildRing();
    this.dot = h('div', 'dc-dot');
    this.el.append(this.ring, this.dot);
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
        判定は「キャンバスの上か」だけ ── デスクトップでは、ここで割れて回り出す
        環が、図を回せることを知らせる合図になる(Phase 18 まではこれが
        「DRAG」の文字だった)。
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

    this.ring.style.translate = `${this.rx.toFixed(2)}px ${this.ry.toFixed(2)}px`;

    if (Math.abs(this.px - this.rx) < SETTLE_PX && Math.abs(this.py - this.ry) < SETTLE_PX) {
      this.rafId = 0; // 落ち着いたら止める。次の pointermove が起こす
      return;
    }
    this.rafId = requestAnimationFrame(this.tick);
  };
}

/**
 * 環を組む(Phase 18)。
 *
 * 入れ子は下から順に「大きさ → 回転 → 押下時の追い回転」で、各層が
 * **別のプロパティ**を持つ ── `scale` は状態の CSS 変数から、`rotate` は
 * @keyframes から、位置(`translate`)は JS から。三者が同じ要素の
 * `transform` を奪い合わないので、どれも他を知らずに動ける。
 *
 * 押下の加速を「入れ子の第二層」で作るのは、`animation-duration` を
 * 差し替えると進行率 t/d が飛んで環が瞬間移動するため。層を足せば
 * 角速度が単純に合成され、押した瞬間も離した瞬間も角度は連続する。
 *
 * 内側の弧は外側と**同一周期で逆向き**に回る ── たがいに直交する二平面を
 * 同じ角速度で回すのが等傾回転(この作品の Clifford/Hopf 展示の主題)で、
 * その定義を色ではなく運動で言っている。
 */
function buildRing(): SVGSVGElement {
  const size = String(RING_EXTENT * 2);
  const root = s('svg', 'dc-ring', {
    viewBox: `${-RING_EXTENT} ${-RING_EXTENT} ${size} ${size}`,
    width: size,
    height: size,
  });

  const scaled = s('g', 'dc-ring-g');
  // pathLength=100 で周長を 100 に正規化する ── dasharray を「全周の %」で
  // 書けるので、半径を変えても弧と隙間の比が崩れない
  const arc = (className: string, radius: number): SVGCircleElement =>
    s('circle', className, { cx: '0', cy: '0', r: String(radius), pathLength: '100' });

  const outer = s('g', 'dc-rotor');
  const outerFast = s('g', 'dc-rotor-fast');
  outerFast.append(arc('dc-arc', RING_RADIUS));
  outer.append(outerFast);

  const inner = s('g', 'dc-rotor dc-rotor-rev');
  const innerFast = s('g', 'dc-rotor-fast dc-rotor-rev');
  innerFast.append(arc('dc-arc-in', RING_RADIUS * 0.72));
  inner.append(innerFast);

  scaled.append(outer, inner);
  root.append(scaled);
  return root;
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
