import { describe, expect, it } from 'vitest';

import { MAX_TUMBLE_PLANES, planSlicePlanes, planTumble } from '../math/tumble';
import { rotateBatch, type PlaneRotation } from '../math/rotation';
import { projectOrtho } from '../math/projection';
import { makePolytope, type PolytopeFamily } from '../math/polytopes';

const N_MIN = 3;
const N_MAX = 10;
const FAMILIES: readonly PolytopeFamily[] = ['cube', 'simplex', 'orthoplex'];
/** 姿勢の走査点。ω と共鳴しないよう半端な値を選ぶ */
const SAMPLES = [0, 0.7, 1.2345, 2.9, 4.4, 7.1, 13.3, 29.5];

function rotsAt(n: number, perspective: boolean, t: number): PlaneRotation[] {
  const plan = planTumble(n, perspective);
  return plan.planes.map(([i, j], k) => ({ i, j, angle: plan.omegas[k] * t + plan.phases[k] }));
}

/**
 * 合成回転行列 M(列 = 基底ベクトルの像)。Givens を再実装せず、本番と同じ
 * `rotateBatch` に基底を通して得る ── 数式の二重実装を避けるため。
 * 返り値は col[k * n + a] = M[a][k]。
 */
function compose(n: number, perspective: boolean, t: number): Float64Array {
  const basis = new Float64Array(n * n);
  for (let k = 0; k < n; k++) basis[k * n + k] = 1;
  const out = new Float64Array(n * n);
  rotateBatch(basis, out, n, n, rotsAt(n, perspective, t));
  return out;
}

/** 投影後の像(自動フィット相当の正規化つき)を文字列化して比較可能にする */
function orthoImage(family: PolytopeFamily, n: number, t: number): string {
  const poly = makePolytope(family, n);
  const rot = new Float64Array(poly.vertexCount * n);
  rotateBatch(poly.vertices, rot, n, poly.vertexCount, rotsAt(n, false, t));
  const proj = new Float32Array(poly.vertexCount * 3);
  projectOrtho(rot, n, poly.vertexCount, proj);

  let radius = 0;
  for (let v = 0; v < poly.vertexCount; v++) {
    radius = Math.max(radius, Math.hypot(proj[v * 3], proj[v * 3 + 1], proj[v * 3 + 2]));
  }
  const k = 1 / (radius || 1);
  const points = new Set<string>();
  for (let v = 0; v < poly.vertexCount; v++) {
    points.add(
      `${(proj[v * 3] * k).toFixed(4)},${(proj[v * 3 + 1] * k).toFixed(4)},` +
        `${(proj[v * 3 + 2] * k).toFixed(4)}`,
    );
  }
  return [...points].sort().join(';');
}

/** 直交投影で長さ 0 に潰れた辺の本数 */
function collapsedEdges(family: PolytopeFamily, n: number, t: number): number {
  const poly = makePolytope(family, n);
  const rot = new Float64Array(poly.vertexCount * n);
  rotateBatch(poly.vertices, rot, n, poly.vertexCount, rotsAt(n, false, t));
  const proj = new Float32Array(poly.vertexCount * 3);
  projectOrtho(rot, n, poly.vertexCount, proj);

  let radius = 0;
  for (let v = 0; v < poly.vertexCount; v++) {
    radius = Math.max(radius, Math.hypot(proj[v * 3], proj[v * 3 + 1], proj[v * 3 + 2]));
  }

  let collapsed = 0;
  for (let e = 0; e < poly.edgeCount; e++) {
    const a = poly.edges[e * 2];
    const b = poly.edges[e * 2 + 1];
    const d = Math.hypot(
      proj[a * 3] - proj[b * 3],
      proj[a * 3 + 1] - proj[b * 3 + 1],
      proj[a * 3 + 2] - proj[b * 3 + 2],
    );
    if (d / radius < 1e-6) collapsed++;
  }
  return collapsed;
}

