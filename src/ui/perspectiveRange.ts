/**
 * PERSPECTIVE 展示の「取りうる (m, n, モード)」の唯一の定義(Phase 42)。
 *
 * **なぜ展示ファイルから出したか。** 二つ理由がある。
 *
 * ① `src/tests/content.test.ts` は「到達しうる全組に専用の一文がある」を主張して
 *    いるが、走査範囲は `const OBSERVERS = [2,3,4]` という**手で写した定数**だった。
 *    写しは写し元が動いた瞬間に嘘になる ── OBSERVER の上限を上げても、テストは
 *    古い 12 組を見たまま緑で通る。**走査範囲は実装から導出しなければならない**。
 * ② そのために展示ファイルから import しようとすると、`perspectiveExhibit.ts` が
 *    three を引くのでテスト(node 環境・jsdom なし)へ持ち込めない。範囲と規則だけを
 *    **DOM も three も知らない純モジュール**へ置けば、両方から同じものを見られる。
 *
 * ここが持つのは範囲と規則だけで、描画も DOM も知らない。
 */

/** 観測者の次元 m の範囲。**m=1 は入っていない**(理由は下記) */
export const OBSERVER_MIN = 2;
export const OBSERVER_MAX = 5;
/** 対象の次元 n の範囲 */
export const TARGET_MIN = 2;
export const TARGET_MAX = 6;

/**
 * X線俯瞰(m > n)が成立する対象の次元の上限。
 *
 * X線俯瞰は一般の数学ではなく**演出された場面**で見せている(家・部屋・住人・宝物)。
 * 用意してある場面は平面の家(n=2)と 3D の家(n=3)の 2 つだけなので、
 * n=4 以上の「見下ろされる世界」は**存在しない**。
 *
 * ここを緩めると `buildXrayScene` の `n <= 2 ? 平面の家 : 3D の家` が
 * n=4 でも n=5 でも 3D の家を出す ── 副題が「五次元の目で四次元の世界を」と
 * 言いながら画面には三次元の家が出る。**罠 #22(操作子が黙って無視される)の再発**。
 */
export const XRAY_TARGET_MAX = 3;

export type PerspectiveMode = 'slice' | 'shadow' | 'xray';

/**
 * m=1(線の住人)を範囲へ入れない理由。
 *
 * Phase 7/8 のコメントは「HUD 表現のストレッチ」と書いていたが、独立監査が実物で
 * 確かめたところ**破綻するのは表現ではなく数学と描画の側**だった:
 *
 *   ① 正軸体は m=1 で**線分 0 本**になる。`faceCountOfDim` は j+1 > n を 0 で返すので
 *      n-面が存在せず、`makeFlatSliceGeometry` の combinations(n, n+1) が空になる
 *   ② `buildSlice` の非カスケード経路は dim ≥ 2 前提で、dim=1 では
 *      `src[a+1]` が**もう一方の端点**を、`src[a+dim+1]` が未使用領域を指す
 *   ③ n=2 と組ませると `pickPlanes(2)` が張る平面 (0,2)/(1,2) に対し `rotateBatch` が
 *      `dst[o+2]`(o = v·2)へ書く = **隣の頂点の第 0 座標を潰す**
 *   ④ `projectPerspective` は n ≥ 3 前提で、n=2 ではモジュール共有の SCRATCH に
 *      前回の呼び出しの z が残ったまま出力される
 *
 * そのうえで、出る絵は**線分 1 本**(cube n=4 の実測で最大 1 本・3 割の時間は空)。
 * 開けるなら 4 箇所の実装と、1 本の線をどう展示にするかという演出の設計が要る。
 */
export const OBSERVER_EXCLUDED = 1;

/**
 * (m, n) が到達しうる組か。**この 1 本が UI・テスト・rebuild の共通の判定**。
 *
 * 規則は 2 つだけ:
 *   ・m ≠ n(同じ次元の観測者と対象は「見る」関係にならない)
 *   ・m > n(見下ろす)なら n ≤ XRAY_TARGET_MAX(演出された場面がある範囲)
 */
export function isReachable(m: number, n: number): boolean {
  if (m < OBSERVER_MIN || m > OBSERVER_MAX) return false;
  if (n < TARGET_MIN || n > TARGET_MAX) return false;
  if (m === n) return false;
  return m < n || n <= XRAY_TARGET_MAX;
}

/** 到達しうる (m, n) の全組。順序は m 昇順・n 昇順で安定 */
export function reachablePairs(): [number, number][] {
  const out: [number, number][] = [];
  for (let m = OBSERVER_MIN; m <= OBSERVER_MAX; m++) {
    for (let n = TARGET_MIN; n <= TARGET_MAX; n++) {
      if (isReachable(m, n)) out.push([m, n]);
    }
  }
  return out;
}

/** 観測者 m と対象 n からモードを確定する(UI の要求は尊重しつつ矛盾を潰す) */
export function resolveMode(m: number, n: number, requested: PerspectiveMode): PerspectiveMode {
  if (m > n) return 'xray'; // 高 → 低 は X 線俯瞰しかない
  return requested === 'xray' ? 'slice' : requested;
}

const clampInt = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, Math.round(v)));

/**
 * 任意の (m, n, 希望モード) を**必ず到達しうる組へ**正規化する。
 *
 * 深リンク・公開 API・プリセットのどこから来た値でも、ここを通れば `isReachable` を
 * 満たす。**動かすのは n の側**にしてある ── OBSERVER はこの展示の主題であり、
 * 直前にユーザーが動かした可能性が最も高いパラメータだからだ(既存の m ≠ n の
 * 解消も n をずらしていたので、その規則をそのまま広げたことになる)。
 */
export function resolvePerspective(
  observer: number,
  target: number,
  requested: PerspectiveMode,
): { m: number; n: number; mode: PerspectiveMode } {
  const m = clampInt(observer, OBSERVER_MIN, OBSERVER_MAX);
  let n = clampInt(target, TARGET_MIN, TARGET_MAX);

  if (n === m) n = m < TARGET_MAX ? m + 1 : m - 1;
  // 見下ろす側で、演出された場面が無い次元を指している(例: m=5 / n=4)。
  // 上へ逃がして断面・影の側へ戻す。上が無いときだけ下(X線の成立する範囲)へ。
  if (m > n && n > XRAY_TARGET_MAX) n = m < TARGET_MAX ? m + 1 : XRAY_TARGET_MAX;

  return { m, n, mode: resolveMode(m, n, requested) };
}
