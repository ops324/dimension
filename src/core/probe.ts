/**
 * スクロールの計測プローブ(Phase 34b — **DEV のみ**)。
 *
 * なぜ先に測るのか:
 * 「スクロールをもっと滑らかに」という要望には、少なくとも 3 つの別々の原因が
 * ありうる ── **折れ**(1 ノッチが刻んで届く)・**遅れ**(指から図がちぎれる)・
 * **フレーム落ち**(そもそも描けていない)。この作品は `window.scrollTo` を rAF で
 * 書いているので、1 フレーム落ちるとアニメーションではなく**スクロールそのもの**が
 * 止まる(ネイティブなら合成スレッドが回し続ける)。つまり原因が 3 番目だった場合、
 * 追従フィルタをどう作り替えても体感は変わらない。
 *
 * 出す数は SPEC §5.5 の前例に倣って **二階差分の最大とフレーム間移動量を対で**扱う
 * ── 前者が折れ、後者が遅れ。片方だけでは「遅らせただけ」と区別がつかない。
 *
 * 立て付け:
 * - `sample()` は engine のフレームループから呼ぶ。**記録していない間は即 return** で、
 *   配列も触らない(ゼロアロケーション契約 / SPEC §4.2 を壊さない)。
 * - フレーム時間は `performance.now()` の差そのもの。engine の `MAX_DELTA`(1/20)
 *   クランプは通さない ── クランプ後の dt を見ると、まさに測りたい落ちが消える。
 * - wheel は `capture` と `bubble` の 2 箇所で時刻を取る。あいだに `smoothScroll` の
 *   `onWheel` が挟まるので、差は「wheel 1 件の配送にかかった時間」の上界になる。
 *   **奪う側には一切触らない**(passive で聞くだけ)。
 * - 本番ビルドには 1 バイトも残らない。`main.ts` の `import.meta.env.DEV` の中から
 *   **動的 import** で読む(静的 import は巻き上げられて本番へ混じる)。
 */

/** これ以上間が空いたら別のジェスチャとみなす(ms)。macOS の慣性は 1 秒以上続く */
const GESTURE_GAP_MS = 250;

/** 60fps の予算(ms) */
export const FRAME_BUDGET_MS = 1000 / 60;

/**
 * 二階差分の最大。SPEC §5.5(Phase 30b の環の半径)が使っているのと同じ指標で、
 * 「折れ」だけを見る ── 速さそのものは一階差分が持つ。
 */
export function secondDifferenceMax(xs: readonly number[]): number {
  let max = 0;
  for (let i = 1; i < xs.length - 1; i++) {
    const d2 = Math.abs(xs[i + 1] - 2 * xs[i] + xs[i - 1]);
    if (d2 > max) max = d2;
  }
  return max;
}

/** 一階差分の最大(絶対値)。二階差分と対で読むためのもの */
export function firstDifferenceMax(xs: readonly number[]): number {
  let max = 0;
  for (let i = 1; i < xs.length; i++) {
    const d = Math.abs(xs[i] - xs[i - 1]);
    if (d > max) max = d;
  }
  return max;
}

/**
 * パーセンタイル(線形補間なしの最近傍)。`xs` は**昇順に並んでいること**。
 * 空配列では 0 を返す ── 記録が 1 件も無いときに NaN を報告しないため。
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

export interface FrameStats {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  /** 60fps の予算を超えたフレームの割合 ∈ [0,1] */
  readonly overBudget: number;
}

export function frameStats(frameMs: readonly number[]): FrameStats {
  if (frameMs.length === 0) return { p50: 0, p95: 0, max: 0, overBudget: 0 };
  const sorted = [...frameMs].sort((a, b) => a - b);
  let over = 0;
  for (const ms of frameMs) if (ms > FRAME_BUDGET_MS) over++;
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    overBudget: over / frameMs.length,
  };
}

