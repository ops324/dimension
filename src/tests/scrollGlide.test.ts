import { describe, it, expect } from 'vitest';
import {
  ARROW_STEP,
  GLIDE_RATE,
  LINE_STEP,
  PAGE_FRACTION,
  ScrollGlide,
  keyIntent,
  normalizeWheel,
} from '../core/scrollGlide';

/** 合計 seconds 秒ぶんを step 刻みで進める(刻み数は丸めず割り切れる組でのみ使う) */
function run(g: ScrollGlide, seconds: number, step = 1 / 60): number {
  const n = Math.round(seconds / step);
  for (let i = 0; i < n; i++) g.step(step);
  return g.value;
}

describe('normalizeWheel', () => {
  it('deltaMode=0 は px をそのまま通す', () => {
    expect(normalizeWheel(100, 0, 800)).toBe(100);
    expect(normalizeWheel(-53, 0, 800)).toBe(-53);
  });

  it('Firefox の 1 ノッチ(3 行)が Chrome の 1 ノッチ(100px)と一致する', () => {
    expect(normalizeWheel(3, 1, 800)).toBeCloseTo(100, 9);
    expect(normalizeWheel(1, 1, 800)).toBeCloseTo(LINE_STEP, 9);
  });

  it('deltaMode=2 はビューポート 1 枚ぶん', () => {
    expect(normalizeWheel(2, 2, 812)).toBe(1624);
  });
});

describe('keyIntent', () => {
  it('矢印は 1 打鍵ぶんの相対移動', () => {
    expect(keyIntent('ArrowDown', false, 800, 5000)).toEqual({ delta: ARROW_STEP });
    expect(keyIntent('ArrowUp', false, 800, 5000)).toEqual({ delta: -ARROW_STEP });
  });

  it('Space は進み、Shift + Space は戻る(ブラウザ既定と同じ約束)', () => {
    const page = 800 * PAGE_FRACTION;
    expect(keyIntent(' ', false, 800, 5000)).toEqual({ delta: page });
    expect(keyIntent(' ', true, 800, 5000)).toEqual({ delta: -page });
  });

  it('Home / End は絶対位置', () => {
    expect(keyIntent('Home', false, 800, 5000)).toEqual({ to: 0 });
    expect(keyIntent('End', false, 800, 5000)).toEqual({ to: 5000 });
  });

  it('スクロールと無関係なキーには触らない', () => {
    for (const key of ['a', 'Escape', 'Tab', 'Enter', 'F5', 'ArrowLeft']) {
      expect(keyIntent(key, false, 800, 5000)).toBeNull();
    }
  });
});

describe('ScrollGlide', () => {
  it('生成直後は着地しており、誰も scrollTo を書かない', () => {
    const g = new ScrollGlide();
    expect(g.settled).toBe(true);
  });

  it('目標へ単調に近づき、追い越さない', () => {
    const g = new ScrollGlide();
    g.setMax(10000);
    g.push(1000);

    let prev = -1;
    for (let i = 0; i < 60; i++) {
      const v = g.step(1 / 60);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(1000);
      prev = v;
    }
  });

  it('時定数 1/rate で目標の 63% に達する(指数則)', () => {
    const g = new ScrollGlide();
    g.setMax(10000);
    g.push(1000);
    const tau = 1 / GLIDE_RATE;
    expect(run(g, tau, 1 / 1000)).toBeCloseTo(1000 * (1 - Math.exp(-1)), 6);
  });

  it('フレームレートに依らず同じ時間で同じ位置に着く', () => {
    const a = new ScrollGlide();
    const b = new ScrollGlide();
    a.setMax(10000);
    b.setMax(10000);
    a.push(1000);
    b.push(1000);
    // 120Hz と 24Hz で 0.25 秒(どちらも刻みが割り切れる組)
    expect(run(a, 0.25, 1 / 120)).toBeCloseTo(run(b, 0.25, 1 / 24), 6);
  });

  it('十分な時間で目標へスナップし、着地したら書き込みが止まる', () => {
    const g = new ScrollGlide();
    g.setMax(10000);
    g.push(1000);
    run(g, 2);
    expect(g.value).toBe(1000);
    expect(g.settled).toBe(true);
  });

  it('目標は [0, max] に丸められる(文書の外へは慣性が伸びない)', () => {
    const g = new ScrollGlide();
    g.setMax(500);
    g.push(9999);
    expect(g.target).toBe(500);
    g.push(-9999);
    expect(g.target).toBe(0);
  });

  it('上限が縮んだら目標も縮む(resize でセクションが短くなる場合)', () => {
    const g = new ScrollGlide();
    g.setMax(5000);
    g.push(4000);
    g.setMax(1200);
    expect(g.target).toBe(1200);
  });

  it('外部スクロールの再同期は現在値と目標を同時に置く(引き戻しが起きない)', () => {
    const g = new ScrollGlide();
    g.setMax(10000);
    g.push(2000);
    run(g, 0.1);
    // 読者が指でまったく別の位置へ送った
    g.reset(7777);
    expect(g.value).toBe(7777);
    expect(g.target).toBe(7777);
    expect(g.settled).toBe(true);
    // 次のフレームで元の目標へ戻ろうとしない
    expect(g.step(1 / 60)).toBe(7777);
  });

  it('上限より先へ再同期されたら上限のほうを広げる(測り直し前の遅延を許す)', () => {
    const g = new ScrollGlide();
    g.setMax(1000);
    g.reset(4200);
    expect(g.value).toBe(4200);
    expect(g.max).toBeGreaterThanOrEqual(4200);
  });

  it('走行中の追加入力は目標に積み上がる(ノッチを取りこぼさない)', () => {
    const g = new ScrollGlide();
    g.setMax(10000);
    g.push(100);
    g.step(1 / 60);
    g.push(100);
    g.push(100);
    expect(g.target).toBe(300);
  });
});
