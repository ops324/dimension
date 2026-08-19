import { describe, it, expect } from 'vitest';
import {
  ARROW_STEP,
  GLIDE_OMEGA,
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

/** 二階差分の最大 = 折れ(SPEC §5.5 と同じ指標) */
function d2max(xs: readonly number[]): number {
  let max = 0;
  for (let i = 1; i < xs.length - 1; i++) {
    const d2 = Math.abs(xs[i + 1] - 2 * xs[i] + xs[i - 1]);
    if (d2 > max) max = d2;
  }
  return max;
}

/** Phase 24 までの一次系(expSmooth, rate 8)の写し。比較の基準に使う */
function onePoleRun(perFrame: number, frames: number, dt = 1 / 60): { lag: number; xs: number[] } {
  const a = 1 - Math.exp(-8 * dt);
  let x = 0;
  let target = 0;
  const xs: number[] = [];
  for (let i = 0; i < frames; i++) {
    target += perFrame;
    x += (target - x) * a;
    xs.push(x);
  }
  return { lag: target - x, xs };
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

  /*
    Phase 24 は一次だったので、ここは「時定数 1/rate で 63%」を固定していた。
    臨界減衰の閉じた形は A[1 − (1 + ωt)e^{−ωt}] なので、t = 1/ω では
    A(1 − 2/e) = 26.42% になる ── 出だしが遅いのは ζ = 1 の性質そのもの。
  */
  it('臨界減衰の閉じた形 ── t = 1/ω で目標の 26.42%(一次の 63% ではない)', () => {
    const g = new ScrollGlide();
    g.setMax(10000);
    g.push(1000);
    const tau = 1 / GLIDE_OMEGA;
    expect(run(g, tau, tau / 1000)).toBeCloseTo(1000 * (1 - 2 * Math.exp(-1)), 6);
  });

  it('速度が残っているあいだは、位置が一致しても着地にしない', () => {
    const g = new ScrollGlide();
    g.setMax(10000);
    g.push(1000);
    g.step(1 / 60);

    // 走行中に目標を現在値へ置く = 位置は一致するが、内段はまだ先を向いている
    g.to(g.value);
    expect(g.settled).toBe(false);
    expect(Math.abs(g.velocity)).toBeGreaterThan(0);

    // その運動は捨てられない(一次系には無かった現象)
    const at = g.value;
    expect(g.step(1 / 60)).toBeGreaterThan(at);
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

  it('上限が縮んだら現在値も速度も丸める(ばねが壁を突き抜けない)', () => {
    const g = new ScrollGlide();
    g.setMax(5000);
    g.push(4000);
    run(g, 0.1);
    g.setMax(1200);
    expect(g.target).toBe(1200);
    for (let i = 0; i < 120; i++) expect(g.step(1 / 60)).toBeLessThanOrEqual(1200);
  });

  it('先頭でも壁を突き抜けない(逆走の持ち越しが 0 を割らない)', () => {
    const g = new ScrollGlide();
    g.setMax(10000);
    g.push(400);
    run(g, 0.15);
    g.to(0);
    for (let i = 0; i < 120; i++) expect(g.step(1 / 60)).toBeGreaterThanOrEqual(0);
  });
});

/* ------------------------------------------------- Phase 34c で固定した体感の量 */

describe('ばね化(Phase 34c)が実際に何を変えたか', () => {
  it('折れが 3 分の 1 になる ── 100px ノッチの二階差分の最大', () => {
    const g = new ScrollGlide();
    g.setMax(10000);
    // 入力の前の 2 フレーム(静止)を含める。ノッチ 1 発の折れはここに立つ
    const xs = [0, 0];
    g.push(100);
    for (let i = 0; i < 120; i++) xs.push(g.step(1 / 60));

    // Phase 24(一次 rate 8)は 100 × (1 − e^{−8/60}) = 12.483px だった
    const onePole = 100 * (1 - Math.exp(-8 / 60));
    expect(onePole).toBeCloseTo(12.483, 3);
    expect(d2max(xs)).toBeCloseTo(4.083, 3);
    expect(d2max(xs)).toBeLessThan(onePole / 3);
  });

  it('遅れは増えていない ── ランプ追従の定常誤差が一次系と一致する', () => {
    /*
      これが Phase 30b の「フレーム間の移動量はほぼ不変」に対応する不変量。
      折れの数だけを見て「良くなった」と言わないための対。
      二次系のランプ遅れは 2/ω、一次系は 1/rate。ω = 2 × rate はここで揃う。
    */
    const perFrame = 20; // 1200px/s @60Hz
    const g = new ScrollGlide();
    g.setMax(1e6);
    let target = 0;
    for (let i = 0; i < 240; i++) {
      target += perFrame;
      g.push(perFrame);
      g.step(1 / 60);
    }
    const lagSpring = target - g.value;
    const lagOnePole = onePoleRun(perFrame, 240).lag;

    expect(lagSpring).toBeCloseTo(140.0, 1);
    expect(lagOnePole).toBeCloseTo(140.22, 1);
    expect(Math.abs(lagSpring - lagOnePole)).toBeLessThan(0.25);
  });

  it('逆走は持ち越すが、上界は v₀/(ω·e) ── ばねの唯一の新しい現象', () => {
    const dt = 1 / 60;
    const g = new ScrollGlide();
    g.setMax(1e6);
    g.push(500); // 下へ 5 ノッチ
    for (let i = 0; i < 12; i++) g.step(dt); // 200ms 走らせる
    const v0 = g.velocity;
    const turn = g.value;

    g.push(-300); // 逆へ 3 ノッチ
    let deepest = turn;
    for (let i = 0; i < 120; i++) {
      const v = g.step(dt);
      if (v > deepest) deepest = v;
    }

    const carry = deepest - turn;
    expect(v0).toBeGreaterThan(0);
    expect(carry).toBeGreaterThan(0); // 一次系ではここが 0 だった
    expect(carry).toBeLessThan(v0 / (GLIDE_OMEGA * Math.E) + 1);
  });

  it('出だしは遅くなる ── ノッチの 5% に達するまでの時間(数で認めておく)', () => {
    const dt = 1 / 1000;
    const g = new ScrollGlide();
    g.setMax(10000);
    g.push(100);
    let ms = 0;
    while (g.value < 5 && ms < 500) {
      g.step(dt);
      ms++;
    }
    // 一次系(rate 8)は 6.4ms。臨界減衰は 22.2ms ── これが唯一の代償
    expect(ms).toBeGreaterThan(15);
    expect(ms).toBeLessThan(30);
  });
});
