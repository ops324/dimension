import { describe, it, expect, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { depthWidthScale, installDepthWidth, DEPTH_WIDTH_AMOUNT } from '../render/depthWidth';
import {
  depthShade,
  DEPTH_SHADE_BASE,
  DEPTH_SHADE_SPAN,
  LEGACY_SHADE_BASE,
  LEGACY_SHADE_SPAN,
} from '../scenes/narrativeMath';

/** narrative.ts の depthScaleFor(dimLevel) と同一。dimLevel 0..6 の実効域 */
const depthScaleFor = (dimLevel: number): number => 1 / (0.3 + 0.19 * dimLevel);

/* -------------------------------------------------------------- 純関数の契約 */

describe('depthWidthScale', () => {
  const A = DEPTH_WIDTH_AMOUNT;
  const S = depthScaleFor(4); // テッセラクトの章

  it('深度の中央(z = 0)で 1 倍 ── 中立面は現行と同じ太さ', () => {
    expect(depthWidthScale(0, S, A)).toBeCloseTo(1, 12);
  });

  it('手前で太く、奥で細い', () => {
    // t01 = 1 になる z(= +1/depthScale)と、t01 = 0 になる z
    expect(depthWidthScale(1 / S, S, A)).toBeCloseTo(1 + A, 12);
    expect(depthWidthScale(-1 / S, S, A)).toBeCloseTo(1 - A, 12);
  });

  it('窓の外はクランプされる(投影が飛んでも線幅は暴走しない)', () => {
    expect(depthWidthScale(1e6, S, A)).toBeCloseTo(1 + A, 12);
    expect(depthWidthScale(-1e6, S, A)).toBeCloseTo(1 - A, 12);
    expect(depthWidthScale(1e6, S, A)).toBeLessThanOrEqual(1 + A);
  });

  it('深度に対して単調(手前ほど太い、が全域で崩れない)', () => {
    let prev = -Infinity;
    for (let z = -3; z <= 3; z += 0.05) {
      const w = depthWidthScale(z, S, A);
      expect(w).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = w;
    }
  });

  it('amount 0 は完全な恒等(品質ティア / reduced-motion の退避路)', () => {
    for (const z of [-9, -1, 0, 1, 9]) expect(depthWidthScale(z, S, 0)).toBe(1);
  });

  it('NaN は「振らない」側へ倒れる(1 − amount ではなく 1 未満に落ちない)', () => {
    const w = depthWidthScale(NaN, S, A);
    expect(w).toBe(1 - A); // t01 が 0 へ倒れる = 最も細い側。負や NaN にはならない
    expect(Number.isFinite(w)).toBe(true);
  });

  it('全 dimLevel(0..6)で倍率は [0.8, 1.2] を出ない', () => {
    for (let dim = 0; dim <= 6; dim += 0.25) {
      const s = depthScaleFor(dim);
      for (let z = -5; z <= 5; z += 0.1) {
        const w = depthWidthScale(z, s, DEPTH_WIDTH_AMOUNT);
        expect(w).toBeGreaterThanOrEqual(1 - DEPTH_WIDTH_AMOUNT - 1e-12);
        expect(w).toBeLessThanOrEqual(1 + DEPTH_WIDTH_AMOUNT + 1e-12);
      }
    }
  });

  it('振れ幅は ±20% ── これ以上は「遠近」ではなく「別の太さの線」になる', () => {
    expect(DEPTH_WIDTH_AMOUNT).toBe(0.2);
  });
});

/* ------------------------------------- 幅と色が同じ深度を指していること(設計の要)

   幅の深度に視距離(clipStart.w)を使うと、カメラが公転する場面(アイドルドリフト /
   Phase 16 の見回し)で「太い側」だけがカメラを追い、「明るい側」は図に貼りついたまま
   離れていく。**ひとつの深度が二つの方向を指す**ことを、ここで構造的に禁じる。 */

describe('深度キューはひとつ ── 幅と色が同じ量を見る', () => {
  /** narrative.ts の lutIndexOf と同じ正規化 */
  const lutT01 = (z: number, scale: number): number => {
    const t = (z * scale + 1) * 0.5;
    return t < 0 ? 0 : t > 1 ? 1 : t;
  };

  it('幅は色の LUT とまったく同じ t01 を通る', () => {
    const S = depthScaleFor(5);
    for (let z = -4; z <= 4; z += 0.13) {
      const t01 = lutT01(z, S);
      const expected = 1 + DEPTH_WIDTH_AMOUNT * (2 * t01 - 1);
      expect(depthWidthScale(z, S, DEPTH_WIDTH_AMOUNT)).toBeCloseTo(expected, 12);
    }
  });

  it('幅と明度は必ず同じ向きに動く(片方だけが手前を指すことがない)', () => {
    const S = depthScaleFor(3);
    let prevW = -Infinity;
    let prevS = -Infinity;
    for (let z = -3; z <= 3; z += 0.05) {
      const w = depthWidthScale(z, S, DEPTH_WIDTH_AMOUNT);
      const sh = depthShade(lutT01(z, S));
      expect(w).toBeGreaterThanOrEqual(prevW - 1e-12);
      expect(sh).toBeGreaterThanOrEqual(prevS - 1e-12);
      prevW = w;
      prevS = sh;
    }
  });
});

/* ------------------------------------------------ インク総量の不変条件(調律の柵)

   幅へ移したぶん色の傾きを緩める、という取り引きが将来こっそり崩れないよう縛る。
   「インク量」= 明度 × 幅倍率(加算合成では明度がピーク、幅が被覆面積)。 */

describe('インク総量 ── 幅へ移したぶんだけ色の傾きを緩めている', () => {
  const ink = (t01: number): number =>
    depthShade(t01) * (1 + DEPTH_WIDTH_AMOUNT * (2 * t01 - 1));
  const legacyInk = (t01: number): number => LEGACY_SHADE_BASE + LEGACY_SHADE_SPAN * t01;

  const mean = (f: (t: number) => number): number => {
    let sum = 0;
    const n = 1001;
    for (let i = 0; i < n; i++) sum += f(i / (n - 1));
    return sum / n;
  };

  it('平均インク量は現行から 5% 以内(ブルームしきい値 0.28 の裾に届かない)', () => {
    const ratio = mean(ink) / mean(legacyInk);
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(1.05);
  });

  it('近/遠のインク比は上がる ── 深度の手がかりが強くなるのが目的', () => {
    const legacyRatio = legacyInk(1) / legacyInk(0);
    const nextRatio = ink(1) / ink(0);
    expect(legacyRatio).toBeCloseTo(1.636, 2);
    expect(nextRatio).toBeCloseTo(2.0, 2);
    expect(nextRatio).toBeGreaterThan(legacyRatio);
  });

  it('色だけの傾きは緩くなる(幅へ移した分)', () => {
    expect(DEPTH_SHADE_SPAN).toBeLessThan(LEGACY_SHADE_SPAN);
    // いちばん奥の線が現行より暗くなりすぎない(消えたら深度キューではなく欠落)
    expect(depthShade(0)).toBeGreaterThan(LEGACY_SHADE_BASE);
    // いちばん手前の線は白飛びの側へ動かさない
    expect(depthShade(1)).toBeLessThan(LEGACY_SHADE_BASE + LEGACY_SHADE_SPAN);
  });

  it('depthShade は [0,1] の外でもクランプされる', () => {
    expect(depthShade(-5)).toBe(DEPTH_SHADE_BASE);
    expect(depthShade(5)).toBe(DEPTH_SHADE_BASE + DEPTH_SHADE_SPAN);
  });
});

/* ------------------------------------------- シェーダー注入(既知の罠 #11 / #19)

   本命のリグレッション検出。three を上げてシェーダー文字列が変われば**ここが落ちる**ので、
   黙って線幅が固定へ戻ることはない。 */

const lineShader = (): string =>
  (THREE.ShaderLib as Record<string, { vertexShader: string }>)['line'].vertexShader;

const compile = (material: LineMaterial): { uniforms: Record<string, { value: THREE.Vector2 }>; vertexShader: string } => {
  const shader = { uniforms: {} as Record<string, { value: THREE.Vector2 }>, vertexShader: lineShader() };
  material.onBeforeCompile(shader as never, null as never);
  return shader;
};

describe('installDepthWidth — three r185 の実物への注入', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('置換アンカーは実物にちょうど 1 箇所ある', () => {
    expect(lineShader().split(ANCHOR_TEXT).length - 1).toBe(1);
  });

  it('instanceStart / instanceEnd はアンカーより手前で宣言されている(読める位置にある)', () => {
    const src = lineShader();
    const anchor = src.indexOf(ANCHOR_TEXT);
    expect(src.indexOf('attribute vec3 instanceStart;')).toBeGreaterThan(-1);
    expect(src.indexOf('attribute vec3 instanceStart;')).toBeLessThan(anchor);
    expect(src.indexOf('attribute vec3 instanceEnd;')).toBeLessThan(anchor);
  });

  it('注入後のシェーダーが整合する(uniform 宣言・アンカー消費・波括弧の釣り合い)', () => {
    const material = new LineMaterial();
    const dw = installDepthWidth(material, 'test.key');
    expect(dw.installed).toBe(true);

    const out = compile(material).vertexShader;
    expect(out).toContain('uniform vec2 uDepthWidth;');
    expect(out.indexOf('uniform vec2 uDepthWidth;')).toBeLessThan(out.indexOf('uDepthWidth.x'));
    expect(out.split('void main() {').length - 1).toBe(1);
    expect(out).toContain('offset *= linewidth * ( 1.0 + uDepthWidth.y * ( 2.0 * dimT - 1.0 ) );');
    expect(out.split('uniform vec2 uDepthWidth;').length - 1).toBe(1);
    const open = (out.match(/{/g) ?? []).length;
    const close = (out.match(/}/g) ?? []).length;
    expect(open).toBe(close);
  });

  it('注入は WORLD_UNITS 側ではなくスクリーン空間側の枝に入る', () => {
    const material = new LineMaterial();
    installDepthWidth(material, 'test.key');
    const out = compile(material).vertexShader;
    const injected = out.indexOf('float dimZ =');
    const elseBranch = out.indexOf('#else', out.indexOf('#ifdef WORLD_UNITS'));
    expect(elseBranch).toBeGreaterThan(-1);
    expect(injected).toBeGreaterThan(elseBranch);
  });

  it('既知の罠 #19: プログラムキャッシュキーを分ける(素の LineMaterial と共有しない)', () => {
    const plain = new LineMaterial();
    const injected = new LineMaterial();
    installDepthWidth(injected, 'dimension.narrative.depthWidth');
    expect(injected.customProgramCacheKey()).toBe('dimension.narrative.depthWidth');
    expect(injected.customProgramCacheKey()).not.toBe(plain.customProgramCacheKey());
  });

  it('既知の罠 #11: アンカーを失ったら警告して no-op(線幅は現行の固定値のまま)', () => {
    const lib = (THREE.ShaderLib as Record<string, { vertexShader: string }>)['line'];
    const saved = lib.vertexShader;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      lib.vertexShader = 'void main() { /* three が書き換えた世界 */ }';
      const material = new LineMaterial();
      const dw = installDepthWidth(material, 'test.key');
      expect(dw.installed).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
      // onBeforeCompile を触っていない = 既存の描画経路がそのまま残る
      expect(material.onBeforeCompile).toBe(LineMaterial.prototype.onBeforeCompile);
      expect(() => {
        dw.setDepthScale(2.5);
        dw.setAmount(0.5);
      }).not.toThrow();
    } finally {
      lib.vertexShader = saved;
    }
  });
});

