import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export interface PostFXOptions {
  /** MSAA サンプル数。呼び出し側で renderer.capabilities.maxSamples とクランプすること */
  samples?: number;
  bloomStrength?: number;
  bloomRadius?: number;
  bloomThreshold?: number;
}

export interface PostFX {
  readonly composer: EffectComposer;
  /** シーン差し替え用(renderPass.scene のみを付け替える) */
  readonly renderPass: RenderPass;
  readonly bloomPass: UnrealBloomPass;
  /** 最終段のグレーディング(ビネット/グレイン/色収差/ディザ) */
  readonly gradePass: ShaderPass;
  /** 現在の MSAA サンプル数(品質 HUD の表示用) */
  readonly samples: number;
  /** width/height は CSS ピクセル、pixelRatio は描画バッファ倍率 */
  setSize(width: number, height: number, pixelRatio: number): void;
  /** グレインのアニメーション時刻(秒)。reduced-motion では無視される */
  setTime(t: number): void;
  /** MSAA サンプル数の変更。レンダーターゲットを作り直す(品質ティア適用) */
  setSamples(samples: number): void;
  /** ブルームの内部解像度スケール。1 = drawingBuffer 等倍(mip 内部は 1/2) */
  setBloomScale(scale: number): void;
  /** ブルームの強さ。**内部解像度とペアで**動かすこと(下の調律ノートを読むこと) */
  setBloomStrength(strength: number): void;
  /** ブルームの mip 合成半径。低解像度ブルームのにじみを締めるのはこちら */
  setBloomRadius(radius: number): void;
  /** GradePass の有効/無効。DEV の before/after 比較用 */
  setGradeEnabled(on: boolean): void;
  /**
   * 重力レンズ(Phase 17)。cx/cy は UV(左下原点 0..1)、amount は 0..1。
   * amount = 0 でシェーダーは完全に恒等(uniform 分岐で計算ごとスキップ)。
   * 書き手は lens ドライバ(src/ui/lens.ts)ただ 1 つ。
   */
  setLens(cx: number, cy: number, amount: number): void;
}

const DEFAULT_SAMPLES = 4;
/**
 * ブルームの基準値(Phase 11 で実測して決めた調律)。
 *
 * Phase 8 までの既定は strength 0.95 / radius 0.4 / **threshold 0.1** で、
 * 監査の実測ではこの閾値が「veil(薄い膜)」の支配的な発生源だった:
 * 線の芯だけでなく、加算合成で持ち上がった**背景側の裾**まで丸ごと閾値を超え、
 * 画面全体に低周波のにじみが敷かれていた。閾値を 0.28 へ上げると裾が落ち、
 * 線の断面コントラスト (peak−floor)/floor が 4〜7 倍に改善する。
 * strength と radius も下げるが、**光の性格は変えない** ── 実測で FWHM
 * (にじみの半値幅)は据え置き、グローは芯の周りにだけ残る。
 * これらは測定して決めた値なので「改善」しないこと。
 *
 * ただし **この 3 つは「ULTRA での」基準値**である(Phase 12a)。
 * 内部解像度(bloomScale)を変えると同じ strength でも見え方が変わるため、
 * 解像度と強さ・半径はティアごとに**組で**決める ── その表は quality.ts の
 * TIERS ただ 1 箇所にあり、ここはその表が参照する基準点を置くだけ。
 *   ・bloomScale ↑(mip が細かくなる)→ 芯が締まり、同じ strength でも明るく出る
 *     → HIGH は scale 1 と引き換えに strength を 0.40 → 0.32 へ落とす
 *   ・bloomScale ↓(mip が粗くなる)→ 1 テクセルの受け持つ画面幅が広がりにじむ
 *     → BALANCED は scale 0.75 に radius 0.25 → 0.18 を組ませて締める
 */
export const BLOOM_BASE_STRENGTH = 0.4;
export const BLOOM_BASE_RADIUS = 0.25;
const DEFAULT_BLOOM_THRESHOLD = 0.28;

/**
 * グレードの既定強度(Phase 11 で再調律)。
 *   x: ビネット深度   — 隅で ×0.85(1 - 0.18 * 0.844)。「穴」ではなく空気として読める深さ
 *   y: グレイン振幅   — 表示値のピーク間 0.015(≒ ±1.9/255)。0.035 は暗部の
 *                       線と同じ振幅を持ち、細線の輪郭を濁らせていた(監査実測)。
 *                       **この値は DPR 等倍を前提にした量**なので、実効 DPR が
 *                       端末の DPR より低いときは setSize() が下記の比で縮める
 *   z: 色収差         — 画面隅での放射オフセット(描画バッファ px)。1.2px は
 *                       線幅 1.7〜2.6px に対して大きすぎ、二重像として読めた
 */