describe('planTumble', () => {
  it('平面枚数は確保上限を超えない', () => {
    for (let n = N_MIN; n <= N_MAX; n++) {
      for (const perspective of [true, false]) {
        expect(planTumble(n, perspective).planes.length).toBeLessThanOrEqual(MAX_TUMBLE_PLANES);
      }
    }
  });

  it('平面と角速度は同数で、角速度はすべて相異なる(合成姿勢が周期を持たないため)', () => {
    for (let n = N_MIN; n <= N_MAX; n++) {
      for (const perspective of [true, false]) {
        const plan = planTumble(n, perspective);
        expect(plan.omegas.length).toBe(plan.planes.length);
        expect(new Set(plan.omegas).size).toBe(plan.omegas.length);
        for (const w of plan.omegas) expect(w).toBeGreaterThan(0);
      }
    }
  });

  it('平面の軸は範囲内で、退化(i === j)しない', () => {
    for (let n = N_MIN; n <= N_MAX; n++) {
      for (const perspective of [true, false]) {
        for (const [i, j] of planTumble(n, perspective).planes) {
          expect(i).toBeGreaterThanOrEqual(0);
          expect(j).toBeLessThan(n);
          expect(i).not.toBe(j);
        }
      }
    }
  });

  it('条件②: 最終軸 n−1 が必ず回る(深度キューが凍らない)', () => {
    for (let n = N_MIN; n <= N_MAX; n++) {
      for (const perspective of [true, false]) {
        const touched = planTumble(n, perspective).planes.some(([i, j]) => i === n - 1 || j === n - 1);
        expect(touched).toBe(true);
      }
    }
  });

  it('条件③: 可視 3 軸だけで閉じた平面を含む(正面固定にならない)', () => {
    for (let n = N_MIN; n <= N_MAX; n++) {
      for (const perspective of [true, false]) {
        const closed = planTumble(n, perspective).planes.some(([i, j]) => i < 3 && j < 3);
        expect(closed).toBe(true);
      }
    }
  });

  it('透視の平面と角速度は Phase 36 以前から変えていない', () => {
    for (let n = 4; n <= N_MAX; n++) {
      const plan = planTumble(n, true);
      expect(plan.planes).toEqual([[0, 2], [1, n - 1], n - 2 > 2 ? [2, n - 2] : [0, 3]]);
      expect(plan.omegas).toEqual([0.31, 0.23 * Math.SQRT2, 0.17 * Math.sqrt(5)]);
      // 位相 0 = 透視の姿勢は Phase 36 以前と時刻ごとに完全一致する
      expect(plan.phases).toEqual([0, 0, 0]);
    }
  });

  it('直交の初期位相は 0 の近傍を踏まない(t=0 でも一般の姿勢でいる)', () => {
    for (let n = 4; n <= N_MAX; n++) {
      for (const phase of planTumble(n, false).phases) {
        const wrapped = Math.min(phase, 2 * Math.PI - phase);
        expect(wrapped).toBeGreaterThan(0.3);
      }
    }
  });
});

