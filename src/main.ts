// フォントは @fontsource で自己ホスト(Google Fonts CDN への外部依存なし)。
// Murecho は 400.css / 500.css を使う: これらは 120 個の unicode-range
// スライスに分割された定義で、ブラウザは実際に使われたグリフを含むスライス
// (各 ~7-15KB)だけを取得する。単一ファイルの japanese-400.css は 1MB 近くを
// 一括ダウンロードしてしまうため採用しない(プラン「技術スタック」節)。
import '@fontsource/unbounded/600.css';
import '@fontsource/unbounded/800.css';
import '@fontsource/murecho/400.css';
import '@fontsource/murecho/500.css';
import '@fontsource/space-mono/400.css';
import './style.css';

import { Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { Engine } from './core/engine';
// 型だけ(verbatimModuleSyntax なので完全に消える)。実体は DEV ブロックの動的 import
import type { ProbeReport, ScrollProbe } from './core/probe';
import { ScrollDirector, SMOOTH_RATE_GLIDING } from './core/scrollDirector';
import { createSmoothScroll } from './core/smoothScroll';
import { Gallery, EXHIBIT_REGISTRY, type ExhibitId } from './core/gallery';
import { Router, parseRoute } from './core/route';
import { QualityController } from './core/quality';
import { createStarfield } from './render/starfield';
import { NarrativeScene, ROTATION_PLANES } from './scenes/narrative';
import { PerspectiveExhibit, type CameraHint } from './scenes/perspectiveExhibit';
import { CHAPTERS, CHAPTER_DIMS } from './ui/content';
import { Overlays, buildNarrativeDOM } from './ui/overlays';
import { Preloader } from './ui/components/Preloader';
import { createCursor } from './ui/components/Cursor';
import { createLensDriver } from './ui/lens';
import { magnetize } from './ui/components/MagneticButton';
import { createSoundToggle } from './ui/components/SoundToggle';
import { createAnnouncer } from './ui/components/Announcer';
import { createRotationReadout } from './ui/components/RotationReadout';
import { audio } from './audio/engine';
import { initAudioWiring, type AudioWiring } from './audio/wiring';

const canvasEl = document.getElementById('gl');
if (!(canvasEl instanceof HTMLCanvasElement)) {
  throw new Error('DIMENSION: #gl canvas element not found');
}
// 明示的に型を確定させる: instanceof の絞り込みは下のクロージャまで届かない
const canvas: HTMLCanvasElement = canvasEl;

/**
 * 単独展示のブートパス(開発・回帰検証用)。?exhibit=hopf | clifford | polytope |
 * perspective で物語もギャラリーシェルも迂回し、展示単体 + OrbitControls を起動する。
 * 生成そのものは gallery.ts の EXHIBIT_REGISTRY を通すので、展示クラスも
 * カメラのホーム姿勢もギャラリー本線と完全に同一のものが使われる。
 */
const exhibitParam = new URLSearchParams(window.location.search).get('exhibit');
const isStandalone =
  exhibitParam === 'hopf' ||
  exhibitParam === 'clifford' ||
  exhibitParam === 'polytope' ||
  exhibitParam === 'perspective';

/**
 * プリローダは **エンジンより先に、同期で** 差し込む。
 * ここで await を挟むと TTI が伸びるので、DOM を組んで載せるだけ ──
 * 進捗は fonts.ready と engine.onFirstFrame という**実測の合図**で進む。
 */
let onCurtainRise: (() => void) | null = null;
const preloader = isStandalone
  ? null
  : new Preloader({
      onReveal: () => {
        onCurtainRise?.();
        mountChrome();
      },
    });
preloader?.mount(document.body);

/**
 * 音(Phase 10、既定は Phase 19 で ON へ反転)。ここでするのは
 * 「最初のユーザー操作を捕まえる網を張る」ことだけ ── AudioContext は、
 * 設定が ON で、かつ操作が一度あったときに初めて生まれる。
 * **既定が ON でも自動再生はしない**という不変条件はここで守られている。
 */
audio.init();

const engine = new Engine(canvas);
const starfield = createStarfield();

if (preloader !== null) engine.onFirstFrame(preloader.signalFirstFrame);

// 星の見かけ大きさは描画バッファ倍率に依存する。resize でも品質ティア適用でも
// engine が同じ経路で配るので、購読はここ 1 箇所でよい(品質より先に登録する)
engine.onResize((_width, _height, pixelRatio) => starfield.setPixelRatio(pixelRatio));

/**
 * 品質制御。HIGH で起動し、最初の 60 フレームの実測で ULTRA へ昇格する
 * (エスカレーション起動 / 既知の罠 #12)。以後は 60 フレーム窓のガバナが見張る。
 */
const quality = new QualityController({ engine, starfield });

/**
 * カメラ誘導ヒントを無視する時間(ミリ秒)。
 * ユーザーが OrbitControls に触れたら、その操作が終わってから 6 秒は
 * こちらからカメラを動かさない(2 秒の「静止」条件はこれに含まれる)。
 */
const HINT_PAUSE_MS = 6000;
/** ヒントへの追従速度(expSmooth)。~0.5 秒で寄る */
const HINT_RATE = 3.2;

if (
  exhibitParam === 'hopf' ||
  exhibitParam === 'clifford' ||
  exhibitParam === 'polytope' ||
  exhibitParam === 'perspective'
) {
  bootStandaloneExhibit(exhibitParam);
  mountChrome();
} else {
  bootNarrative();
}

/**
 * 計器としてのカーソルと、操作要素の磁力。
 *
 * どちらもデスクトップの細いポインタ専用で、reduced-motion や
 * タッチ端末では自分から何もしない(createCursor は null を返し、
 * magnetize は何も付けない)。プリローダが幕を割る瞬間に呼ぶ。
 */
function mountChrome(): void {
  createCursor(document.body);
  // カーソルの下で時空が歪む(Phase 17)。ゲートは createCursor と同一で、
  // 作られない環境ではシェーダー側のレンズ節ごと眠ったままになる
  createLensDriver(engine);

  /*
    スキップリンク(Phase 14c)。押したときの経路は終章の CTA と**完全に同じ** ──
    同じ CustomEvent を投げるので、ギャラリーの遅延構築も遷移の幕も
    (Phase 13 以降は)履歴への push も、すべて 1 本の道を共有する。
  */
  document.getElementById('skip-gallery')?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('dimension:enter-gallery'));
  });

  const cta = document.getElementById('enter-gallery');
  if (cta instanceof HTMLElement) magnetize(cta, { labelSelector: '.cta-label' });

  for (const pill of document.querySelectorAll<HTMLElement>('#mode-nav .nav-pill')) {
    magnetize(pill, { radius: 70, max: 6, labelMax: 9, labelSelector: '.nav-jp' });
  }

  const chip = document.querySelector<HTMLElement>('#quality .q-chip');
  if (chip !== null) magnetize(chip, { radius: 60, max: 5, labelMax: 7 });

  // 音のチップ。品質チップの真下に座り、初回訪問だけ 2 回小さく脈打つ
  createSoundToggle(document.body);
}

