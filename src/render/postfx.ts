import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

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
  /** width/height は CSS ピクセル、pixelRatio は描画バッファ倍率 */
  setSize(width: number, height: number, pixelRatio: number): void;
}

const DEFAULT_SAMPLES = 4;
const DEFAULT_BLOOM_STRENGTH = 0.95;
const DEFAULT_BLOOM_RADIUS = 0.4;
const DEFAULT_BLOOM_THRESHOLD = 0.1;

/**
 * ポストプロセスチェーンを構築する。
 *
 *   RenderPass(HalfFloat + MSAA) → UnrealBloomPass → OutputPass(ACES + sRGB)
 *
 * GradePass(ビネット/グレイン/ディザ)は Phase 8 で追加する。
 */
export function buildPostFX(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  opts: PostFXOptions = {},
): PostFX {
  const cssSize = renderer.getSize(new THREE.Vector2());
  const pixelRatio = renderer.getPixelRatio();
  const bufferWidth = Math.max(1, Math.round(cssSize.x * pixelRatio));
  const bufferHeight = Math.max(1, Math.round(cssSize.y * pixelRatio));

  // HalfFloat: 加算合成の線がブルーム閾値を超える HDR 値を保持するために必須。
  // samples で MSAA を有効化(細いワイヤーのジャギー対策。renderer 側の antialias は false)。
  const renderTarget = new THREE.WebGLRenderTarget(bufferWidth, bufferHeight, {
    type: THREE.HalfFloatType,
    samples: opts.samples ?? DEFAULT_SAMPLES,
    depthBuffer: true,
    stencilBuffer: false,
  });
  renderTarget.texture.name = 'DIMENSION.composer';

  const composer = new EffectComposer(renderer, renderTarget);
  const renderPass = new RenderPass(scene, camera);

  // UnrealBloomPass は渡された resolution を内部で 1/2 にして mip 鎖を作る。
  // よって drawingBuffer サイズを渡すとブラー内部解像度が drawingBuffer の 1/2 になり、
  // プラン5節の指定と一致する。composer.setSize() も同じ effective size を pass へ
  // 転送するため、初期構築時とリサイズ後で解像度が一貫する。
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(bufferWidth, bufferHeight),
    opts.bloomStrength ?? DEFAULT_BLOOM_STRENGTH,
    opts.bloomRadius ?? DEFAULT_BLOOM_RADIUS,
    opts.bloomThreshold ?? DEFAULT_BLOOM_THRESHOLD,
  );

  // OutputPass がトーンマッピング(renderer.toneMapping)と sRGB 変換をまとめて行う
  const outputPass = new OutputPass();

  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(outputPass);

  const setSize = (width: number, height: number, ratio: number): void => {
    composer.setPixelRatio(ratio);
    composer.setSize(Math.max(1, width), Math.max(1, height));
  };

  // addPass() は renderTarget サイズ基準の誤った size を各 pass へ配ってしまうため、
  // ここで CSS サイズ基準に正規化しておく。
  setSize(cssSize.x, cssSize.y, pixelRatio);

  return { composer, renderPass, bloomPass, setSize };
}
