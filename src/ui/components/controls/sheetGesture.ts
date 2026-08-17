/**
 * sheetGesture — ボトムシートの掃きとホイールを「意図」へ翻訳する(Phase 26)。
 *
 * **DOM を一切見ない。** `scrollGlide.ts` と同じ流儀 ── 体感を決める場所は
 * テストで固定できる形に切り出しておく(`src/tests/sheetGesture.test.ts`)。
 *
 * 翻訳先が `'open' | 'close'` の**絶対の意図**であって、トグルではないことが要。
 * 開いているシートを上へ掃いたときに閉じるのは間違いで、そういう作りにすると
 * 「開こうとして閉じる」が必ず起きる。呼び出し側は意図をそのまま
 * `setCollapsed()` へ渡し、同じ状態への再適用は向こうで無音になる。
 */

/** 掃き / ホイールの行き先。`tap` は「ジェスチャではない」の意 */
export type SheetIntent = 'open' | 'close' | 'tap';

/**
 * 掃いたと認める最小の縦移動(px)。
 *
 * キャンバスのタップ判定(`TAP_MOVE_PX = 8`, core/gallery.ts)より十分大きく取る ──
 * あちらは「動いていない」ことの判定で、こちらは「意図して動かした」ことの判定なので
 * 求める確信の度合いが違う。56px の帯の上で 24px は指の 1 節ぶん。
 */
export const SWIPE_MIN_PX = 24;

/**
 * ホイールを意図と認める最小量(**正規化済みの** px)。
 *
 * 素の `WheelEvent.deltaY` に閾値を当ててはいけない ── px なのは
 * `deltaMode === 0` のときだけで、Firefox は行単位(deltaY = 3)を返す。
 * 呼び出し側は core/scrollGlide.ts の `normalizeWheel` を通してから渡す。
 */
export const WHEEL_MIN_PX = 6;

/**
 * つまみ帯の掃きを意図へ。判定は**終値だけ**で行う(途中の軌跡は見ない)。
 *
 * 横優勢を弾くのは、タブ帯を横へ送った指が行き過ぎて帯に乗る筋があるため。
 * 同値(`|dx| === |dy|`)も弾く ── どちらとも言えないものは動かさない方が正しい。
 */
export const decideSwipe = (dx: number, dy: number): SheetIntent => {
  const up = Math.abs(dy);
  if (up < SWIPE_MIN_PX) return 'tap';
  if (Math.abs(dx) >= up) return 'tap';
  return dy < 0 ? 'open' : 'close';
};

/**
 * ホイールを意図へ。**`deltaY > 0`(その人にとっての「下へ」)が開く側**。
 *
 * 符号は OS の natural scrolling 設定を通した後の値なので、「その人が
 * 下へ送るつもりで出した向き」に一致する。下へ送る = 画面の下にあるものを
 * 迎えに行く = 下端のシートが上がってくる。smoothScroll も `deltaY > 0` を
 * 「下へ」として扱っており(core/smoothScroll.ts)、作品内で符号の意味が割れない。
 *
 * **満たせない一点**: natural scrolling を切っている環境では、トラックパッドの
 * 物理的な上向き 2 本指が `deltaY < 0` になり、タッチの上スワイプと逆の意図になる。
 * OS 設定は JS から読めないので、ここは直せない(SPEC §7 に残してある)。
 */
export const decideWheel = (normalizedDeltaY: number): SheetIntent => {
  if (Math.abs(normalizedDeltaY) < WHEEL_MIN_PX) return 'tap';
  return normalizedDeltaY > 0 ? 'open' : 'close';
};