describe('installDepthWidth — uniform の書き込み', () => {
  it('setDepthScale / setAmount は vec2 の各成分を書く', () => {
    const material = new LineMaterial();
    const dw = installDepthWidth(material, 'test.key');
    const v = compile(material).uniforms.uDepthWidth.value;
    expect(v.y).toBe(DEPTH_WIDTH_AMOUNT);
    dw.setDepthScale(0.68);
    expect(v.x).toBeCloseTo(0.68, 12);
    dw.setAmount(0.35);
    expect(v.y).toBe(0.35);
  });

  it('setAmount は負を 0 でクランプする(反転した線幅を作らせない)', () => {
    const material = new LineMaterial();
    const dw = installDepthWidth(material, 'test.key');
    const v = compile(material).uniforms.uDepthWidth.value;
    dw.setAmount(-1);
    expect(v.y).toBe(0);
  });

  it('起動時の既定 depthScale は 1(まだ配られていなくても倍率は有限)', () => {
    const material = new LineMaterial();
    installDepthWidth(material, 'test.key');
    const v = compile(material).uniforms.uDepthWidth.value;
    expect(Number.isFinite(v.x)).toBe(true);
    expect(depthWidthScale(0, v.x, v.y)).toBeCloseTo(1, 12);
  });
});

const ANCHOR_TEXT = 'offset *= linewidth;';
