/**
 * Drawer — 解説の引き出し(Phase 9b)。
 *
 * 幾何は Phase 7 のまま(デスクトップは左から差し込む板、モバイルは下からの
 * フルシート)。変えたのは**開いたあとに何が起きるか**:
 *
 *   ① 背後をわずかに落とす暗幕。blur は敷かない ── 全画面の backdrop-filter は
 *      ギャラリー中の WebGL と真正面からフレーム時間を取り合うため。
 *   ② 見出しは SplitText の文字で立ち上がり、本文は段落ごとに 60ms ずつ遅れて
 *      浮かび上がる(**開いたときだけ**。閉じるのは一息で引く)。
 *   ③ 板の縁に 1px のグラデーションヘアライン(CSS 側の ::after)。
 *   ④ 閉じる ✕ には磁力。
 *
 * 本文を**段落単位で**動かすのは content.ts の解説が `<em>` と `<sup>` を含む
 * ためで、SplitText の行分割は textContent で組み直すので指数の組版が壊れる
 * (S³ が S3 になる)。数式の正しさは動きより上位 ── 行の代わりに段落を、
 * 同じ 60ms の階段で送る。
 */

import { EASE, cancelAll, h, play, type Component } from './component';
import { reveal, splitChars, type SplitHandle } from './SplitText';
import { magnetize, type Magnet } from './MagneticButton';

export interface DrawerOptions {
  /** 器。index.html の #gallery-drawer */
  readonly root: HTMLElement;
  /** 暗幕のクリック・閉じるボタンから呼ばれる(呼び出し側が状態を一元管理する) */
  readonly onRequestClose: () => void;
}

/** 段落の階段(ms) */
const PARA_STAGGER = 60;
const PARA_MS = 560;
const PARA_DELAY = 120;
/** 見出しの文字送り(ms) */
const TITLE_STAGGER = 16;
const TITLE_MS = 620;
/** 段落の立ち上がり(px) */
const RISE = 10;

