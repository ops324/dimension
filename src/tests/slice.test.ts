import { describe, expect, it } from 'vitest';
import { makeFaces2, makeNCube, makeNOrthoplex, makeNSimplex } from '../math/polytopes';
import { sliceFaces, sphereSliceRadius } from '../math/slice';

/**
 * 断面ワイヤが閉構造を成すこと(ぶら下がり端点がない = 各交差点の次数 ≥ 2)を検証。
 * 2D 断面(多角形)では次数はちょうど 2、3D 以上の断面では断面ポリトープの
 * 頂点次数(立方体断面なら 3)になるため、下限のみを検証する。
 * toFixed だと -0.0000000 と 0.0000000 が別キーになるので +0 に正規化する。
 */
function assertClosedLoops(out: Float64Array, segments: number, dim: number): void {
  const keys: string[] = [];
  for (let s = 0; s < segments; s++) {
    for (let e = 0; e < 2; e++) {
      const o = s * dim * 2 + e * dim;
      const parts: string[] = [];
      for (let k = 0; k < dim; k++) parts.push((out[o + k] + 0).toFixed(7).replace('-0.0000000', '0.0000000'));
      keys.push(parts.join(','));
    }
  }
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const [key, c] of counts) {
    expect(c, `交差点 ${key} がぶら下がり端点`).toBeGreaterThanOrEqual(2);
  }
}

describe('sliceFaces', () => {
  it('立方体を z=0 で切ると正方形(4 線分・座標 ±1/√3)', () => {
    const p = makeNCube(3);
    const faces = makeFaces2('cube', 3);
    const out = new Float64Array(faces.count * 2 * 2);
    const segments = sliceFaces(p.vertices, 3, faces, 2, 1e-9, out);
    expect(segments).toBe(4);
    const r = 1 / Math.sqrt(3);
    for (let s = 0; s < segments; s++) {
      for (let e = 0; e < 2; e++) {
        const o = s * 4 + e * 2;
        expect(Math.abs(out[o])).toBeCloseTo(r, 9);
        expect(Math.abs(out[o + 1])).toBeCloseTo(r, 9);
      }
    }
    assertClosedLoops(out, segments, 2);
  });

  it('テッセラクトを w=0 で切ると立方体(12 線分)', () => {
    const p = makeNCube(4);
    const faces = makeFaces2('cube', 4);
    const out = new Float64Array(faces.count * 2 * 3);
    const segments = sliceFaces(p.vertices, 4, faces, 3, 1e-9, out);
    expect(segments).toBe(12);
    assertClosedLoops(out, segments, 3);
    // 断面立方体の辺はすべて座標 ±1/2(=辺長 1 の立方体 × 外接正規化 1/√4)
    const r = 0.5;
    for (let s = 0; s < segments; s++) {
      for (let e = 0; e < 2; e++) {
        const o = s * 6 + e * 3;
        for (let k = 0; k < 3; k++) {
          expect(Math.abs(out[o + k])).toBeCloseTo(r, 6);
        }
      }
    }
  });

  it('16-cell を w=+ε で切ると正八面体(12 線分)', () => {
    const p = makeNOrthoplex(4);
    const faces = makeFaces2('orthoplex', 4);
    const out = new Float64Array(faces.count * 2 * 3);
    const segments = sliceFaces(p.vertices, 4, faces, 3, 1e-6, out);
    expect(segments).toBe(12);
    assertClosedLoops(out, segments, 3);
  });

  it('範囲外のオフセットでは交差しない', () => {
    const p = makeNCube(4);
    const faces = makeFaces2('cube', 4);
    const out = new Float64Array(faces.count * 2 * 3);
    expect(sliceFaces(p.vertices, 4, faces, 3, 0.9, out)).toBe(0);
    expect(sliceFaces(p.vertices, 4, faces, 3, -0.9, out)).toBe(0);
  });

  it('四面体の中央断面は閉ループを成す(3 または 4 線分)', () => {
    const p = makeNSimplex(3);
    const faces = makeFaces2('simplex', 3);
    const out = new Float64Array(faces.count * 2 * 2);
    const segments = sliceFaces(p.vertices, 3, faces, 2, 1e-9, out);
    expect(segments === 3 || segments === 4).toBe(true);
    assertClosedLoops(out, segments, 2);
  });

  it('5-cube の断面(4 次元ポリトープの辺)も閉構造を成す', () => {
    const p = makeNCube(5);
    const faces = makeFaces2('cube', 5);
    const out = new Float64Array(faces.count * 2 * 4);
    const segments = sliceFaces(p.vertices, 5, faces, 4, 1e-9, out);
    // w5=0 での 5-cube 断面はテッセラクト: 4-cube の辺数 32
    expect(segments).toBe(32);
    assertClosedLoops(out, segments, 4);
  });
});

describe('sphereSliceRadius', () => {
  it('中心断面は最大、境界で 0、外側も 0', () => {
    expect(sphereSliceRadius(1, 0)).toBe(1);
    expect(sphereSliceRadius(1, 0.6)).toBeCloseTo(0.8, 12);
    expect(sphereSliceRadius(1, 1)).toBe(0);
    expect(sphereSliceRadius(1, 1.5)).toBe(0);
  });
});
