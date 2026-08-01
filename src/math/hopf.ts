/**
 * ホップ・ファイブレーション S¹ ↪ S³ → S²。
 *
 * S³ ⊂ C² を z1 = x+iy, z2 = z+iw と見ると、ホップ写像は
 *   h(z1, z2) = (2·Re(z1·z̄2), 2·Im(z1·z̄2), |z1|² − |z2|²)
 * で与えられ、S² の 1 点の逆像(ファイバー)は S³ 上の大円になる。
 *
 * 基点 (θ, φ) ∈ S²(θ: 余緯度 0..π, φ: 経度)のファイバーは
 *   p(a) = ( cos(θ/2)·cos a,  cos(θ/2)·sin a,  sin(θ/2)·cos(a+φ),  sin(θ/2)·sin(a+φ) )
 * で径数化され、全点が h(p(a)) = (sinθ·cosφ, −sinθ·sinφ, cosθ) に写る。
 *
 * θ = π のファイバーはステレオ投影の極 (w=1) を通り無限遠へ飛ぶため、
 * すべての基点分布は θ を [THETA_MIN, THETA_MAX] にクランプする
 * (最大投影半径 ≈ √((1+sin(θmax/2))/(1−sin(θmax/2))) ≈ 11.5 に収まる)。
 */

const TWO_PI = Math.PI * 2;

/** 基点余緯度の安全範囲(投影半径の暴走と極ファイバーの退化を防ぐ) */
export const THETA_MIN = 0.12;
export const THETA_MAX = Math.PI - 0.35;

const clampTheta = (theta: number): number =>
  theta < THETA_MIN ? THETA_MIN : theta > THETA_MAX ? THETA_MAX : theta;

/**
 * 基点 (θ, φ) のファイバー円を `segments` 点で径数化し、
 * out[offset .. offset + segments*4) へ xyzw インターリーブで書き込む。
 * 点は閉ループ(描画側が i → (i+1) mod segments を線分で結ぶ)。
 */
export function hopfFiber(
  theta: number,
  phi: number,
  segments: number,
  out: Float64Array,
  offset = 0,
): void {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  for (let k = 0; k < segments; k++) {
    const a = (k / segments) * TWO_PI;
    const o = offset + k * 4;
    out[o] = c * Math.cos(a);
    out[o + 1] = c * Math.sin(a);
    out[o + 2] = s * Math.cos(a + phi);
    out[o + 3] = s * Math.sin(a + phi);
  }
}

/** ファイバー点 (x,y,z,w) をホップ写像で S² へ送る(テスト・彩色用) */
export function hopfMap(
  x: number,
  y: number,
  z: number,
  w: number,
): [number, number, number] {
  return [2 * (x * z + y * w), 2 * (y * z - x * w), x * x + y * y - z * z - w * w];
}

/**
 * S² の緯線リング分布: `rings` 本の緯線 × 各 `perRing` 点。
 * S³ ではリングごとに入れ子のトーラスを成す(古典的で最も美しい構図)。
 * リング間で φ を黄金角ずらして重なりを散らす。
 * out へ [θ0,φ0, θ1,φ1, …] を書き、書いた基点数を返す。
 */
export function baseLatitudeRings(
  rings: number,
  perRing: number,
  out: Float64Array,
): number {
  const golden = TWO_PI * 0.381966; // 2π(1 − 1/φ)
  let p = 0;
  for (let r = 0; r < rings; r++) {
    const t = rings === 1 ? 0.5 : r / (rings - 1);
    const theta = clampTheta(THETA_MIN + (THETA_MAX - THETA_MIN) * t);
    const phase = r * golden;
    for (let k = 0; k < perRing; k++) {
      out[p * 2] = theta;
      out[p * 2 + 1] = (k / perRing) * TWO_PI + phase;
      p++;
    }
  }
  return p;
}

/**
 * S² の緯線リング分布(面積重み付き): リングごとの本数を sinθ に比例させる。
 *
 * 等本数のリング(baseLatitudeRings)は θ が小さいリングでファイバーが
 * ほぼ同一の円に投影されて加算合成が飽和する(白飛び)。S² 上の一様密度は
 * 緯線周長 = 2π·sinθ に比例するので、本数を sinθ で重み付けするのが
 * 数学的に正しいサンプリングになる。合計はおおよそ targetTotal に一致する。
 * out へ [θ,φ,…] を書き、実際に書いた基点数を返す。
 */
export function baseLatitudeRingsWeighted(
  rings: number,
  targetTotal: number,
  out: Float64Array,
  thetaMin = THETA_MIN,
  thetaMax = THETA_MAX,
): number {
  const lo = clampTheta(thetaMin);
  const hi = clampTheta(thetaMax);
  const golden = TWO_PI * 0.381966;
  // 正規化係数: Σ sinθ_r
  let sinSum = 0;
  for (let r = 0; r < rings; r++) {
    const t = rings === 1 ? 0.5 : r / (rings - 1);
    sinSum += Math.sin(lo + (hi - lo) * t);
  }
  let p = 0;
  for (let r = 0; r < rings; r++) {
    const t = rings === 1 ? 0.5 : r / (rings - 1);
    const theta = lo + (hi - lo) * t;
    const perRing = Math.max(4, Math.round((targetTotal * Math.sin(theta)) / sinSum));
    const phase = r * golden;
    for (let k = 0; k < perRing; k++) {
      out[p * 2] = theta;
      out[p * 2 + 1] = (k / perRing) * TWO_PI + phase;
      p++;
    }
  }
  return p;
}

/**
 * S² の大円分布: 軸を `tilt` だけ傾けた大円上に `count` 点。
 * ファイバーの投影はヴィラルソー円の鎖(絡み合うリンク)になる。
 */
export function baseGreatCircle(count: number, tilt: number, out: Float64Array): number {
  const ax = Math.cos(tilt);
  const az = Math.sin(tilt);
  for (let k = 0; k < count; k++) {
    const u = (k / count) * TWO_PI;
    // d(u) = cos u · (ax, 0, az) + sin u · (0, 1, 0)
    const dx = Math.cos(u) * ax;
    const dy = Math.sin(u);
    const dz = Math.cos(u) * az;
    out[k * 2] = clampTheta(Math.acos(dz));
    out[k * 2 + 1] = Math.atan2(dy, dx);
  }
  return count;
}

/**
 * フィボナッチ球面分布: S² を黄金角スパイラルでほぼ一様に覆う。
 * cosθ の範囲を極から離して取る(南極 θ=π の暴走回避)。
 */
export function baseFibonacci(count: number, out: Float64Array): number {
  const golden = TWO_PI * 0.381966;
  const zMax = Math.cos(THETA_MIN);
  const zMin = Math.cos(THETA_MAX);
  for (let k = 0; k < count; k++) {
    const z = zMax - ((k + 0.5) / count) * (zMax - zMin);
    out[k * 2] = clampTheta(Math.acos(z));
    out[k * 2 + 1] = (k * golden) % TWO_PI;
  }
  return count;
}
