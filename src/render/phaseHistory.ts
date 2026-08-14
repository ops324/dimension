/**
 * 回転位相の履歴リング(Phase 23)。
 *
 * 「さっきこの図形がどこに居たか」を厳密に答えるための、時刻つきリングバッファ。
 *
 * **なぜ遅延フィルタではないのか。** `expSmooth` で位相を遅らせれば残像らしきものは
 * 作れるが、それは過去の姿ではない ── 指数遅れの量は角速度に依存するので平面ごとに
 * 違う「過去」を指すし、位相が 0 へ緩和している最中(次元を降りるとき)には
 * まったく居なかった位置を指す。この作品の第一原則は数学的な正しさなので、
 * 残像は **実際に記録した位相**からしか作らない。
 *
 * 位相は (−π, π] へ畳まれているので、補間は**最短弧**で行う ── 3.0 と −3.0 の
 * あいだを線形に混ぜると 0 を通ってしまい、図形が半周ぶん暴れる。
 *
 * 構築後のアロケーションはゼロ。sample() は二分探索(容量 128 なら 7 段)で、
 * 呼ぶ順序にも遅延の大きさにも依存しない。
 */

const TAU = Math.PI * 2;

export class PhaseHistory {
  readonly planeCount: number;
  readonly capacity: number;

  private readonly times: Float64Array;
  private readonly values: Float64Array;
  /** リング上の最古の位置 */
  private start = 0;
  /** 有効な記録数 */
  private count = 0;
  /** これを超える時刻の飛びは「途切れ」とみなして履歴を捨てる(秒) */
  private readonly maxGap: number;

  constructor(planeCount: number, capacity: number, maxGap = 0.5) {
    this.planeCount = planeCount;
    this.capacity = capacity;
    this.maxGap = maxGap;
    this.times = new Float64Array(capacity);
    this.values = new Float64Array(capacity * planeCount);
  }

  /** 記録の本数 */
  get length(): number {
    return this.count;
  }

  /** 最新の記録の時刻(空なら NaN) */
  get newestTime(): number {
    return this.count === 0 ? Number.NaN : this.times[this.indexOf(this.count - 1)];
  }

  /** 最古の記録の時刻(空なら NaN) */
  get oldestTime(): number {
    return this.count === 0 ? Number.NaN : this.times[this.start];
  }

  /**
   * 1 フレームぶんを記録する。
   *
   * 時刻が巻き戻ったとき、または前回から maxGap 以上飛んだとき(タブ復帰・
   * 長いフレーム落ち)は履歴を捨てて 1 本だけにする ── 存在しなかった
   * 中間状態を補間で捏造しないため。残像は図形へ畳まれてから伸び直す。
   */
  record(t: number, phases: Float64Array): void {
    if (this.count > 0) {
      const newest = this.times[this.indexOf(this.count - 1)];
      if (!(t > newest) || t - newest > this.maxGap) {
        this.count = 0;
        this.start = 0;
      }
    }

    if (this.count === this.capacity) {
      this.start = (this.start + 1) % this.capacity;
      this.count--;
    }

    const slot = this.indexOf(this.count);
    this.times[slot] = t;
    const base = slot * this.planeCount;
    for (let k = 0; k < this.planeCount; k++) this.values[base + k] = phases[k];
    this.count++;
  }

  /**
   * 時刻 t の位相を out へ書く。
   *
   * 戻り値は「その時刻が記録の範囲に**収まっていた**か」。範囲外では最も近い端の
   * 記録をそのまま書く(false)ので、呼び出し側は out を無条件に使ってよい ──
   * 起動直後の残像は最古の記録、つまり図形そのものの位置から伸びはじめる。
   */
  sample(t: number, out: Float64Array): boolean {
    if (this.count === 0) return false;

    const n = this.planeCount;
    if (t <= this.times[this.start]) {
      this.copyOut(0, out);
      return false;
    }
    const lastIdx = this.count - 1;
    if (t >= this.times[this.indexOf(lastIdx)]) {
      this.copyOut(lastIdx, out);
      return false;
    }

    // times[lo] <= t < times[lo+1] となる lo を二分探索で求める
    let lo = 0;
    let hi = lastIdx;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.times[this.indexOf(mid)] <= t) lo = mid;
      else hi = mid;
    }

    const ia = this.indexOf(lo);
    const ib = this.indexOf(lo + 1);
    const ta = this.times[ia];
    const tb = this.times[ib];
    const f = tb > ta ? (t - ta) / (tb - ta) : 0;

    const ba = ia * n;
    const bb = ib * n;
    for (let k = 0; k < n; k++) {
      const a = this.values[ba + k];
      // 最短弧で混ぜる。位相は (−π, π] なので差が π を越えたら回り込む
      let d = this.values[bb + k] - a;
      if (d > Math.PI) d -= TAU;
      else if (d < -Math.PI) d += TAU;
      let v = a + d * f;
      if (v > Math.PI) v -= TAU;
      else if (v <= -Math.PI) v += TAU;
      out[k] = v;
    }
    return true;
  }

  /** 履歴を捨てて 1 本だけにする */
  resetTo(t: number, phases: Float64Array): void {
    this.count = 0;
    this.start = 0;
    this.record(t, phases);
  }

  private indexOf(i: number): number {
    const raw = this.start + i;
    return raw < this.capacity ? raw : raw - this.capacity;
  }

  private copyOut(i: number, out: Float64Array): void {
    const base = this.indexOf(i) * this.planeCount;
    for (let k = 0; k < this.planeCount; k++) out[k] = this.values[base + k];
  }
}
