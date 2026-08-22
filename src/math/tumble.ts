/**
 * 自動タンブル(回転平面と角速度)の設計。
 *
 * **回転と投影は対で設計しないと次元が消える。** 投影が捨てる軸へ回転が一度も
 * 触れなければ、その軸は像に一切現れない ── 「n を上げても絵が変わらない」という
 * 形で表面化する。Phase 37 の実測では、直交投影の 6-cube と 10-cube の像が
 * 自動フィット後に**完全に一致**していた(10-cube は 5,120 本の辺のうち 2,560 本が
 * 長さ 0 に潰れ、1,024 頂点が 32 か所へ重なっていた)。
 *
 * 平面の選び方が満たすべき条件:
 *
 *   ① 少なくとも 1 平面が軸 3 以上を含む ── さもないと「ただの 3D の回転」に
 *      なり、高次元性が見えない
 *   ② **最終軸(深度軸)n−1 が必ず回る** ── 回らないと深度が定数になり、
 *      配色の深度キューが凍りつく
 *   ③ **可視 3 軸だけで閉じた平面を含む** ── 高次元平面だけで組むと 3D 空間内での
 *      姿勢が変わらず、形状が正面固定のまま脈動するだけに見える(実測: (0,3)/
 *      (1,n−1)/(2,n−2) の組では 10-cube が常に正面向きの「トンネル」に見えた)
 *   ④ **直交のときのみ: すべての軸が可視 3 軸へ到達する** ── `projectOrtho` は
 *      座標 3..n−1 を捨てるだけなので、可視 3 軸へ混ざらない軸は投影の核へ落ちる
 *
 * 透視は ④ を要求しない。透視カスケードは f = dist/(dist − p[d]) を通じて全軸を
 * 倍率として読むので、回らない軸も像に効くからだ。だから条件が違う以上、
 * 平面の組も投影ごとに分ける。
 */

/**
 * 回転平面の並び。**配列順に適用する**(`rotateBatch` の契約)。
 * 順序は意味を持つ ── 直交の鎖は深い軸から先に回さないと伝播しない。
 */
export interface TumblePlan {
  /** 回転平面の軸対 [i, j] */
  readonly planes: readonly (readonly [number, number])[];
  /** planes[k] の角速度(rad/s)。角度は毎フレーム ω·t + φ で絶対値から再計算する */
  readonly omegas: readonly number[];
  /**
   * planes[k] の位相 φ(rad)。
   *
   * t = 0 では**どんな平面を選んでも** Givens はすべて恒等になり、直交投影は
   * 単なる座標の切り捨てへ退化する ── 条件④は位相なしでは満たしようがない。
   * 起動直後の 1 秒も一般の姿勢でいられるよう、直交には初期位相を与える。
   * 透視は Phase 36 以前の見えを一切変えないため 0 のまま。
   */
  readonly phases: readonly number[];
}

/** 透視の角速度。比を無理数にして周期が一致しないようにする */
const PERSPECTIVE_OMEGAS = [0.31, 0.23 * Math.SQRT2, 0.17 * Math.sqrt(5)] as const;

/**
 * 直交の角速度: ω_k = A + B·√p_k(p_k は相異なる素数)。
 *
 * p ≠ q のとき (A+B√p)/(A+B√q) は必ず無理数になる ── √p, √q, 1 が ℚ 上一次独立
 * だからだ。よって何枚に増やしても、どの 2 枚の比も有理数にならない
 * = 合成姿勢は決して同じ姿勢へ戻らない。帯は 0.21〜0.39 rad/s で、
 * 透視の 0.31〜0.38 と同じ速度感に収めてある。
 *
 * 必要枚数は n−1(鎖 n−3 枚 + 姿勢 2 枚)で、n=10 の 9 枚が最大。
 */
const ORTHO_OMEGA_PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23] as const;
const ORTHO_OMEGA_BASE = 0.13;
const ORTHO_OMEGA_SPAN = 0.055;
const ORTHO_OMEGAS: readonly number[] = ORTHO_OMEGA_PRIMES.map(
  (p) => ORTHO_OMEGA_BASE + ORTHO_OMEGA_SPAN * Math.sqrt(p),
);

/**
 * 直交の初期位相。黄金角の整数倍を取ると、どの枚数で切っても互いに近づかず、
 * かつ 0 の近傍を踏まない(最小でも 0.35 rad ≈ sin 0.34 は残る)。
 */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const orthoPhase = (k: number): number => ((k + 1) * GOLDEN_ANGLE) % (2 * Math.PI);

/** 平面の最大枚数(= n=10 の直交)。バッファ確保側の上限に使う */
export const MAX_TUMBLE_PLANES = ORTHO_OMEGAS.length;

/**
 * n と投影モードから回転平面を決める。
 *
 * 形状変更・投影モード変更でのみ呼ぶ冷たい経路なので、配列は都度作ってよい
 * (毎フレーム側は返り値を使い回す)。
 */
export function planTumble(n: number, perspective: boolean): TumblePlan {
  const planes: [number, number][] = [];
  const omegas: number[] = [];
  const phases: number[] = [];

  // 3 次元以下は捨てる軸が無い。素直に 3 平面すべてを回す
  if (n <= 3) {
    planes.push([0, 1], [0, 2], [1, 2]);
    omegas.push(...PERSPECTIVE_OMEGAS);
    return { planes, omegas, phases: [0, 0, 0] };
  }

  if (perspective) {
    // (0,2) で 3D の傾き、(1,n−1) で深度軸、(2,n−2) で中位軸を混ぜる
    planes.push([0, 2], [1, n - 1]);
    // n=4 は (2,2) が退化する。(0,3) にすると 4 軸すべてが回る
    planes.push(n - 2 > 2 ? [2, n - 2] : [0, 3]);
    omegas.push(...PERSPECTIVE_OMEGAS);
    return { planes, omegas, phases: [0, 0, 0] };
  }

  /*
   * 直交の鎖(条件④)。平面 (k, k+3) を k = n−4 から 0 へ**降順に**適用する。
   * `rotateBatch` は配列順に適用するので、深い側から先に回さないと伝播しない
   * ── (6,9) が軸 9 を軸 6 へ運び、続く (3,6) がそれを軸 3 へ、最後の (0,3) が
   * 軸 0 へ運ぶ。
   *
   * 3 本ずつずらすので、軸は可視 3 軸へ均等に配られる(n=10):
   *   軸 0 ← {0,3,6,9} / 軸 1 ← {1,4,7} / 軸 2 ← {2,5,8}
   * 1 本の可視軸へ全部を集める鎖((0,3),(3,4),(4,5),…)でも軸は死なないが、
   * 高次元ぶんが画面上の 1 方向へ潰れて、影が線的に見えてしまう。
   */
  let k = 0;
  for (let a = n - 4; a >= 0; a--) {
    planes.push([a, a + 3]);
    omegas.push(ORTHO_OMEGAS[k]);
    phases.push(orthoPhase(k));
    k++;
  }

  // 可視 3 軸だけで閉じた 2 枚(条件③)。鎖と ω が衝突しないよう末尾から取る。
  // 鎖は最大 n−3 = 7 枚 = 添字 0..6 までしか使わないので重ならない。
  const last = ORTHO_OMEGAS.length - 1;
  planes.push([0, 2], [1, 2]);
  omegas.push(ORTHO_OMEGAS[last - 1], ORTHO_OMEGAS[last]);
  phases.push(orthoPhase(last - 1), orthoPhase(last));

  return { planes, omegas, phases };
}
