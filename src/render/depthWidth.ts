import type { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import * as THREE from 'three';

/**
 * 深度で線幅を振る(Phase 35 / 提案 A1)。
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
  /** 深度の正規化係数。色の LUT が使うのと**同じ値**を渡すこと */
  setDepthScale(depthScale: number): void;
  /** 振れ幅(0 で完全に恒等)。品質ティアや reduced-motion から落とす口 */
  setAmount(amount: number): void;
}

/**
 * 何もしない実装。呼び出し側のフィールド初期化にも使う ── 同じ形を 2 箇所へ
 * 手で書くと、インターフェースが増えたとき片方だけが古くなる。
 */
export const DEPTH_WIDTH_NOOP: DepthWidth = {
  installed: false,
  setDepthScale(): void {},
  setAmount(): void {},
};

/**
 * LineMaterial へ深度線幅を組み込む。マテリアル 1 本につき 1 回だけ呼ぶこと。
 * 以後は uniform 1 本の書き込みだけで済む(毎フレームのアロケーションはゼロ)。
 */
export function installDepthWidth(
  material: LineMaterial,
  cacheKey: string,
  amount = DEPTH_WIDTH_AMOUNT,
): DepthWidth {
  const source = (THREE.ShaderLib as Record<string, { vertexShader?: string }>)['line']
    ?.vertexShader;
  const ok =
    typeof source === 'string' && source.includes(ANCHOR) && source.includes('void main() {');

  if (!ok) {
    console.warn(
      '[depthWidth] three のシェーダー更新により置換アンカーが見つからないため ' +
        '深度線幅を無効にします(線幅は現行の固定値のまま / three のバージョン pin を確認すること)',
    );
    return DEPTH_WIDTH_NOOP;
  }

  const uniform: THREE.IUniform<THREE.Vector2> = { value: new THREE.Vector2(1, amount) };

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDepthWidth = uniform;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', INJECT_UNIFORM)
      .replace(ANCHOR, INJECT_BODY);
  };
  // 既知の罠 #19: 鍵を分けないと素の LineMaterial とプログラムを共有してしまう
  material.customProgramCacheKey = () => cacheKey;

  const value = uniform.value;
  return {
    installed: true,
    setDepthScale(depthScale: number): void {
      value.x = depthScale;
    },
    setAmount(next: number): void {
      value.y = next > 0 ? next : 0;
    },
  };
}
