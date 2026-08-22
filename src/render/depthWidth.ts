import type { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import * as THREE from 'three';

import {
  GLOW_FRAG_ANCHOR,
  GLOW_FRAG_BODY,
  GLOW_FRAG_DECL,
  GLOW_VERT_BODY,
  GLOW_VERT_DECL,
  LINE_GLOW_CORE_K,
  LINE_GLOW_INTENSITY,
  LINE_GLOW_THICK_NORM,
} from './lineGlow';

/**
 * 深度で線幅を振る(Phase 35 / 提案 A1)。
 *
 * **Phase 36 でフラグメント側の注入(線そのもののグロー)も引き受けた。**
 * 理由は設計ではなく制約で、`onBeforeCompile` はマテリアルに 1 つしか置けない ──
 * 持ち主を 2 つにすると、後から書いたほうが前の注入を黙って消す。式と定数は
 * `lineGlow.ts` にあり、ここは**注入の唯一の窓口**という役だけを持つ。
 *
 * この作品の図は、深度を **色でしか語っていなかった** ── `depthLut` が色相と明度を
 * 動かす一方、線幅は全部同じだった。製図では手前の線を太く、奥の線を細く引く。
 * それが無い線画は「ワイヤーフレーム」に見え、あると「図版」に見える。
 *
 * ## 深度は「色と同じ量」で測る ── ここが設計の要
 *
 * 素直に書くならカメラからの視距離(`clipStart.w`)を使いたくなる。物理的にはそちらが
 * 正しい空気遠近だが、**この作品では間違いになる**。色の深度キューは投影後の
 * ローカル z(`instanceStart.z`)を `depthScale` で正規化した量で、これは図に固定された軸である。
 * 一方カメラは公転する ── アイドルドリフトと、読者のドラッグによる見回し(Phase 16)。
 * 視距離で幅を振ると、**ドラッグのあいだ「太い側」だけがカメラを追い、「明るい側」は
 * 図に貼りついたまま**になり、ひとつの深度が二つの方向を指す。
 *
 * したがって幅は色とまったく同じ式を通す:
 *
 *   t01   = clamp01((z · depthScale + 1) / 2)      ← lutIndexOf と同一
 *   scale = 1 + amount · (2·t01 − 1)               ← t01=1(手前)で 1+amount
 *
 * 深度キューはひとつ。表れる先が色と幅の二つになる、というだけになる。
 *
 * ## なぜ uniform ひとつ(vec2)なのか
 *
 * depthScale と amount はいつも一緒に意味を持つ。`depthScale` は CPU 側が毎フレーム
 * `depthScaleFor(dimLevel)` で作っている値そのものなので、**新しい測定は何も要らない**。
 *
 * ## 既知の罠 #11 と #19
 *
 * ・#11: three のシェーダー文字列が変わればアンカーを失う。組み込み前に実物の
 *   `ShaderLib['line']` を検証し、無ければ警告して**何もしない**(線幅は現行のまま)。
 * ・#19: three は `onBeforeCompile` を**プログラムキャッシュキーに含めない**
 *   (`WebGLPrograms.getProgramCacheKey` が見るのは `customProgramCacheKey()` だけ)。
 *   鍵を分けないと、注入したマテリアルと素の LineMaterial が**同じプログラムを共有**し、
 *   どちらが先にコンパイルされたかで結果が変わる。
 */

/** 振れ幅(±20% = 0.80〜1.20 倍)。これ以上は「遠近」ではなく「別の太さの線」になる */
export const DEPTH_WIDTH_AMOUNT = 0.2;

/** 頂点シェーダーの置換アンカー(three r185 の実物から採取。単一箇所) */
const ANCHOR = 'offset *= linewidth;';

const INJECT_UNIFORM = /* glsl */ `uniform vec2 uDepthWidth;
void main() {`;

/** グロー同梱版。宣言をまとめて 1 回の置換で入れる(置換は先頭 1 箇所しか当たらない) */
const INJECT_UNIFORM_GLOW = /* glsl */ `uniform vec2 uDepthWidth;
${GLOW_VERT_DECL}
void main() {`;

/**
 * uDepthWidth = (depthScale, amount)。
 * `instanceStart` / `instanceEnd` は投影後の 3D 座標そのもの(LineBatch の契約)なので、
 * その z は CPU 側の `depthLut` が引くのとまったく同じ値になる。
 */
const INJECT_BODY = /* glsl */ `float dimZ = ( position.y < 0.5 ) ? instanceStart.z : instanceEnd.z;
				float dimT = clamp( ( dimZ * uDepthWidth.x + 1.0 ) * 0.5, 0.0, 1.0 );
				offset *= linewidth * ( 1.0 + uDepthWidth.y * ( 2.0 * dimT - 1.0 ) );`;

/**
 * 幅の倍率(純関数 / テスト用)。シェーダーの式と**同じ順序**で書いてある。
 * `z` は投影後のローカル z、`depthScale` は `depthScaleFor(dimLevel)` の値。
 */
export function depthWidthScale(z: number, depthScale: number, amount: number): number {
  const raw = (z * depthScale + 1) * 0.5;
  // NaN は「振らない」側へ倒す(比較で false になる並びに書く)
  const t01 = raw > 0 ? (raw < 1 ? raw : 1) : 0;
  return 1 + amount * (2 * t01 - 1);
}

export interface DepthWidth {
  /** 注入に成功したか。false のとき setDepthScale / setAmount は無害な no-op */
  readonly installed: boolean;
  /**
   * グロー(Phase 36)まで注入できたか。
   * `installed` が true でもこちらは false になりうる ── フラグメント側の
   * アンカーだけが three の更新で消えた場合、線幅だけを生かして退く。
   */
  readonly glowInstalled: boolean;
  /** 深度の正規化係数。色の LUT が使うのと**同じ値**を渡すこと */
  setDepthScale(depthScale: number): void;
  /** 振れ幅(0 で完全に恒等)。品質ティアや reduced-motion から落とす口 */
  setAmount(amount: number): void;
  /**
   * 場の強さと芯の鋭さ。**いつも組で意味を持つ**ので 1 本の口にしてある ──
   * k を上げると芯も暈も下がり、暈のぶんは強度で戻す関係にあるため
   * (lineGlow.ts の `glowIntensityFor`)、片方だけ書くと必ず釣り合いが崩れる。
   */
  setGlow(intensity: number, coreK: number): void;
}

export interface InstallOptions {
  /** 深度による線幅の振れ幅 */
  readonly amount?: number;
  /** 線そのもののグロー(Phase 36)を入れるか */
  readonly glow?: boolean;
  /** グローの初期強度 */
  readonly glowIntensity?: number;
}

/**
 * 何もしない実装。呼び出し側のフィールド初期化にも使う ── 同じ形を 2 箇所へ
 * 手で書くと、インターフェースが増えたとき片方だけが古くなる。
 */
export const DEPTH_WIDTH_NOOP: DepthWidth = {
  installed: false,
  glowInstalled: false,
  setDepthScale(): void {},
  setAmount(): void {},
  setGlow(): void {},
};

/**
 * LineMaterial へ深度線幅を組み込む。マテリアル 1 本につき 1 回だけ呼ぶこと。
 * 以後は uniform 1 本の書き込みだけで済む(毎フレームのアロケーションはゼロ)。
 */
export function installDepthWidth(
  material: LineMaterial,
  cacheKey: string,
  options: InstallOptions = {},
): DepthWidth {
  const amount = options.amount ?? DEPTH_WIDTH_AMOUNT;
  const lib = (THREE.ShaderLib as Record<string, { vertexShader?: string; fragmentShader?: string }>)[
    'line'
  ];
  const source = lib?.vertexShader;
  const ok =
    typeof source === 'string' && source.includes(ANCHOR) && source.includes('void main() {');

  if (!ok) {
    console.warn(
      '[depthWidth] three のシェーダー更新により置換アンカーが見つからないため ' +
        '深度線幅を無効にします(線幅は現行の固定値のまま / three のバージョン pin を確認すること)',
    );
    return DEPTH_WIDTH_NOOP;
  }

  /*
    グローは**別に検証する**。フラグメント側のアンカーだけが消えることはありうるし、
    そのとき線幅まで道連れにする理由はない。片方だけ退けるようにしておく。
  */
  const fragSource = lib?.fragmentShader;
  const glowWanted = options.glow === true;
  const glowOk =
    glowWanted &&
    typeof fragSource === 'string' &&
    fragSource.includes(GLOW_FRAG_ANCHOR) &&
    fragSource.includes('void main() {');

  if (glowWanted && !glowOk) {
    console.warn(
      '[depthWidth] three のシェーダー更新によりフラグメント側のアンカーが見つからないため ' +
        '線グロー(Phase 36)を無効にします(線は平坦な帯のまま / linewidth は器の幅なので ' +
        '呼び出し側は見かけの太さを戻すこと)',
    );
  }

  const uniform: THREE.IUniform<THREE.Vector2> = { value: new THREE.Vector2(1, amount) };
  const glowUniform: THREE.IUniform<THREE.Vector3> = {
    value: new THREE.Vector3(
      LINE_GLOW_THICK_NORM,
      options.glowIntensity ?? LINE_GLOW_INTENSITY,
      LINE_GLOW_CORE_K,
    ),
  };

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDepthWidth = uniform;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', glowOk ? INJECT_UNIFORM_GLOW : INJECT_UNIFORM)
      .replace(ANCHOR, glowOk ? `${GLOW_VERT_BODY}\n\t\t\t\t${INJECT_BODY}` : INJECT_BODY);

    if (!glowOk) return;
    shader.uniforms.uLineGlow = glowUniform;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${GLOW_FRAG_DECL}\nvoid main() {`)
      .replace(GLOW_FRAG_ANCHOR, GLOW_FRAG_BODY);
  };
  /*
    既知の罠 #19: 鍵を分けないと素の LineMaterial とプログラムを共有してしまう。
    グローの有無でも**別のプログラムになる**ので、鍵にも載せる。
  */
  material.customProgramCacheKey = () => (glowOk ? `${cacheKey}+glow` : cacheKey);

  const value = uniform.value;
  const glowValue = glowUniform.value;
  return {
    installed: true,
    glowInstalled: glowOk,
    setDepthScale(depthScale: number): void {
      value.x = depthScale;
    },
    setAmount(next: number): void {
      value.y = next > 0 ? next : 0;
    },
    setGlow(intensity: number, coreK: number): void {
      glowValue.y = intensity > 0 ? intensity : 0;
      // k=0 は芯が発散するので、下限は Strands の値に張る
      glowValue.z = coreK > LINE_GLOW_CORE_K ? coreK : LINE_GLOW_CORE_K;
    },
  };
}