/** 焦点の閉じ込めが巡回する対象(Phase 14c)。押された瞬間に数え直す */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export class Drawer implements Component {
  readonly el: HTMLElement;

  private readonly titleEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly closeEl: HTMLButtonElement;
  private readonly scrim: HTMLElement;
  private readonly magnet: Magnet;
  private readonly onRequestClose: () => void;

  private readonly running: Animation[] = [];
  private titleSplit: SplitHandle | null = null;
  private open = false;
  private timer = 0;

  constructor(options: DrawerOptions) {
    this.el = options.root;
    this.onRequestClose = options.onRequestClose;

    this.titleEl = need(this.el, 'drawer-title');
    this.bodyEl = need(this.el, 'drawer-body');
    this.closeEl = need(this.el, 'drawer-close') as HTMLButtonElement;

    // ダイアログとしての意味づけ(aria-labelledby は index.html が持っている)
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');

    this.scrim = h('div', 'dw-scrim', { 'aria-hidden': 'true' });
    this.scrim.addEventListener('click', this.onScrim);
    this.el.parentElement?.insertBefore(this.scrim, this.el);

    /*
      本文にキーボードの停留点を与える(Phase 14c)。

      .dw-body は overflow-y: auto なのに、これまでキーボードでスクロールする手段が
      無かった。焦点の閉じ込めを足すと、これが無いと停留点が ✕ 1 つだけになり
      Tab が無反応になる ── 準拠を実際の改善へ変える 1 行でもある。
    */
    this.bodyEl.tabIndex = 0;

    this.closeEl.addEventListener('click', this.onClose);
    this.closeEl.setAttribute('data-cursor', '');
    this.magnet = magnetize(this.closeEl, { radius: 70, strength: 0.35, max: 6, labelMax: 6 });
  }

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * 中身の差し替え。**開いていないときにだけ**呼ばれる想定
   * (展示の切替はドロワーを閉じた状態で走る)。
   */
  setContent(title: string, html: string): void {
    this.stop();
    this.titleEl.textContent = title;
    // 解説は content.ts の定数のみ(外部入力は入らない)
    this.bodyEl.innerHTML = html;
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    this.el.classList.add('is-open');
    this.el.setAttribute('aria-hidden', 'false');
    this.scrim.dataset.on = 'true';
    this.el.addEventListener('keydown', this.onKeyDown);
    this.reveal();
    this.focusClose();
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.stop();
    /*
      リスナは**ここで外す**。is-open のトランジション(0.38s)の完了に載せてはならない ──
      exitGallery() は closeDrawer() と rootEl.hidden = true を同じ同期ブロックで
      実行するので、遅らせると display:none のサブツリーへフォーカスを跳ね返そうとする。
    */
    this.el.removeEventListener('keydown', this.onKeyDown);
    this.el.classList.remove('is-open');
    this.el.setAttribute('aria-hidden', 'true');
    this.scrim.dataset.on = 'false';
  }

  destroy(): void {
    this.stop();
    this.magnet.destroy();
    this.el.removeEventListener('keydown', this.onKeyDown);
    this.closeEl.removeEventListener('click', this.onClose);
    this.scrim.removeEventListener('click', this.onScrim);
    this.scrim.remove();
  }

  // --- 内部 ------------------------------------------------------------------

  private readonly onClose = (): void => this.onRequestClose();
  private readonly onScrim = (): void => this.onRequestClose();

  /**
   * 焦点の閉じ込め(Phase 14c)。
   *
   * `role="dialog" aria-modal="true"` を宣言している以上、Tab が背後へ抜けるのは
   * 仕様違反である。にもかかわらずここまで Tab の制御は 1 行も無かった。
   *
   * **Escape はここでは扱わない。** 順序の契約(没入 → ドロワー → 退場)は
   * gallery.ts の window リスナ 1 本が持っており、ここで拾うと二重に閉じる。
   *
   * 兄弟を inert にする案は採らない ── 7 要素(うち 1 つは展示ごとに作り直される)へ
   * 触ることになり、遷移の途中で例外が飛べばページが恒久的に inert になる。
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab' || !this.open) return;
    // 押された瞬間に数える。**キャッシュしない** ── setContent が本文を差し替え、
    // reveal() が見出しを再分割するので、作り置きした一覧はすぐ古くなる
    const items = this.el.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !this.el.contains(active)) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (active === last || !this.el.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };

  /**
   * ダイアログを開いたらフォーカスを ✕ へ渡す。
   * **初回だけ**は受け取られないことがある ── クラスを付けた直後の要素は
   * まだ「描画されている」と見なされず、focus() が黙って無視される。
   * 受け取れたかを確かめ、駄目なら次のタスクでもう一度だけ試す。
   */
  private readonly focusClose = (): void => {
    if (this.timer !== 0) {
      window.clearTimeout(this.timer);
      this.timer = 0;
    }
    // 「描画されているか」の判定は最新のレイアウトを要る。開くときに 1 度だけ
    // 読んで確定させてから渡す(この読みは開閉のたびの 1 回きり)
    void this.closeEl.offsetWidth;
    this.closeEl.focus({ preventScroll: true });
    if (document.activeElement === this.closeEl || !this.open) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      if (this.open) this.closeEl.focus({ preventScroll: true });
    }, 0);
  };

  /** 開いた瞬間の振り付け。見出し(文字)→ 段落(階段) */
  private reveal(): void {
    this.titleSplit = splitChars(this.titleEl, { keepWords: true });
    pushAll(
      this.running,
      reveal(this.titleSplit, {
        stagger: TITLE_STAGGER,
        duration: TITLE_MS,
        easing: EASE.outExpo,
      }),
    );

    const paragraphs = this.bodyEl.children;
    for (let i = 0; i < paragraphs.length; i++) {
      this.running.push(
        play(
          paragraphs[i],
          [
            { opacity: 0, transform: `translateY(${RISE}px)` },
            { opacity: 1, transform: 'translateY(0)' },
          ],
          {
            duration: PARA_MS,
            delay: PARA_DELAY + i * PARA_STAGGER,
            easing: EASE.outExpo,
            fill: 'backwards',
          },
        ),
      );
    }
  }

  /** 走っているものを畳み、分割したテキストを元へ戻す */
  private stop(): void {
    cancelAll(this.running);
    this.titleSplit?.restore();
    this.titleSplit = null;
    if (this.timer !== 0) {
      window.clearTimeout(this.timer);
      this.timer = 0;
    }
  }
}

/* ------------------------------------------------------------------ 内部 */

function pushAll(into: Animation[], animations: readonly Animation[]): void {
  for (let i = 0; i < animations.length; i++) into.push(animations[i]);
}

function need(root: HTMLElement, id: string): HTMLElement {
  const node = root.querySelector<HTMLElement>(`#${id}`);
  if (node === null) {
    throw new Error(`DIMENSION: #${id} not found (index.html の解説ドロワーを確認)`);
  }
  return node;
}
