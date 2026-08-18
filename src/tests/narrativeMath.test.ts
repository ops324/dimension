import { describe, expect, it } from 'vitest';

import { rotateBatch, type PlaneRotation } from '../math/rotation';
import {
  FRONT_BASE,
  FRONT_BOOST,
  FRONT_LEAD,
  FRONT_SIGMA,
  birthEnvelope,
  buildFrontTables,
  frontPosition,
  ORBIT_FADE_START,
  ORBIT_FADE_WIDTH,
  ORBIT_GATE,
  ORBIT_GATE_WIDTH,
  orbitAmount,
  LENS_GATE,
  LENS_GATE_WIDTH,
  lensAmount,
  VERTIGO_AMOUNT,
  vertigoScale,
  fovForDollyZoom,
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

describe('buildFrontTables(波面)', () => {
  const SUBDIV = 16;
  const mix = new Float64Array(SUBDIV + 1);
  const boost = new Float64Array(SUBDIV + 1);
  /** 表と同じ閉形式。実装が式から離れていないことを縛る */
  const gauss = (u: number, e: number): number => {
    const d = (u - Math.min(1, e * FRONT_LEAD)) / FRONT_SIGMA;
    return Math.exp(-d * d);
  };

  it('プラトーでは 1 要素も光らず、明るさも素通し(包絡が 0)', () => {
    for (const e of [0, 1]) {
      buildFrontTables(mix, boost, e, SUBDIV);
      for (let s = 0; s <= SUBDIV; s++) {
        expect(mix[s]).toBe(0);
        expect(boost[s]).toBe(1);
      }
    }
    expect(birthEnvelope(0)).toBe(0);
    expect(birthEnvelope(1)).toBe(0);
    expect(birthEnvelope(0.5)).toBe(1);
  });

  it('閉形式と一致する', () => {
    for (const e of [0.13, 0.5, 0.77, 0.96]) {
      const env = birthEnvelope(e);
      buildFrontTables(mix, boost, e, SUBDIV);
      for (let s = 0; s <= SUBDIV; s++) {
        const g = gauss(s / SUBDIV, e);
        expect(mix[s]).toBeCloseTo(env * (FRONT_BASE + (1 - FRONT_BASE) * g), 12);
        expect(boost[s]).toBeCloseTo(1 + FRONT_BOOST * env * g, 12);
      }
    }
  });

  it('前線は extent より少しだけ先を走り、e=0.8 で向こう側のコピーへ着く', () => {
    for (const e of [0.2, 0.4, 0.6, 0.8, 0.95]) {
      buildFrontTables(mix, boost, e, SUBDIV);
      let peak = 0;
      for (let s = 1; s <= SUBDIV; s++) if (mix[s] > mix[peak]) peak = s;
      expect(Math.abs(peak / SUBDIV - frontPosition(e))).toBeLessThanOrEqual(0.5 / SUBDIV + 1e-9);
    }
    expect(frontPosition(0.8)).toBe(1);
    expect(frontPosition(1)).toBe(1);
    expect(frontPosition(0)).toBe(0);
  });

  it('混色比は包絡を超えず、下駄を下回らない', () => {
    for (const e of [0.05, 0.3, 0.5, 0.9]) {
      const env = birthEnvelope(e);
      buildFrontTables(mix, boost, e, SUBDIV);
      for (let s = 0; s <= SUBDIV; s++) {
        expect(mix[s]).toBeLessThanOrEqual(env + 1e-12);
        expect(mix[s]).toBeGreaterThanOrEqual(env * FRONT_BASE - 1e-12);
        expect(boost[s]).toBeGreaterThanOrEqual(1);
        expect(boost[s]).toBeLessThanOrEqual(1 + FRONT_BOOST * env + 1e-12);
      }
    }
  });

  it('ゴールドの総量は一様フラッシュより少ない(既知の罠 #6 に対して安全側)', () => {
    // 「一様」= 旧実装で、辺のどこでも混色比が env だった状態
    for (const e of [0.3, 0.5, 0.7]) {
      const env = birthEnvelope(e);
      buildFrontTables(mix, boost, e, SUBDIV);
      let energy = 0;
      for (let s = 0; s <= SUBDIV; s++) energy += mix[s] * boost[s];
      const mean = energy / (SUBDIV + 1);
      expect(mean).toBeLessThan(env);
    }
  });

  it('前線の位置は extent に対して単調に進む(巻き戻せる)', () => {
    let prev = -1;
    for (let e = 0.05; e <= 0.95; e += 0.05) {
      buildFrontTables(mix, boost, e, SUBDIV);
      let peak = 0;
      for (let s = 1; s <= SUBDIV; s++) if (mix[s] > mix[peak]) peak = s;
      expect(peak).toBeGreaterThanOrEqual(prev);
      prev = peak;
    }
  });
});

describe('めまい(ドリーズーム)', () => {
  it('次元が動かないところでは恒等(prologue / epilogue / プラトー)', () => {
    for (const e of [0, 1]) {
      expect(vertigoScale(e)).toBe(1);
      expect(fovForDollyZoom(50, vertigoScale(e))).toBe(50);
    }
  });

  it('もっとも深く効くのは伸長の半ばで、深さは AMOUNT ぶん', () => {
    expect(vertigoScale(0.5)).toBeCloseTo(1 - VERTIGO_AMOUNT, 12);
    let min = 1;
    let at = -1;
    for (let e = 0; e <= 1.0001; e += 0.01) {
      const m = vertigoScale(e);
      if (m < min) {
        min = m;
        at = e;
      }
    }
    expect(at).toBeCloseTo(0.5, 2);
    expect(min).toBeCloseTo(1 - VERTIGO_AMOUNT, 12);
  });

  it('画面上の大きさ 2·d·tan(fov/2) を保存する', () => {
    for (const fov of [40, 46, 50, 54]) {
      for (const m of [0.85, 0.9, 0.95, 1, 1.1]) {
        const d = 4.6;
        const before = d * Math.tan((fov * Math.PI) / 360);
        const after = d * m * Math.tan((fovForDollyZoom(fov, m) * Math.PI) / 360);
        expect(after).toBeCloseTo(before, 12);
      }
    }
  });

  it('画角は (0, 180) を出ない', () => {
    for (let e = 0; e <= 1.0001; e += 0.02) {
      const f = fovForDollyZoom(54, vertigoScale(e));
      expect(f).toBeGreaterThan(0);
      expect(f).toBeLessThan(180);
      // 寄るぶんだけ広がる(狭まらない)
      expect(f).toBeGreaterThanOrEqual(54 - 1e-9);
    }
  });

  it('章のいちばん広い画角でも増分は 9° を超えない', () => {
    const widest = 54; // CAMERA_KEYS の最大(epilogue)
    const peak = fovForDollyZoom(widest, vertigoScale(0.5));
    expect(peak - widest).toBeLessThan(9);
    expect(peak - widest).toBeGreaterThan(3);
  });

  it('不正な倍率では素通しする(0 割りを構造的に避ける)', () => {
    expect(fovForDollyZoom(50, 0)).toBe(50);
    expect(fovForDollyZoom(50, -1)).toBe(50);
    expect(fovForDollyZoom(50, Number.NaN)).toBe(50);
  });
});

describe('重力場のゲート', () => {
  it('第四章までは完全に閉じている', () => {
    for (const d of [0, 2, 4, 4.5, LENS_GATE]) expect(lensAmount(d)).toBe(0);
  });

  it('5.8 で開き切り、第六章では最大のまま', () => {
    expect(lensAmount(LENS_GATE + LENS_GATE_WIDTH)).toBe(1);
    expect(lensAmount(6)).toBe(1);
    expect(lensAmount(99)).toBe(1);
  });

  it('立ち上がりは線形で単調', () => {
    expect(lensAmount(LENS_GATE + LENS_GATE_WIDTH / 2)).toBeCloseTo(0.5, 12);
    let prev = -1;
    for (let d = 4; d <= 6.5; d += 0.05) {
      const a = lensAmount(d);
      expect(a).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = a;
    }
  });
});