/** wheel 1 件ぶんの生ログ */
export interface WheelSample {
  readonly t: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly cancelable: boolean;
  /** `WheelEvent.momentum`(Chrome 151+)。取れない環境では null */
  readonly momentum: boolean | null;
  /** capture → bubble の差(ms)。あいだに smoothScroll の onWheel が挟まる */
  readonly ms: number;
}

/** 1 ジェスチャ(指を置いてから慣性が終わるまで)の要約 */
export interface GestureSummary {
  readonly events: number;
  readonly ms: number;
  readonly deltaSum: number;
  /**
   * cancelable だった件数。
   * **0 なら、そのジェスチャは丸ごとネイティブスクロールに落ちている**
   * (Safari がメインスレッドを 50ms 待って諦めた場合など)。
   */
  readonly cancelable: number;
  /** momentum が true だった件数。取れない環境では null */
  readonly momentum: number | null;
  readonly deltaMode: number;
}

export interface ProbeReport {
  readonly frames: number;
  readonly seconds: number;
  /**
   * 記録中に一度でも文書が hidden になったか。
   *
   * hidden になると rAF が止まるので `sample()` が呼ばれなくなり、
   * **frames が 0 のまま「折れゼロ」という嘘の要約が出る**。背面タブでの記録や、
   * 自動化ブラウザから評価を挟んだときに実際に起きる(検証ハーネスで踏んだ)。
   * true のときは、この報告の数を根拠にしてはいけない。
   */
  readonly documentHidden: boolean;
  /** フレーム時間(ms)。rAF のタイムスタンプ差そのもの */
  readonly frameMs: FrameStats;
  /** scrollY の二階差分の最大(px)= 折れ */
  readonly d2ScrollY: number;
  /** scrollY の一階差分の最大(px)= 1 フレームの移動量 */
  readonly d1ScrollY: number;
  /** dimLevel の二階差分の最大 */
  readonly d2Dim: number;
  readonly d1Dim: number;
  /** wheel 1 件の配送にかかった時間(ms) */
  readonly wheelMs: { readonly mean: number; readonly max: number; readonly n: number };
  readonly gestures: readonly GestureSummary[];
  /** `record(s, { raw: true })` のときだけ入る */
  readonly raw?: {
    readonly t: readonly number[];
    readonly y: readonly number[];
    readonly dim: readonly number[];
    readonly wheels: readonly WheelSample[];
  };
}

export function summarizeGestures(wheels: readonly WheelSample[]): GestureSummary[] {
  const out: GestureSummary[] = [];
  let i = 0;
  while (i < wheels.length) {
    let j = i + 1;
    while (j < wheels.length && wheels[j].t - wheels[j - 1].t <= GESTURE_GAP_MS) j++;

    let deltaSum = 0;
    let cancelable = 0;
    let momentum = 0;
    let momentumKnown = false;
    for (let k = i; k < j; k++) {
      deltaSum += wheels[k].deltaY;
      if (wheels[k].cancelable) cancelable++;
      if (wheels[k].momentum !== null) {
        momentumKnown = true;
        if (wheels[k].momentum === true) momentum++;
      }
    }
    out.push({
      events: j - i,
      ms: wheels[j - 1].t - wheels[i].t,
      deltaSum,
      cancelable,
      momentum: momentumKnown ? momentum : null,
      deltaMode: wheels[i].deltaMode,
    });
    i = j;
  }
  return out;
}

/** `WheelEvent.momentum` は Chrome 151+ にしか無い。無い環境では null を返す */
function readMomentum(event: WheelEvent): boolean | null {
  const value = (event as unknown as { momentum?: unknown }).momentum;
  return typeof value === 'boolean' ? value : null;
}

export class ScrollProbe {
  private readonly ts: number[] = [];
  private readonly ys: number[] = [];
  private readonly dims: number[] = [];
  private readonly wheels: WheelSample[] = [];

