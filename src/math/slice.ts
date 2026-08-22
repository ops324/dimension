import type { Faces2 } from './polytopes';
import { MAX_N } from './projection';

/**
 * 超平面スライス(余次元 1)。
 *
 * **展示はもうこれを呼ばない**(Phase 39 で `flatSlice.ts` の余次元 k 版へ移った)。
 * 残してあるのは**基準実装**としてである ── `flatSlice.test.ts` は
 * 「余次元 1 では sliceFaces と完全に一致する」ことを 3 族 × n=3..6 ×
 * 姿勢 4 × 掃引位置 4 で毎回突き合わせており、一般化が一段の拡張に
 * 留まっていることをこの関数が保証している。消すなら、その担保も一緒に消える。
 *
 * (`sphereSliceRadius` は n-球の断面半径として展示が今も使っている)
 *
 * n 次元ポリトープと超平面 { x[axis] = offset } の交差は (n−1) 次元の
 * ポリトープになる。その**辺の集合**は「元のポリトープの各 2-面と超平面の
 * 交差線分」に一致する — 凸包の計算は一切不要で、2-面(四角形/三角形)の
 * 境界辺のうち超平面を跨ぐ 2 本を見つけて内分点を結ぶだけでよい。
 *
 * 数え上げの検算(既知形状):
 * - 立方体 (n=3) を z=0 で切る → 側面 4 枚が交差 → 正方形(4 線分)
 * - テッセラクトを w=0 で切る → 24 枚中 12 枚が交差 → 立方体(12 線分)
 * - 16-cell を w=+ε で切る → 32 枚中 12 枚が交差 → 正八面体(12 線分)
 *
 * 退化対策(既知の罠 #9): 超平面が頂点をちょうど通ると交差判定が不安定に
 * なるため、呼び出し側は offset に微小 eps を加えて厳密一致を避けること
 * (sliceFaces 自体は d=0 の頂点を「跨がない」側に倒す)。
 */

/** 交差点 2 つ分の作業領域(アロケーションフリー契約) */
const HIT = new Float64Array(2 * MAX_N);

/**
 * 回転済み頂点群 `rotated`(count × n、インターリーブ)に対し、
 * 超平面 { x[axis] = offset } と各 2-面の交差線分を求める。
 *
 * 出力レイアウト: 線分ごとに端点 2 つ × (n−1) 座標(axis 座標を除いた残り、
 * 元の軸順を保つ)。out には faces.count * 2 * (n−1) 要素以上を確保すること。
 * 戻り値は書き込んだ線分数。
 */
export function sliceFaces(
  rotated: Float64Array,
  n: number,
  faces: Faces2,
  axis: number,
  offset: number,
  out: Float64Array,
): number {
  const size = faces.size;
  const indices = faces.indices;
  const outStride = (n - 1) * 2;
  let segments = 0;

  for (let f = 0; f < faces.count; f++) {
    const base = f * size;
    let hits = 0;

    // 面の境界を巡回し、超平面を跨ぐ辺の内分点を求める(凸面なので高々 2 つ)
    for (let c = 0; c < size && hits < 2; c++) {
      const a = indices[base + c];
      const b = indices[base + ((c + 1) % size)];
      const da = rotated[a * n + axis] - offset;
      const db = rotated[b * n + axis] - offset;
      // 厳密に 0 の頂点は「負側」に倒す(呼び出し側の eps オフセットと併せて
      // 同一交差点の二重計上を防ぐ)
      const sa = da > 0;
      const sb = db > 0;
      if (sa === sb) continue;

      const t = da / (da - db);
      const ao = a * n;
      const bo = b * n;
      const ho = hits * MAX_N;
      for (let k = 0; k < n; k++) {
        HIT[ho + k] = rotated[ao + k] + (rotated[bo + k] - rotated[ao + k]) * t;
      }
      hits++;
    }

    if (hits === 2) {
      const o = segments * outStride;
      let w = 0;
      for (let k = 0; k < n; k++) {
        if (k === axis) continue;
        out[o + w] = HIT[k];
        out[o + (n - 1) + w] = HIT[MAX_N + k];
        w++;
      }
      segments++;
    }
  }

  return segments;
}

/**
 * n-球(半径 R)を距離 s の超平面で切った (n−1)-球の半径。
 * |s| ≥ R なら 0(接触または非交差)。
 */
export function sphereSliceRadius(R: number, s: number): number {
  const d2 = R * R - s * s;
  return d2 > 0 ? Math.sqrt(d2) : 0;
}
