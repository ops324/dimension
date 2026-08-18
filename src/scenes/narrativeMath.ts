/**
 * 物語シーンの「調律できる数式」だけを集めた純関数モジュール。
 *
 * なぜ narrative.ts から出すのか: あちらは three.js と WebGL のバッファに触るので
 * vitest から素直に読めない。**体感を決めている式が試験に載らない**のは、この作品で
 * いちばん壊れてはいけない性質(スクロールで巻き戻せること・次元ごとに何が起きるか)が
 * 人間の記憶だけで守られている状態を意味する。ゲートの立ち上がり・前線の形・
 * ドリーズームの保存量は、ここで閉じた形にして試験で縛る。
 *
 * 規約: この中の関数はすべて **副作用なし・アロケーションなし**(出力配列は呼び出し側
 * が渡す)。DOM も three も import しない。
 */

import { clamp01, smoothstep } from '../math/ease';

/* ------------------------------------------------------------------ 軌道環(Phase 27)

   等傾二重回転が開くのと同じ場所で立ち上がり、図が密になる前に引く。

   立ち上がりを残響(§5.5)と同じ 3.5 に揃えるのは筋書きの都合ではない ──
   どちらも「追えない運動が始まった」という同じ事実に紐づいており、その事実は
   SCHEDULE の gate 3(角速度が 3.0 → 3.8 で立ち上がる)ただ 1 つが決めている。

   引く側は Phase 23b の実測に従う。ゴーストだけを隔離した点灯面積の増分は
   4D で +21.3% に対し 6D では +3.8% だった ── 疎な図ではコピーが空いた場所へ落ち、
   密な図では埋もれる。軌道環も同じで、192 本が重なる 5D/6D では輪が図に沈む。
   さらに (2,4)(0,5) が開くと「等傾ペアだけが回り続けたら」という前提そのものが
   弱くなる。**見えなくなる場所と、嘘になりはじめる場所が一致している**ので、
   そこで消すのが正しい。 */

export const ORBIT_GATE = 3.5;
export const ORBIT_GATE_WIDTH = 0.5;
export const ORBIT_FADE_START = 4.7;
export const ORBIT_FADE_WIDTH = 1;

/**
 * 軌道環の強さ ∈ [0,1]。3.5 → 4.0 で開き、4.7 → 5.7 で閉じる。
 * 4D のプラトー(dimLevel = 4.0)では開き切っている。
 */
export function orbitAmount(dimLevel: number): number {
  const open = smoothstep((dimLevel - ORBIT_GATE) / ORBIT_GATE_WIDTH);
  const close = 1 - smoothstep((dimLevel - ORBIT_FADE_START) / ORBIT_FADE_WIDTH);
  return clamp01(open * close);
}

/* ------------------------------------------------------------------ 波面(Phase 28)

   誕生フラッシュ `4e(1−e)` は「この軸がいま生まれつつある」を伝えるが、辺ぜんたいを
   一様にゴールドへ寄せるので **どちらからどちらへ生まれたのか**は言っていない。

   包絡はそのまま、位置の情報だけを足す:

     mix(u) = 4e(1−e) · ( BASE + (1 − BASE)·exp(−((u − e)/σ)²) )

   u は新しい軸に沿う正規化座標 ∈ [0,1]、e はその軸の伸長率。前線の位置は **e より
   LEAD 倍だけ先** ── ちょうど e にすると、光が向こう側のコピーへ着くのは e=1、つまり
   包絡が 0 になる瞬間になり、到達が誰にも見えない。1.25 倍先行させると e=0.8 で着地し、
   残り 2 割のあいだ「新しい壁の上で消えていく光」が見える。独立した時間軸は持たせない
   のが要点で(位置は e の純関数)、スクロールを戻せば前線も戻る。

   **この表を掛けるのは「生まれる軸に沿う辺」だけ**(narrative.ts の scatterSegments)。
   ここを間違えると図ぜんたいが金色へ寄る ── 実測で 2 つのコピー(160 辺)にも下駄が乗り、
   ゴールド総量が約 2.3 倍になっていた。前線は新しい軸の上だけを走る。

   **ゴールドの総量は必ず減る。** 一様だったものをガウスへ寄せるので、辺に沿った積分は
   BASE + (1−BASE)·σ√π ≒ 0.57 倍。既知の罠 #6(加算エネルギーの収支)に対して安全側にしか
   動かない ── 新しい光を足したのではなく、同じ光を**一点へ集めた**。

   e → 0 と e → 1 で包絡が 0 になるので、プラトーでは何も起きない(連続に消える)。
   到達の瞬間に弾けさせたくなるが、それは e の純関数では書けない ── 「到達してから n 秒」は
   履歴依存であり、巻き戻せることの契約(§2.1)を破る。光は向こう側のコピーへ吸い込まれて
   消える、という読みを選んだ。

   **exp を内側ループから消す。** u は離散である ── 軸 k に沿う辺では u = s/SUBDIV の
   SUBDIV+1 通り、それ以外の辺では u は 0 か 1 の定数(辺の k 座標の符号で決まる)。
   毎フレーム表を 1 本作れば、3264 点の内側は添字参照だけになる。 */