const GRADE_VIGNETTE = 0.18;
const GRADE_GRAIN = 0.015;
const GRADE_ABERRATION = 0.4;

/**
 * 重力レンズの調律(Phase 17、ブラウザ実測で決定)。距離は**短辺基準の UV**
 * (min(width,height) を 1 とする単位)で測る ── 画面アスペクトに依らず円になる。
 *
 *   SIGMA: ガウス裾の σ。見かけの影響圏はおよそ 2σ(短辺の ~18%)
 *   PULL:  中心へ引き込む倍率。変位は (uv−c)·amount·g·PULL で、
 *          ピーク変位は r=σ の位置で σ·e^{−1/2}·PULL ≒ 短辺の 3%。
 *          係数が r に比例するので**中心に特異点がない**(1/r 型レンズは
 *          カーソル直下で発散し、1 テクセルの色が円盤に引き伸ばされる)
 *   TWIST: 中心での回転角(rad)。慣性系の引きずりの引用。符号は CCW
 *   DISP:  R/B の PULL 差(±)。リムでだけ虹の縁が出る ── 全画面の色収差
 *          (uStrength.z)とは独立で、レンズの縁にのみ現れる
 *
 * これらはシェーダー内 const へ**焼き込む**(毎フレーム変える理由がなく、
 * uniform を増やすとドライバ側に「調律したくなる口」が生えるため)。
 */
const LENS_SIGMA = 0.09;
const LENS_PULL = 0.55;
const LENS_TWIST = 0.25;
const LENS_DISP = 0.12;

const GRADE_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * OutputPass の**後ろ**に置く前提のシェーダー。入力は既にトーンマップ + sRGB
 * エンコード済みの表示色空間なので、ここでの加減算はそのまま「見た目の量」になる。
 */
const GRADE_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform sampler2D tDiffuse;
uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uStrength;
// (中心UV.x, 中心UV.y, 強さ 0..1)。強さ 0 でレンズ節は丸ごとスキップされる
uniform vec3 uLens;

varying vec2 vUv;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// 1 テクセル 1 値のハッシュ(テクスチャ不要のホワイトノイズ)
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// 調律値は postfx.ts の LENS_* 定数から焼き込まれる(JS 側コメント参照)
const float LENS_SIGMA = ${LENS_SIGMA.toFixed(4)};
const float LENS_PULL = ${LENS_PULL.toFixed(4)};
const float LENS_TWIST = ${LENS_TWIST.toFixed(4)};
const float LENS_DISP = ${LENS_DISP.toFixed(4)};

