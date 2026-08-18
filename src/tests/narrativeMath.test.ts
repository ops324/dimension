import { describe, expect, it } from 'vitest';

import { rotateBatch, type PlaneRotation } from '../math/rotation';
import {
  ORBIT_FADE_START,
  ORBIT_FADE_WIDTH,
  ORBIT_GATE,
  ORBIT_GATE_WIDTH,
  orbitAmount,
} from '../scenes/narrativeMath';

const TAU = Math.PI * 2;

describe('orbitAmount(軌道環のゲート)', () => {
  it('等傾二重回転が立ち上がる前は完全に閉じている', () => {
    for (const d of [0, 1, 2, 3, 3.4, ORBIT_GATE]) {
      expect(orbitAmount(d)).toBe(0);
    }
  });

  it('4次元のプラトーでは開き切っている', () => {
    expect(orbitAmount(ORBIT_GATE + ORBIT_GATE_WIDTH)).toBe(1);
    expect(orbitAmount(4)).toBe(1);
    expect(orbitAmount(ORBIT_FADE_START)).toBe(1);
  });

  it('図が密になる 5〜6 次元では閉じる(Phase 23b の実測に従う)', () => {
    expect(orbitAmount(ORBIT_FADE_START + ORBIT_FADE_WIDTH)).toBe(0);
    expect(orbitAmount(6)).toBe(0);
  });

  it('立ち上がりと減衰の中点は 0.5', () => {
    expect(orbitAmount(ORBIT_GATE + ORBIT_GATE_WIDTH / 2)).toBeCloseTo(0.5, 12);
    expect(orbitAmount(ORBIT_FADE_START + ORBIT_FADE_WIDTH / 2)).toBeCloseTo(0.5, 12);
  });

  it('全域で [0,1] に収まり、開いてから閉じるまで単峰である', () => {
    let peakAt = -1;
    let peak = -1;
    for (let d = -1; d <= 8; d += 0.01) {
      const a = orbitAmount(d);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
      if (a > peak) {
        peak = a;
        peakAt = d;
      }
    }
    expect(peak).toBe(1);
    expect(peakAt).toBeGreaterThanOrEqual(ORBIT_GATE);
    expect(peakAt).toBeLessThanOrEqual(ORBIT_FADE_START + 1e-9);
  });
});

/*
  軌道環が主張していること ── 「等傾ペアだけが回り続ければ、頂点はこの輪の上を進む」──
  を数式で縛る。実装は位相へ θ を足して rotateBatch を通すだけなので、ここで確かめる
  性質がそのまま画面の正しさになる。
*/
describe('等傾二重回転の軌道(物語の第四章)', () => {
  /** 平面 (0,3) と (1,2) へ同じ角 theta を与える回転列 */
  const isoclinic = (theta: number): PlaneRotation[] => [
    { i: 0, j: 3, angle: theta },
    { i: 1, j: 2, angle: theta },
  ];

  const source = new Float64Array([0.31, -0.52, 0.24, 0.66, 0.18, -0.41]);
  const norm = (v: Float64Array): number => Math.hypot(...Array.from(v));

  it('原点からの距離を保つ', () => {
    const r0 = norm(source);
    const p = new Float64Array(6);
    for (let s = 0; s <= 32; s++) {
      p.set(source);
      rotateBatch(p, p, 6, 1, isoclinic((s / 32) * TAU));
      expect(norm(p)).toBeCloseTo(r0, 12);
    }
  });

  it('始点との内積が |p|²·cos θ ── つまり軌道は等速で回る真円である', () => {
    const r2 = source.reduce((acc, v) => acc + v * v, 0);
    const p = new Float64Array(6);
    for (let s = 0; s <= 48; s++) {
      const theta = (s / 48) * TAU;
      p.set(source);
      rotateBatch(p, p, 6, 1, isoclinic(theta));
      let dot = 0;
      for (let k = 0; k < 6; k++) dot += p[k] * source[k];
      // 第 5・第 6 軸は等傾ペアに含まれないので、その寄与は cos θ の外に残る
      const fixed = source[4] * source[4] + source[5] * source[5];
      expect(dot).toBeCloseTo((r2 - fixed) * Math.cos(theta) + fixed, 12);
    }
  });

  it('θ を一周ぶん足すと元の点へ厳密に戻る(輪が閉じる)', () => {
    const p = new Float64Array(6);
    p.set(source);
    rotateBatch(p, p, 6, 1, isoclinic(TAU));
    for (let k = 0; k < 6; k++) expect(p[k]).toBeCloseTo(source[k], 12);
  });

  it('等傾でない組み合わせ(角が違う)では真円にならない', () => {
    const p = new Float64Array(6);
    p.set(source);
    rotateBatch(p, p, 6, 1, [
      { i: 0, j: 3, angle: 0.7 },
      { i: 1, j: 2, angle: 0.2 },
    ]);
    let dot = 0;
    for (let k = 0; k < 6; k++) dot += p[k] * source[k];
    const r2 = source.reduce((acc, v) => acc + v * v, 0);
    const fixed = source[4] * source[4] + source[5] * source[5];
    expect(dot).not.toBeCloseTo((r2 - fixed) * Math.cos(0.7) + fixed, 6);
  });
});