/** 前線のガウス幅(u 単位)。これ以上広げると「流れる光」になり装飾へ堕ちる */
export const FRONT_SIGMA = 0.19;
/** 前線から離れた場所へ残す下駄。0 にすると辺の存在そのものが読めなくなる */
export const FRONT_BASE = 0.35;
/** 前線の先行。1 だと到達が包絡 0 と同時になり、着地が見えない */
export const FRONT_LEAD = 1.25;
/**
 * 前線の芯へ戻す明るさ(倍率 = 1 + BOOST·env·g)。
 *
 * 再配分だけでは前線が読めなかった ── 実測でゴールドの総量は旧実装の **0.30 倍**まで
 * 落ちており、予算が余っている。余ったぶんを「一様に散らし直す」のではなく**芯へ戻す**
 * のがこの機能の趣旨なので、ガウスの山にだけ掛ける。0.9 でも総量は旧実装を超えない。
 */
export const FRONT_BOOST = 0.9;

/**
 * 誕生フラッシュの包絡 `4e(1−e)`。e=0.5 で 1、e=0 と e=1 で 0。
 * (この式は Phase 2 から figure の彩色に入っていたもので、値は変えていない)
 */
export function birthEnvelope(extent: number): number {
  const e = clamp01(extent);
  return 4 * e * (1 - e);
}

/** 前線の位置 ∈ [0,1](ガウスの山が立つ u)。試験と実装で 1 つの式を共有する */
export function frontPosition(extent: number, lead = FRONT_LEAD): number {
  return clamp01(clamp01(extent) * lead);
}

/**
 * 波面の表を 2 本作る。u = s/subdiv における
 *   `mix[s]`   … ゴールドへの混色比 ∈ [0,1]
 *   `boost[s]` … 芯へ戻す明るさの倍率 ≥ 1
 *
 * どちらも長さ subdiv+1 以上であること。アロケーションはしない ──
 * **exp はここで subdiv+1 回だけ**評価され、3264 点の内側ループは添字参照になる。
 */
export function buildFrontTables(
  mix: Float64Array,
  boost: Float64Array,
  extent: number,
  subdiv: number,
): void {
  const env = birthEnvelope(extent);
  const n = subdiv + 1;
  if (env <= 0) {
    for (let s = 0; s < n; s++) {
      mix[s] = 0;
      boost[s] = 1;
    }
    return;
  }
  const pos = frontPosition(extent);
  const inv = 1 / (subdiv * FRONT_SIGMA);
  const shift = pos / FRONT_SIGMA;
  for (let s = 0; s < n; s++) {
    const d = s * inv - shift;
    const g = Math.exp(-d * d);
    mix[s] = env * (FRONT_BASE + (1 - FRONT_BASE) * g);
    boost[s] = 1 + FRONT_BOOST * env * g;
  }
}

