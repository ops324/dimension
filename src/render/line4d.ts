import * as THREE from 'three';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { PlaneRotation } from '../math/rotation';
import { projectStereographic } from '../math/projection';

/**
 * 4D 属性 GPU ラインパス(プラン5節)。
 *
 * S³ 上の線分の両端 4D 座標 (x,y,z,w) を **静的な** インスタンス属性
 * `instanceStart4` / `instanceEnd4` として焼き込み、LineMaterial の頂点シェーダーを
 * onBeforeCompile で拡張して、SO(4) 回転(uniform mat4)とステレオ投影を
 * GPU 内で行う。毎フレームの CPU コストは 4×4 行列の合成だけ、バッファの
 * 再アップロードはゼロになり、23 万線分級のファイバー束が 60fps で回る。
 *
 * w→1(投影極)を跨ぐ線分は無限遠へ伸びるため、シェーダー内で両端の投影後
 * 距離が閾値を超えたら縮退させて不可視化する(既知の罠 #1 の GPU 側解決)。
 *
 * three のバージョン更新でシェーダー文字列が変わり置換アンカーが見つからない
 * 場合は、コンソールに警告を出して CPU パス(毎フレーム rotate+投影+書込)へ
 * フォールバックする(既知の罠 #11)。
 */

/** LineMaterial 頂点シェーダー内の置換アンカー(three r185 実物から採取) */
const ANCHOR_START = 'vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );';
const ANCHOR_END = 'vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );';

const INJECT_DECLS = /* glsl */ `
attribute vec4 instanceStart4;
attribute vec4 instanceEnd4;
uniform mat4 uRot4;
uniform float uStereoEps;
uniform float uMaxSegLen2;
void main() {`;

const INJECT_BODY = /* glsl */ `
	// ---- DIMENSION 4D パス: SO(4) 回転 → ステレオ投影 S³→R³ を GPU で行う ----
	vec4 rs4 = uRot4 * instanceStart4;
	vec4 re4 = uRot4 * instanceEnd4;
	vec3 s3 = rs4.xyz / max( 1.0 - rs4.w, uStereoEps );
	vec3 e3 = re4.xyz / max( 1.0 - re4.w, uStereoEps );
	vec3 seg4d = e3 - s3;
	if ( dot( seg4d, seg4d ) > uMaxSegLen2 ) { e3 = s3; } // 極ストリークの縮退
	vec4 start = modelViewMatrix * vec4( s3, 1.0 );
	vec4 end = modelViewMatrix * vec4( e3, 1.0 );`;

const STEREO_EPS = 1e-4;

/**
 * PlaneRotation 列(4D: 軸 0..3)を SO(4) の 4×4 行列へ合成する。
 * rotateBatch と同じ適用順序(v ← G_r v を r=0.. の順)になるよう、
 * 各 Givens を**左から**掛ける。target を書き換えて返す(アロケーションなし)。
 */
export function composeRot4(
  rots: readonly PlaneRotation[],
  target: THREE.Matrix4,
): THREE.Matrix4 {
  target.identity();
  const e = target.elements; // column-major
  for (let r = 0; r < rots.length; r++) {
    const rot = rots[r];
    const i = rot.i;
    const j = rot.j;
    const c = Math.cos(rot.angle);
    const s = Math.sin(rot.angle);
    // 左乗算 G(i,j)·M: 各列 col の行 i, j 成分だけが混ざる
    for (let col = 0; col < 4; col++) {
      const o = col * 4;
      const a = e[o + i];
      const b = e[o + j];
      e[o + i] = a * c - b * s;
      e[o + j] = a * s + b * c;
    }
  }
  return target;
}

export interface Line4DBatchOptions {
  /** 線幅(CSS px) */
  linewidth?: number;
  /** 極ストリーク縮退の距離閾値(ワールド単位) */
  maxSegmentLength?: number;
  /**
   * シーンフォグに反応させる。加算合成では黒フォグ = 距離減衰として働き、
   * 束の裏側の加算積み上げを抑えつつ奥行きの知覚を与える(Hopf 用)。
   */
  fog?: boolean;
}

