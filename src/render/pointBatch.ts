import * as THREE from 'three';
import { CYAN } from './palette';

export interface PointBatchOptions {
  /** グローの色(既定はパレットのシアン)。値はコピーされる */
  color?: THREE.Color;
  /** 加算合成の基礎輝度。ブルーム閾値 0.1 を超える程度に(既知の罠 #6) */
  brightness?: number;
  /** 距離 1 での見かけサイズ(CSS px)。実サイズは uScale / -mv.z */
  scale?: number;
  /** カメラに寄ったときの暴走防止(CSS px) */
  maxSize?: number;
  /** ガウス減衰の鋭さ。大きいほど芯が締まる */
  falloff?: number;
  pixelRatio?: number;
}

/**
 * カーソル近傍の応答半径(NDC、**画面高を基準**にした単位)。
 * 重力レンズの σ 0.09(短辺基準 UV)と同じ桁 ── 同じ「質量」が空間を歪め、
 * 頂点を明るくしていると読めるように揃えてある。
 */
const CURSOR_RADIUS = 0.12;
/** 応答のピーク倍率。輝度は ×1.35、大きさは ×1.15 まで */
const CURSOR_BRIGHT_GAIN = 0.35;
const CURSOR_SIZE_GAIN = 0.15;

const VERTEX_SHADER = /* glsl */ `
attribute float aSize;
attribute float aBright;

uniform float uPixelRatio;
uniform float uScale;
uniform float uMaxSize;

/*
  カーソル近傍の応答(Phase 22)。xy は NDC のカーソル位置、z は強さ(0..1)。

  頂点シェーダーで測るのは、CPU 側で 3264 点を NDC へ変換し直さないため ──
  gl_Position はもう計算されているので、必要なのは除算 1 回と指数 1 回だけ。
  強さが 0 のときは g も 0 になり、両方の係数が厳密に 1 倍へ戻る(polytope 展示は
  この uniform を一度も書かないので、恒等のまま回り続ける)。
*/
uniform vec3 uCursor;
/** 画面アスペクト(w/h)。掛けないと応答域が楕円になる */
uniform float uCursorAspect;

varying float vBright;

void main() {
  vBright = aBright;

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;

  // カメラ距離に対するサイズ減衰(星と違い瞬きはしない)
  float size = aSize * uScale / max(-mv.z, 0.1);

  if (uCursor.z > 0.001) {
    // w はカメラ面上/背後で 0 に近づく。割る前に必ず床を入れる
    vec2 ndc = gl_Position.xy / max(abs(gl_Position.w), 1e-4);
    vec2 d = (ndc - uCursor.xy) * vec2(uCursorAspect, 1.0);
    float g = uCursor.z * exp(-dot(d, d) / (2.0 * ${CURSOR_RADIUS.toFixed(4)} * ${CURSOR_RADIUS.toFixed(4)}));
    vBright *= 1.0 + ${CURSOR_BRIGHT_GAIN.toFixed(3)} * g;
    size *= 1.0 + ${CURSOR_SIZE_GAIN.toFixed(3)} * g;
  }

  gl_PointSize = min(size, uMaxSize) * uPixelRatio;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uBrightness;
uniform float uFalloff;

varying float vBright;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;

  float falloff = exp(-r2 * uFalloff);

  // AdditiveBlending は (SrcAlpha, One)。alpha は 1.0 固定で輝度は rgb へ集約する
  gl_FragColor = vec4(uColor * (uBrightness * vBright * falloff), 1.0);
}
`;

/**
 * 頂点グロー用の事前確保 Points ラッパー。
 *
 * 契約: `positions` は BufferAttribute の配列そのもの。呼び出し側が in-place で
 * 書き込み(投影関数の出力先にそのまま渡せる)、`commit(count)` で
 * needsUpdate + drawRange を更新する。毎フレームのアロケーションはゼロ。
 *
 * `material` は公開してあるので、DPR 変更時は engine.onResize から
 * `setPixelRatio()` を呼ぶこと。
 */
