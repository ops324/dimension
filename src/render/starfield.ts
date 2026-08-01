import * as THREE from 'three';

export interface Starfield {
  /** アクティブなシーンへ add() して使い回す共有オブジェクト */
  readonly group: THREE.Group;
  update(dt: number): void;
  /**
   * 描画バッファ倍率の変更に uPixelRatio を追従させる。
   * これを怠ると DPR を上げたときに星が CSS ピクセル基準の大きさのまま縮む
   * (生成時の値を握りっぱなしにする実装の典型的な罠)。
   */
  setPixelRatio(ratio: number): void;
  /**
   * 星の密度スケール(1 = 全 3 層 / 0.5 = 手前の層だけ)。
   * 個々の Points の中身は触らず、遠い層から visible を落とすだけ ──
   * ジオメトリの作り直しもアロケーションも発生しない。
   */
  setDensity(factor: number): void;
}

interface LayerConfig {
  count: number;
  radius: number;
  /** 基準距離での見かけサイズ(CSS px 相当) */
  size: number;
  /** 加算合成の基礎輝度。ブルーム閾値 0.1 をわずかに超える程度に抑える */
  brightness: number;
  twinkleSpeed: number;
}

// 近/中/遠の 3 層。遠いほど小さく暗く、瞬きもゆっくり。
// brightness は「星色 #cdd6ff の輝度係数 0.683 を掛けた値がブルーム閾値 0.1 を
// 下回る」ように選んである(典型星は非発光、スパークルの 1/4 だけが閾値を超える)。
const LAYERS: readonly LayerConfig[] = [
  { count: 3000, radius: 40, size: 3.0, brightness: 0.155, twinkleSpeed: 1.7 },
  { count: 2000, radius: 55, size: 2.3, brightness: 0.115, twinkleSpeed: 1.15 },
  { count: 1000, radius: 70, size: 1.7, brightness: 0.085, twinkleSpeed: 0.8 },
];

/** 星は青白。ColorManagement が有効なので Color は線形値として uniform に載る */
const STAR_COLOR = 0xcdd6ff;

/** 全体の 1/4 だけ明るくしてスパークルを作る(輝度上限 0.26 * 1.35 ≒ 0.35) */
const SPARKLE_RATIO = 0.25;
const SPARKLE_GAIN = 1.35;

/**
 * ネブラ球の半径。カメラ距離 20 以上で遠平面(engine の CAMERA_FAR)に切られて
 * 多角形のシルエットが出ていたため、球を十分遠くへ逃がす(Phase 5 の指摘)。
 * 遠平面 400 に対し、最遠カメラ(距離 40)からでも 190 で収まる。
 */
const NEBULA_RADIUS = 150;
/** 分割数。全天を覆う球なので輪郭が折れない程度に細かくする(64×40 → 4992 三角形と軽い) */
const NEBULA_SEGMENTS_W = 64;
const NEBULA_SEGMENTS_H = 40;
/**
 * ネブラの色付き成分の上限(シーン線形)。ACES + sRGB を通した後のピークが
 * rgb(6,17,29) 程度になる値で、#05060f のベースからごく僅かに立ち上がるだけ。
 */
const NEBULA_INTENSITY = 0.012;

/**
 * 空のベース色。ACES(exposure 1.1) + sRGB エンコードを通すと厳密に #05060f に
 * なるシーン線形値。GL のクリアカラーは色空間リーク回避のため黒に固定してあり
 * (engine.ts の CLEAR_COLOR 参照)、背景色はこのネブラ球が担う。
 * CSS の --bg と一致させることで、Phase 3 以降に canvas 上へ重ねる HTML との
 * 境界が見えないようにする。
 */
const NEBULA_BASE = new THREE.Vector3(0.006765, 0.00756, 0.014759);

const GROUP_SPIN_Y = 0.002;
const GROUP_SPIN_X = 0.0005;

const STAR_VERTEX_SHADER = /* glsl */ `
attribute float aPhase;
attribute float aSize;
attribute float aBright;

uniform float uPixelRatio;
uniform float uAttenuation;

varying float vPhase;
varying float vBright;

void main() {
  vPhase = aPhase;
  vBright = aBright;

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;

  // 遠近減衰: 層の基準半径で 1.0 になるよう正規化してある
  gl_PointSize = aSize * uPixelRatio * (uAttenuation / max(-mv.z, 1.0));
}
`;

const STAR_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform float uTime;
uniform vec3 uColor;
uniform float uBrightness;
uniform float uTwinkleSpeed;

varying float vPhase;
varying float vBright;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;

  float falloff = exp(-r2 * 26.0);                              // ガウス放射減衰
  float twinkle = 0.75 + 0.25 * sin(uTime * uTwinkleSpeed + vPhase);

  // AdditiveBlending は (SrcAlpha, One) なので alpha は 1.0 に固定し、輝度は rgb へ集約する
  gl_FragColor = vec4(uColor * (uBrightness * vBright * falloff * twinkle), 1.0);
}
`;

const NEBULA_VERTEX_SHADER = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const NEBULA_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uIntensity;
uniform vec3 uBase;
uniform vec3 uViolet;
uniform vec3 uCyan;
uniform vec3 uMagenta;

varying vec3 vDir;

// ハッシュベースの value noise(テクスチャ不要)
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);

  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));

  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

// 4 オクターブ fBm
float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * vnoise(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

void main() {
  vec3 dir = normalize(vDir);

  float n1 = fbm(dir * 2.2 + vec3(0.0, uTime * 0.008, 0.0));
  float n2 = fbm(dir * 4.1 + vec3(11.3, 5.7, 2.1));

  vec3 tint = mix(uViolet, uCyan, smoothstep(0.30, 0.72, n1));
  tint = mix(tint, uMagenta, smoothstep(0.52, 0.88, n2) * 0.45);

  float amount = smoothstep(0.28, 0.86, n1 * 0.65 + n2 * 0.35);

  // uBase = 空のベース色(トーンマップ後に #05060f)、そこへ極僅かな色付きを加算
  gl_FragColor = vec4(uBase + tint * (amount * uIntensity), 1.0);
}
`;

