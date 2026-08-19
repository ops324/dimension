import { clamp } from '../math/ease';

/**
 * スクロールの「滑走」だけを担う純粋な積分器(Phase 24 / 追従は Phase 34c で
 * 一次の指数平滑から**臨界減衰の二次系**へ)。
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
 * 追従の角周波数(rad/s)。**臨界減衰(ζ = 1)の二次系**(Phase 34c)。
 *
 * Phase 24 は一次の指数平滑(rate 8、時定数 125ms)だった。一次は入力の瞬間に
 * 速度が最大になり、そこから単調に減衰する ── つまり **ẋ が t=0 で跳ぶ**。
 * 1 ノッチが刻んで届く感じの正体はここにある。臨界減衰なら ẋ(0) = 0 で、
 * 速度も連続に立ち上がる。ζ は 1 ちょうど ── 1 未満は行き過ぎ(読者が指定した
 * 位置を通り過ぎる = §2.1 の「巻き戻せる」感覚を壊す)、1 超えは遅れが増える。
 *
 * **16 という値に調律の余地は無い。** 二次系のランプ追従の遅れは 2/ω なので、
 * 一次の 1/rate と揃えるには ω = 2 × rate でなければならない。外すと:
 *   整定時間で揃える(ω ≈ 12.7)→ 遅れが 125 → 158ms。「指から図がちぎれる」に直撃
 *   ω を下げる → 2 秒で GLIDE_SNAP へ入らなくなる(ω ≥ 約 6.25 が下限)
 *
 * ω = 16 の値(100px ノッチ、60Hz、120 フレーム):
 *   二階差分の最大        12.483 → **4.09px(3.05 分の 1)**
 *   ランプ遅れ @1200px/s  140.22 → **140.00px(不変)**
 *   ステップのピーク速度  8A → 5.886A(−26%)
 *   GLIDE_SNAP までの尾   950 → 625ms
 * 代償は 2 つだけ ── 出だしの +15.8ms(ノッチの 5% を動くまで 6.4 → 22.2ms)と、
 * **逆走の持ち越し** v₀/(ω·e)。一次には無かった現象で、どちらも数では
 * 良し悪しが決まらない(作者が指で判定する)。
 */
export const GLIDE_OMEGA = 16;

/**
 * 残距離がこれ未満なら目標へスナップする(px)。
 *
 * 0.05 だった(Phase 24)。100px ノッチがその圏内へ入るまで **950ms** かかり、
 * 読んでいるあいだほぼ常に `settled === false` ── 「着いている間は 1 バイトも
 * 書かない」という契約が実質発動していなかった。dpr 2 の**半物理画素**まで
 * 緩めても、見える位置は 1 画素も変わらない(scrollY はどのみち 0.5px 単位へ
 * 丸められる)。コメントの自己申告と実装が 10 倍ずれていたのを揃えた。
 */
export const GLIDE_SNAP = 0.25;

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
  /**
   * 二次系の**内段**。`cur` は「内段を追う一次系」で、二段合わせて臨界減衰になる。
   *
   * ばね積分器(速度を状態に持って semi-implicit Euler で積む形)は書かない。
   * 臨界減衰は伝達関数が `ω²/(s+ω)² = [ω/(s+ω)]²` なので、**同じレートの
   * 一次 2 段直列と厳密に等しい** ── つまり `expSmooth` と同じ「厳密解を dt で
   * 刻む」形が閉じた形で書ける。フレームレート非依存がここで保たれる
   * (Euler で積むと 120Hz と 20Hz が 2.3px ずれ、既存試験が落ちる)。
   *
   * 速度は `ω(inner − cur)` で復元できるので、独立に壊れる状態は増えていない。
   */
  private inner = 0;
  private tgt = 0;
  private maxY = 0;

  /** いま書き込むべき位置(px) */
  get value(): number {
    return this.cur;
  }

  /** いまの速度(px/s)。内段との差がそのまま速度になる */
  get velocity(): number {
    return GLIDE_OMEGA * (this.inner - this.cur);
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
   *
   * **内段も見る**(Phase 34c)。位置だけを見ると「cur === tgt だが速度が残っている」
   * 瞬間 ── 走行中に逆向きの入力が来て目標が現在値と一致した場合 ── を
   * 「着いた」と誤判定し、読者の入力ぶんの運動を黙って捨てることになる。
   */
  get settled(): boolean {
    return this.cur === this.tgt && this.inner === this.tgt;
  }

  /**
   * スクロール上限の更新(resize / セクション高の変化)。目標は新しい上限へ丸める。
   * **現在値と内段も丸める** ── ばねは速度を持つので、内段だけ上限の外に
   * 残っていると、そこへ引かれて壁を突き抜ける(一次系には無かった現象)。
   */
  setMax(max: number): void {
    this.maxY = max > 0 ? max : 0;
    this.tgt = clamp(this.tgt, 0, this.maxY);
    if (this.cur > this.maxY) this.cur = this.maxY;
    if (this.inner > this.maxY) this.inner = this.maxY;
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
    // 内段も置く = 速度もゼロにする。残すと、指で送った先で勝手に走り出す
    this.inner = at;
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
   *
   * 臨界減衰の**閉じた形**。誤差 u = inner − tgt、w = cur − tgt に対して
   *
   *   a = e^{−ω·dt}
   *   w(t+dt) = w·a + u·ω·dt·a      ← 外段は内段との差も引き継ぐ
   *   u(t+dt) = u·a
   *
   * これは `x(t) = A[1 − (1 + ωt)e^{−ωt}]` の厳密解を dt で刻んだものなので、
   * **任意の dt で正確**(120Hz でも 20Hz でも同じ時間で同じ位置に着く)。
   * `expSmooth` を素朴に 2 回呼ぶ形は、外段が内段の**更新後**の値を読むため
   * これを満たさない ── 100px ステップの 250ms 後で 120Hz と 20Hz が 2.3px ずれる。
   */
  step(dt: number): number {
    const a = Math.exp(-GLIDE_OMEGA * dt);
    // 外段は**更新前の**内段を読む。順序がこの式の正しさそのもの
    const u = this.inner - this.tgt;
    this.cur = this.tgt + (this.cur - this.tgt) * a + u * GLIDE_OMEGA * dt * a;
    this.inner = this.tgt + u * a;

    // 文書の端は壁。ぶつかったら速度も捨てる ── 残すと端で跳ね返り、
    // ブラウザがクランプする位置を毎フレーム書き続けることになる
    if (this.cur < 0) {
      this.cur = 0;
      this.inner = 0;
    } else if (this.cur > this.maxY) {
      this.cur = this.maxY;
      this.inner = this.maxY;
    }

    // **両段が圏内に入ってはじめて**着地とする(片方だけだと速度を捨てる)
    if (
      Math.abs(this.tgt - this.cur) < GLIDE_SNAP &&
      Math.abs(this.tgt - this.inner) < GLIDE_SNAP
    ) {
      this.cur = this.tgt;
      this.inner = this.tgt;
    }
    return this.cur;
  }
}
