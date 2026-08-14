import { describe, it, expect } from 'vitest';
import { PhaseHistory } from '../render/phaseHistory';

const TAU = Math.PI * 2;

/** 平面 k の位相が時刻 t で f(t) になるよう履歴を敷き詰める */
function fill(h: PhaseHistory, from: number, to: number, step: number, f: (t: number, k: number) => number): void {
  const buf = new Float64Array(h.planeCount);
  for (let t = from; t <= to + 1e-9; t += step) {
    for (let k = 0; k < h.planeCount; k++) buf[k] = f(t, k);
    h.record(t, buf);
  }
}

describe('PhaseHistory', () => {
  it('記録した時刻の値をそのまま返す', () => {
    const h = new PhaseHistory(3, 64);
    fill(h, 0, 1, 1 / 60, (t, k) => 0.3 * t * (k + 1));
    const out = new Float64Array(3);
    expect(h.sample(0.5, out)).toBe(true);
    for (let k = 0; k < 3; k++) expect(out[k]).toBeCloseTo(0.3 * 0.5 * (k + 1), 9);
  });

  it('記録の間は線形に補間する', () => {
    // maxGap を広げてある: 1 秒間隔は実際のフレーム間隔(1/60)より遥かに粗く、
    // 既定の 0.5 秒では「途切れ」と判定されて履歴が捨てられる(下の飛びの試験を参照)
    const h = new PhaseHistory(1, 8, 10);
    const buf = new Float64Array(1);
    buf[0] = 0;
    h.record(0, buf);
    buf[0] = 1;
    h.record(1, buf);
    const out = new Float64Array(1);
    h.sample(0.25, out);
    expect(out[0]).toBeCloseTo(0.25, 12);
    h.sample(0.75, out);
    expect(out[0]).toBeCloseTo(0.75, 12);
  });

  it('(−π, π] の折り返しを最短弧で跨ぐ', () => {
    // 3.0 → −3.0 は 0 を通る 6.0 の道ではなく、π を跨ぐ 0.283 の道
    const h = new PhaseHistory(1, 8, 10);
    const buf = new Float64Array(1);
    buf[0] = 3.0;
    h.record(0, buf);
    buf[0] = -3.0;
    h.record(1, buf);
    const out = new Float64Array(1);
    h.sample(0.5, out);
    // 中点はちょうど π。(−π, π] の代表元は +π なので折り返さないのが正しい
    expect(Math.cos(out[0])).toBeCloseTo(Math.cos(3.0 + (TAU - 6.0) / 2), 12);
    expect(Math.sin(out[0])).toBeCloseTo(Math.sin(3.0 + (TAU - 6.0) / 2), 12);
    expect(out[0]).toBeGreaterThan(-Math.PI);
    expect(out[0]).toBeLessThanOrEqual(Math.PI);
    // どの中間時刻でも 0 の近くを通らない(= 逆回りしていない)
    for (let f = 0.05; f < 1; f += 0.05) {
      h.sample(f, out);
      expect(Math.abs(out[0])).toBeGreaterThan(2.8);
    }
  });

  it('容量を超えると最古から捨て、残りは正しく引ける', () => {
    const cap = 16;
    const h = new PhaseHistory(2, cap);
    fill(h, 0, 5, 0.1, (t) => 0.2 * t); // 51 本 → 16 本だけ残る
    expect(h.length).toBe(cap);
    expect(h.newestTime).toBeCloseTo(5, 9);
    expect(h.oldestTime).toBeCloseTo(5 - (cap - 1) * 0.1, 9);
    const out = new Float64Array(2);
    expect(h.sample(4.75, out)).toBe(true);
    expect(out[0]).toBeCloseTo(0.2 * 4.75, 9);
  });

  it('範囲外は最も近い端を書き、false を返す', () => {
    const h = new PhaseHistory(1, 8);
    fill(h, 1, 2, 0.25, (t) => t);
    const out = new Float64Array(1);
    expect(h.sample(0, out)).toBe(false);
    expect(out[0]).toBeCloseTo(1, 9);
    expect(h.sample(99, out)).toBe(false);
    expect(out[0]).toBeCloseTo(2, 9);
  });

  it('時刻が飛んだら履歴を捨てる(タブ復帰で中間状態を捏造しない)', () => {
    const h = new PhaseHistory(1, 32);
    fill(h, 0, 1, 1 / 60, (t) => t);
    expect(h.length).toBeGreaterThan(1);
    const buf = new Float64Array(1);
    buf[0] = 42;
    h.record(30, buf); // 29 秒の飛び > maxGap
    expect(h.length).toBe(1);
    const out = new Float64Array(1);
    expect(h.sample(29, out)).toBe(false);
    expect(out[0]).toBe(42);
  });

  it('時刻が巻き戻っても壊れない', () => {
    const h = new PhaseHistory(1, 32);
    fill(h, 5, 6, 0.1, (t) => t);
    const buf = new Float64Array(1);
    buf[0] = -1;
    h.record(1, buf);
    expect(h.length).toBe(1);
    expect(h.newestTime).toBeCloseTo(1, 9);
  });

  it('空のときは false を返し、out に触れない', () => {
    const h = new PhaseHistory(2, 8);
    const out = new Float64Array(2).fill(7);
    expect(h.sample(1, out)).toBe(false);
    expect(Array.from(out)).toEqual([7, 7]);
  });
});
