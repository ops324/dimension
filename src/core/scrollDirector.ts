import { clamp01, expSmooth, smoothstep } from '../math/ease';

/**
 * スクロール位置 → (章, 章内進捗, dimLevel) の変換器(プラン2節)。
 *
 * 設計上の約束:
 * - **scroll / wheel / touch のリスナーを一切張らない**。毎フレーム rAF の中で
 *   `window.scrollY` を読むだけ。モバイル Safari のリサイズストームやスクロール
 *   イベントの間引き差異に影響されない(既知の罠 #5)。
 * - セクションの実測(getBoundingClientRect)は `remeasure()` に集約する。
 *   毎フレームのレイアウト読みは強制同期レイアウトを招くため厳禁。
 * - 公開値は getter のみ。毎フレームのオブジェクト生成をしないよう内部フィールドを
 *   書き換える(ゼロアロケーション契約)。
 */

/** 章の前半 40% で次元を伸ばし、残り 60% は読書のためのプラトーにする */
const MORPH_FRACTION = 0.4;
/**
 * dimLevel の指数平滑化レート(プラン2節: rate≈6)。
 * この 6 は **ホイールの離散的なノッチを隠すため**の値だった。
 */
export const SMOOTH_RATE_NATIVE = 6;
/**
 * スクロール位置そのものが滑走しているとき(`smoothScroll` 有効時)のレート。
 * ノッチ隠しの役目は前段へ移ったので、ここは緩める ── 二段重ねの遅れは
 * 時定数の和(1/8 + 1/6 = 292ms)になり、図が指からちぎれて見える。
 * 14 にすると 125 + 71 = 196ms で、Phase 23 までの体感(167ms)にほぼ揃う。
 */
export const SMOOTH_RATE_GLIDING = 14;
/** 平滑値をターゲットへスナップする閾値 */
const SNAP_EPSILON = 1e-4;

export class ScrollDirector {
  /** 章セクション(index.html の <section class="chapter">) */
  private readonly sections: readonly HTMLElement[];
  /** 章ごとの目標 dimLevel */
  private readonly dims: Float64Array;
  /** 章の開始スクロール位置(ドキュメント座標) */
  private readonly starts: Float64Array;
  /** 章のスクラブ可能長 = max(1, セクション高 − ビューポート高) */
  private readonly lens: Float64Array;
  /**
   * 章ごとの localT ∈ [0,1]。overlays が全章のフェードを駆動するために使う。
   * **読み取り専用として扱うこと**(TypedArray に readonly 修飾はできないため規約で担保)。
   */
  readonly chapterLocals: Float64Array;

  private scrollMax = 1;
  private viewportHeight = 1;

  private activeIndex = 0;
  private activeLocalT = 0;
  private smoothedDim = 0;
  private targetDim = 0;
  private progress = 0;
  private smoothRate = SMOOTH_RATE_NATIVE;

  /** 初回 update() でのレイアウト再計測 + 平滑値のスナップに使う */
  private settled = false;

  constructor(sections: readonly HTMLElement[], dims: readonly number[]) {
    if (sections.length === 0) throw new Error('ScrollDirector: sections is empty');
    if (sections.length !== dims.length) {
      throw new Error('ScrollDirector: sections と dims の要素数が一致しない');
    }

    this.sections = sections;
    this.dims = Float64Array.from(dims);
    this.starts = new Float64Array(sections.length);
    this.lens = new Float64Array(sections.length).fill(1);
    this.chapterLocals = new Float64Array(sections.length);

    this.remeasure();
  }

  /** 章の総数 */
  get count(): number {
    return this.sections.length;
  }

  /** 現在ピン留めされている章のインデックス */
  get chapterIndex(): number {
    return this.activeIndex;
  }

