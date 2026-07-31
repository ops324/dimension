/**
 * n 次元空間の回転。
 *
 * n 次元の回転は「2 次元平面の中の回転」の合成として表せる(SO(n) の生成元)。
 * 平面 (i, j) の Givens 回転は座標 i, j だけに触れるため、1 頂点あたり
 * 4 乗算 + 2 加算で済む。
 *
 * 角度は毎フレーム経過時刻 t から絶対値で再計算する契約(angle = ω·t)。
 * 増分回転を積み重ねると浮動小数の誤差でノルムがドリフトするが、
 * 絶対角なら誤差は蓄積しない。
 */

export interface PlaneRotation {
  /** 回転平面の第 1 軸(0 ≤ i < n) */
  i: number;
  /** 回転平面の第 2 軸(0 ≤ j < n, i ≠ j) */
  j: number;
  /** 回転角(ラジアン)。毎フレーム t から絶対値で設定する */
  angle: number;
}

/**
 * `count` 個の n 次元ベクトル(インターリーブ配置 src[v*n + k])へ
 * 平面回転の列を順に適用し dst へ書き込む。src === dst でもよい。
 * ホットパス: アロケーションなし。
 */
export function rotateBatch(
  src: Float64Array,
  dst: Float64Array,
  n: number,
  count: number,
  rots: readonly PlaneRotation[],
): void {
  const total = n * count;
  if (dst !== src) {
    for (let k = 0; k < total; k++) dst[k] = src[k];
  }
  for (let r = 0; r < rots.length; r++) {
    const rot = rots[r];
    const i = rot.i;
    const j = rot.j;
    const c = Math.cos(rot.angle);
    const s = Math.sin(rot.angle);
    for (let v = 0; v < count; v++) {
      const o = v * n;
      const a = dst[o + i];
      const b = dst[o + j];
      dst[o + i] = a * c - b * s;
      dst[o + j] = a * s + b * c;
    }
  }
}
