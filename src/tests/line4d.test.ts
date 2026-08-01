import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { composeRot4 } from '../render/line4d';
import { rotateBatch, type PlaneRotation } from '../math/rotation';

/**
 * GPU パス(SO(4) 行列 uniform)と CPU パス(rotateBatch)の等価性検証。
 * これが一致していれば、シェーダー内の `uRot4 * v` は数学コアと同じ回転になる。
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('composeRot4', () => {
  const rand = mulberry32(7);
  const rots: PlaneRotation[] = [
    { i: 0, j: 1, angle: 0.83 },
    { i: 2, j: 3, angle: -1.91 },
    { i: 0, j: 2, angle: 2.47 },
    { i: 1, j: 3, angle: -0.35 },
  ];

  it('rotateBatch と同一の回転になる(適用順序を含めて)', () => {
    const m = composeRot4(rots, new THREE.Matrix4());
    for (let trial = 0; trial < 20; trial++) {
      const src = new Float64Array([
        rand() * 2 - 1,
        rand() * 2 - 1,
        rand() * 2 - 1,
        rand() * 2 - 1,
      ]);
      const expected = new Float64Array(4);
      rotateBatch(src, expected, 4, 1, rots);

      const v = new THREE.Vector4(src[0], src[1], src[2], src[3]).applyMatrix4(m);
      expect(v.x).toBeCloseTo(expected[0], 9);
      expect(v.y).toBeCloseTo(expected[1], 9);
      expect(v.z).toBeCloseTo(expected[2], 9);
      expect(v.w).toBeCloseTo(expected[3], 9);
    }
  });

  it('空の回転列は単位行列', () => {
    const m = composeRot4([], new THREE.Matrix4());
    expect(m.elements).toEqual(new THREE.Matrix4().identity().elements);
  });

  it('直交行列である(MᵀM = I, 1e-12)', () => {
    const m = composeRot4(rots, new THREE.Matrix4());
    const mt = m.clone().transpose();
    const prod = mt.multiply(m).elements;
    const identity = new THREE.Matrix4().identity().elements;
    for (let k = 0; k < 16; k++) {
      expect(prod[k]).toBeCloseTo(identity[k], 12);
    }
  });

  it('等傾二重回転 (0,1)+(2,3) は全単位ベクトルのノルムを保つ', () => {
    const iso: PlaneRotation[] = [
      { i: 0, j: 1, angle: 1.234 },
      { i: 2, j: 3, angle: 1.234 },
    ];
    const m = composeRot4(iso, new THREE.Matrix4());
    for (let trial = 0; trial < 10; trial++) {
      const v = new THREE.Vector4(rand() - 0.5, rand() - 0.5, rand() - 0.5, rand() - 0.5)
        .normalize()
        .applyMatrix4(m);
      expect(Math.hypot(v.x, v.y, v.z, v.w)).toBeCloseTo(1, 12);
    }
  });
});
