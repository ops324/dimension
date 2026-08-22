/**
 * 余次元 k の平坦面によるスライス(Phase 39)。
 *
 * `slice.ts` の `sliceFaces` は**超平面**(余次元 1)専用である。断面が常に
 * n−1 次元になるので、観測者が m 次元でも m < n−1 のときは「その住人が見て
 * いる世界」になっていなかった(Phase 38 の監査で判明)。
 *
 * ここでは対象を **m 次元の平坦面** A = { x_m = o_0, …, x_{n−1} = o_{k−1} }
 * (k = n − m)で切る。次元の勘定はこうなる:
 *
 *   dim(j-面 ∩ A) = j − k
 *
 * つまり **k-面が断面の頂点を**、**(k+1)-面が断面の辺を**生む。k=1 では
 * 「辺が頂点を、2-面が辺を生む」── `sliceFaces` がやっていることそのもので、
 * この実装はその一段の一般化である(テストで両者の一致を固定している)。
 *
 * 凸包の計算は要らない。k-面ごとに交点を 1 つ求め、(k+1)-面ごとに
 * 「自分の境界 k-面のうち当たった 2 つ」を結ぶだけでよい。
 */

import type { PolytopeFamily } from './polytopes';
import { MAX_N } from './projection';

/** 内側判定の型。cube の k-面は k-立方体、他 2 族の k-面は k-単体 */
export type CellShape = 'box' | 'simplex';

/**
 * 平坦スライスの組合せ構造。形状(族・n)と余次元 k だけで決まり、
 * 回転や掃引位置には依らない ── 形状変更時に 1 度だけ組めばよい。
 */
export interface FlatSliceGeometry {
  readonly family: PolytopeFamily;
  readonly n: number;
  /** 余次元 k = n − m */
  readonly codim: number;
  /** k-面(断面の頂点を生む)の数 */
  readonly nodeCount: number;
  /**
   * k-面ごとのアフィン枠: 頂点インデックス k+1 個 [v₀, v₁, …, v_k]。
   * 面上の点は v₀ + Σ tᵢ·(vᵢ − v₀) と書ける。
   */
  readonly frames: Uint32Array;
  /** 枠の内側判定(box: 0≤tᵢ≤1 / simplex: tᵢ≥0 かつ Σtᵢ≤1) */
  readonly shape: CellShape;
  /** (k+1)-面(断面の辺を生む)の数 */
  readonly linkCount: number;
  /** (k+1)-面 1 つが持つ境界 k-面の数 */
  readonly boundStride: number;
  /** (k+1)-面ごとの境界 k-面インデックス */
  readonly bounds: Uint32Array;
}

