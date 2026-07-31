/**
 * 高次元 → 3D への投影。
 *
 * すべてホットパス想定: 出力は呼び出し側が確保した Float32Array
 * (= GPU バッファの実体)へ直接書き、アロケーションしない。
 */

/** 対応する最大次元(SCRATCH の確保サイズ) */
export const MAX_N = 16;

/** 透視除算係数の暴走ガード(形状は外接半径 1 に正規化される前提の保険) */
const F_CLAMP = 50;

const SCRATCH = new Float64Array(MAX_N);

/**
 * 透視カスケード投影 nD → 3D。
 *
 * 最上位軸 d = n−1 から 3 まで、視点距離 dist の透視除算
 * f = dist / (dist − p[d]) を反復適用する。各段が「d 次元の空間を
 * (d−1) 次元のスクリーンへ透視投影する」ことに相当し、高次元の
 * 直線辺が 3D では曲線に映る(数学的に正しい)投影が得られる。
 *
 * 前提: n ≥ 3、全点のノルム ≤ 1(外接半径 1 に正規化済み)、dist > 1。
 * このとき分母 dist − p[d] ≥ dist − 1 > 0 で特異点は構造的に生じない。
 */
export function projectPerspective(
  src: Float64Array,
  n: number,
  count: number,
  dist: number,
  out: Float32Array,
): void {
  for (let v = 0; v < count; v++) {
    const o = v * n;
    for (let k = 0; k < n; k++) SCRATCH[k] = src[o + k];
    for (let d = n - 1; d >= 3; d--) {
      let f = dist / (dist - SCRATCH[d]);
      if (f > F_CLAMP) f = F_CLAMP;
      else if (f < -F_CLAMP) f = -F_CLAMP;
      for (let k = 0; k < d; k++) SCRATCH[k] *= f;
    }
    out[v * 3] = SCRATCH[0];
    out[v * 3 + 1] = SCRATCH[1];
    out[v * 3 + 2] = SCRATCH[2];
  }
}

/** 直交投影 nD → 3D: 座標 3..n−1 を捨てるだけ(n ≥ 3) */
export function projectOrtho(
  src: Float64Array,
  n: number,
  count: number,
  out: Float32Array,
): void {
  for (let v = 0; v < count; v++) {
    const o = v * n;
    out[v * 3] = src[o];
    out[v * 3 + 1] = src[o + 1];
    out[v * 3 + 2] = src[o + 2];
  }
}

/**
 * ステレオ投影 S³ → R³(投影極は w = +1)。
 *
 *   (x, y, z, w) ↦ (x, y, z) / (1 − w)
 *
 * 単位球面上の点では |out| = √((1+w)/(1−w))。w → 1 の極近傍では
 * 分母を eps でクランプする(極を通るファイバーは無限遠へ飛ぶため、
 * 長すぎる線分の間引きは描画側が担う)。
 */
export function projectStereographic(
  src: Float64Array,
  count: number,
  out: Float32Array,
  eps = 1e-4,
): void {
  for (let v = 0; v < count; v++) {
    const o = v * 4;
    const w = src[o + 3];
    const denom = 1 - w;
    const k = 1 / (denom > eps ? denom : eps);
    out[v * 3] = src[o] * k;
    out[v * 3 + 1] = src[o + 1] * k;
    out[v * 3 + 2] = src[o + 2] * k;
  }
}