function bootStandaloneExhibit(kind: ExhibitId): void {
  document.body.classList.add('mode-gallery');
  // 物語 DOM もギャラリーシェルも不要なので落とす(スクロールも殺す)
  document.getElementById('narrative')?.remove();
  document.getElementById('hud')?.remove();
  document.getElementById('progress')?.remove();
  document.getElementById('gallery')?.remove();
  document.getElementById('mode-nav')?.remove();
  // 行き先そのものが無いので、スキップリンクも落とす
  document.getElementById('skip-gallery')?.remove();
  document.body.style.overflow = 'hidden';

  const entry = EXHIBIT_REGISTRY.find((e) => e.id === kind);
  if (entry === undefined) throw new Error(`DIMENSION: 未知の展示 ${kind}`);

  const exhibit = entry.create();
  exhibit.init({ engine });
  exhibit.scene.add(starfield.group);
  engine.setScene(exhibit.scene);

  engine.camera.position.set(entry.home[0], entry.home[1], entry.home[2]);
  engine.camera.lookAt(0, 0, 0);

  const controls = new OrbitControls(engine.camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = entry.minDistance;
  controls.maxDistance = entry.maxDistance;
  controls.enablePan = false;

  /**
   * 展示からのカメラ誘導(perspective の「2 次元世界ビュー」等)。
   *
   * OrbitControls は毎フレーム target からの相対位置を球座標で往復させるだけなので、
   * update() の**前**に camera.position と controls.target を書き換えれば、その姿勢が
   * そのまま維持される(操作を奪い合わない)。ユーザーが触ったらしばらく沈黙する。
   */
  const hint: CameraHint = { pos: new Vector3(), look: new Vector3() };
  const perspective = exhibit instanceof PerspectiveExhibit ? exhibit : null;
  let hintPausedUntil = 0;
  if (perspective !== null) {
    const pause = (): void => {
      hintPausedUntil = performance.now() + HINT_PAUSE_MS;
    };
    controls.addEventListener('start', pause);
    controls.addEventListener('end', pause);
  }

  engine.onFrame((dt, t) => {
    if (perspective !== null && performance.now() >= hintPausedUntil) {
      if (perspective.getCameraHint(hint)) {
        const k = 1 - Math.exp(-HINT_RATE * dt);
        engine.camera.position.lerp(hint.pos, k);
        controls.target.lerp(hint.look, k);
      }
    }
    controls.update();
    starfield.update(dt);
    exhibit.update(dt, t);
  });

  exhibit.enter();
  engine.start();

  // 単独展示にも操作音はつく(次元の鐘は物語だけなので scrollDirector は渡さない)
  const wiring = initAudioWiring({ engine });

  if (import.meta.env.DEV) {
    let devClock = 0;
    const renderOnce = (steps = 1): void => {
      const count = steps > 0 ? Math.floor(steps) : 1;
      const dt = 1 / 60;
      let t = engine.time + devClock;
      for (let i = 0; i < count; i++) {
        t += dt;
        controls.update();
        starfield.update(dt);
        exhibit.update(dt, t);
      }
      devClock += count * dt;
      engine.postfx.composer.render();
      // engine.tick() と同じ順序で第2パス(神視点インセット)も進める
      perspective?.renderInset(engine.renderer);
    };
    (window as unknown as Record<string, unknown>).__DIMENSION__ = {
      engine,
      exhibit,
      quality,
      /** GradePass の on/off(グレイン・ビネット・ディザの before/after 比較用) */
      grade: (on: boolean): void => engine.postfx.setGradeEnabled(on),
      /** 重力レンズを直接置く(UV・左下原点)。ヘッドレス検証用 ── rAF が止まって
       *  いてもドライバを介さず uniform を書ける。renderOnce と組で使う */
      lens: (x: number, y: number, amount: number): void => engine.postfx.setLens(x, y, amount),
      renderOnce,
      audio: devAudioHooks(wiring),
    };
  }
}

function bootNarrative(): void {
  const narrativeRoot = document.getElementById('narrative');
  if (!(narrativeRoot instanceof HTMLElement)) {
    throw new Error('DIMENSION: #narrative container not found');
  }

  // キャンバスの pointer-events を切る(物語モードではスクロールだけが入力)
  document.body.classList.add('mode-narrative');

  // 1) DOM: index.html の静的プロローグを content.ts 由来の全章で置き換える
  const dom = buildNarrativeDOM(narrativeRoot, CHAPTERS);

  // 2) スクロール → (章, 章内進捗, dimLevel)。スクロールリスナーは張らない
  const scrollDirector = new ScrollDirector(dom.sections, CHAPTER_DIMS);

  /*
    2b) スクロールの滑走(Phase 24)。ホイールとキーの離散的な飛びを引き受け、
    毎フレーム scrollY 自体を平滑化して書き戻す。**文字も図形も同じ 1 つの値**
    から動くので、DOM と WebGL がずれることが構造的に起きない。
    タッチ・スクロールバー・reduced-motion では何もしない(ネイティブのまま)。
  */
  const smoothScroll = createSmoothScroll();
  // 前段で滑らかになったぶん、dimLevel 側のノッチ隠しは緩める(遅れの二重取りを避ける)
  if (smoothScroll.enabled) scrollDirector.setSmoothRate(SMOOTH_RATE_GLIDING);

  // 3) レンダリング
  const narrative = new NarrativeScene(scrollDirector);
  narrative.init({ engine });

  // starfield は共有オブジェクト。アクティブなシーンへ add() で付け替える(背景の連続性)
  narrative.scene.add(starfield.group);
  engine.setScene(narrative.scene);

  /*
    状態の変化を告げる一行(Phase 14b)。**<body> 直下**に立てる ── #hud は
    aria-hidden、#narrative はギャラリーで visibility:hidden、#gallery は物語で
    hidden、body.ui-hidden の集合は没入モードで visibility:hidden になるので、
    どこへ入れても「必要なときに黙る」領域になってしまう。
  */
  const announcer = createAnnouncer(document.body);

  // 4) テキストオーバーレイ(振り付け・HUD・進捗バー・CTA)
  const overlays = new Overlays({ director: scrollDirector, chapters: CHAPTERS, dom, announcer });

  /*
    回転の計器(Phase 21)。次元の読みの真上へ積む。物語シーンが平面ごとに
    合算した角度を毎フレーム読むだけで、シーン側には何も足していない。
    単独展示ブートでは #hud が無いので null になる。
  */
  const rotationReadout = createRotationReadout(ROTATION_PLANES);

  /**
   * 5) ギャラリーは**初回入場時に初めて構築する**。
   * 4 展示ぶんのバッファ(Hopf 1200×192 線分ほか)を起動時に確保しないことで、
   * 初期ロードは物語だけの軽さのまま保たれる。
   */
  let gallery: Gallery | null = null;
  const ensureGallery = (): Gallery => {
    if (gallery === null) {
      gallery = new Gallery({
        engine,
        canvas,
        starfield,
        narrative,
        scrollDirector,
        router,
        announcer,
      });
    }
    return gallery;
  };

  /**
   * URL と履歴(Phase 13)。popstate も深リンクも **ensureGallery() を通る**ので、
   * 遅延構築の保証は構造的に保たれる ── URL かユーザーが求めない限り誰も呼ばない。
   */
  const initialRoute = parseRoute(window.location.href, history.state);
  const router = new Router((route) => ensureGallery().applyRoute(route));

  window.addEventListener('dimension:enter-gallery', () => {
    ensureGallery().requestEnter();
  });

  // プリローダが上下パネルを割りはじめた瞬間にテキストの振り付けを始める ──
  // 開いていく隙間の向こうで、序章がちょうど立ち上がる。
  // URL がギャラリーを名指していたときだけ、ここで 4 展示を建てる ──
  // 物語だけの訪問者はこれまでどおり 1 バイトのバッファも確保しない。
  // 幕は張らない(instant): .tx(z 80)はプリローダ(.pl = 90)の下なので、
  // 被せても「止まったローダー」が 1.1 秒伸びるだけになる
  onCurtainRise = (): void => {
    overlays.start();
    if (initialRoute.mode === 'gallery') ensureGallery().applyRoute(initialRoute, true);
  };

  // resize は engine が debounce(150ms)して配る。セクション高は svh 基準なので
  // アドレスバーの伸縮では変わらないが、回転や幅変更では必ず測り直す(既知の罠 #5)。
  // 行分割は幅に依存するので**先に**組み直し、そのあと章の高さを測る。
  engine.onResize(() => {
    overlays.remeasure();
    scrollDirector.remeasure();
    smoothScroll.remeasure();
  });

  // モードで駆動対象を丸ごと切り替える。ギャラリー中は scrollDirector も
  // narrative も overlays も一切走らない(プラン3節)
  engine.onFrame((dt, t, rawDt) => {
    if (gallery !== null && gallery.isGallery) {
      // 展示はパラメータが主役。重力場は物語だけのものなので、ここで必ず 0 を書く
      starfield.setLens(0, 0, 1);
      gallery.update(dt, t);
      return;
    }
    /*
      scrollY を書くのは **director が読む前**。同じフレームで文字と図が一致する。
      この 2 つだけ **クランプしていない rawDt** を受け取る(Phase 34c)──
      どちらも目標へ収束する閉じた形なので、クランプは「実時間から遅れて、
      それが累積する」だけの効果しかない。星野と物語シーンは時間を積分するので
      これまでどおりクランプ済みの dt。
    */
    smoothScroll.update(rawDt);
    scrollDirector.update(rawDt);
    starfield.update(dt);
    narrative.update(dt, t);
    /*
      重力場(Phase 30)。図が背後の星を曲げる ── **配るのはここ 1 箇所だけ**。
      物語シーンは星野を知らないし、星野は図を知らない。合成の根が毎フレーム
      「いまの図の見かけ半径と強さ」を渡すことで、両者の独立を保ったまま繋ぐ。
    */
    starfield.setLens(narrative.lensRadius, narrative.lensStrength, engine.camera.aspect);
    overlays.update();
    rotationReadout?.update(narrative.rotationAngles, narrative.rotationOmegas);
  });

  narrative.enter();
  engine.start();

  /**
   * 音づけ。**この 1 行が音と作品の唯一の接点**で、既存のコンポーネントには
   * 一行も足していない(委譲と CustomEvent だけで届く)。次元の鐘は
   * scrollDirector.dimLevel の床を毎フレーム見て、跨いだ瞬間に撞かれる。
   */
  const wiring = initAudioWiring({ engine, scrollDirector });

  // 開発時のみ: ヘッドレス検証用のフック。
  // ブラウザペインが非表示のときは rAF が止まりスクリーンショットが白/古いままに
  // なるため、合成フレームを手動で進めて 1 枚だけ描画できるようにしておく。
  if (import.meta.env.DEV) {
    /*
      計測プローブ(Phase 34b)。実機のホイール / トラックパッド / 指で
      10 秒ぶん記録して、フレーム時間・scrollY と dimLevel の折れ・wheel の
      配送コスト・ジェスチャごとの cancelable / momentum を返す。

      **記録していない間は 1 行も走らない**(sample は先頭で return する)ので、
      ここに常駐させても通常の DEV 実行には影響しない。実体は動的 import なので
      本番ビルドには 1 バイトも残らない。
    */
    let probe: ScrollProbe | null = null;
    engine.onFrame(() => {
      probe?.sample(window.scrollY, scrollDirector.dimLevel);
    });

    let devClock = 0;
    /** 合成フレームを steps 回進めて 1 枚描画する。**いま有効なモードだけ**を進める */
    const renderOnce = (steps = 1): number => {
      const count = steps > 0 ? Math.floor(steps) : 1;
      const dt = 1 / 60;
      let t = engine.time + devClock;
      const inGallery = gallery !== null && gallery.isGallery;
      for (let i = 0; i < count; i++) {
        t += dt;
        if (inGallery && gallery !== null) {
          gallery.update(dt, t);
        } else {
          smoothScroll.update(dt);
          scrollDirector.update(dt);
          starfield.update(dt);
          narrative.update(dt, t);
          starfield.setLens(narrative.lensRadius, narrative.lensStrength, engine.camera.aspect);
          overlays.update();
          rotationReadout?.update(narrative.rotationAngles, narrative.rotationOmegas);
          // 次元の鐘も実ループと同じ順序で進める(engine.onFrame の写し)
          wiring.step();
        }
      }
      devClock += count * dt;
      engine.postfx.composer.render();
      // engine.tick() と同じ順序で第2パス(perspective の神視点インセット)も進める
      if (inGallery && gallery !== null) gallery.afterRender(engine.renderer);
      return scrollDirector.dimLevel;
    };

    (window as unknown as Record<string, unknown>).__DIMENSION__ = {
      engine,
      narrative,
      scrollDirector,
      smoothScroll,
      overlays,
      quality,
      /** GradePass の on/off(グレイン・ビネット・ディザの before/after 比較用) */
      grade: (on: boolean): void => engine.postfx.setGradeEnabled(on),
      /** 重力レンズを直接置く(UV・左下原点)。ヘッドレス検証用 ── rAF が止まって
       *  いてもドライバを介さず uniform を書ける。renderOnce と組で使う */
      lens: (x: number, y: number, amount: number): void => engine.postfx.setLens(x, y, amount),
      /** 初回入場までは null(遅延生成) */
      get gallery(): Gallery | null {
        return gallery;
      },
      router,
      /**
       * 検証から直接モードを叩くための口。**履歴経由**にしてあるので、
       * ヘッドレス検証が本番と同じ経路(URL 更新・戻るの行き先)を通る
       */
      enterGallery: (): void => ensureGallery().requestEnter(),
      exitGallery: (): void => router.leave(),
      /**
       * 指定スクロール位置へ即座に飛ぶ(html { scroll-behavior: auto })。
       * 滑走層へ同期させるのは検証を決定論にするため ── 同期しないと
       * 次のフレームで「外部スクロール」として検出されるまでの 1 枚が古い値になる。
       */
      setScroll: (y: number): void => {
        window.scrollTo(0, y);
        smoothScroll.sync();
      },
      /** 合成フレームを steps 回進めて 1 枚描画する。戻り値は到達した dimLevel */
      renderOnce,
      /**
       * 実機のスクロールを seconds 秒ぶん記録して要約を返す(Phase 34b)。
       * 呼んだら**手でスクロールする** ── 合成イベントでは wheel を奪えないので
       * (CDP のホイールは常に cancelable = false)、この数だけは実機でしか取れない。
       *
       *   await __DIMENSION__.probe.record(10)
       */
      probe: {
        record: async (seconds = 10, raw = false): Promise<ProbeReport> => {
          const { ScrollProbe } = await import('./core/probe');
          probe?.dispose();
          const p = new ScrollProbe();
          probe = p;
          try {
            return await p.record(seconds, { raw });
          } finally {
            p.dispose();
            if (probe === p) probe = null;
          }
        },
      },
      audio: devAudioHooks(wiring),
    };
  }
}

/**
 * 音の検証フック(DEV のみ)。
 *
 * `render(name)` は実機と**同じ build 関数・同じ出力チェーン**を
 * OfflineAudioContext へ通し、peak / rms / durMs / clipped を返す ──
 * 耳で確かめられないものを数値で確かめるための唯一の道具。
 * 動的 import なので、本番ビルドにはこの分岐ごと 1 バイトも残らない。
 */
function devAudioHooks(wiring: AudioWiring): Record<string, unknown> {
  return {
    engine: audio,
    wiring,
    render: async (name: string) => (await import('./audio/render')).render(name),
    renderAll: async () => (await import('./audio/render')).renderAll(),
    /**
     * 両耳の層のいま。left / right は AudioParam の現在値なので、
     * 拍を動かした直後は τ=0.8s の途中の値が返る(滑っている証拠でもある)。
     */
    binaural: (): Record<string, unknown> | null => {
      const layer = audio.binauralLayer;
      if (layer === null) return null;
      return {
        active: layer.active,
        beat: layer.beatHz,
        left: layer.leftHz,
        right: layer.rightHz,
        split: layer.rightHz - layer.leftHz,
      };
    },
  };
}
