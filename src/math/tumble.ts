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

/** 自動タンブルの平面の最大枚数(= n=10 の直交)。 */
export const MAX_TUMBLE_PLANES = ORTHO_OMEGAS.length;

/**
 * ユーザーが足す平面ぶんの素数(Phase 43)。
 *
 * 基底の 9 個(2..23)と**重ならない**素数を取る。√p が ℚ 上一次独立である以上、
 * 基底の ω とも互いとも比が有理数にならない
 * (`PERSPECTIVE_OMEGAS` の 0.31 / 0.23√2 / 0.17√5 とも同じ理由で衝突しない)。
 *
 * **枚数は 13 必要**である ── 追加できる最大は「上限 16 − 最小の基底 3(透視)」で、
 * 7 個しか置かないと透視の n≥6 で素数を使い切って ω が循環し、
 * **比が 1 になる 2 枚**ができる = 合成姿勢が周期を持つ(実測で踏んだ)。
 */
const EXTRA_OMEGA_PRIMES = [29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79] as const;

/**
 * 追加平面の角速度の帯。**基底の 0.21〜0.39 rad/s に揃える。**
 *
 * `ORTHO_OMEGA_BASE + SPAN·√p` をそのまま延長すると p=79 で 0.62 rad/s になり、
 * ユーザーが足した平面だけが目に見えて速く回る。√p の**小数部**を取れば帯に
 * 収まり、しかも無理性は失われない ── frac(√p) = √p − ⌊√p⌋ は有理数を引いた
 * だけなので、ω = (A − SPAN·⌊√p⌋) + SPAN·√p、つまり「有理数 + 有理数×√p」の
 * 形のままである。
 */
const EXTRA_OMEGA_BASE = 0.21;
const EXTRA_OMEGA_SPAN = 0.18;

/**
 * 回転列の最大長(Phase 43)。
 *
 * **C(10,2) = 45 ではない。** 45 枚を毎フレーム回すと 10-cube の直交で
 * 1.93ms/frame(既存 9 枚の 3.2 倍・透視 3 枚の 5.5 倍)になり、
 * 品質ガバナーは**それに効く手を持っていない** ── 見ているのはフレーム時間だけで、
 * 打てるのは DPR / MSAA / ブルーム / 星密度、つまり GPU 側だけである。
 * しかも降格すると 1 セッションに 1 度しかない再昇格の権利を無駄に使う。
 * 16 枚なら実測 ≈0.85ms(既存比 1.4 倍)。**上限は UI 側で持つ。**
 */
export const MAX_PLANE_ROTATIONS = 16;

/** 追加平面 k(0 始まり)の角速度 */
export function extraOmega(k: number): number {
  const p = EXTRA_OMEGA_PRIMES[k % EXTRA_OMEGA_PRIMES.length];
  const root = Math.sqrt(p);
  return EXTRA_OMEGA_BASE + EXTRA_OMEGA_SPAN * (root - Math.floor(root));
}

/**
 * 追加平面 k の初期位相。基底の黄金角の列を**そのまま延長する**。
 *
 * 位相が要るのは飾りではない ── **t = 0 ではどんな平面でも Givens は恒等**
 * なので、位相を与えないとユーザーが足した平面は起動直後の 1 秒を何もしない
 * (罠 #20 の末尾)。
 */
export function extraPhase(k: number): number {
  return orthoPhase(ORTHO_OMEGAS.length + k);
}

/**
 * 回転平面 (i, j) の整数キー。i < j に正規化してから畳む。
 * 16 進む幅を取るのは `MAX_N`(投影の上限)に合わせたため ── n を広げても
 * キーの意味が変わらない。
 */
const KEY_STRIDE = 16;

export function planeKey(i: number, j: number): number {
  return i < j ? i * KEY_STRIDE + j : j * KEY_STRIDE + i;
}

export function planeFromKey(key: number): readonly [number, number] {
  return [(key / KEY_STRIDE) | 0, key % KEY_STRIDE];
}

/** n 次元で取りうる全平面 C(n,2) のキー(i 昇順・j 昇順で安定) */
export function allPlaneKeys(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) out.push(planeKey(i, j));
  }
  return out;
}

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

/* ------------------------------------------- ユーザーが選ぶ回転平面(Phase 43) */

/**
 * 回転列の 1 枚。`planRotations` が返す完成形で、展示はこれを写すだけ。
 */
export interface PlaneRotationPlan {
  readonly i: number;
  readonly j: number;
  /** 角速度(rad/s)。**0 は「凍結」であって「無い」ではない** */
  readonly omega: number;
  /** 初期位相(rad) */
  readonly phase: number;
}

/** その形状・投影での既定の回す平面(= `planTumble` が選んだ組)のキー集合 */
export function defaultSpin(n: number, perspective: boolean): Set<number> {
  const plan = planTumble(n, perspective);
  return new Set(plan.planes.map(([i, j]) => planeKey(i, j)));
}

