import * as THREE from 'three';
import { clamp01 } from '../math/ease';

/**
 * 配色定数と IQ コサインパレット。
 *
 * 色空間について: three の ColorManagement が有効なので `new THREE.Color(hex)` は
 * 16 進の sRGB 値を **リニア作業色空間** へ変換して保持する。シーン内の色は
 * すべてリニア値であり、sRGB へ戻すのは postfx チェーン末尾の OutputPass。
 * したがって cosinePalette もリニア値を書き出す(下の係数はリニア空間で調律してある)。
 */

// --- プラン5節の配色(sRGB 16進) -------------------------------------------------

export const BG_HEX = 0x05060f;
export const CYAN_HEX = 0x4fd8ff;
export const MAGENTA_HEX = 0xff4fd8;
export const VIOLET_HEX = 0x9d6bff;
export const GOLD_HEX = 0xffd24f;

/** 16 進値のまとめ(UI や uniform の初期化用) */
export const PALETTE_HEX = {
  bg: BG_HEX,
  cyan: CYAN_HEX,
  magenta: MAGENTA_HEX,
  violet: VIOLET_HEX,
  gold: GOLD_HEX,
} as const;

// --- 同じ色の THREE.Color インスタンス(リニア値) ---------------------------------
// 共有インスタンスなので呼び出し側で mutate しないこと(必要なら .copy() で複製する)。

export const BG = new THREE.Color(BG_HEX);
export const CYAN = new THREE.Color(CYAN_HEX);
export const MAGENTA = new THREE.Color(MAGENTA_HEX);
export const VIOLET = new THREE.Color(VIOLET_HEX);
export const GOLD = new THREE.Color(GOLD_HEX);

export const PALETTE = {
  bg: BG,
  cyan: CYAN,
  magenta: MAGENTA,
  violet: VIOLET,
  gold: GOLD,
} as const;

// --- IQ コサインパレット -----------------------------------------------------------

const TAU = Math.PI * 2;

/**
 * Inigo Quilez のコサインパレット `color(t) = a + b·cos(2π(c·t + d))`。
 *
 * 係数はサイトの配色圏(深い青 → シアン → バイオレット → マゼンタ)から出ないよう
 * 調律してある。フルレインボーにはしない ─ 高次元の「深さ」を表す色は、作品全体の
 * トーンと衝突しないことが条件だから。
 *
 * 実測(t を 0.15→0.85 で走査し、リニア値を sRGB へエンコードしたもの):
 *   0.15 #2790d4(深い青) / 0.33 #5dd8f5(シアン ≒ #4fd8ff)
 *   0.50 #9f98ff(バイオレット) / 0.85 #fc41ca(マゼンタ ≒ #ff4fd8)
 *
 * ・R: 半周期ぶんの単調増加(深青 0.02 → マゼンタ 0.97)
 * ・G: t≈0.33 にピークを持つ山(シアンの緑成分 0.69 に一致)。周期は
 *      「t=0.85 でも低いまま」を満たす値を選んである
 * ・B: t≈0.48 を頂点とする緩やかな山(シアン〜バイオレットで最大)
 */
const PAL_A_R = 0.62;
const PAL_A_G = 0.24;
const PAL_A_B = 0.53;
const PAL_B_R = 0.6;
const PAL_B_G = 0.45;
const PAL_B_B = 0.47;
const PAL_C_R = 0.5;
const PAL_C_G = 1.31;
const PAL_C_B = 0.62;
const PAL_D_R = 0.425;
const PAL_D_G = -0.432;
const PAL_D_B = -0.298;

/**
 * パレットを評価して `target` へ書き込む(アロケーションなし・target を返す)。
 * 実用域は t ∈ [0.15, 0.85]。範囲外でも結果は 0..1 にクランプされる。
 */
export function cosinePalette(t: number, target: THREE.Color): THREE.Color {
  target.r = clamp01(PAL_A_R + PAL_B_R * Math.cos(TAU * (PAL_C_R * t + PAL_D_R)));
  target.g = clamp01(PAL_A_G + PAL_B_G * Math.cos(TAU * (PAL_C_G * t + PAL_D_G)));
  target.b = clamp01(PAL_A_B + PAL_B_B * Math.cos(TAU * (PAL_C_B * t + PAL_D_B)));
  return target;
}
