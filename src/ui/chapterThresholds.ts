import type { ChapterRole } from './content';

/**
 * 章の出し入れのしきい値と、その判定(Phase 34a)。
 *
 * DOM を一切見ない ── `overlays.ts` から切り出したのは 2 つの理由による。
 *
 * 1. **出側にヒステリシスが無かった**のを直すにあたって、境界の挙動を
 *    テストで固定したかった(`src/tests/chapterThresholds.test.ts`)。
 * 2. しきい値の所有者を 1 つにしたかった。踊り場(文字が退いてから次章の
 *    文字が立つまでの区間)の入口は `OUT_T` と同じ点から導かれるので、
 *    スクロール側と overlays 側で二重に持つと必ずずれる。
 *
 * `scrollGlide.ts` を `smoothScroll.ts` から、`narrativeMath.ts` を
 * `narrative.ts` から切り出したのと同じ理由づけである。
 */

/**
 * 入退場のヒステリシス幅(localT)。
 *
 * 入り側は最初からこの幅を持っていた ── `IN_T` 0.06 で出し、`BACK_T` 0.02 まで
 * 巻き戻すと引っ込める。**出側には無かった**: `OUT_T` の一点で入りも出も
 * 判定していたので、そこで数 px 揺れるだけで 1.29 秒の振り付けがフル再生された
 * (英字 9 文字 = (9−1)×24 + 1100 = 1292ms が支配項)。トラックパッドの
 * 微小 delta やスクロールバーの微調整では現実に起きる。
 *
 * 0.04 は章のスクラブ長 120svh に対して 4.8svh(800px 画面で 38px)。
 * 揺れ(数 px)の 10 倍以上あり、かつ読者が「戻したのに出ない」と感じる幅ではない。
 */
export const HYSTERESIS = 0.04;

/** 章に入ったと見なす localT */
export const IN_T = 0.06;
/** ここまで巻き戻すと引っ込める(= `IN_T` − `HYSTERESIS`) */
export const BACK_T = 0.02;

/** 章から出る localT */
export const OUT_T_CHAPTER = 0.86;
/** 出たあと、ここまで戻ってはじめて出直す(= `OUT_T_CHAPTER` − `HYSTERESIS`) */
export const BACK_OUT_T_CHAPTER = 0.82;

/** 序章はスクラブ長が 30svh しかないので早めに退く */
export const OUT_T_PROLOGUE = 0.72;
/** 同上の出直し(= `OUT_T_PROLOGUE` − `HYSTERESIS`) */
export const BACK_OUT_T_PROLOGUE = 0.68;

/**
 * エピローグは CTA を押せる状態のまま最後まで残す = 出ない。
 * localT は [0,1] に丸められるので、2 は「到達しない」と同義。
 */
export const OUT_T_NEVER = 2;

/** 1 つの章のしきい値一式 */
export interface ChapterThresholds {
  /** 出す(localT がこれ以上) */
  readonly inT: number;
  /** 引っ込める(localT がこれ未満)。序章は戻る先が無いので負値 */
  readonly backT: number;
  /** 引っ込める(localT がこれを超える) */
  readonly outT: number;
  /** 出直す上限。`outT` を超えたあとは、ここまで戻らないと出直さない */
  readonly backOutT: number;
}

/**
 * 役割ごとのしきい値。**オブジェクトを作るので構築時にだけ呼ぶこと**
 * (毎フレームの判定は `chapterMove` が数だけを受け取る)。
 */
export function thresholdsFor(role: ChapterRole): ChapterThresholds {
  switch (role) {
    case 'prologue':
      // ページ最上部(localT = 0)で読めていなければならないので入りの敷居は 0。
      // 巻き戻しでは消さない ── 戻る先がない
      return { inT: 0, backT: -1, outT: OUT_T_PROLOGUE, backOutT: BACK_OUT_T_PROLOGUE };
    case 'epilogue':
      return { inT: IN_T, backT: BACK_T, outT: OUT_T_NEVER, backOutT: OUT_T_NEVER };
    default:
      return { inT: IN_T, backT: BACK_T, outT: OUT_T_CHAPTER, backOutT: BACK_OUT_T_CHAPTER };
  }
}

/** 判定の結果。1 = 出す / −1 = 引っ込める / 0 = そのまま */
export type ChapterMove = 1 | -1 | 0;

/**
 * 毎フレームの判定。**入るのは数だけ**で、DOM も時計も見ない。
 *
 * 伏せているときの上限が `outT` ではなく `backOutT` であることが
 * 出側のヒステリシスそのもの。副作用として、`backOutT` と `outT` の
 * あいだ(章のスクラブ長の 4%)へ**跳んで**着地したときは伏せたままになる
 * ── 連続にスクロールしている限り、そこへは必ずどちらかの側から入るので
 * 到達しない。跳ぶのは履歴復元と `scrollTo` だけである。
 *
 * @param shown いま出ているか(Revealing / Shown なら true)
 * @param t     その章の localT ∈ [0,1]
 */
export function chapterMove(
  shown: boolean,
  t: number,
  inT: number,
  backT: number,
  outT: number,
  backOutT: number,
): ChapterMove {
  if (!shown) return t >= inT && t <= backOutT ? 1 : 0;
  return t > outT || t < backT ? -1 : 0;
}