/* --------------------------------------------------------------- めまい(Phase 29)

   章のカメラは位置と画角を smoothstep で混ぜている。移動は上品だが、「次元が増えた」と
   いう**身体の感覚**がない ── ただ寄るだけなら、図が大きくなるだけだ。

   ドリーズーム(ヒッチコックが『めまい』で撮った方法)は、**被写体の画面上の大きさを
   保ったまま**距離と画角を交換する。保存量は

     size ∝ 2·d·tan(fov/2)

   なので、半径を m 倍したら tan(fov/2) を 1/m 倍すればよい。図は 1 ミリも動かないのに、
   背後の星と図の内部の透視だけが伸びる。

   **駆動は章ではなく「軸が生まれている最中か」。** 包絡は誕生フラッシュと同じ `4e(1−e)` を
   使う ── これで prologue と epilogue(次元が動かない章)では何も起きず、しかも dimLevel の
   純関数なので巻き戻しでも同じ絵になる(§2.1)。章番号で駆動すると、この 2 つがどちらも
   壊れる。

   0.15 は fov 50° に対して約 +7°。`prefers-reduced-motion` では完全に停止する。 */

/** ドリーズームの深さ。1 章あたり fov ±9° を上限とみて選んだ値 */
export const VERTIGO_AMOUNT = 0.15;

/** 半径に掛ける倍率 ∈ (0,1]。誕生の最中だけ 1 を下回る */
export function vertigoScale(extent: number, amount = VERTIGO_AMOUNT): number {
  return 1 - amount * birthEnvelope(extent);
}

/**
 * 半径を `scale` 倍したときに **画面上の大きさを保つ** 画角(度)。
 * `2·d·tan(fov/2)` が不変になるよう tan(fov/2) を 1/scale 倍する。
 */
export function fovForDollyZoom(fovDeg: number, scale: number): number {
  if (!(scale > 0) || scale === 1) return fovDeg;
  const half = (fovDeg * Math.PI) / 360;
  return (2 * Math.atan(Math.tan(half) / scale) * 180) / Math.PI;
}

/* --------------------------------------------------------------- 重力場(Phase 30)

   カーソルの下では時空が歪む(§4.7)。読者の指には重力があるのに、図そのものには
   無かった ── 第五章から、図の周囲で星野が曲がりはじめる。

   立ち上がりを 4.6 に置くのは、第五の軸が伸び切る(dimLevel 5)より**手前**から
   気配を出すため。5.8 で開き切り、第六章では最大のまま動かない ── 「次元が増えるほど
   空間が曲がる」という一行の宣言なので、上限は最後の章に置く。 */

export const LENS_GATE = 4.6;
export const LENS_GATE_WIDTH = 1.2;

/** 重力場の強さ ∈ [0,1]。4.6 → 5.8 で開き、以後は最大のまま */
export function lensAmount(dimLevel: number): number {
  return clamp01((dimLevel - LENS_GATE) / LENS_GATE_WIDTH);
}

/* ----------------------------------------------------------------- 足場(Phase 31)

   残響は「時間の過去」を見せる。足場は **「次元の過去」** ── つねに `dim − 1` の姿を、
   同じ姿勢・同じ回転のまま薄く置き去りにする。作品の題は「次元の階段」なのに、
   画面に居るのは常にいまの次元だけで、降りてきた段が一つも残っていなかった。

   1.6 から開くのは、0 次元の点を 1 次元の線に重ねても何も言わないから。
   6 次元では 192 本に 192 本が重なるので、輝度を次元とともに落とす(下記の密度係数)。 */

export const SCAFFOLD_GATE = 1.6;
export const SCAFFOLD_GATE_WIDTH = 0.4;

/** 足場の強さ ∈ [0,1] */
export function scaffoldAmount(dimLevel: number): number {
  return smoothstep((dimLevel - SCAFFOLD_GATE) / SCAFFOLD_GATE_WIDTH);
}

/**
 * 密度による減光。足場の姿(dim − 1)が持つ辺の数は次元とともに増えるので、
 * そのままだと 6 次元で図が二重の藪になる。0.62^(dim−1−2.5) で薄くしていく。
 */
export function scaffoldDensityFade(dimLevel: number): number {
  return Math.pow(0.62, Math.max(0, dimLevel - 1 - 2.5));
}
