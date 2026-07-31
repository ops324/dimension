/**
 * 正多胞体ファミリーの生成。
 *
 * すべての頂点は外接半径 1 に正規化する — 透視カスケード
 * (projection.ts)の分母が特異点を持たないことの構造的保証。
 */

export type PolytopeFamily = 'cube' | 'simplex' | 'orthoplex';

export interface Polytope {
  n: number;
  vertexCount: number;
  edgeCount: number;
  /** インターリーブ配置 vertices[v*n + k]、外接半径 1 */
  vertices: Float64Array;
  /** 辺の頂点インデックス対 [a0,b0, a1,b1, ...] */
  edges: Uint32Array;
  /**
   * cube のみ: 各辺が走る軸(0..n−1)。
   * narrative の「次元別フェード」(伸長中の軸の辺だけ輝度を変える)に使う。
   */
  edgeAxis?: Uint8Array;
}

/** 2-面(スライス計算用)。cube は四角形(size=4)、他は三角形(size=3) */
export interface Faces2 {
  size: 3 | 4;
  count: number;
  /** 面ごとに size 個の頂点インデックス。四角形は境界を巡る順(サイクリック) */
  indices: Uint32Array;
}

/**
 * n 次元超立方体: 2^n 頂点(±1/√n)・n·2^(n−1) 辺。
 * 頂点 v のビット b が座標 b の符号(1 → +)。辺はハミング距離 1 の対。
 */
export function makeNCube(n: number): Polytope {
  const vertexCount = 1 << n;
  const edgeCount = n * (1 << (n - 1));
  const vertices = new Float64Array(vertexCount * n);
  const edges = new Uint32Array(edgeCount * 2);
  const edgeAxis = new Uint8Array(edgeCount);

  const r = 1 / Math.sqrt(n);
  for (let v = 0; v < vertexCount; v++) {
    for (let k = 0; k < n; k++) {
      vertices[v * n + k] = (v >> k) & 1 ? r : -r;
    }
  }

  let e = 0;
  for (let v = 0; v < vertexCount; v++) {
    for (let b = 0; b < n; b++) {
      if (!((v >> b) & 1)) {
        edges[e * 2] = v;
        edges[e * 2 + 1] = v | (1 << b);
        edgeAxis[e] = b;
        e++;
      }
    }
  }

  return { n, vertexCount, edgeCount, vertices, edges, edgeAxis };
}

/**
 * n 次元正単体: n+1 頂点・C(n+1,2) 辺(全頂点対が辺)。
 *
 * 構築: R^(n+1) の標準基底 e_0..e_n を重心へ平行移動した n+1 点は
 * 超平面 ⊥(1,…,1) 上の正単体になる。この超平面の正規直交基底
 * (e_k − e_0 を Gram–Schmidt)へ射影して R^n 座標を得る。
 */
export function makeNSimplex(n: number): Polytope {
  const m = n + 1;
  const vertexCount = m;
  const edgeCount = (m * (m - 1)) / 2;

  // 重心を原点へ: v_i = e_i − (1/m)·(1,…,1) ∈ R^m
  const ambient = new Float64Array(m * m);
  for (let i = 0; i < m; i++) {
    for (let k = 0; k < m; k++) {
      ambient[i * m + k] = (i === k ? 1 : 0) - 1 / m;
    }
  }

  // 超平面 ⊥(1,…,1) の正規直交基底(n 本)を Gram–Schmidt で構築
  const basis = new Float64Array(n * m);
  for (let b = 0; b < n; b++) {
    const row = basis.subarray(b * m, (b + 1) * m);
    // 初期ベクトル e_{b+1} − e_0(超平面内にある)
    row.fill(0);
    row[b + 1] = 1;
    row[0] = -1;
    for (let p = 0; p < b; p++) {
      const prev = basis.subarray(p * m, (p + 1) * m);
      let dot = 0;
      for (let k = 0; k < m; k++) dot += row[k] * prev[k];
      for (let k = 0; k < m; k++) row[k] -= dot * prev[k];
    }
    let norm = 0;
    for (let k = 0; k < m; k++) norm += row[k] * row[k];
    norm = Math.sqrt(norm);
    for (let k = 0; k < m; k++) row[k] /= norm;
  }

  // R^n 座標へ射影し、外接半径 1(|v_i| = √(n/(n+1)))へ正規化
  const vertices = new Float64Array(vertexCount * n);
  const scale = 1 / Math.sqrt(n / m);
  for (let i = 0; i < vertexCount; i++) {
    for (let b = 0; b < n; b++) {
      let dot = 0;
      for (let k = 0; k < m; k++) dot += ambient[i * m + k] * basis[b * m + k];
      vertices[i * n + b] = dot * scale;
    }
  }

  const edges = new Uint32Array(edgeCount * 2);
  let e = 0;
  for (let a = 0; a < m; a++) {
    for (let b = a + 1; b < m; b++) {
      edges[e * 2] = a;
      edges[e * 2 + 1] = b;
      e++;
    }
  }

  return { n, vertexCount, edgeCount, vertices, edges };
}