/**
 * 3 層の加算 Points 星背景 + fBm ネブラ背面球。
 * DPR の初期値は engine の起動時上限(2)に合わせ、以後は setPixelRatio() で追従する。
 */
export function createStarfield(): Starfield {
  const group = new THREE.Group();
  group.name = 'starfield';

  const pixelRatio = Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, 2);
  const starColor = new THREE.Color(STAR_COLOR);

  // update() 内でアロケーションしないよう uniform の参照を事前収集する
  const timeUniforms: THREE.IUniform<number>[] = [];
  const ratioUniforms: THREE.IUniform<number>[] = [];
  const layerPoints: THREE.Points[] = [];

  for (const layer of LAYERS) {
    const { points, timeUniform, ratioUniform } = createStarLayer(layer, starColor, pixelRatio);
    group.add(points);
    layerPoints.push(points);
    timeUniforms.push(timeUniform);
    ratioUniforms.push(ratioUniform);
  }

  const nebula = createNebula();
  group.add(nebula.mesh);
  timeUniforms.push(nebula.timeUniform);

  // 密度判定用の累積本数(近い層から)。ネブラは背景色そのものなので常に残す
  const totalStars = LAYERS.reduce((sum, layer) => sum + layer.count, 0);
  const cumulative: number[] = [];
  let running = 0;
  for (const layer of LAYERS) {
    running += layer.count;
    cumulative.push(running);
  }

  let elapsed = 0;

  return {
    group,
    update(dt: number): void {
      elapsed += dt;
      group.rotation.y += GROUP_SPIN_Y * dt;
      group.rotation.x += GROUP_SPIN_X * dt;
      for (let i = 0; i < timeUniforms.length; i++) {
        timeUniforms[i].value = elapsed;
      }
    },
    setPixelRatio(ratio: number): void {
      const value = ratio > 0 ? ratio : 1;
      for (let i = 0; i < ratioUniforms.length; i++) {
        ratioUniforms[i].value = value;
      }
    },
    setDensity(factor: number): void {
      // 累積本数が予算を超える層から先に落とす。手前の層(最も構図に効く)は必ず残す。
      // LAYERS = [3000, 2000, 1000] なので factor=0.5 → 手前 3000 本ちょうどが残る
      const budget = totalStars * factor;
      for (let i = 0; i < layerPoints.length; i++) {
        layerPoints[i].visible = i === 0 || cumulative[i] <= budget;
      }
    },
  };
}

function createStarLayer(
  layer: LayerConfig,
  color: THREE.Color,
  pixelRatio: number,
): {
  points: THREE.Points;
  timeUniform: THREE.IUniform<number>;
  ratioUniform: THREE.IUniform<number>;
} {
  const { count, radius } = layer;

  const positions = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const sizes = new Float32Array(count);
  const brights = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // 球面上の一様分布(cosθ を一様サンプル)+ わずかな半径ジッタ
    const cosTheta = Math.random() * 2 - 1;
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const phi = Math.random() * Math.PI * 2;
    const r = radius * (0.92 + Math.random() * 0.16);

    positions[i * 3] = r * sinTheta * Math.cos(phi);
    positions[i * 3 + 1] = r * cosTheta;
    positions[i * 3 + 2] = r * sinTheta * Math.sin(phi);

    phases[i] = Math.random() * Math.PI * 2;
    sizes[i] = layer.size * (0.7 + Math.random() * 0.6);
    brights[i] =
      Math.random() < SPARKLE_RATIO
        ? 1.0 + Math.random() * (SPARKLE_GAIN - 1.0)
        : 0.65 + Math.random() * 0.35;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aBright', new THREE.BufferAttribute(brights, 1));

  const timeUniform: THREE.IUniform<number> = { value: 0 };
  const ratioUniform: THREE.IUniform<number> = { value: pixelRatio };

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: timeUniform,
      uColor: { value: color },
      uBrightness: { value: layer.brightness },
      uTwinkleSpeed: { value: layer.twinkleSpeed },
      uPixelRatio: ratioUniform,
      uAttenuation: { value: radius },
    },
    vertexShader: STAR_VERTEX_SHADER,
    fragmentShader: STAR_FRAGMENT_SHADER,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });

  const points = new THREE.Points(geometry, material);
  points.name = `starfield.layer.${radius}`;

  return { points, timeUniform, ratioUniform };
}

function createNebula(): { mesh: THREE.Mesh; timeUniform: THREE.IUniform<number> } {
  const geometry = new THREE.SphereGeometry(NEBULA_RADIUS, NEBULA_SEGMENTS_W, NEBULA_SEGMENTS_H);
  const timeUniform: THREE.IUniform<number> = { value: 0 };

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: timeUniform,
      uIntensity: { value: NEBULA_INTENSITY },
      uBase: { value: NEBULA_BASE },
      uViolet: { value: new THREE.Color(0x9d6bff) },
      uCyan: { value: new THREE.Color(0x4fd8ff) },
      uMagenta: { value: new THREE.Color(0xff4fd8) },
    },
    vertexShader: NEBULA_VERTEX_SHADER,
    fragmentShader: NEBULA_FRAGMENT_SHADER,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    transparent: true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'starfield.nebula';
  // 常に最背面。depthTest を切っているので描画順を明示する必要がある
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;

  return { mesh, timeUniform };
}
