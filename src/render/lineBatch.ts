import * as THREE from 'three';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import type { LineMaterial } from 'three/addons/lines/LineMaterial.js';

/**
 * 事前確保した LineSegments2 ラッパー(プラン6節「ゼロアロケーション毎フレーム
 * データフロー」の GPU 側の橋)。
 *
 * 契約:
 * - `positions` / `colors` は **インスタンスバッファの実体そのもの**。呼び出し側は
 *   毎フレームここへ in-place で書き込み、commit で needsUpdate を立てるだけ。
 *   コピーも再確保も発生しない。
 * - 構築後に `setPositions()` / `setColors()` / `setFromPoints()` を呼んではならない。
 *   これらは新しい Float32Array と InstancedInterleavedBuffer を毎回確保する
 *   (既知の罠 #4)。
 * - needsUpdate は **InterleavedBuffer** に立てる。InterleavedBufferAttribute 側に
 *   立てても GPU へは反映されない(定番の罠 — WebGLAttributes は
 *   `attribute.isInterleavedBufferAttribute` を見て `attribute.data` を追跡する)。
 * - マテリアルは呼び出し側が生成する:
 *   `new LineMaterial({ vertexColors: true, transparent: true,
 *                       blending: THREE.AdditiveBlending, depthWrite: false, linewidth: px })`
 *   生成したら **必ず `engine.registerLineMaterial()` へ登録**すること
 *   (resize 時の resolution 更新漏れ = 既知の罠 #3)。
 */
export class LineBatch {
  /** 確保済みセグメント数の上限 */
  readonly maxSegments: number;
  /** インスタンス位置バッファの実体 [x0,y0,z0, x1,y1,z1] × maxSegments */
  readonly positions: Float32Array;
  /** インスタンス色バッファの実体 [r0,g0,b0, r1,g1,b1] × maxSegments */
  readonly colors: Float32Array;
  readonly geometry: LineSegmentsGeometry;
  readonly object: LineSegments2;

  private readonly positionBuffer: THREE.InstancedInterleavedBuffer;
  private readonly colorBuffer: THREE.InstancedInterleavedBuffer;
  /** 部分アップロード範囲。毎フレーム使い回す(push しても新規確保は起きない) */
  private readonly positionRange = { start: 0, count: 0 };
  private readonly colorRange = { start: 0, count: 0 };

  private activeCount = 0;
  private revealFactor = 1;

  constructor(maxSegments: number, material: LineMaterial) {
    this.maxSegments = maxSegments;
    this.positions = new Float32Array(maxSegments * 6);
    this.colors = new Float32Array(maxSegments * 6);

    const geometry = new LineSegmentsGeometry();

    // setPositions() と同じ結線を手動で組む(= 一度だけ確保して以後は書き換えるだけ)
    this.positionBuffer = new THREE.InstancedInterleavedBuffer(this.positions, 6, 1);
    this.positionBuffer.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(
      'instanceStart',
      new THREE.InterleavedBufferAttribute(this.positionBuffer, 3, 0),
    );
    geometry.setAttribute(
      'instanceEnd',
      new THREE.InterleavedBufferAttribute(this.positionBuffer, 3, 3),
    );

    // setColors() 相当。LineMaterial は vertexColors:true のとき USE_COLOR が定義され、
    // instanceColorStart / instanceColorEnd を読む。
    this.colorBuffer = new THREE.InstancedInterleavedBuffer(this.colors, 6, 1);
    this.colorBuffer.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(
      'instanceColorStart',
      new THREE.InterleavedBufferAttribute(this.colorBuffer, 3, 0),
    );
    geometry.setAttribute(
      'instanceColorEnd',
      new THREE.InterleavedBufferAttribute(this.colorBuffer, 3, 3),
    );

    geometry.instanceCount = 0;

    // 未使用領域(全ゼロ)を含む境界計算を走らせないための防御。
    // frustumCulled=false かつ raycast もしないので実際には参照されないが、
    // LineSegmentsGeometry.computeBoundingSphere() が NaN 警告を出す経路を塞ぐ。
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(-1e6, -1e6, -1e6),
      new THREE.Vector3(1e6, 1e6, 1e6),
    );

    this.geometry = geometry;

    this.object = new LineSegments2(geometry, material);
    this.object.name = 'lineBatch';
    // 動的バッファなのでバウンディング球の再計算コストと範囲外ゴミを構造的に排除
    this.object.frustumCulled = false;
  }

  /** 現在有効なセグメント数(reveal 適用前) */
  get segmentCount(): number {
    return this.activeCount;
  }

  /** 現在の draw-on 係数 */
  get reveal(): number {
    return this.revealFactor;
  }

  /**
   * 位置バッファの先頭 `segCount` セグメントを GPU へ反映する。
   * 書き込みは呼び出し側が `positions` へ直接済ませておくこと。
   */
  commitPositions(segCount: number): void {
    this.activeCount = clampCount(segCount, this.maxSegments);
    this.uploadRange(this.positionBuffer, this.positionRange, this.activeCount);
    this.applyInstanceCount();
  }

  /** 色バッファの先頭 `segCount` セグメントを GPU へ反映する */
  commitColors(segCount: number): void {
    this.uploadRange(this.colorBuffer, this.colorRange, clampCount(segCount, this.maxSegments));
  }

  /**
   * draw-on 遷移のプリミティブ。f ∈ [0,1] を描画セグメント比率として適用する
   * (プラン3節: reveal で instanceCount を伸ばすアロケーションフリーな入場演出)。
   */
  setReveal(f: number): void {
    this.revealFactor = f < 0 ? 0 : f > 1 ? 1 : f;
    this.applyInstanceCount();
  }

  dispose(): void {
    this.geometry.dispose();
  }

  private applyInstanceCount(): void {
    this.geometry.instanceCount = Math.floor(this.activeCount * this.revealFactor);
  }

  /**
   * updateRanges を使って「使用中の先頭部分だけ」を bufferSubData する。
   * 範囲オブジェクトは使い回すので毎フレームのアロケーションはゼロ
   * (three は転送後に updateRanges を空にするため、毎回 length=0 → push し直す)。
   */
  private uploadRange(
    buffer: THREE.InstancedInterleavedBuffer,
    range: { start: number; count: number },
    segCount: number,
  ): void {
    if (segCount === 0) return; // 空アップロードは全域転送に化けるので何もしない
    const ranges = buffer.updateRanges;
    ranges.length = 0;
    range.start = 0;
    range.count = segCount * 6;
    ranges.push(range);
    buffer.needsUpdate = true; // attribute ではなく InterleavedBuffer 側に立てる
  }
}

function clampCount(value: number, max: number): number {
  if (!(value > 0)) return 0;
  return value > max ? max : value | 0;
}
