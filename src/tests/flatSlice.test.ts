import { describe, expect, it } from 'vitest';

import { faceCountOfDim, makeFlatSliceGeometry, sliceFlat } from '../math/flatSlice';
import { sliceFaces } from '../math/slice';
import { makeFaces2, makePolytope, type PolytopeFamily } from '../math/polytopes';
import { rotateBatch, type PlaneRotation } from '../math/rotation';

const FAMILIES: readonly PolytopeFamily[] = ['cube', 'simplex', 'orthoplex'];
/** 姿勢の走査点。ω と共鳴しないよう半端な値 */
const TIMES = [0.41, 1.7, 3.33, 5.9];
/** 掃引位置。頂点をちょうど通らないよう半端な値にする(既知の罠 #9) */
const OFFSETS = [-0.31, -0.07, 0.17, 0.42];

function rotsAt(n: number, t: number): PlaneRotation[] {
  // 全軸が動く一般の姿勢。特定の平面選択に依存しない検証にするため
  // perspectiveExhibit とは別に組む
  const rots: PlaneRotation[] = [];
  for (let i = 0; i < n - 1; i++) {
    rots.push({ i, j: i + 1, angle: (0.29 + 0.11 * i) * t });
  }
  rots.push({ i: 0, j: n - 1, angle: 0.19 * t });
  return rots;
}

function rotate(family: PolytopeFamily, n: number, t: number): Float64Array {
  const poly = makePolytope(family, n);
  const dst = new Float64Array(poly.vertexCount * n);
  rotateBatch(poly.vertices, dst, n, poly.vertexCount, rotsAt(n, t));
  return dst;
}

/** 線分集合を順序に依らない正規形へ(端点の並びも入れ替え不変にする) */
function canonical(out: Float64Array, segments: number, m: number): string[] {
  const list: string[] = [];
  for (let s = 0; s < segments; s++) {
    const o = s * m * 2;
    const a: string[] = [];
    const b: string[] = [];
    for (let x = 0; x < m; x++) {
      a.push(out[o + x].toFixed(6));
      b.push(out[o + m + x].toFixed(6));
    }
    const p = a.join(',');
    const q = b.join(',');
    list.push(p < q ? `${p}|${q}` : `${q}|${p}`);
  }
  return list.sort();
}

describe('faceCountOfDim', () => {
  it('既知の面数と一致する', () => {
    // 立方体: 8 頂点 / 12 辺 / 6 面
    expect(faceCountOfDim('cube', 3, 0)).toBe(8);
    expect(faceCountOfDim('cube', 3, 1)).toBe(12);
    expect(faceCountOfDim('cube', 3, 2)).toBe(6);
    // テッセラクト: 16 / 32 / 24 / 8
    expect(faceCountOfDim('cube', 4, 0)).toBe(16);
    expect(faceCountOfDim('cube', 4, 1)).toBe(32);
    expect(faceCountOfDim('cube', 4, 2)).toBe(24);
    expect(faceCountOfDim('cube', 4, 3)).toBe(8);
    // 16-cell(4-orthoplex): 8 頂点 / 24 辺 / 32 三角形 / 16 四面体
    expect(faceCountOfDim('orthoplex', 4, 0)).toBe(8);
    expect(faceCountOfDim('orthoplex', 4, 1)).toBe(24);
    expect(faceCountOfDim('orthoplex', 4, 2)).toBe(32);
    expect(faceCountOfDim('orthoplex', 4, 3)).toBe(16);
    // 5-cell(4-simplex): 5 / 10 / 10 / 5
    expect(faceCountOfDim('simplex', 4, 0)).toBe(5);
    expect(faceCountOfDim('simplex', 4, 1)).toBe(10);
    expect(faceCountOfDim('simplex', 4, 2)).toBe(10);
    expect(faceCountOfDim('simplex', 4, 3)).toBe(5);
  });

  it('2-面の数は makeFaces2 の実際の数と一致する', () => {
    for (const family of FAMILIES) {
      for (let n = 3; n <= 6; n++) {
        expect(faceCountOfDim(family, n, 2), `${family} n=${n}`).toBe(makeFaces2(family, n).count);
      }
    }
  });
});

describe('makeFlatSliceGeometry', () => {
  it('k-面・(k+1)-面の数が面数の公式と一致する', () => {
    for (const family of FAMILIES) {
      for (let n = 3; n <= 6; n++) {
        for (let m = 2; m < n; m++) {
          const k = n - m;
          const g = makeFlatSliceGeometry(family, n, k);
          expect(g.nodeCount, `${family} n=${n} k=${k} nodes`).toBe(faceCountOfDim(family, n, k));
          expect(g.linkCount, `${family} n=${n} k=${k} links`).toBe(
            faceCountOfDim(family, n, k + 1),
          );
        }
      }
    }
  });

  it('境界の参照はすべて範囲内で、(k+1)-面ごとに相異なる k-面を指す', () => {
    for (const family of FAMILIES) {
      for (let n = 3; n <= 6; n++) {
        for (let m = 2; m < n; m++) {
          const g = makeFlatSliceGeometry(family, n, n - m);
          expect(g.bounds.length).toBe(g.linkCount * g.boundStride);
          for (let l = 0; l < g.linkCount; l++) {
            const seen = new Set<number>();
            for (let i = 0; i < g.boundStride; i++) {
              const c = g.bounds[l * g.boundStride + i];
              expect(c).toBeLessThan(g.nodeCount);
              seen.add(c);
            }
            expect(seen.size, `${family} n=${n} m=${m} link ${l}`).toBe(g.boundStride);
          }
        }
      }
    }
  });
});