describe('直交投影の非退化(Phase 37 の回帰)', () => {
  it('条件④: すべての軸が可視 3 軸へ到達する', () => {
    for (let n = N_MIN; n <= N_MAX; n++) {
      for (const t of SAMPLES) {
        const m = compose(n, false, t);
        for (let k = 0; k < n; k++) {
          // 軸 k の像が可視 3 軸のどこにも現れないなら、その次元は投影の核に落ちる
          const reach = Math.max(
            Math.abs(m[k * n]),
            Math.abs(m[k * n + 1]),
            Math.abs(m[k * n + 2]),
          );
          expect(reach, `n=${n} t=${t} 軸 ${k} が可視 3 軸へ届いていない`).toBeGreaterThan(1e-9);
        }
      }
    }
  });

  it('長さ 0 に潰れる辺が 1 本も出ない', () => {
    for (const family of FAMILIES) {
      for (let n = N_MIN; n <= N_MAX; n++) {
        for (const t of SAMPLES) {
          expect(collapsedEdges(family, n, t), `${family} n=${n} t=${t}`).toBe(0);
        }
      }
    }
  });

  it('n が違えば像も違う ── 6..10 で同一像になっていた退化の回帰テスト', () => {
    for (const family of FAMILIES) {
      for (const t of SAMPLES) {
        const images = new Set<string>();
        for (let n = 4; n <= N_MAX; n++) images.add(orthoImage(family, n, t));
        expect(images.size, `${family} t=${t} で n ごとの像が重複している`).toBe(N_MAX - 3);
      }
    }
  });

  it('頂点が画面上で潰れ合わない(cube は 2^n 個がすべて別位置)', () => {
    for (let n = N_MIN; n <= N_MAX; n++) {
      const poly = makePolytope('cube', n);
      const distinct = orthoImage('cube', n, 1.2345).split(';').length;
      expect(distinct, `n=${n}`).toBe(poly.vertexCount);
    }
  });
});

/* ------------------------------------------------- PERSPECTIVE の回転平面(Phase 42) */

describe('planSlicePlanes', () => {
  const TARGET_MIN = 2;
  const TARGET_MAX = 6;

  it('常に 3 枚で、軸は範囲内・i ≠ j', () => {
    /*
      範囲内であることが要。`rotateBatch` はストライド n の配列へ `dst[v·n + j]`
      と書くので、j ≥ n の平面は**隣の頂点の座標を潰す**。旧実装は n=2 でも
      (0,2) / (1,2) を張っていた(X線俯瞰しか n=2 を取らないので露出していなかった)。
    */
    for (let n = TARGET_MIN; n <= TARGET_MAX; n++) {
      const planes = planSlicePlanes(n);
      expect(planes.length, `n=${n}`).toBe(3);
      for (const [i, j] of planes) {
        expect(i, `n=${n} の平面 (${i},${j})`).toBeGreaterThanOrEqual(0);
        expect(j, `n=${n} の平面 (${i},${j}) が範囲外の軸へ書く`).toBeLessThan(n);
        expect(i, `n=${n} の平面 (${i},${j})`).not.toBe(j);
      }
    }
  });

  it('条件⑤ スライス軸 n−1 を含む平面が必ず 1 枚ある', () => {
    // 無いと対象が超平面に対して姿勢を変えず、断面は相似縮小して消えるだけになる
    for (let n = 4; n <= TARGET_MAX; n++) {
      const planes = planSlicePlanes(n);
      const touchesLast = planes.some(([i, j]) => i === n - 1 || j === n - 1);
      expect(touchesLast, `n=${n} が最終軸を回していない`).toBe(true);
    }
  });

  it('条件⑥ どの軸も少なくとも 1 枚の平面に触られる', () => {
    /*
      触られない軸は時間で動かない座標になる ── 影の深度キューがその軸を
      駆動する m のとき色が凍り、断面ではその軸の固定オフセットが一度も
      別の場所を通らない。旧実装は n=6 で軸 3 を落としていた(罠 #20 の、
      透視でも残る半分)。
    */
    for (let n = TARGET_MIN; n <= TARGET_MAX; n++) {
      const touched = new Set<number>();
      for (const [i, j] of planSlicePlanes(n)) {
        touched.add(i);
        touched.add(j);
      }
      for (let axis = 0; axis < n; axis++) {
        expect(touched.has(axis), `n=${n} の軸 ${axis} がどの平面にも入っていない`).toBe(true);
      }
    }
  });

  it('n=4 / n=5 は Phase 42 以前と同一(絵が変わるのは n=6 だけ)', () => {
    expect(planSlicePlanes(4)).toEqual([[0, 2], [1, 3], [0, 3]]);
    expect(planSlicePlanes(5)).toEqual([[0, 2], [1, 4], [2, 3]]);
    expect(planSlicePlanes(6)).toEqual([[0, 2], [1, 5], [3, 4]]);
  });
});
