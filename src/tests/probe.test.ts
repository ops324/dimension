import { describe, it, expect } from 'vitest';
import {
  FRAME_BUDGET_MS,
  firstDifferenceMax,
  frameStats,
  percentile,
  secondDifferenceMax,
  summarizeGestures,
  type WheelSample,
} from '../core/probe';

/** 生ログを組み立てる小道具。既定値は「奪えている macOS のトラックパッド」 */
function wheel(t: number, over: Partial<WheelSample> = {}): WheelSample {
  return { t, deltaY: 10, deltaMode: 0, cancelable: true, momentum: null, ms: 0.1, ...over };
}

describe('secondDifferenceMax ── 折れの指標(SPEC §5.5 と同じもの)', () => {
  it('等速の直線には折れが無い', () => {
    expect(secondDifferenceMax([0, 10, 20, 30, 40])).toBe(0);
  });

  it('折れた点でその大きさを返す', () => {
    // 0,10,20 と来て 25 → 二階差分は 25 − 2×20 + 10 = −5
    expect(secondDifferenceMax([0, 10, 20, 25])).toBe(5);
  });

  it('3 点に満たなければ 0(判定材料が無い)', () => {
    expect(secondDifferenceMax([])).toBe(0);
    expect(secondDifferenceMax([5])).toBe(0);
    expect(secondDifferenceMax([5, 9])).toBe(0);
  });

  it('指数の減衰(現行の追従)は最初のフレームが最も折れる', () => {
    // expSmooth: x ← x + (T − x)(1 − e^{−k dt})。k=8, dt=1/60, T=100
    const k = 8;
    const dt = 1 / 60;
    const a = 1 - Math.exp(-k * dt);
    const xs = [0];
    for (let i = 0; i < 30; i++) xs.push(xs[xs.length - 1] + (100 - xs[xs.length - 1]) * a);
    // 1 フレーム目の移動量そのものが最大の折れになる(速度が t=0 で跳ぶため)
    expect(secondDifferenceMax(xs)).toBeCloseTo(100 * a * a, 9);
  });
});

describe('firstDifferenceMax ── 1 フレームの移動量', () => {
  it('向きに関わらず絶対値の最大を返す', () => {
    expect(firstDifferenceMax([0, 12, 8, 40, 39])).toBe(32);
    expect(firstDifferenceMax([0, -12, 8])).toBe(20);
  });

  it('2 点に満たなければ 0', () => {
    expect(firstDifferenceMax([])).toBe(0);
    expect(firstDifferenceMax([7])).toBe(0);
  });
});

describe('percentile', () => {
  it('端と中央', () => {
    const xs = [1, 2, 3, 4, 5];
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 0.5)).toBe(3);
    expect(percentile(xs, 1)).toBe(5);
  });

  it('空配列では NaN ではなく 0 を返す(記録ゼロを報告できるように)', () => {
    expect(percentile([], 0.95)).toBe(0);
  });
});

describe('frameStats', () => {
  it('60fps の予算を超えたフレームの割合を出す', () => {
    // 16.7ms 予算。20ms が 2 本 / 10 本
    const ms = [10, 10, 10, 10, 20, 10, 10, 20, 10, 10];
    const s = frameStats(ms);
    expect(s.max).toBe(20);
    expect(s.overBudget).toBeCloseTo(0.2, 9);
    expect(s.p50).toBe(10);
  });

  it('予算ちょうど(16.666…ms)は超過に数えない', () => {
    expect(frameStats([FRAME_BUDGET_MS, FRAME_BUDGET_MS]).overBudget).toBe(0);
  });

  it('記録が無ければすべて 0', () => {
    expect(frameStats([])).toEqual({ p50: 0, p95: 0, max: 0, overBudget: 0 });
  });
});

describe('summarizeGestures', () => {
  it('250ms 以上あいたら別のジェスチャに割る', () => {
    const g = summarizeGestures([wheel(0), wheel(20), wheel(40), wheel(400), wheel(420)]);
    expect(g.length).toBe(2);
    expect(g[0].events).toBe(3);
    expect(g[0].ms).toBe(40);
    expect(g[1].events).toBe(2);
  });

  it('慣性フェーズは同じジェスチャに属する ── 間隔が詰まっているから', () => {
    // 指を置いた 3 件のあと、慣性が 16ms 間隔で 1.2 秒続く
    const ws = [wheel(0), wheel(16), wheel(32)];
    for (let t = 48; t <= 1248; t += 16) ws.push(wheel(t, { momentum: true, deltaY: 4 }));
    const g = summarizeGestures(ws);
    expect(g.length).toBe(1);
    expect(g[0].ms).toBe(1248);
    expect(g[0].momentum).toBe(76);
  });

  it('cancelable が 0 なら、そのジェスチャは丸ごとネイティブへ落ちている', () => {
    const g = summarizeGestures([
      wheel(0, { cancelable: false }),
      wheel(16, { cancelable: false }),
    ]);
    expect(g[0].cancelable).toBe(0);
  });

  it('momentum を取れない環境では null(0 件と区別する)', () => {
    expect(summarizeGestures([wheel(0), wheel(16)])[0].momentum).toBeNull();
  });

  it('delta は符号つきで合算する(往復すれば打ち消し合う)', () => {
    const g = summarizeGestures([wheel(0, { deltaY: 100 }), wheel(16, { deltaY: -100 })]);
    expect(g[0].deltaSum).toBe(0);
  });

  it('ログが空なら空', () => {
    expect(summarizeGestures([])).toEqual([]);
  });
});