  /**
   * dimLevel の平滑化レートの差し替え(`SMOOTH_RATE_NATIVE` / `SMOOTH_RATE_GLIDING`)。
   * 前段でスクロール位置が平滑化されているかどうかで、必要な量が変わる。
   */
  setSmoothRate(rate: number): void {
    this.smoothRate = rate > 0 ? rate : SMOOTH_RATE_NATIVE;
  }

  /** 現在の章の中での進捗 ∈ [0,1] */
  get localT(): number {
    return this.activeLocalT;
  }

  /** 平滑化済みの次元レベル ∈ [0,6]。narrative シーンが読む値 */
  get dimLevel(): number {
    return this.smoothedDim;
  }

  /** 平滑化前の目標次元レベル(デバッグ・検証用) */
  get dimTarget(): number {
    return this.targetDim;
  }

  /** ページ全体のスクロール進捗 ∈ [0,1](プログレスバー用) */
  get globalProgress(): number {
    return this.progress;
  }

  /**
   * セクション寸法の再計測。
   *
   * 呼ぶタイミング: 生成時 / debounce 後の resize(engine.onResize)/
   * `document.fonts.ready` / 初回フレーム(レイアウト確定待ち)。
   *
   * offsetTop ではなく getBoundingClientRect を使う理由:
   * `#narrative` は position:relative なので、子セクションの offsetTop は
   * ドキュメント原点ではなく #narrative 基準になってしまう。rect + scrollY なら
   * offsetParent に依存せず常にドキュメント座標が得られ、端数も保たれる。
   */
  remeasure(): void {
    const vh = Math.max(1, window.visualViewport?.height ?? window.innerHeight);
    this.viewportHeight = vh;

    const scrollY = window.scrollY;
    for (let i = 0; i < this.sections.length; i++) {
      const rect = this.sections[i].getBoundingClientRect();
      this.starts[i] = rect.top + scrollY;
      // ピンが貼り付いている間だけがスクラブ区間。0 除算は max(1,…) で構造的に排除
      this.lens[i] = Math.max(1, rect.height - vh);
    }

    this.scrollMax = Math.max(1, document.documentElement.scrollHeight - vh);
  }

  /**
   * 毎フレーム呼ぶ(engine.onFrame から)。
   * ここでは **レイアウトを読まない** — window.scrollY はレイアウトを強制しない。
   */
  update(dt: number): void {
    // 初回フレーム: フォント適用前後でセクション高が動くので測り直し、
    // かつ平滑値をターゲットへスナップする(リロード復帰時の 0 からの助走を防ぐ)
    const first = !this.settled;
    if (first) {
      this.settled = true;
      this.remeasure();
    }

    const y = window.scrollY > 0 ? window.scrollY : 0;
    const n = this.sections.length;

    // 章の判定と全章の localT を同時に求める(starts は昇順)
    let index = 0;
    for (let i = 0; i < n; i++) {
      this.chapterLocals[i] = clamp01((y - this.starts[i]) / this.lens[i]);
      if (y >= this.starts[i]) index = i;
    }

    this.activeIndex = index;
    this.activeLocalT = this.chapterLocals[index];

    // 章 i は d[i-1] → d[i] を前半 MORPH_FRACTION で補間し、以降はプラトー。
    // 先頭章は d[-1] = d[0] とみなす(プロローグは 0 を保持する)。
    const from = index === 0 ? this.dims[0] : this.dims[index - 1];
    const to = this.dims[index];
    this.targetDim = from + (to - from) * smoothstep(this.activeLocalT / MORPH_FRACTION);

    if (first) {
      this.smoothedDim = this.targetDim;
    } else {
      this.smoothedDim = expSmooth(this.smoothedDim, this.targetDim, this.smoothRate, dt);
      if (Math.abs(this.targetDim - this.smoothedDim) < SNAP_EPSILON) {
        this.smoothedDim = this.targetDim;
      }
    }

    this.progress = clamp01(y / this.scrollMax);
  }

  /** 現在のビューポート高(デバッグ表示用) */
  get measuredViewportHeight(): number {
    return this.viewportHeight;
  }
}