/**
 * 「どの平面を回すか」の選択から、実際に `rotateBatch` へ渡す回転列を組む。
 *
 * ## OFF は「消す」ではなく「凍結」である
 *
 * これがこの機能の設計そのもの。`planTumble` が選んだ平面は**必ず列に残り**、
 * 選択から外れたときは ω = 0(位相 φ はそのまま)になる。ユーザーは回転を
 * 止められるが、**軸の混ざりは取り上げられない**。
 *
 * 引き算を許すとどうなるかは実測してある(10-cube・直交・7 姿勢の最悪値):
 *
 * | 構成 | 可視 3 軸への到達(最小) | 潰れた辺 | 相異なる頂点 |
 * |---|---|---|---|
 * | 既定の 9 枚 | 2.03e-2 | 0 / 5,120 | 1,024 / 1,024 |
 * | **凍結した基底のみ**(全 OFF) | **4.07e-2** | **0** | **1,024** |
 * | 素で可視 3 軸だけを選択 | **0** | **3,584** | **8** |
 *
 * 最下段が「消す」を許した場合で、**Phase 37 のバグ(2,560 本)より悪い退化に
 * UI から到達できる**ことになる。しかも症状は「絵が壊れる」ではなく
 * 「**n を上げても絵が変わらない**」なので、触っている本人には見えない(罠 #20)。
 *
 * 凍結で条件④が保たれるのは、既にある設計のおかげである ── 黄金角の初期位相
 * (`orthoPhase`)は **ω = 0 でも Givens を恒等にしない**。位相は飾りではなく
 * 安全網だった。
 *
 * (厳密には、ユーザー側の回転の可視 3 行が凍結した鎖の第 k 列をちょうど消す
 * 瞬間は測度 0 で起こりうる。消えるのは**全時刻で軸が核に落ちる**という
 * 構造的な退化のほうで、それがこの機能で守りたかったものである。)
 *
 * @param spin 回したい平面のキー集合(`planeKey`)。基底に無いキーは追加平面になる
 */
export function planRotations(
  n: number,
  perspective: boolean,
  spin: ReadonlySet<number>,
): PlaneRotationPlan[] {
  const plan = planTumble(n, perspective);
  const out: PlaneRotationPlan[] = [];
  const base = new Set<number>();

  for (let k = 0; k < plan.planes.length; k++) {
    const [i, j] = plan.planes[k];
    const key = planeKey(i, j);
    base.add(key);
    out.push({
      i,
      j,
      omega: spin.has(key) ? plan.omegas[k] : 0,
      phase: plan.phases[k],
    });
  }

  let extra = 0;
  for (const key of allPlaneKeys(n)) {
    if (base.has(key) || !spin.has(key)) continue;
    if (out.length >= MAX_PLANE_ROTATIONS) break; // 上限は静かに切らない(呼び出し側が数を出す)
    const [i, j] = planeFromKey(key);
    out.push({ i, j, omega: extraOmega(extra), phase: extraPhase(extra) });
    extra++;
  }

  return out;
}

/** `spin` のうち実際に列へ載る枚数(上限で切り落とされた数を呼び出し側が知るため) */
export function countRotations(n: number, perspective: boolean, spin: ReadonlySet<number>): number {
  return planRotations(n, perspective, spin).length;
}

/**
 * PERSPECTIVE 展示の回転平面(3 枚固定)。
 *
 * この展示は透視カスケードしか使わないので条件④(全軸が可視 3 軸へ到達)は
 * 要らない ── f = dist/(dist − p[d]) が全軸を倍率として読むからだ。
 * 代わりに**この展示だけの条件**が 2 つある:
 *
 *   ⑤ **スライス軸 n−1 を含む平面を必ず 1 枚**。さもないと対象が超平面に対して
 *      姿勢を変えず、断面が相似縮小して消えるだけになる
 *   ⑥ **どの軸も、少なくとも 1 枚の平面に触られる**。触られない軸は
 *      **時間で動かない座標**になり、(a) その軸が影の深度キューを駆動する m の
 *      ときに色が凍り、(b) 断面ではその軸の固定オフセットが一度も別の場所を
 *      通らない ── 罠 #20 の、透視でも残る半分である
 *
 * 旧実装は (0,2) / (1,n−1) / (2,n−2) で、**n=6 のとき軸 3 がどの平面にも入らな
 * かった**(触れるのは 0,1,2,4,5)。Phase 42 で影の深度キューを「観測者がまず
 * 届かない軸 x_m」にしたところ、m=3 / n=6 で色が完全に静止して露見した。
 * 第 3 平面を (n−3, n−2) にすると n=6 で (3,4) になり全軸が回る。
 * n=5 では (2,3) で**旧実装と同一**、n=4 は (0,3) のまま ── つまり
 * **絵が変わるのは n=6 だけ**である。
 */
export function planSlicePlanes(n: number): readonly (readonly [number, number])[] {
  /*
    n=2 には平面が 1 枚しか無い。同じ平面を 3 度重ねても回転は回転のまま
    (角が足されるだけ)で、しかも**範囲外の軸へ書かない**。
    旧実装は n=2 でも (0,2) / (1,2) を張っていた ── `rotateBatch` は
    `dst[v·2 + 2]` へ書くので、**隣の頂点の第 0 座標を潰す**位置にいた。
    いま n=2 を取るのは X線俯瞰(演出シーンで頂点を回さない)だけなので
    露出していないが、置いておく理由は無い。
  */
  if (n <= 2) return [[0, 1], [0, 1], [0, 1]];
  if (n === 3) return [[0, 1], [0, 2], [1, 2]];
  // n=4 は (n−3, n−2) = (1,2) が最終軸を持たない組と噛み合わないので (0,3) を保つ
  if (n === 4) return [[0, 2], [1, 3], [0, 3]];
  return [[0, 2], [1, n - 1], [n - 3, n - 2]];
}
