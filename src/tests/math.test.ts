import { describe, expect, it } from 'vitest';
import { clamp01, expSmooth, lerp, pingpong, smoothstep } from '../math/ease';
import { rotateBatch, type PlaneRotation } from '../math/rotation';
import {
  projectOrtho,
  projectPerspective,
  projectStereographic,
} from '../math/projection';
import {
  hopfFiber,
  hopfMap,
  baseFibonacci,
  baseGreatCircle,
  baseLatitudeRings,
  THETA_MAX,
  THETA_MIN,
} from '../math/hopf';
import {
  makeFaces2,
  makeNCube,
  makeNOrthoplex,
  makeNSimplex,
} from '../math/polytopes';

/** 決定的な擬似乱数(テストの再現性のため Math.random は使わない) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function norm(arr: Float64Array, n: number, v: number): number {
  let sum = 0;
  for (let k = 0; k < n; k++) sum += arr[v * n + k] ** 2;
  return Math.sqrt(sum);
}

describe('ease', () => {
  it('clamp01 は範囲外を丸める', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.25)).toBe(0.25);
    expect(clamp01(1.5)).toBe(1);
  });

  it('lerp / smoothstep の端点と中点', () => {
    expect(lerp(2, 6, 0.5)).toBe(4);
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 12);
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(2)).toBe(1);
  });

  it('expSmooth は dt 分割に対して不変(フレームレート非依存)', () => {
    const oneStep = expSmooth(0, 10, 6, 1 / 30);
    const half = expSmooth(0, 10, 6, 1 / 60);
    const twoStep = expSmooth(half, 10, 6, 1 / 60);
    expect(twoStep).toBeCloseTo(oneStep, 12);
  });

  it('pingpong は 0→1→0 を往復し負の入力でも周期的', () => {
    expect(pingpong(0)).toBe(0);
    expect(pingpong(1)).toBe(1);
    expect(pingpong(1.5)).toBeCloseTo(0.5, 12);
    expect(pingpong(2)).toBe(0);
    expect(pingpong(-0.5)).toBeCloseTo(0.5, 12);
  });
});

describe('rotation', () => {
  const rand = mulberry32(42);
  const n = 7;
  const count = 50;
  const src = new Float64Array(n * count);
  for (let k = 0; k < src.length; k++) src[k] = rand() * 2 - 1;
  const rots: PlaneRotation[] = [
    { i: 0, j: 3, angle: 0.7 },
    { i: 1, j: 5, angle: -1.3 },
    { i: 2, j: 6, angle: 2.9 },
  ];

  it('ノルムを保存する(1e-12)', () => {
    const dst = new Float64Array(src.length);
    rotateBatch(src, dst, n, count, rots);
    for (let v = 0; v < count; v++) {
      expect(norm(dst, n, v)).toBeCloseTo(norm(src, n, v), 12);
    }
  });

  it('逆順の逆回転で恒等になる', () => {
    const dst = new Float64Array(src.length);
    rotateBatch(src, dst, n, count, rots);
    const inverse = [...rots].reverse().map((r) => ({ ...r, angle: -r.angle }));
    rotateBatch(dst, dst, n, count, inverse); // src === dst の in-place も同時に検証
    for (let k = 0; k < src.length; k++) {
      expect(dst[k]).toBeCloseTo(src[k], 12);
    }
  });

  it('回転平面の外の座標には触れない', () => {
    const dst = new Float64Array(src.length);
    rotateBatch(src, dst, n, count, [{ i: 0, j: 1, angle: 1.1 }]);
    for (let v = 0; v < count; v++) {
      for (let k = 2; k < n; k++) {
        expect(dst[v * n + k]).toBe(src[v * n + k]);
      }
    }
  });
});

describe('projection', () => {
  it('直交投影は先頭 3 座標を取り出す', () => {
    const src = new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5]);
    const out = new Float32Array(3);
    projectOrtho(src, 5, 1, out);
    expect([...out]).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
    ]);
  });

  it('透視カスケード n=4 の手計算値', () => {
    // f = 2.4/(2.4−0.4) = 1.2
    const src = new Float64Array([0.5, -0.3, 0.2, 0.4]);
    const out = new Float32Array(3);
    projectPerspective(src, 4, 1, 2.4, out);
    expect(out[0]).toBeCloseTo(0.6, 6);
    expect(out[1]).toBeCloseTo(-0.36, 6);
    expect(out[2]).toBeCloseTo(0.24, 6);
  });

  it('透視カスケード n=5 の手計算値(2 段)', () => {
    // d=4: f = 3/(3−0.5) = 1.2 → (0.12, 0.24, 0.36, 0.48)
    // d=3: f = 3/(3−0.48)     → (0.1428571, 0.2857143, 0.4285714)
    const src = new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5]);
    const out = new Float32Array(3);
    projectPerspective(src, 5, 1, 3, out);
    expect(out[0]).toBeCloseTo(0.12 * (3 / 2.52), 6);
    expect(out[1]).toBeCloseTo(0.24 * (3 / 2.52), 6);
    expect(out[2]).toBeCloseTo(0.36 * (3 / 2.52), 6);
  });

  it('n=3 では恒等(コピー)になる', () => {
    const src = new Float64Array([0.3, -0.7, 0.2]);
    const out = new Float32Array(3);
    projectPerspective(src, 3, 1, 2.4, out);
    expect(out[0]).toBeCloseTo(0.3, 6);
    expect(out[1]).toBeCloseTo(-0.7, 6);
    expect(out[2]).toBeCloseTo(0.2, 6);
  });

  it('ステレオ投影: 赤道は固定、南極は原点、半径は √((1+w)/(1−w))', () => {
    const src = new Float64Array([
      1, 0, 0, 0, // 赤道上の点 → そのまま
      0, 0, 0, -1, // 南極 → 原点
      0.5, 0.5, 0.5, 0.5, // 一般の単位ベクトル
    ]);
    const out = new Float32Array(9);
    projectStereographic(src, 3, out);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(0, 6);
    expect(out[2]).toBeCloseTo(0, 6);
    expect(out[3]).toBeCloseTo(0, 6);
    expect(out[4]).toBeCloseTo(0, 6);
    expect(out[5]).toBeCloseTo(0, 6);
    const r = Math.hypot(out[6], out[7], out[8]);
    expect(r).toBeCloseTo(Math.sqrt((1 + 0.5) / (1 - 0.5)), 5);
  });

  it('ステレオ投影: 極 (w→1) は eps クランプで有限に留まる', () => {
    const src = new Float64Array([0, 0, 1e-9, 1 - 1e-12]);
    const out = new Float32Array(3);
    projectStereographic(src, 1, out, 1e-4);
    expect(Number.isFinite(out[2])).toBe(true);
    expect(Math.abs(out[2])).toBeLessThanOrEqual(1e-9 / 1e-4 + 1);
  });
});

describe('hopf', () => {
  it('ファイバーの全点が S³ 上(ノルム 1)にある', () => {
    const segments = 64;
    const out = new Float64Array(segments * 4);
    hopfFiber(1.1, 2.3, segments, out);
    for (let k = 0; k < segments; k++) {
      expect(norm(out, 4, k)).toBeCloseTo(1, 12);
    }
  });

  it('ファイバーの全点が同一の基点 (sinθcosφ, −sinθsinφ, cosθ) へ写る', () => {
    const theta = 0.9;
    const phi = 1.7;
    const segments = 32;
    const out = new Float64Array(segments * 4);
    hopfFiber(theta, phi, segments, out);
    const expected = [
      Math.sin(theta) * Math.cos(phi),
      -Math.sin(theta) * Math.sin(phi),
      Math.cos(theta),
    ];
    for (let k = 0; k < segments; k++) {
      const [hx, hy, hz] = hopfMap(
        out[k * 4],
        out[k * 4 + 1],
        out[k * 4 + 2],
        out[k * 4 + 3],
      );
      expect(hx).toBeCloseTo(expected[0], 12);
      expect(hy).toBeCloseTo(expected[1], 12);
      expect(hz).toBeCloseTo(expected[2], 12);
    }
  });

  it('基点分布は個数を返し θ を安全範囲に収める', () => {
    const out = new Float64Array(2000);
    const cases: Array<[string, number]> = [
      ['rings', baseLatitudeRings(7, 24, out)],
      ['greatCircle', baseGreatCircle(120, 0.6, out)],
      ['fibonacci', baseFibonacci(300, out)],
    ];
    expect(cases[0][1]).toBe(7 * 24);
    expect(cases[1][1]).toBe(120);
    expect(cases[2][1]).toBe(300);
    // 直近の呼び出し結果(fibonacci)の θ 範囲を検証
    for (let k = 0; k < 300; k++) {
      const theta = out[k * 2];
      expect(theta).toBeGreaterThanOrEqual(THETA_MIN - 1e-12);
      expect(theta).toBeLessThanOrEqual(THETA_MAX + 1e-12);
    }
  });
});

describe('polytopes', () => {
  it('既知の頂点数・辺数(cube n=10, simplex n=4, orthoplex n=3/6)', () => {
    const cube = makeNCube(10);
    expect(cube.vertexCount).toBe(1024);
    expect(cube.edgeCount).toBe(5120);
    expect(cube.edges.length).toBe(10240);

    const simplex = makeNSimplex(4);
    expect(simplex.vertexCount).toBe(5);
    expect(simplex.edgeCount).toBe(10);

    const octa = makeNOrthoplex(3);
    expect(octa.vertexCount).toBe(6);
    expect(octa.edgeCount).toBe(12);

    const hexadecachoron = makeNOrthoplex(6);
    expect(hexadecachoron.edgeCount).toBe(60);
  });

  it('全ファミリーの全頂点が外接半径 1(1e-12)', () => {
    for (const p of [makeNCube(6), makeNSimplex(7), makeNOrthoplex(5)]) {
      for (let v = 0; v < p.vertexCount; v++) {
        expect(norm(p.vertices, p.n, v)).toBeCloseTo(1, 12);
      }
    }
  });

  it('cube の辺はハミング距離 1 で edgeAxis が一致する', () => {
    const p = makeNCube(5);
    expect(p.edgeAxis).toBeDefined();
    for (let e = 0; e < p.edgeCount; e++) {
      const a = p.edges[e * 2];
      const b = p.edges[e * 2 + 1];
      const diff = a ^ b;
      expect(diff & (diff - 1)).toBe(0); // 1 ビットだけ異なる
      expect(1 << p.edgeAxis![e]).toBe(diff);
    }
  });

  it('simplex は重心が原点で全辺長が等しい', () => {
    const p = makeNSimplex(6);
    for (let k = 0; k < p.n; k++) {
      let sum = 0;
      for (let v = 0; v < p.vertexCount; v++) sum += p.vertices[v * p.n + k];
      expect(sum).toBeCloseTo(0, 12);
    }
    let first = -1;
    for (let e = 0; e < p.edgeCount; e++) {
      const a = p.edges[e * 2];
      const b = p.edges[e * 2 + 1];
      let d2 = 0;
      for (let k = 0; k < p.n; k++) {
        d2 += (p.vertices[a * p.n + k] - p.vertices[b * p.n + k]) ** 2;
      }
      const d = Math.sqrt(d2);
      if (first < 0) first = d;
      expect(d).toBeCloseTo(first, 9);
    }
  });

  it('orthoplex の辺は対蹠対を含まず全長 √2', () => {
    const p = makeNOrthoplex(4);
    for (let e = 0; e < p.edgeCount; e++) {
      const a = p.edges[e * 2];
      const b = p.edges[e * 2 + 1];
      expect(a >> 1).not.toBe(b >> 1);
      let d2 = 0;
      for (let k = 0; k < p.n; k++) {
        d2 += (p.vertices[a * p.n + k] - p.vertices[b * p.n + k]) ** 2;
      }
      expect(Math.sqrt(d2)).toBeCloseTo(Math.SQRT2, 12);
    }
  });

  it('2-面の既知個数(立方体 6 / 4-cube 24 / 四面体 4 / 八面体 8)', () => {
    expect(makeFaces2('cube', 3).count).toBe(6);
    expect(makeFaces2('cube', 4).count).toBe(24);
    expect(makeFaces2('simplex', 3).count).toBe(4);
    expect(makeFaces2('orthoplex', 3).count).toBe(8);
    expect(makeFaces2('cube', 6).count).toBe(15 * 16);
  });

  it('cube の 2-面は境界を巡る順(隣接コーナーがハミング距離 1)', () => {
    const faces = makeFaces2('cube', 4);
    const vertexCount = 16;
    for (let f = 0; f < faces.count; f++) {
      for (let c = 0; c < 4; c++) {
        const a = faces.indices[f * 4 + c];
        const b = faces.indices[f * 4 + ((c + 1) % 4)];
        expect(a).toBeLessThan(vertexCount);
        const diff = a ^ b;
        expect(diff).not.toBe(0);
        expect(diff & (diff - 1)).toBe(0);
      }
      // 対角は 2 ビット異なる
      const d = faces.indices[f * 4] ^ faces.indices[f * 4 + 2];
      expect(d & (d - 1)).not.toBe(0);
    }
  });
});