/**
 * n 次元正軸体(クロスポリトープ): 2n 頂点 ±e_i・2n(n−1) 辺。
 * 頂点順: v_{2i} = +e_i, v_{2i+1} = −e_i。対蹠対以外のすべてが辺。
 */
export function makeNOrthoplex(n: number): Polytope {
  const vertexCount = 2 * n;
  const edgeCount = 2 * n * (n - 1);
  const vertices = new Float64Array(vertexCount * n);
  for (let i = 0; i < n; i++) {
    vertices[2 * i * n + i] = 1;
    vertices[(2 * i + 1) * n + i] = -1;
  }

  const edges = new Uint32Array(edgeCount * 2);
  let e = 0;
  for (let a = 0; a < vertexCount; a++) {
    for (let b = a + 1; b < vertexCount; b++) {
      if ((a >> 1) === (b >> 1)) continue; // 同一軸の ± 対(対蹠)は辺でない
      edges[e * 2] = a;
      edges[e * 2 + 1] = b;
      e++;
    }
  }

  return { n, vertexCount, edgeCount, vertices, edges };
}

export function makePolytope(family: PolytopeFamily, n: number): Polytope {
  switch (family) {
    case 'cube':
      return makeNCube(n);
    case 'simplex':
      return makeNSimplex(n);
    case 'orthoplex':
      return makeNOrthoplex(n);
  }
}

/**
 * 2-面の列挙(超平面スライス用 — slice.ts が辺∩超平面ではなく
 * 2-面∩超平面の線分を集めるために使う)。
 *
 * - cube:      軸対 (i<j) × 残り n−2 軸の符号 2^(n−2) 通り → 四角形
 * - simplex:   頂点の 3 部分集合すべて → C(n+1,3) 三角形
 * - orthoplex: 軸 3 つ組 (i<j<k) × 各符号 2³ → C(n,3)·8 三角形
 */
export function makeFaces2(family: PolytopeFamily, n: number): Faces2 {
  if (family === 'cube') {
    const pairCount = (n * (n - 1)) / 2;
    const perPair = 1 << (n - 2);
    const count = pairCount * perPair;
    const indices = new Uint32Array(count * 4);
    let f = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        // 残り軸のビット値 rest を、i・j の位置を飛ばして頂点インデックスへ展開
        for (let rest = 0; rest < perPair; rest++) {
          let base = 0;
          let bit = 0;
          for (let k = 0; k < n; k++) {
            if (k === i || k === j) continue;
            if ((rest >> bit) & 1) base |= 1 << k;
            bit++;
          }
          // 境界を巡る順: (0,0) → (1,0) → (1,1) → (0,1)
          indices[f * 4] = base;
          indices[f * 4 + 1] = base | (1 << i);
          indices[f * 4 + 2] = base | (1 << i) | (1 << j);
          indices[f * 4 + 3] = base | (1 << j);
          f++;
        }
      }
    }
    return { size: 4, count, indices };
  }

  if (family === 'simplex') {
    const m = n + 1;
    const count = (m * (m - 1) * (m - 2)) / 6;
    const indices = new Uint32Array(count * 3);
    let f = 0;
    for (let a = 0; a < m; a++) {
      for (let b = a + 1; b < m; b++) {
        for (let c = b + 1; c < m; c++) {
          indices[f * 3] = a;
          indices[f * 3 + 1] = b;
          indices[f * 3 + 2] = c;
          f++;
        }
      }
    }
    return { size: 3, count, indices };
  }

  // orthoplex
  const tripleCount = (n * (n - 1) * (n - 2)) / 6;
  const count = tripleCount * 8;
  const indices = new Uint32Array(count * 3);
  let f = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        for (let s = 0; s < 8; s++) {
          indices[f * 3] = 2 * i + (s & 1);
          indices[f * 3 + 1] = 2 * j + ((s >> 1) & 1);
          indices[f * 3 + 2] = 2 * k + ((s >> 2) & 1);
          f++;
        }
      }
    }
  }
  return { size: 3, count, indices };
}