  private recording = false;
  private startedAt = 0;
  /** capture 側で押した時刻。bubble 側が引く */
  private wheelEnteredAt = 0;
  private pendingWheel: WheelEvent | null = null;
  /** 記録中に一度でも hidden になったか(なった時点でこの記録は無効) */
  private sawHidden = false;

  constructor() {
    window.addEventListener('wheel', this.onWheelCapture, { passive: true, capture: true });
    // **smoothScroll より後に登録される**ことが前提(main.ts の DEV ブロックは
    // createSmoothScroll のあと)。bubble 段の window リスナは登録順に走るので、
    // ここへ来た時点で onWheel は済んでいる
    window.addEventListener('wheel', this.onWheelBubble, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** engine のフレームループから毎フレーム呼ぶ。記録していない間は何もしない */
  readonly sample = (scrollY: number, dimLevel: number): void => {
    if (!this.recording) return;
    this.ts.push(performance.now());
    this.ys.push(scrollY);
    this.dims.push(dimLevel);
  };

  /** `seconds` 秒ぶん記録して要約を返す。作者が実機のホイール / 指で動かすためのもの */
  record(seconds = 10, options: { raw?: boolean } = {}): Promise<ProbeReport> {
    this.reset();
    this.recording = true;
    this.sawHidden = document.hidden;
    this.startedAt = performance.now();
    return new Promise((resolve) => {
      window.setTimeout(() => {
        this.recording = false;
        resolve(this.report(options.raw === true));
      }, seconds * 1000);
    });
  }

  reset(): void {
    this.ts.length = 0;
    this.ys.length = 0;
    this.dims.length = 0;
    this.wheels.length = 0;
  }

  report(raw = false): ProbeReport {
    const frameMs: number[] = [];
    for (let i = 1; i < this.ts.length; i++) frameMs.push(this.ts[i] - this.ts[i - 1]);

    let wheelSum = 0;
    let wheelMax = 0;
    for (const w of this.wheels) {
      wheelSum += w.ms;
      if (w.ms > wheelMax) wheelMax = w.ms;
    }

    const report: ProbeReport = {
      frames: this.ts.length,
      seconds: this.ts.length > 1 ? (this.ts[this.ts.length - 1] - this.ts[0]) / 1000 : 0,
      documentHidden: this.sawHidden,
      frameMs: frameStats(frameMs),
      d2ScrollY: secondDifferenceMax(this.ys),
      d1ScrollY: firstDifferenceMax(this.ys),
      d2Dim: secondDifferenceMax(this.dims),
      d1Dim: firstDifferenceMax(this.dims),
      wheelMs: {
        mean: this.wheels.length > 0 ? wheelSum / this.wheels.length : 0,
        max: wheelMax,
        n: this.wheels.length,
      },
      gestures: summarizeGestures(this.wheels),
    };

    if (!raw) return report;
    return {
      ...report,
      raw: { t: [...this.ts], y: [...this.ys], dim: [...this.dims], wheels: [...this.wheels] },
    };
  }

  dispose(): void {
    this.recording = false;
    window.removeEventListener('wheel', this.onWheelCapture, { capture: true });
    window.removeEventListener('wheel', this.onWheelBubble);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private readonly onVisibility = (): void => {
    if (this.recording && document.hidden) this.sawHidden = true;
  };

  private readonly onWheelCapture = (event: WheelEvent): void => {
    if (!this.recording) return;
    this.wheelEnteredAt = performance.now();
    this.pendingWheel = event;
  };

  private readonly onWheelBubble = (event: WheelEvent): void => {
    if (!this.recording || this.pendingWheel !== event) return;
    this.pendingWheel = null;
    this.wheels.push({
      t: this.wheelEnteredAt - this.startedAt,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      // **capture の時点の値**を読むべきだが、cancelable はディスパッチ中に
      // 変わらないのでここで読んで等価(preventDefault は defaultPrevented を動かす)
      cancelable: event.cancelable,
      momentum: readMomentum(event),
      ms: performance.now() - this.wheelEnteredAt,
    });
  };
}
