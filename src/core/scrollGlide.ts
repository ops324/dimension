import { clamp, expSmooth } from '../math/ease';

/**
 * スクロールの「滑走」だけを担う純粋な積分器(Phase 24)。
 *
 * DOM に一切触れない ── window も document も読まない。ここに入るのは
 * 「いまの位置・行きたい位置・行ける上限」の 3 つの数だけで、実際に
 * `window.scrollTo` を書くのは `smoothScroll.ts` の役目。分けてあるのは、
 * この層こそが体感を決める場所であり、**テストで挙動を固定したい**ため
 * (`src/tests/scrollGlide.test.ts`)。
 *
 * なぜ「ホイールを奪って自分で書く」形にしたか:
 * ネイティブのホイールは 1 ノッチ = 約 100px の**離散的な飛び**で届く。
 * この作品は scrollY がそのまま図形の次元・カメラ・文字の不透明度を駆動するため、
 * 飛びはそのまま図形の飛びになる。位置そのものを平滑化すれば、
 * 文字(DOM)と図形(WebGL)が**同じ 1 つの値**から滑らかに動く ──
 * どちらか片方だけを平滑化すると、両者は必ずずれる。
 */

/**
 * 指数平滑化のレート。時定数 τ = 1/rate ≒ 125ms。
 * これより速いとノッチが残り、遅いと指から図がちぎれて「重い」になる。
 */
export const GLIDE_RATE = 8;

/** 残距離がこれ未満なら目標へスナップする(px)。1 物理画素より細かい追従は無意味 */
export const GLIDE_SNAP = 0.05;

/**
 * `deltaMode = 1`(行単位)1 行あたりの px。
 * Firefox はノッチあたり 3 行を返すので、3 × 33.3 = 100px となり
 * Chrome のノッチ 100px と一致する ── 体感距離をブラウザ間で揃えるための係数。
 */
export const LINE_STEP = 100 / 3;

/** キーボードの 1 打鍵ぶん(px)。ネイティブの 40px は滑走させると遅く感じる */
export const ARROW_STEP = 64;

/** Space / PageDown が進む量(ビューポート比)。1.0 だと読んでいた行が消える */
export const PAGE_FRACTION = 0.9;

/**
 * ホイールの delta を px へ正規化する。
 * deltaMode: 0 = px(Chrome/Safari)、1 = 行(Firefox)、2 = ページ。
 */
export const normalizeWheel = (
  deltaY: number,
  deltaMode: number,
  viewportHeight: number,
): number => {
  if (deltaMode === 1) return deltaY * LINE_STEP;
  if (deltaMode === 2) return deltaY * viewportHeight;
  return deltaY;
};

/** キー入力の意図。相対移動か、絶対位置(Home / End)か、対象外か */
export type ScrollIntent = { readonly delta: number } | { readonly to: number } | null;

/**
 * スクロールを意味するキーを px の意図へ翻訳する。
 * **ここに載っていないキーには一切触らない**(修飾キー付きも呼び出し側で弾く)。
 */
export const keyIntent = (
  key: string,
  shiftKey: boolean,
  viewportHeight: number,
  max: number,
): ScrollIntent => {
  const page = viewportHeight * PAGE_FRACTION;
  switch (key) {
    case 'ArrowDown':
      return { delta: ARROW_STEP };
    case 'ArrowUp':
      return { delta: -ARROW_STEP };
    case 'PageDown':
      return { delta: page };
    case 'PageUp':
      return { delta: -page };
    // Space は「読み進める」の既定操作。Shift で戻る(ブラウザ既定と同じ約束)
    case ' ':
    case 'Spacebar':
      return { delta: shiftKey ? -page : page };
    case 'Home':
      return { to: 0 };
    case 'End':
      return { to: max };
    default:
      return null;
  }
};

export class ScrollGlide {
  private cur = 0;
  private tgt = 0;
  private maxY = 0;

  /** いま書き込むべき位置(px) */
  get value(): number {
    return this.cur;
  }

  /** 慣性の行き先(px) */
  get target(): number {
    return this.tgt;
  }

  /** スクロール可能な最大位置(px) */
  get max(): number {
    return this.maxY;
  }

  /**
   * 目標に着いているか。**着いている間は誰も scrollTo を書かない**という契約で、
   * タッチ端末のネイティブ慣性やスクロールバーのドラッグと競合しない。
   */
  get settled(): boolean {
    return this.cur === this.tgt;
  }

  /** スクロール上限の更新(resize / セクション高の変化)。目標は新しい上限へ丸める */
  setMax(max: number): void {
    this.maxY = max > 0 ? max : 0;
    this.tgt = clamp(this.tgt, 0, this.maxY);
  }

  /**
   * 外部要因(タッチ・スクロールバー・`scrollTo`・履歴復元)で位置が動いたときの再同期。
   * 現在値と目標を**同時に**その位置へ置く ── 目標だけ残すと、次のフレームで
   * 読者が指で送った先から勝手に引き戻される。
   */
  reset(y: number): void {
    const at = y > 0 ? y : 0;
    if (at > this.maxY) this.maxY = at;
    this.cur = at;
    this.tgt = at;
  }

  /** ホイール / キーの相対入力 */
  push(delta: number): void {
    this.tgt = clamp(this.tgt + delta, 0, this.maxY);
  }

  /** Home / End のような絶対指定 */
  to(y: number): void {
    this.tgt = clamp(y, 0, this.maxY);
  }

  /**
   * 1 フレーム進めて、書き込むべき位置を返す。
   * `expSmooth` はフレームレート非依存なので、120Hz でも 30Hz でも同じ時間で着く。
   */
  step(dt: number): number {
    this.cur = expSmooth(this.cur, this.tgt, GLIDE_RATE, dt);
    if (Math.abs(this.tgt - this.cur) < GLIDE_SNAP) this.cur = this.tgt;
    return this.cur;
  }
}
