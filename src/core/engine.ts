import * as THREE from 'three';
import { buildPostFX, type PostFX } from '../render/postfx';

export type FrameCallback = (dt: number, t: number) => void;
export type ResizeCallback = (width: number, height: number, pixelRatio: number) => void;
/**
 * composer のパスが終わった**後**に走る直描画コールバック。
 * scissor/viewport を使った第2パス(perspective 展示の神視点インセット)専用の口で、
 * 呼び出し側は自分で状態を保存・復帰する責務を負う(既知の罠 #10)。
 */
export type AfterRenderCallback = (renderer: THREE.WebGLRenderer) => void;

/**
 * resolution を描画バッファサイズへ追従させる必要があるマテリアル。
 * Phase 2 以降で使う three/addons の LineMaterial を、addons への型依存を
 * engine に持ち込まずに構造的部分型として受けるための最小インターフェース。
 */
export interface ResolutionTrackingMaterial {
  resolution: THREE.Vector2;
}

/**
 * 起動時の DPR 上限。**HIGH ティア相当**で立ち上げ、実測フレーム時間が足りていれば
 * quality.ts が setQuality() で 3 まで引き上げる(エスカレーション起動 / 既知の罠 #12)。
 */
const BOOT_DPR_CAP = 2;
/** 起動時の MSAA サンプル数(HIGH ティア相当) */
const BOOT_SAMPLES = 4;
/** モバイル Safari のアドレスバー伸縮によるリサイズストーム対策(既知の罠 #5) */
const RESIZE_DEBOUNCE_MS = 150;
/** タブ非表示から復帰したときの dt スパイク対策(既知の罠 #7) */
const MAX_DELTA = 1 / 20;

const CAMERA_FOV = 50;
const CAMERA_NEAR = 0.05;
/**
 * 遠平面。ネブラ球(半径 150)の**裏側**まで含めて切らない距離であること。
 * カメラの最大距離は展示レジストリの maxDistance = 40 なので、必要なのは
 * 150 + 40 = 190 以上 ── 余裕を見て 400 とする。ここが足りないと遠景球が
 * 遠平面で切られ、切り口が多角形のシルエットとして見える(Phase 5 の指摘)。
 */
const CAMERA_FAR = 400;
const CAMERA_Z = 6;

/**
 * GL のクリアカラーは「黒」でなければならない。
 *
 * EffectComposer の RenderPass は `renderer.clear()` を直接呼ぶが、これは GL に
 * 最後にプログラムされたクリアカラーを使う。そのクリアカラーを設定するのは
 * WebGLBackground で、変換先の色空間は `getUnlitUniformColorSpace()` が決める —
 * レンダーターゲットへ描く時は working(linear)、画面へ描く時は outputColorSpace
 * (sRGB)。チェーン最後の OutputPass は画面へ描くため sRGB 値が GL に残り、
 * 次フレームの RenderPass がその sRGB 値をそのまま linear の HDR バッファへ
 * クリアしてしまう(#05060f が実測 rgb(22,27,58) になる = 約4倍の持ち上がり)。
 *
 * 黒は色空間変換で不変なのでこのリークの影響を受けない。実際の背景色 #05060f は
 * starfield のネブラ球が uBase として線形値で加算する。
 */
const CLEAR_COLOR = 0x000000;