export class Line4DBatch {
  readonly maxSegments: number;
  /**
   * 線分両端の S³ 座標 [sx,sy,sz,sw, ex,ey,ez,ew] × maxSegments。
   * 再構築(分布変更)時のみ書き換え、commitData() で一括アップロードする。
   */
  readonly data4: Float32Array;
  /** 線分両端の色 [r,g,b, r,g,b] × maxSegments。分布変更時のみ */
  readonly colors: Float32Array;
  readonly geometry: LineSegmentsGeometry;
  readonly material: LineMaterial;
  readonly object: LineSegments2;
  /** GPU パスが有効か(false = CPU フォールバック動作中) */
  readonly gpuPath: boolean;

  private readonly data4Buffer: THREE.InstancedInterleavedBuffer;
  private readonly colorBuffer: THREE.InstancedInterleavedBuffer;
  private readonly rot4Uniform: THREE.IUniform<THREE.Matrix4>;
  private readonly maxSegLen2Uniform: THREE.IUniform<number>;

  /** CPU フォールバック時のみ確保される標準 instanceStart/End バッファ */
  private cpuPositions: Float32Array | null = null;
  private cpuPositionBuffer: THREE.InstancedInterleavedBuffer | null = null;
  /** CPU フォールバックの作業領域(回転後の 4D 座標と投影結果) */
  private cpuScratch4: Float64Array | null = null;
  private cpuScratch3: Float32Array | null = null;
  private cpuSource4: Float64Array | null = null;

  private activeCount = 0;
  private revealFactor = 1;

