import { describe, it, expect, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

import { installDepthWidth } from '../render/depthWidth';
import {
  GLOW_FRAG_ANCHOR,
  LINE_GLOW_CORE_K,
  LINE_GLOW_CORE_K_FROM,
  LINE_GLOW_CORE_K_MAX,
  LINE_GLOW_HALO_REF,
  coreKFor,
  glowIntensityFor,
  lineGlowCorePeak,
  LINE_GLOW_CUTOFF,
  LINE_GLOW_INTENSITY,
  LINE_GLOW_PX_MAX,
  LINE_GLOW_PX_MIN,
  LINE_GLOW_THICK_NORM,
  glowPxFor,
  lineGlowGain,
  lineGlowLenNorm,
  lineGlowQuadWidth,
} from '../render/lineGlow';

/* ------------------------------------------------------------ 器と場のつじつま */

describe('器の幅と場のスケールは同じ 1 本の約束から出る', () => {
  it('thickNorm は cutoff の逆数(= 器の縁がそのまま打ち切り位置)', () => {
    expect(LINE_GLOW_THICK_NORM).toBeCloseTo(1 / LINE_GLOW_CUTOFF, 12);
  });

  it('glowPx を動かしても thickNorm は動かない — 器が glowPx に比例するから', () => {
    for (const glowPx of [2, 3, 4.5, 6, 11]) {
      const quad = lineGlowQuadWidth(glowPx);
      // 正規化した器の中で glowPx が占める割合 = glowPx / (器の幅/2)
      expect(glowPx / (quad / 2)).toBeCloseTo(LINE_GLOW_THICK_NORM, 12);
    }
  });

  it('器の半幅はちょうど cutoff 個ぶんの glowPx', () => {
    for (const glowPx of [3, 5, 6]) {
      expect(lineGlowQuadWidth(glowPx) / 2).toBeCloseTo(LINE_GLOW_CUTOFF * glowPx, 12);
    }
  });
});

/* ------------------------------------------------------------------ 場の形 */

describe('lineGlowGain', () => {
  it('芯(d=0)で (1/0.45)² × 強度 まで跳ね上がる — HDR で 1 を超えるのが白い芯の正体', () => {
    const peak = lineGlowGain(0, 1);
    expect(peak).toBeCloseTo((1 / 0.45) ** 2 * LINE_GLOW_INTENSITY, 10);
    expect(peak).toBeGreaterThan(1);
  });

  it('器の縁(d=1)でちょうど 0 — 打ち切りの円が見えない条件', () => {
    expect(lineGlowGain(1, 1)).toBe(0);
  });

  it('芯から縁へ向かって単調に減る', () => {
    let prev = Infinity;
    for (let i = 0; i <= 40; i++) {
      const g = lineGlowGain(i / 40, 1);
      expect(g).toBeLessThanOrEqual(prev + 1e-12);
      prev = g;
    }
  });

  it('定義域の外は端へ倒す(NaN は 0 側)', () => {
    expect(lineGlowGain(-5, 1)).toBeCloseTo(lineGlowGain(0, 1), 12);
    expect(lineGlowGain(5, 1)).toBe(0);
    expect(lineGlowGain(NaN, 1)).toBeCloseTo(lineGlowGain(0, 1), 12);
  });

  it('強度 0 で完全に消える', () => {
    for (const d of [0, 0.3, 0.7]) expect(lineGlowGain(d, 1, LINE_GLOW_THICK_NORM, 0)).toBe(0);
  });

  it('寄与は線分長の係数に比例する', () => {
    const full = lineGlowGain(0.25, 1);
    expect(lineGlowGain(0.25, 0.5)).toBeCloseTo(full * 0.5, 12);
    expect(lineGlowGain(0.25, 0)).toBe(0);
  });
});

/* -------------------------------------------------- 細分割に明るさを依らせない */

describe('lineGlowLenNorm — 16 分割しても明るさが変わらないための係数', () => {
  const QUAD = lineGlowQuadWidth(5);

  it('器より短い線分は長さに比例する(= 線積分。分割数に依らない)', () => {
    expect(lineGlowLenNorm(QUAD / 4, QUAD)).toBeCloseTo(0.25, 12);
    expect(lineGlowLenNorm(QUAD / 2, QUAD)).toBeCloseTo(0.5, 12);
  });

  it('器より長い線分は 1 で飽和する(1 本で暈の全域を覆うため)', () => {
    expect(lineGlowLenNorm(QUAD, QUAD)).toBe(1);
    expect(lineGlowLenNorm(QUAD * 10, QUAD)).toBe(1);
  });

  it('短い側では分割数を変えても総和が変わらない', () => {
    // 長さ L の辺を n 分割したときの総寄与 = n × lenNorm(L/n)
    const L = QUAD * 0.8;
    const sums = [2, 4, 8, 16, 32].map((n) => n * lineGlowLenNorm(L / n, QUAD));
    for (const s of sums) expect(s).toBeCloseTo(sums[0], 12);
  });

  it('退化した入力で NaN を出さない', () => {
    expect(lineGlowLenNorm(0, QUAD)).toBe(0);
    expect(lineGlowLenNorm(10, 0)).toBe(0);
    expect(lineGlowLenNorm(-5, QUAD)).toBe(0);
  });
});

/* ------------------------------------------------------ 次元が上がるほど締まる */

describe('glowPxFor', () => {
  it('次元が上がるほど暈は締まる(辺の間隔より小さく保つ)', () => {
    let prev = Infinity;
    for (let d = 0; d <= 6; d += 0.25) {
      const px = glowPxFor(d);
      expect(px).toBeLessThanOrEqual(prev + 1e-12);
      prev = px;
    }
  });

  it('実測点に一致する — 4 次元で 5px、6 次元で 3px', () => {
    expect(glowPxFor(4)).toBeCloseTo(5, 12);
    expect(glowPxFor(6)).toBeCloseTo(3, 12);
  });

  it('低次元は上限で頭打ち(辺が数本しかないので広げても融合しない)', () => {
    for (const d of [0, 1, 2, 3]) expect(glowPxFor(d)).toBe(LINE_GLOW_PX_MAX);
  });

  it('実効域の外でも下限・上限を割らない', () => {
    for (const d of [-3, 0, 3.5, 6, 9, 20]) {
      const px = glowPxFor(d);
      expect(px).toBeGreaterThanOrEqual(LINE_GLOW_PX_MIN);
      expect(px).toBeLessThanOrEqual(LINE_GLOW_PX_MAX);
    }
  });

  it('器の幅は 6 次元でも現行線幅(2.6px)より広い = 暈が入る余地がある', () => {
    expect(lineGlowQuadWidth(glowPxFor(6))).toBeGreaterThan(2.6);
  });
});

/* ------------------------------------------- 芯だけを鈍らせる(Phase 36a) */

describe('coreKFor — 芯の鋭さは次元の関数', () => {
  it('第四章の平地(dim = 4.00)は Strands のまま ── ここを動かすと 4D の見え方が変わる', () => {
    expect(coreKFor(4)).toBeCloseTo(LINE_GLOW_CORE_K, 12);
    for (const d of [0, 1, 2, 3, 3.9, 4]) expect(coreKFor(d)).toBeCloseTo(LINE_GLOW_CORE_K, 12);
  });

  it('ランプは 4.0 から始まる ── 4.5 始まりだと dim 4.47 のモーフに効かない', () => {
    expect(LINE_GLOW_CORE_K_FROM).toBe(4);
    expect(coreKFor(4.47)).toBeGreaterThan(LINE_GLOW_CORE_K);
  });

  it('次元とともに単調に鈍り、6 次元で実測値へ達する', () => {
    let prev = -Infinity;
    for (let d = 0; d <= 7; d += 0.1) {
      const k = coreKFor(d);
      expect(k).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = k;
    }
    expect(coreKFor(6)).toBeCloseTo(LINE_GLOW_CORE_K_MAX, 12);
    expect(coreKFor(9)).toBeCloseTo(LINE_GLOW_CORE_K_MAX, 12);
  });

  it('実測で決めた値(「改善」してはいけない)', () => {
    expect(LINE_GLOW_CORE_K).toBe(0.45);
    expect(LINE_GLOW_CORE_K_MAX).toBe(1.3);
  });
});

describe('glowIntensityFor — 暈は次元によらず同じ濃さで出る', () => {
  /** 支点 d = REF·thickNorm での場の値。ここが不変であることが補正の定義 */
  const haloAt = (dimLevel: number): number =>
    lineGlowGain(
      LINE_GLOW_HALO_REF * LINE_GLOW_THICK_NORM,
      1,
      LINE_GLOW_THICK_NORM,
      glowIntensityFor(dimLevel),
      coreKFor(dimLevel),
    );

  it('支点での暈は全次元で一定 ── これが補正式の存在理由', () => {
    const ref = haloAt(4);
    for (let d = 0; d <= 6; d += 0.25) expect(haloAt(d)).toBeCloseTo(ref, 10);
  });

  it('芯のピークは次元とともに単調に下がる(= 白飛びが引く)', () => {
    let prev = Infinity;
    for (let d = 4; d <= 6; d += 0.1) {
      const peak = lineGlowCorePeak(d);
      expect(peak).toBeLessThanOrEqual(prev + 1e-12);
      prev = peak;
    }
    // 4D は 1.5/0.45² = 7.41、6D は約 1.61 まで落ちる(SPEC §4.10 の表)
    expect(lineGlowCorePeak(4)).toBeCloseTo(7.41, 1);
    expect(lineGlowCorePeak(6)).toBeCloseTo(1.61, 1);
  });

  it('芯は下がるのに暈は下がらない ── 強度は次元とともに**上がる**', () => {
    expect(glowIntensityFor(6)).toBeGreaterThan(glowIntensityFor(4));
    expect(glowIntensityFor(4)).toBeCloseTo(LINE_GLOW_INTENSITY, 12);
  });

  it('base を変えると全体が比例する(露出のノブは 1 本のまま)', () => {
    for (const d of [4, 5, 6]) expect(glowIntensityFor(d, 3)).toBeCloseTo(glowIntensityFor(d, 1.5) * 2, 10);
  });
});

/* --------------------------------------------- シェーダー注入(既知の罠 #11 / #19)

   three を上げてフラグメントシェーダーの文字列が変われば**ここが落ちる**ので、
   黙って線が平坦な帯へ戻ることはない。 */

const lineLib = (): { vertexShader: string; fragmentShader: string } =>
  (THREE.ShaderLib as Record<string, { vertexShader: string; fragmentShader: string }>)['line'];

const compile = (
  material: LineMaterial,
): { uniforms: Record<string, { value: THREE.Vector3 }>; vertexShader: string; fragmentShader: string } => {
  const lib = lineLib();
  const shader = {
    uniforms: {} as Record<string, { value: THREE.Vector3 }>,
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
  };
  material.onBeforeCompile(shader as never, null as never);
  return shader;
};

describe('線グローの注入 — three r185 の実物へ', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('フラグメントの置換アンカーは実物にちょうど 1 箇所ある', () => {
    expect(lineLib().fragmentShader.split(GLOW_FRAG_ANCHOR).length - 1).toBe(1);
  });

  it('vUv はスクリーン空間側で宣言されている(垂直方向は x)', () => {
    const frag = lineLib().fragmentShader;
    expect(frag).toContain('varying vec2 vUv;');
    // three 自身の端キャップ判定が「線に沿う軸は y」であることの証拠
    expect(frag).toContain('if ( abs( vUv.y ) > 1.0 )');
  });

  it('ndcStart / ndcEnd / resolution / linewidth は頂点アンカーより手前にある', () => {
    const src = lineLib().vertexShader;
    const anchor = src.indexOf('offset *= linewidth;');
    expect(anchor).toBeGreaterThan(-1);
    for (const decl of ['vec3 ndcStart =', 'vec3 ndcEnd =', 'uniform vec2 resolution;', 'uniform float linewidth;']) {
      const at = src.indexOf(decl);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(anchor);
    }
  });

  it('glow: true で両方のシェーダーへ入り、アンカーを消費する', () => {
    const material = new LineMaterial();
    const dw = installDepthWidth(material, 'test.key', { glow: true });
    expect(dw.installed).toBe(true);
    expect(dw.glowInstalled).toBe(true);

    const out = compile(material);
    expect(out.vertexShader).toContain('varying float vGlowLen;');
    expect(out.vertexShader).toContain('vGlowLen =');
    expect(out.fragmentShader).toContain('uniform vec3 uLineGlow;');
    expect(out.fragmentShader).toContain('varying float vGlowLen;');
    // アンカーは消費され、素の出力は残っていない
    expect(out.fragmentShader).not.toContain(GLOW_FRAG_ANCHOR);
    expect(out.fragmentShader.split('void main() {').length - 1).toBe(1);
    expect(out.uniforms.uLineGlow.value.x).toBeCloseTo(LINE_GLOW_THICK_NORM, 12);
    expect(out.uniforms.uLineGlow.value.y).toBeCloseTo(LINE_GLOW_INTENSITY, 12);
    expect(out.uniforms.uLineGlow.value.z).toBeCloseTo(LINE_GLOW_CORE_K, 12);
  });

  it('注入後のフラグメントで波括弧が釣り合う', () => {
    const material = new LineMaterial();
    installDepthWidth(material, 'test.key', { glow: true });
    const frag = compile(material).fragmentShader;
    expect((frag.match(/{/g) ?? []).length).toBe((frag.match(/}/g) ?? []).length);
  });

  it('glow を頼まなければフラグメントは一切触られない', () => {
    const material = new LineMaterial();
    const dw = installDepthWidth(material, 'test.key');
    expect(dw.glowInstalled).toBe(false);
    const out = compile(material);
    expect(out.fragmentShader).toBe(lineLib().fragmentShader);
    expect(out.uniforms.uLineGlow).toBeUndefined();
  });

  it('既知の罠 #19: グローの有無でキャッシュキーが分かれる(別プログラムだから)', () => {
    const plain = new LineMaterial();
    const width = new LineMaterial();
    const glow = new LineMaterial();
    installDepthWidth(width, 'k');
    installDepthWidth(glow, 'k', { glow: true });
    expect(width.customProgramCacheKey()).toBe('k');
    expect(glow.customProgramCacheKey()).toBe('k+glow');
    expect(glow.customProgramCacheKey()).not.toBe(width.customProgramCacheKey());
    expect(glow.customProgramCacheKey()).not.toBe(plain.customProgramCacheKey());
  });

  it('既知の罠 #11: フラグメントのアンカーだけ失っても線幅は生き残る', () => {
    const lib = lineLib();
    const saved = lib.fragmentShader;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      lib.fragmentShader = 'void main() { /* three が書き換えた世界 */ }';
      const material = new LineMaterial();
      const dw = installDepthWidth(material, 'test.key', { glow: true });
      expect(dw.installed).toBe(true);
      expect(dw.glowInstalled).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
      expect(() => dw.setGlow(2, 0.45)).not.toThrow();
    } finally {
      lib.fragmentShader = saved;
    }
  });

  it('setGlow が uniform の実体へ書く(負は 0 へ倒す)', () => {
    const material = new LineMaterial();
    const dw = installDepthWidth(material, 'test.key', { glow: true });
    const v = compile(material).uniforms.uLineGlow.value;
    dw.setGlow(2.5, 0.9);
    expect(v.y).toBe(2.5);
    expect(v.z).toBeCloseTo(0.9, 12);
    dw.setGlow(-1, 0.1);
    expect(v.y).toBe(0);
    // k=0 は芯が発散するので下限に張りつく
    expect(v.z).toBeCloseTo(LINE_GLOW_CORE_K, 12);
    // thickNorm 側は触られない
    expect(v.x).toBeCloseTo(LINE_GLOW_THICK_NORM, 12);
  });
});