/**
 * レンダリングの中枢。renderer / composer / camera / rAF ループ / resize を
 * 一箇所に集約する。シーンは差し替え式で、これらは常に 1 つだけ存在する。
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly postfx: PostFX;

  private readonly canvas: HTMLCanvasElement;
  private readonly frameCallbacks: FrameCallback[] = [];
  private readonly resizeCallbacks: ResizeCallback[] = [];
  private readonly afterRenderCallbacks: AfterRenderCallback[] = [];
  private readonly lineMaterials: ResolutionTrackingMaterial[] = [];
  /** 毎フレーム/リサイズで使い回す作業用ベクタ(ループ内アロケーション禁止) */
  private readonly bufferSize = new THREE.Vector2();

  private scene: THREE.Scene;
  private rafId = 0;
  private resizeTimer = 0;
  private prevTime = 0;
  private elapsed = 0;
  private running = false;
  private contextLost = false;
  /** devicePixelRatio の上限。品質ティア(quality.ts)が唯一の書き手 */
  private dprCap = BOOT_DPR_CAP;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // AA は composer 側の MSAA レンダーターゲットが担当
      powerPreference: 'high-performance',
    });
    // outputColorSpace は既定(SRGB)のまま。線形→sRGB 変換は OutputPass が行う。
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.setClearColor(CLEAR_COLOR, 1);

    const width = Engine.viewportWidth();
    const height = Engine.viewportHeight();
    const pixelRatio = this.pixelRatio();

    this.renderer.setPixelRatio(pixelRatio);
    // updateStyle = false: レイアウトサイズは CSS(#gl の inset:0)に委ねる
    this.renderer.setSize(width, height, false);

    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, width / height, CAMERA_NEAR, CAMERA_FAR);
    this.camera.position.set(0, 0, CAMERA_Z);

    // setScene() が来るまでのプレースホルダ
    this.scene = new THREE.Scene();

    this.postfx = buildPostFX(this.renderer, this.scene, this.camera, {
      samples: Math.min(BOOT_SAMPLES, this.renderer.capabilities.maxSamples),
    });

    canvas.addEventListener('webglcontextlost', this.handleContextLost, false);
    window.addEventListener('resize', this.requestResize);
    window.addEventListener('orientationchange', this.requestResize);
    window.visualViewport?.addEventListener('resize', this.requestResize);
  }

  /** 現在レンダリング対象になっているシーン */
  get currentScene(): THREE.Scene {
    return this.scene;
  }

  /** 経過時間(秒)。dt クランプ後の累積なので実時間とは厳密には一致しない */
  get time(): number {
    return this.elapsed;
  }

  /** composer は再生成せず、RenderPass のシーン参照だけを差し替える */
  setScene(scene: THREE.Scene): void {
    this.scene = scene;
    this.postfx.renderPass.scene = scene;
  }

  /**
   * 品質ティアの適用(quality.ts からのみ呼ぶ)。
   *
   * DPR 上限と MSAA サンプル数を差し替え、リサイズ経路をそのまま通す ──
   * composer のターゲット・ブルーム解像度・LineMaterial.resolution・
   * onResize 購読者(starfield の uPixelRatio など)が一度に整合する。
   * samples は GPU の上限で必ずクランプする(ULTRA の 8x が通らない環境がある)。
   */
  setQuality(quality: { samples: number; dpr: number }): void {
    this.dprCap = Math.max(1, quality.dpr);
    this.postfx.setSamples(Math.min(quality.samples, this.renderer.capabilities.maxSamples));
    this.applyResize();
  }

  /** 実効の描画バッファサイズを out へ書き込む(品質セレクタの表示用) */
  getDrawingBufferSize(out: THREE.Vector2): THREE.Vector2 {
    return this.renderer.getDrawingBufferSize(out);
  }

  onFrame(cb: FrameCallback): void {
    this.frameCallbacks.push(cb);
  }

  onResize(cb: ResizeCallback): void {
    this.resizeCallbacks.push(cb);
  }

  /**
   * composer.render() の直後に呼ばれる直描画パスを登録する。
   * インセット等はポストFXを通さずに画面へ重ねたいのでここへ挿す。
   */
  onAfterRender(cb: AfterRenderCallback): void {
    this.afterRenderCallbacks.push(cb);
  }

  /**
   * LineMaterial 等、resolution を描画バッファに追従させる必要のあるマテリアルを登録。
   * resize 時の更新漏れは既知の罠 #3 なので、必ずここへ集約する。
   */
  registerLineMaterial(material: ResolutionTrackingMaterial): void {
    this.lineMaterials.push(material);
    this.renderer.getDrawingBufferSize(this.bufferSize);
    material.resolution.set(this.bufferSize.x, this.bufferSize.y);
  }

  start(): void {
    if (this.running || this.contextLost) return;
    this.running = true;
    this.prevTime = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /** rAF のタイムスタンプは performance.now() と同一時間軸 */
  private readonly tick = (now: number): void => {
    this.rafId = requestAnimationFrame(this.tick);

    const dt = Math.min((now - this.prevTime) / 1000, MAX_DELTA);
    this.prevTime = now;
    this.elapsed += dt;

    const callbacks = this.frameCallbacks;
    for (let i = 0; i < callbacks.length; i++) {
      callbacks[i](dt, this.elapsed);
    }

    // GradePass のグレインを流す(reduced-motion では postfx 側が無視する)
    this.postfx.setTime(this.elapsed);
    this.postfx.composer.render();

    const afterRender = this.afterRenderCallbacks;
    for (let i = 0; i < afterRender.length; i++) {
      afterRender[i](this.renderer);
    }
  };

  private readonly requestResize = (): void => {
    if (this.resizeTimer !== 0) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(this.applyResize, RESIZE_DEBOUNCE_MS);
  };

  private readonly applyResize = (): void => {
    this.resizeTimer = 0;
    if (this.contextLost) return;

    const width = Engine.viewportWidth();
    const height = Engine.viewportHeight();
    const pixelRatio = this.pixelRatio();

    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.postfx.setSize(width, height, pixelRatio);

    this.renderer.getDrawingBufferSize(this.bufferSize);
    for (let i = 0; i < this.lineMaterials.length; i++) {
      this.lineMaterials[i].resolution.set(this.bufferSize.x, this.bufferSize.y);
    }

    for (let i = 0; i < this.resizeCallbacks.length; i++) {
      this.resizeCallbacks[i](width, height, pixelRatio);
    }
  };

  private readonly handleContextLost = (event: Event): void => {
    // preventDefault しないと自動復帰の機会も失われるが、復帰処理は実装せず
    // 明示的なリロード導線を出す(既知の罠 #8)
    event.preventDefault();
    this.contextLost = true;
    this.stop();
    this.showContextLostOverlay();
  };

  private showContextLostOverlay(): void {
    if (document.getElementById('gl-context-lost')) return;

    const overlay = document.createElement('div');
    overlay.id = 'gl-context-lost';
    overlay.setAttribute('role', 'alert');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:9999',
      'display:flex',
      'flex-direction:column',
      'gap:1.5rem',
      'align-items:center',
      'justify-content:center',
      'padding:2rem',
      'text-align:center',
      'background:var(--bg,#05060f)',
      'color:var(--ink,#e8ecfb)',
      'font-family:var(--font-body,system-ui,sans-serif)',
    ].join(';');

    const message = document.createElement('p');
    message.textContent = 'グラフィックスの初期化に失敗しました。ページを再読み込みしてください。';
    message.style.cssText = 'margin:0;max-width:34rem;line-height:2';

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '再読み込み';
    button.style.cssText = [
      'padding:0.7rem 2rem',
      'border:1px solid var(--cyan,#4fd8ff)',
      'border-radius:999px',
      'background:transparent',
      'color:var(--cyan,#4fd8ff)',
      'font:inherit',
      'letter-spacing:0.1em',
      'cursor:pointer',
    ].join(';');
    button.addEventListener('click', () => window.location.reload());

    overlay.append(message, button);
    (document.body ?? this.canvas.parentElement ?? document.documentElement).append(overlay);
  }

  private static viewportWidth(): number {
    return Math.max(1, Math.floor(window.innerWidth));
  }

  /** モバイル Safari のアドレスバー分を除いた実表示高さを優先する */
  private static viewportHeight(): number {
    return Math.max(1, Math.floor(window.visualViewport?.height ?? window.innerHeight));
  }

  /** 実効 DPR。上限は品質ティアが決める(ULTRA なら 3 まで解放) */
  private pixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, this.dprCap);
  }
}