/** j-面の数。cube = C(n,j)·2^(n−j) / simplex = C(n+1,j+1) / orthoplex = C(n,j+1)·2^(j+1) */
export function faceCountOfDim(family: PolytopeFamily, n: number, j: number): number {
  if (j < 0) return 0;
  switch (family) {
    case 'cube':
      return j > n ? 0 : choose(n, j) * (1 << (n - j));
    case 'simplex':
      return choose(n + 1, j + 1);
    case 'orthoplex':
      return j + 1 > n ? 0 : choose(n, j + 1) * (1 << (j + 1));
  }
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

/** 昇順の組合せを列挙する(size 個を total から選ぶ)。cold path なので配列を返す */
function combinations(total: number, size: number): number[][] {
  const out: number[][] = [];
  const cur = new Array<number>(size);
  const walk = (start: number, depth: number): void => {
    if (depth === size) {
      out.push(cur.slice());
      return;
    }
    for (let v = start; v < total; v++) {
      cur[depth] = v;
      walk(v + 1, depth + 1);
    }
  };
  if (size <= total) walk(0, 0);
  return out;
}

/**
 * 形状と余次元から組合せ構造を作る。**形状変更時のみ**(毎フレームではない)。
 *
 * 作り方は 3 族とも同じ形をしている ── 「k-面を鍵つきで並べ、(k+1)-面を
 * 並べながら、その境界 k-面を鍵で引く」。族ごとに違うのは鍵の作り方だけ。
 */
export function makeFlatSliceGeometry(
  family: PolytopeFamily,
  n: number,
  codim: number,
): FlatSliceGeometry {
  const k = codim;

  // --- k-面を並べ、鍵 → 添字の表を作る -------------------------------------
  const index = new Map<number, number>();
  const frames: number[] = [];
  let nodeCount = 0;

  const shape: CellShape = family === 'cube' ? 'box' : 'simplex';

  if (family === 'cube') {
    // k-面 = 自由な k 軸 S と、残り n−k 軸の符号(= base 頂点)
    for (const s of combinations(n, k)) {
      let mask = 0;
      for (const a of s) mask |= 1 << a;
      const rest = n - k;
      for (let bits = 0; bits < 1 << rest; bits++) {
        let base = 0;
        let b = 0;
        for (let axis = 0; axis < n; axis++) {
          if (mask & (1 << axis)) continue;
          if ((bits >> b) & 1) base |= 1 << axis;
          b++;
        }
        index.set(cubeKey(n, mask, base), nodeCount++);
        frames.push(base);
        for (const a of s) frames.push(base | (1 << a));
      }
    }
  } else if (family === 'simplex') {
    // k-面 = n+1 頂点から k+1 個を選ぶ
    for (const set of combinations(n + 1, k + 1)) {
      let mask = 0;
      for (const v of set) mask |= 1 << v;
      index.set(mask, nodeCount++);
      for (const v of set) frames.push(v);
    }
  } else {
    // orthoplex: k-面 = k+1 軸 × 各軸の符号。頂点番号は 2·axis + signBit
    for (const axes of combinations(n, k + 1)) {
      for (let signs = 0; signs < 1 << (k + 1); signs++) {
        let mask = 0;
        for (let i = 0; i < axes.length; i++) mask |= 1 << (2 * axes[i] + ((signs >> i) & 1));
        index.set(mask, nodeCount++);
        for (let i = 0; i < axes.length; i++) frames.push(2 * axes[i] + ((signs >> i) & 1));
      }
    }
  }

  // --- (k+1)-面を並べ、境界 k-面を鍵で引く ---------------------------------
  const boundStride = family === 'cube' ? 2 * (k + 1) : k + 2;
  const bounds: number[] = [];
  let linkCount = 0;

  if (family === 'cube') {
    for (const s of combinations(n, k + 1)) {
      let mask = 0;
      for (const a of s) mask |= 1 << a;
      const rest = n - (k + 1);
      for (let bits = 0; bits < 1 << rest; bits++) {
        let base = 0;
        let b = 0;
        for (let axis = 0; axis < n; axis++) {
          if (mask & (1 << axis)) continue;
          if ((bits >> b) & 1) base |= 1 << axis;
          b++;
        }
        // 各自由軸を「下面」「上面」へ固定した 2(k+1) 枚が境界
        for (const a of s) {
          const sub = mask & ~(1 << a);
          bounds.push(requireIndex(index, cubeKey(n, sub, base)));
          bounds.push(requireIndex(index, cubeKey(n, sub, base | (1 << a))));
        }
        linkCount++;
      }
    }
  } else if (family === 'simplex') {
    for (const set of combinations(n + 1, k + 2)) {
      let mask = 0;
      for (const v of set) mask |= 1 << v;
      for (const v of set) bounds.push(requireIndex(index, mask & ~(1 << v)));
      linkCount++;
    }
  } else {
    for (const axes of combinations(n, k + 2)) {
      for (let signs = 0; signs < 1 << (k + 2); signs++) {
        const verts: number[] = [];
        let mask = 0;
        for (let i = 0; i < axes.length; i++) {
          const v = 2 * axes[i] + ((signs >> i) & 1);
          verts.push(v);
          mask |= 1 << v;
        }
        for (const v of verts) bounds.push(requireIndex(index, mask & ~(1 << v)));
        linkCount++;
      }
    }
  }

  ensureScratch(nodeCount);

  return {
    family,
    n,
    codim: k,
    nodeCount,
    frames: Uint32Array.from(frames),
    shape,
    linkCount,
    boundStride,
    bounds: Uint32Array.from(bounds),
  };
}

/** cube の k-面の鍵。n ≤ MAX_N なら mask・base とも 2^n 未満に収まる */
function cubeKey(n: number, mask: number, base: number): number {
  return mask * (1 << n) + base;
}

function requireIndex(index: Map<number, number>, key: number): number {
  const v = index.get(key);
  if (v === undefined) throw new Error(`flatSlice: 境界 k-面が見つからない (key=${key})`);
  return v;
}

/**
 * k-面ごとの交点(ストライド MAX_N)と、当たったかどうかの旗。
 *
 * 必要量は形状と余次元で決まる(6-cube の 2-面と 6-orthoplex の 3-面がともに
 * 240 で最大)。**上限を定数で決め打つと n の上限を上げた瞬間に破綻する**ので、
 * 組合せ構造を組むとき(= 冷たい経路)に必要なら伸ばす。`sliceFlat` 側は
 * 決してアロケーションしない。
 */
let HIT_POINT = new Float64Array(0);
let HIT_FLAG = new Uint8Array(0);

function ensureScratch(nodeCount: number): void {
  if (HIT_FLAG.length >= nodeCount) return;
  HIT_POINT = new Float64Array(nodeCount * MAX_N);
  HIT_FLAG = new Uint8Array(nodeCount);
}

/** 連立の作業領域(k×(k+1) の拡大係数行列)。k ≤ MAX_N − 2 */
const AUG = new Float64Array(MAX_N * (MAX_N + 1));
const SOLUTION = new Float64Array(MAX_N);

/** 特異な係数行列(面が平坦面と平行)を捨てる閾値 */
const PIVOT_EPS = 1e-12;

/**
 * 回転済み頂点群を、平坦面 A = { x_{m+j} = offsets[j] } で切る。
 *
 * 出力は `sliceFaces` と同じ約束 ── 線分ごとに端点 2 つ × m 座標
 * (固定した軸 m..n−1 を除いた残り、元の軸順)。戻り値は線分数。
 * out には linkCount * 2 * m 要素以上を確保すること。
 *
 * ホットパス(毎フレーム): アロケーションなし。
 */
export function sliceFlat(
  rotated: Float64Array,
  n: number,
  m: number,
  offsets: Float64Array,
  geom: FlatSliceGeometry,
  out: Float64Array,
): number {
  const k = n - m;
  const frameStride = k + 1;
  const frames = geom.frames;
  const box = geom.shape === 'box';

  // --- k-面 → 断面の頂点 ---------------------------------------------------
  for (let c = 0; c < geom.nodeCount; c++) {
    const fo = c * frameStride;
    const v0 = frames[fo] * n;

    // M t = b。M[j][i] = (vᵢ − v₀) の軸 m+j 成分、b[j] = offsets[j] − v₀ の同成分
    for (let j = 0; j < k; j++) {
      const row = j * (k + 1);
      const axis = m + j;
      const origin = rotated[v0 + axis];
      for (let i = 0; i < k; i++) {
        AUG[row + i] = rotated[frames[fo + 1 + i] * n + axis] - origin;
      }
      AUG[row + k] = offsets[j] - origin;
    }

    HIT_FLAG[c] = 0;
    if (!solve(k)) continue;

    // 内側判定 ── ここを外れた交点は面の外(= 断面の頂点ではない)
    let ok = true;
    let sum = 0;
    for (let i = 0; i < k; i++) {
      const t = SOLUTION[i];
      if (t < 0) {
        ok = false;
        break;
      }
      if (box) {
        if (t > 1) {
          ok = false;
          break;
        }
      } else {
        sum += t;
      }
    }
    if (!ok || (!box && sum > 1)) continue;

    // 点を復元し、残る m 座標(軸 0..m−1)だけを書く
    const po = c * MAX_N;
    for (let a = 0; a < m; a++) {
      let x = rotated[v0 + a];
      for (let i = 0; i < k; i++) {
        x += SOLUTION[i] * (rotated[frames[fo + 1 + i] * n + a] - rotated[v0 + a]);
      }
      HIT_POINT[po + a] = x;
    }
    HIT_FLAG[c] = 1;
  }

  // --- (k+1)-面 → 断面の辺 -------------------------------------------------
  const bounds = geom.bounds;
  const boundStride = geom.boundStride;
  const outStride = m * 2;
  let segments = 0;

  for (let l = 0; l < geom.linkCount; l++) {
    const bo = l * boundStride;
    let a = -1;
    let b = -1;
    for (let i = 0; i < boundStride; i++) {
      const c = bounds[bo + i];
      if (HIT_FLAG[c] === 0) continue;
      if (a < 0) a = c;
      else {
        b = c;
        break;
      }
    }
    if (b < 0) continue;

    const o = segments * outStride;
    const ao = a * MAX_N;
    const bp = b * MAX_N;
    for (let x = 0; x < m; x++) {
      out[o + x] = HIT_POINT[ao + x];
      out[o + m + x] = HIT_POINT[bp + x];
    }
    segments++;
  }

  return segments;
}

/**
 * AUG(k×(k+1) の拡大係数行列)を部分ピボット付きガウス消去で解き、
 * SOLUTION へ書く。特異なら false(面が平坦面と平行 = 交点を持たない)。
 */
function solve(k: number): boolean {
  const w = k + 1;
  for (let col = 0; col < k; col++) {
    let pivot = col;
    let best = Math.abs(AUG[col * w + col]);
    for (let r = col + 1; r < k; r++) {
      const v = Math.abs(AUG[r * w + col]);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best < PIVOT_EPS) return false;
    if (pivot !== col) {
      for (let c = col; c < w; c++) {
        const tmp = AUG[col * w + c];
        AUG[col * w + c] = AUG[pivot * w + c];
        AUG[pivot * w + c] = tmp;
      }
    }
    const inv = 1 / AUG[col * w + col];
    for (let r = col + 1; r < k; r++) {
      const f = AUG[r * w + col] * inv;
      if (f === 0) continue;
      for (let c = col; c < w; c++) AUG[r * w + c] -= f * AUG[col * w + c];
    }
  }
  for (let r = k - 1; r >= 0; r--) {
    let x = AUG[r * w + k];
    for (let c = r + 1; c < k; c++) x -= AUG[r * w + c] * SOLUTION[c];
    SOLUTION[r] = x / AUG[r * w + r];
  }
  return true;
}