void main() {
  vec2 d = vUv - 0.5;
  float r2 = dot(d, d);

  // ⓪ 重力レンズ: **サンプル座標**を歪める(ビネット/グレインは画面に固定のまま)。
  //    短辺基準の座標系 q で測るのでレンズは常に真円。変位は (uv−c) に比例するため
  //    中心に特異点がなく、中心ほど拡大される「質量のあるガラス」として読める。
  //    条件は uniform のみの分岐なので、レンズ不在(タッチ端末・reduced-motion)では
  //    ワープ全体でこの節が実行されない。
  vec2 uvR = vUv;
  vec2 uvG = vUv;
  vec2 uvB = vUv;
  if (uLens.z > 0.001) {
    vec2 asp = uResolution / min(uResolution.x, uResolution.y);
    vec2 q = (vUv - uLens.xy) * asp;
    float g = uLens.z * exp(-dot(q, q) / (2.0 * LENS_SIGMA * LENS_SIGMA));
    float a = g * LENS_TWIST;
    float cs = cos(a);
    float sn = sin(a);
    vec2 rq = mat2(cs, sn, -sn, cs) * q;
    float pull = g * LENS_PULL;
    uvR = uLens.xy + rq * (1.0 - pull * (1.0 - LENS_DISP)) / asp;
    uvG = uLens.xy + rq * (1.0 - pull) / asp;
    uvB = uLens.xy + rq * (1.0 - pull * (1.0 + LENS_DISP)) / asp;
  }

  // ① 色収差: 中心からの放射方向へ RGB をずらす。量は r² 比例(隅で uStrength.z px)
  vec2 shift = d * inversesqrt(max(r2, 1e-6)) * (uStrength.z * r2 * 2.0) / uResolution;
  vec3 color = vec3(
    texture2D(tDiffuse, uvR + shift).r,
    texture2D(tDiffuse, uvG).g,
    texture2D(tDiffuse, uvB - shift).b
  );

  // ② ビネット: 中心 55% はフラット、そこから隅へなだらかに落とす
  float rr = sqrt(r2) * 1.41421356;
  color *= 1.0 - uStrength.x * smoothstep(0.55, 1.15, rr);

  // ③ フィルムグレイン: 平均 0 の符号付きノイズ(輝度を持ち上げない)。
  //    ブルームのハイライトだけは粒を抑え、光の芯を濁らせない
  float lum = dot(color, LUMA);
  float grain = (hash12(gl_FragCoord.xy + uTime * 137.0) - 0.5) * uStrength.y;
  color += grain * (1.0 - 0.7 * smoothstep(0.55, 1.0, lum));

  // ④ ディザ: 8bit 量子化の**直前**に ±0.5/255。暗部グラデーションのバンディング対策
  color += (hash12(gl_FragCoord.xy + 17.31) - 0.5) * (1.0 / 255.0);

  gl_FragColor = vec4(color, 1.0);
}
`;

/**
 * ポストプロセスチェーンを構築する。
 *
 *   RenderPass(HalfFloat + MSAA) → UnrealBloomPass → OutputPass(ACES + sRGB) → GradePass
 *
 * GradePass は EffectComposer が最後の有効パスへ自動的に renderToScreen を立てるので、
 * 無効化すれば OutputPass がそのまま画面へ出る(DEV の before/after 比較がこれで成立する)。
 */
export function buildPostFX(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  opts: PostFXOptions = {},
): PostFX {
  const cssSize = renderer.getSize(new THREE.Vector2());
  let cssWidth = Math.max(1, cssSize.x);
  let cssHeight = Math.max(1, cssSize.y);
  let ratio = renderer.getPixelRatio();
  let samples = opts.samples ?? DEFAULT_SAMPLES;
  let bloomScale = 1;

  // HalfFloat: 加算合成の線がブルーム閾値を超える HDR 値を保持するために必須。
  // samples で MSAA を有効化(細いワイヤーのジャギー対策。renderer 側の antialias は false)。
  const createTarget = (width: number, height: number): THREE.WebGLRenderTarget => {
    const target = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
      type: THREE.HalfFloatType,
      samples,
      depthBuffer: true,
      stencilBuffer: false,
    });
    target.texture.name = 'DIMENSION.composer';
    return target;
  };

  const composer = new EffectComposer(
    renderer,
    createTarget(Math.round(cssWidth * ratio), Math.round(cssHeight * ratio)),
  );
  const renderPass = new RenderPass(scene, camera);

  // UnrealBloomPass は渡された resolution を内部で 1/2 にして mip 鎖を作る。
  // よって drawingBuffer サイズを渡すとブラー内部解像度が drawingBuffer の 1/2 になる
  // ── これが bloomScale=1(ULTRA / HIGH)の状態。BALANCED の 0.75 では 3/8 まで
  // 落ちるので、そのぶん radius を締めてにじみを戻す(quality.ts の TIERS を参照)。
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(Math.round(cssWidth * ratio), Math.round(cssHeight * ratio)),
    opts.bloomStrength ?? BLOOM_BASE_STRENGTH,
    opts.bloomRadius ?? BLOOM_BASE_RADIUS,
    opts.bloomThreshold ?? DEFAULT_BLOOM_THRESHOLD,
  );

  // OutputPass がトーンマッピング(renderer.toneMapping)と sRGB 変換をまとめて行う
  const outputPass = new OutputPass();

  const gradePass = new ShaderPass({
    name: 'DIMENSION.grade',
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uStrength: { value: new THREE.Vector3(GRADE_VIGNETTE, GRADE_GRAIN, GRADE_ABERRATION) },
      uLens: { value: new THREE.Vector3(0.5, 0.5, 0) },
    },
    vertexShader: GRADE_VERTEX_SHADER,
    fragmentShader: GRADE_FRAGMENT_SHADER,
  });
  // ShaderPass は uniforms を clone するので、参照は**構築後の pass 側**から取る
  const gradeTime = gradePass.uniforms.uTime as THREE.IUniform<number>;
  const gradeResolution = gradePass.uniforms.uResolution.value as THREE.Vector2;
  const gradeStrength = gradePass.uniforms.uStrength.value as THREE.Vector3;
  const gradeLens = gradePass.uniforms.uLens.value as THREE.Vector3;

  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(outputPass);
  composer.addPass(gradePass);

  const setSize = (width: number, height: number, pixelRatio: number): void => {
    cssWidth = Math.max(1, width);
    cssHeight = Math.max(1, height);
    ratio = pixelRatio;

    composer.setPixelRatio(pixelRatio);
    composer.setSize(cssWidth, cssHeight);

    const bufferWidth = Math.max(1, Math.round(cssWidth * pixelRatio));
    const bufferHeight = Math.max(1, Math.round(cssHeight * pixelRatio));

    // composer.setSize() は全 pass へ等倍サイズを配ってしまうため、ブルームだけ上書きする
    bloomPass.setSize(
      Math.max(1, Math.round(bufferWidth * bloomScale)),
      Math.max(1, Math.round(bufferHeight * bloomScale)),
    );
    // グレインとディザは描画バッファのピクセル格子で刻む(色収差の px 換算もここ)
    gradeResolution.set(bufferWidth, bufferHeight);

    /*
      グレインを実効 DPR へ追従させる(Phase 12a)。

      粒は **描画バッファの 1 テクセル = 1 粒** で刻む。DPR 3 の端末を BALANCED
      (dprCap 1.5)で走らせると 1 粒が 2×2 の物理ピクセルへ拡大され、面積で 4 倍、
      空間周波数は半分になる ── 同じ振幅でも「フィルムの粒」ではなく「砂嵐」として
      読める(監査: 弱い端末ほどノイズが目立つ、の正体)。実効 DPR が端末の DPR を
      下回るぶんだけ振幅を落とせば、見かけのざらつきが端末とティアによらず揃う。
      Math.min(1, …) で上限を 1 に留めるのは、DPR 1 の外部ディスプレイのように
      端末 DPR のほうが低い場合に**増幅しない**ため(基準値は等倍で決めた量)。
    */
    const nativeRatio = window.devicePixelRatio || 1;
    gradeStrength.y = GRADE_GRAIN * Math.min(1, pixelRatio / nativeRatio);
  };

  // addPass() は renderTarget サイズ基準の誤った size を各 pass へ配ってしまうため、
  // ここで CSS サイズ基準に正規化しておく。
  setSize(cssWidth, cssHeight, ratio);

  // グレインの凍結判定は起動時に一度だけ(毎フレーム matchMedia を叩かない)
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  return {
    composer,
    renderPass,
    bloomPass,
    gradePass,
    get samples(): number {
      return samples;
    },
    setSize,
    setTime(t: number): void {
      if (reduceMotion) return; // グレインを静止させる(プラン8節)
      gradeTime.value = t;
    },
    setSamples(next: number): void {
      const value = Math.max(0, Math.round(next));
      if (value === samples) return;
      samples = value;
      // WebGLRenderTarget.samples は生成後に変えても GPU 側の FBO へ伝わらない。
      // ターゲットごと作り直して composer.reset() で差し替える(旧ターゲットは reset が dispose)。
      composer.reset(createTarget(Math.round(cssWidth * ratio), Math.round(cssHeight * ratio)));
      setSize(cssWidth, cssHeight, ratio);
    },
    setBloomScale(scale: number): void {
      const value = scale > 0 ? scale : 1;
      if (value === bloomScale) return;
      bloomScale = value;
      setSize(cssWidth, cssHeight, ratio);
    },
    // strength / radius は UnrealBloomPass が毎 render で compositeMaterial の
    // uniform へ写す素のプロパティなので、代入するだけで次のフレームから効く
    // (レンダーターゲットの作り直しは不要 = ティア切替でフレーム落ちしない)
    setBloomStrength(strength: number): void {
      bloomPass.strength = strength >= 0 ? strength : 0;
    },
    setBloomRadius(radius: number): void {
      bloomPass.radius = radius >= 0 ? radius : 0;
    },
    setGradeEnabled(on: boolean): void {
      gradePass.enabled = on;
    },
    setLens(cx: number, cy: number, amount: number): void {
      // NaN は 0 側へ倒す(min/max の NaN 伝播は引数順に依存するため三項で書く)
      gradeLens.set(cx, cy, amount > 0 ? (amount < 1 ? amount : 1) : 0);
    },
  };
}