describe('sliceFlat', () => {
  it('余次元 1 では sliceFaces と完全に一致する(一段の一般化であることの担保)', () => {
    for (const family of FAMILIES) {
      for (let n = 3; n <= 6; n++) {
        const m = n - 1;
        const poly = makePolytope(family, n);
        const faces = makeFaces2(family, n);
        const geom = makeFlatSliceGeometry(family, n, 1);
        const refOut = new Float64Array(faces.count * 2 * m);
        const newOut = new Float64Array(geom.linkCount * 2 * m);
        const offsets = new Float64Array(1);

        for (const t of TIMES) {
          const rot = rotate(family, n, t);
          for (const s of OFFSETS) {
            offsets[0] = s;
            const refCount = sliceFaces(rot, n, faces, n - 1, s, refOut);
            const newCount = sliceFlat(rot, n, m, offsets, geom, newOut);
            expect(newCount, `${family} n=${n} t=${t} s=${s} 線分数`).toBe(refCount);
            expect(canonical(newOut, newCount, m)).toEqual(canonical(refOut, refCount, m));
          }
        }
        expect(poly.n).toBe(n); // 形状が想定どおり組めていること
      }
    }
  });

  it('入れ子の整合: m 次元の断面は (m+1) 次元の断面をもう一度切ったものに一致する', () => {
    // m=2 の断面の頂点は、m=3 の断面(多面体)の辺を x₂ = o₀ で切った点に等しい。
    // 余次元 2 の解が、余次元 1 を二度使った結果と一致することの直接検証。
    for (const family of FAMILIES) {
      for (const n of [4, 5]) {
        const g3 = makeFlatSliceGeometry(family, n, n - 3);
        const g2 = makeFlatSliceGeometry(family, n, n - 2);
        const out3 = new Float64Array(g3.linkCount * 2 * 3);
        const out2 = new Float64Array(g2.linkCount * 2 * 2);

        for (const t of TIMES) {
          const rot = rotate(family, n, t);
          for (const o0 of [-0.13, 0.21]) {
            const off3 = Float64Array.from(
              Array.from({ length: n - 3 }, (_, j) => OFFSETS[j % OFFSETS.length]),
            );
            const off2 = Float64Array.from([o0, ...off3]);

            const c3 = sliceFlat(rot, n, 3, off3, g3, out3);
            const c2 = sliceFlat(rot, n, 2, off2, g2, out2);

            // 3D 断面の各辺を x₂ = o₀ で切って点を集める
            const viaNesting = new Set<string>();
            for (let s = 0; s < c3; s++) {
              const o = s * 6;
              const az = out3[o + 2];
              const bz = out3[o + 5];
              if (az > o0 === bz > o0) continue;
              const u = (o0 - az) / (bz - az);
              const x = out3[o] + (out3[o + 3] - out3[o]) * u;
              const y = out3[o + 1] + (out3[o + 4] - out3[o + 1]) * u;
              viaNesting.add(`${x.toFixed(5)},${y.toFixed(5)}`);
            }

            const direct = new Set<string>();
            for (let s = 0; s < c2; s++) {
              const o = s * 4;
              direct.add(`${out2[o].toFixed(5)},${out2[o + 1].toFixed(5)}`);
              direct.add(`${out2[o + 2].toFixed(5)},${out2[o + 3].toFixed(5)}`);
            }

            expect([...direct].sort(), `${family} n=${n} t=${t} o0=${o0}`).toEqual(
              [...viaNesting].sort(),
            );
          }
        }
      }
    }
  });

  it('m=2 の断面は閉じた多角形になる(どの頂点にも辺がちょうど 2 本)', () => {
    for (const family of FAMILIES) {
      for (const n of [3, 4, 5, 6]) {
        const geom = makeFlatSliceGeometry(family, n, n - 2);
        const out = new Float64Array(geom.linkCount * 2 * 2);
        const offsets = new Float64Array(n - 2);

        for (const t of TIMES) {
          const rot = rotate(family, n, t);
          for (let j = 0; j < n - 2; j++) offsets[j] = OFFSETS[j % OFFSETS.length] * 0.5;
          const count = sliceFlat(rot, n, 2, offsets, geom, out);
          if (count === 0) continue; // 平坦面が形状を外れた回

          const degree = new Map<string, number>();
          for (let s = 0; s < count; s++) {
            const o = s * 4;
            for (const key of [
              `${out[o].toFixed(5)},${out[o + 1].toFixed(5)}`,
              `${out[o + 2].toFixed(5)},${out[o + 3].toFixed(5)}`,
            ]) {
              degree.set(key, (degree.get(key) ?? 0) + 1);
            }
          }
          expect(degree.size, `${family} n=${n} t=${t} 頂点数`).toBe(count);
          for (const [key, deg] of degree) {
            expect(deg, `${family} n=${n} t=${t} 頂点 ${key} の次数`).toBe(2);
          }
        }
      }
    }
  });

  it('平坦面が形状の外なら線分は 1 本も出ない', () => {
    for (const family of FAMILIES) {
      for (const n of [4, 5]) {
        const geom = makeFlatSliceGeometry(family, n, n - 2);
        const out = new Float64Array(geom.linkCount * 2 * 2);
        const offsets = new Float64Array(n - 2).fill(9); // 外接半径 1 の遥か外
        const rot = rotate(family, n, 1.7);
        expect(sliceFlat(rot, n, 2, offsets, geom, out), `${family} n=${n}`).toBe(0);
      }
    }
  });
});