  constructor(maxSegments: number, opts: Line4DBatchOptions = {}) {
    this.maxSegments = maxSegments;
    this.data4 = new Float32Array(maxSegments * 8);
    this.colors = new Float32Array(maxSegments * 6);

    this.rot4Uniform = { value: new THREE.Matrix4() };
    this.maxSegLen2Uniform = { value: (opts.maxSegmentLength ?? 8) ** 2 };

    const material = new LineMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      linewidth: opts.linewidth ?? 2,
    });
    // ShaderMaterial の fog 既定は false。true にするとシーンに fog がある場合のみ
    // USE_FOG が定義される(fog の無いシーンでは無害)
    material.fog = opts.fog ?? false;

    // アンカーが実在するかを組み込み前に検証する(既知の罠 #11)。
    // ShaderLib['line'] は LineMaterial が使う実物のシェーダーソース。
    const source = (THREE.ShaderLib as Record<string, { vertexShader?: string }>)['line']
      ?.vertexShader;
    const gpuPath =
      typeof source === 'string' &&
      source.includes(ANCHOR_START) &&
      source.includes(ANCHOR_END) &&
      source.includes('void main() {');
    this.gpuPath = gpuPath;

    if (gpuPath) {
      const rot4 = this.rot4Uniform;
      const eps: THREE.IUniform<number> = { value: STEREO_EPS };
      const maxLen2 = this.maxSegLen2Uniform;
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uRot4 = rot4;
        shader.uniforms.uStereoEps = eps;
        shader.uniforms.uMaxSegLen2 = maxLen2;
        shader.vertexShader = shader.vertexShader
          .replace('void main() {', INJECT_DECLS)
          .replace(ANCHOR_START, '')
          .replace(ANCHOR_END, INJECT_BODY);
      };
      // onBeforeCompile を持つマテリアルはプログラムキャッシュキーを分離する
      material.customProgramCacheKey = () => 'dimension.line4d';
    } else {
      console.warn(
        '[line4d] three のシェーダー更新により置換アンカーが見つからないため ' +
          'CPU パスへフォールバックします(three のバージョン pin を確認してください)',
      );
    }

    const geometry = new LineSegmentsGeometry();

    this.data4Buffer = new THREE.InstancedInterleavedBuffer(this.data4, 8, 1);
    // GPU パスでは分布変更時のみアップロード(既定 StaticDraw 相当でも良いが
    // ファイバー数変更 UI があるため Dynamic にしておく)
    this.data4Buffer.setUsage(THREE.DynamicDrawUsage);
    if (gpuPath) {
      geometry.setAttribute(
        'instanceStart4',
        new THREE.InterleavedBufferAttribute(this.data4Buffer, 4, 0),
      );
      geometry.setAttribute(
        'instanceEnd4',
        new THREE.InterleavedBufferAttribute(this.data4Buffer, 4, 4),
      );
    } else {
      // CPU フォールバック: 標準の instanceStart/End を毎フレーム書き換える
      this.cpuPositions = new Float32Array(maxSegments * 6);
      this.cpuPositionBuffer = new THREE.InstancedInterleavedBuffer(this.cpuPositions, 6, 1);
      this.cpuPositionBuffer.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(
        'instanceStart',
        new THREE.InterleavedBufferAttribute(this.cpuPositionBuffer, 3, 0),
      );
      geometry.setAttribute(
        'instanceEnd',
        new THREE.InterleavedBufferAttribute(this.cpuPositionBuffer, 3, 3),
      );
      this.cpuScratch4 = new Float64Array(8);
      this.cpuScratch3 = new Float32Array(6);
      this.cpuSource4 = new Float64Array(maxSegments * 8);
    }

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
    // 動的ジオメトリ: 事前計算不能なバウンディングは巨大な固定値で塞ぐ
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(-1e6, -1e6, -1e6),
      new THREE.Vector3(1e6, 1e6, 1e6),
    );
    this.geometry = geometry;

    this.material = material;
    this.object = new LineSegments2(geometry, material);
    this.object.name = 'line4dBatch';
    this.object.frustumCulled = false;
  }

  get segmentCount(): number {
    return this.activeCount;
  }

  /**
   * data4 / colors の先頭 segCount 線分を GPU へ反映する(分布の再構築時のみ)。
   * 毎フレーム呼んではならない — 毎フレーム変わるのは回転 uniform だけ。
   */
  commitData(segCount: number): void {
    this.activeCount = clampCount(segCount, this.maxSegments);
    this.data4Buffer.needsUpdate = true;
    this.colorBuffer.needsUpdate = true;
    if (this.cpuSource4 !== null) {
      // CPU フォールバックは倍精度の元データを保持しておく
      this.cpuSource4.set(this.data4.subarray(0, this.activeCount * 8));
    }
    this.applyInstanceCount();
  }

  /** 毎フレームの回転更新。GPU パスでは uniform 書換えのみで完結する */
  setRotation(rots: readonly PlaneRotation[]): void {
    composeRot4(rots, this.rot4Uniform.value);
    if (!this.gpuPath) this.cpuProject();
  }

  /** 極ストリーク縮退の距離閾値(ワールド単位) */
  setMaxSegmentLength(len: number): void {
    this.maxSegLen2Uniform.value = len * len;
  }

  setReveal(f: number): void {
    this.revealFactor = f < 0 ? 0 : f > 1 ? 1 : f;
    this.applyInstanceCount();
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private applyInstanceCount(): void {
    this.geometry.instanceCount = Math.floor(this.activeCount * this.revealFactor);
  }

  /**
   * CPU フォールバック: 回転行列を CPU で各端点に適用し、ステレオ投影して
   * 標準の instanceStart/End バッファへ書く。GPU パスと同じ縮退規則を適用する。
   */
  private cpuProject(): void {
    const src = this.cpuSource4;
    const pos = this.cpuPositions;
    const buf = this.cpuPositionBuffer;
    const p4 = this.cpuScratch4;
    const p3 = this.cpuScratch3;
    if (src === null || pos === null || buf === null || p4 === null || p3 === null) return;

    const m = this.rot4Uniform.value.elements;
    const maxLen2 = this.maxSegLen2Uniform.value;
    const count = this.activeCount;

    for (let s = 0; s < count; s++) {
      const o = s * 8;
      // 両端に 4×4 行列を適用(column-major: out_r = Σ_c m[c*4+r]·v_c)
      for (let end = 0; end < 2; end++) {
        const io = o + end * 4;
        const x = src[io];
        const y = src[io + 1];
        const z = src[io + 2];
        const w = src[io + 3];
        for (let row = 0; row < 4; row++) {
          p4[end * 4 + row] = m[row] * x + m[4 + row] * y + m[8 + row] * z + m[12 + row] * w;
        }
      }
      projectStereographic(p4, 2, p3, STEREO_EPS);

      const po = s * 6;
      const dx = p3[3] - p3[0];
      const dy = p3[4] - p3[1];
      const dz = p3[5] - p3[2];
      const collapse = dx * dx + dy * dy + dz * dz > maxLen2;
      pos[po] = p3[0];
      pos[po + 1] = p3[1];
      pos[po + 2] = p3[2];
      pos[po + 3] = collapse ? p3[0] : p3[3];
      pos[po + 4] = collapse ? p3[1] : p3[4];
      pos[po + 5] = collapse ? p3[2] : p3[5];
    }

    buf.needsUpdate = true;
  }
}

function clampCount(value: number, max: number): number {
  if (!(value > 0)) return 0;
  return value > max ? max : value | 0;
}