export class PointBatch {
  readonly maxPoints: number;
  /** 位置バッファの実体 [x,y,z] × maxPoints */
  readonly positions: Float32Array;
  /** 点ごとの基準サイズ(既定 1) */
  readonly sizes: Float32Array;
  /** 点ごとの輝度係数(既定 1)。深度キューはここへ書く */
  readonly brights: Float32Array;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.ShaderMaterial;
  readonly object: THREE.Points;

  private readonly positionAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;
  private readonly brightAttr: THREE.BufferAttribute;

  constructor(maxPoints: number, options: PointBatchOptions = {}) {
    this.maxPoints = maxPoints;
    this.positions = new Float32Array(maxPoints * 3);
    this.sizes = new Float32Array(maxPoints).fill(1);
    this.brights = new Float32Array(maxPoints).fill(1);

    this.positionAttr = new THREE.BufferAttribute(this.positions, 3);
    this.positionAttr.setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.sizes, 1);
    this.sizeAttr.setUsage(THREE.DynamicDrawUsage);
    this.brightAttr = new THREE.BufferAttribute(this.brights, 1);
    this.brightAttr.setUsage(THREE.DynamicDrawUsage);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this.positionAttr);
    geometry.setAttribute('aSize', this.sizeAttr);
    geometry.setAttribute('aBright', this.brightAttr);
    geometry.setDrawRange(0, 0);
    // frustumCulled=false なので実際には参照されないが、未使用領域を含む
    // 境界計算が走る経路を塞いでおく
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);
    this.geometry = geometry;

    const pixelRatio =
      options.pixelRatio ??
      Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, 2);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: (options.color ?? CYAN).clone() },
        uBrightness: { value: options.brightness ?? 0.9 },
        uFalloff: { value: options.falloff ?? 17 },
        uScale: { value: options.scale ?? 92 },
        uMaxSize: { value: options.maxSize ?? 56 },
        uPixelRatio: { value: pixelRatio },
        // 既定は「カーソルなし」。書かないかぎり応答は恒等(Phase 22)
        uCursor: { value: new THREE.Vector3(0, 0, 0) },
        uCursorAspect: { value: 1 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });

    this.object = new THREE.Points(geometry, this.material);
    this.object.name = 'pointBatch';
    this.object.frustumCulled = false;
  }

  /** 位置バッファの反映と描画点数の設定 */
  commit(count: number): void {
    const n = clampCount(count, this.maxPoints);
    this.positionAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, n);
  }

  /** aBright を毎フレーム書き換える場合に呼ぶ(深度キュー用) */
  commitBrightness(): void {
    this.brightAttr.needsUpdate = true;
  }

  /** aSize を書き換えた場合に呼ぶ */
  commitSizes(): void {
    this.sizeAttr.needsUpdate = true;
  }

  /** engine.onResize から呼ぶ(DPR 追従) */
  setPixelRatio(pixelRatio: number): void {
    this.material.uniforms.uPixelRatio.value = pixelRatio;
  }

  setBrightness(brightness: number): void {
    this.material.uniforms.uBrightness.value = brightness;
  }

  setColor(color: THREE.Color): void {
    (this.material.uniforms.uColor.value as THREE.Color).copy(color);
  }

  /**
   * カーソル近傍の応答(Phase 22)。nx/ny は NDC(−1..1、上が +y)、amount は 0..1。
   * amount = 0 でシェーダーの節ごとスキップされる ── 呼ばない展示は何も払わない。
   */
  setCursor(nx: number, ny: number, amount: number, aspect: number): void {
    const v = this.material.uniforms.uCursor.value as THREE.Vector3;
    v.set(nx, ny, amount > 0 ? (amount < 1 ? amount : 1) : 0);
    this.material.uniforms.uCursorAspect.value = aspect > 0 ? aspect : 1;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

function clampCount(value: number, max: number): number {
  if (!(value > 0)) return 0;
  return value > max ? max : value | 0;
}
