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
