// フォントは @fontsource で自己ホスト(Google Fonts CDN への外部依存なし)。
// Zen Kaku Gothic New は 400.css / 500.css を使う: これらは 121 個の unicode-range
// スライスに分割された定義で、ブラウザは実際に使われたグリフを含むスライス
// (各 ~7-15KB)だけを取得する。単一ファイルの japanese-400.css は 966KB を
// 一括ダウンロードしてしまうため採用しない(プラン「技術スタック」節)。
import '@fontsource/unbounded/600.css';
import '@fontsource/unbounded/800.css';
import '@fontsource/zen-kaku-gothic-new/400.css';
import '@fontsource/zen-kaku-gothic-new/500.css';
import '@fontsource/space-mono/400.css';
import './style.css';

import { Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { Engine } from './core/engine';
import { ScrollDirector } from './core/scrollDirector';
import { Gallery, EXHIBIT_REGISTRY, type ExhibitId } from './core/gallery';
import { createStarfield } from './render/starfield';
import { NarrativeScene } from './scenes/narrative';
import { PerspectiveExhibit, type CameraHint } from './scenes/perspectiveExhibit';
import { CHAPTERS, CHAPTER_DIMS } from './ui/content';
import { Overlays, buildNarrativeDOM } from './ui/overlays';

const canvasEl = document.getElementById('gl');
if (!(canvasEl instanceof HTMLCanvasElement)) {
  throw new Error('DIMENSION: #gl canvas element not found');
}
// 明示的に型を確定させる: instanceof の絞り込みは下のクロージャまで届かない
const canvas: HTMLCanvasElement = canvasEl;

const engine = new Engine(canvas);
const starfield = createStarfield();

/**
 * 単独展示のブートパス(開発・回帰検証用)。?exhibit=hopf | clifford | polytope |
 * perspective で物語もギャラリーシェルも迂回し、展示単体 + OrbitControls を起動する。
 * 生成そのものは gallery.ts の EXHIBIT_REGISTRY を通すので、展示クラスも
 * カメラのホーム姿勢もギャラリー本線と完全に同一のものが使われる。
 */

/**
 * カメラ誘導ヒントを無視する時間(ミリ秒)。
 * ユーザーが OrbitControls に触れたら、その操作が終わってから 6 秒は
 * こちらからカメラを動かさない(2 秒の「静止」条件はこれに含まれる)。
 */
const HINT_PAUSE_MS = 6000;
/** ヒントへの追従速度(expSmooth)。~0.5 秒で寄る */
const HINT_RATE = 3.2;

const exhibitParam = new URLSearchParams(window.location.search).get('exhibit');

if (
  exhibitParam === 'hopf' ||
  exhibitParam === 'clifford' ||
  exhibitParam === 'polytope' ||
  exhibitParam === 'perspective'
) {
  bootStandaloneExhibit(exhibitParam);
} else {
  bootNarrative();
}

function bootStandaloneExhibit(kind: ExhibitId): void {
  document.body.classList.add('mode-gallery');
  // 物語 DOM もギャラリーシェルも不要なので落とす(スクロールも殺す)
  document.getElementById('narrative')?.remove();
  document.getElementById('hud')?.remove();
  document.getElementById('progress')?.remove();
  document.getElementById('gallery')?.remove();
  document.getElementById('mode-nav')?.remove();
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
      renderOnce,
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

  // 3) レンダリング
  const narrative = new NarrativeScene(scrollDirector);
  narrative.init({ engine });

  // starfield は共有オブジェクト。アクティブなシーンへ add() で付け替える(背景の連続性)
  narrative.scene.add(starfield.group);
  engine.setScene(narrative.scene);

  // 4) テキストオーバーレイ(フェード・HUD・進捗バー・CTA)
  const overlays = new Overlays({ director: scrollDirector, chapters: CHAPTERS, dom });

  /**
   * 5) ギャラリーは**初回入場時に初めて構築する**。
   * 4 展示ぶんのバッファ(Hopf 1200×192 線分ほか)を起動時に確保しないことで、
   * 初期ロードは物語だけの軽さのまま保たれる。
   */
  let gallery: Gallery | null = null;
  const ensureGallery = (): Gallery => {
    if (gallery === null) {
      gallery = new Gallery({ engine, canvas, starfield, narrative, scrollDirector });
    }
    return gallery;
  };
  window.addEventListener('dimension:enter-gallery', () => {
    ensureGallery().enterGallery();
  });

  // resize は engine が debounce(150ms)して配る。セクション高は svh 基準なので
  // アドレスバーの伸縮では変わらないが、回転や幅変更では必ず測り直す(既知の罠 #5)
  engine.onResize(() => scrollDirector.remeasure());

  // モードで駆動対象を丸ごと切り替える。ギャラリー中は scrollDirector も
  // narrative も overlays も一切走らない(プラン3節)
  engine.onFrame((dt, t) => {
    if (gallery !== null && gallery.isGallery) {
      gallery.update(dt, t);
      return;
    }
    scrollDirector.update(dt);
    starfield.update(dt);
    narrative.update(dt, t);
    overlays.update();
  });

  narrative.enter();
  engine.start();

  // 開発時のみ: ヘッドレス検証用のフック。
  // ブラウザペインが非表示のときは rAF が止まりスクリーンショットが白/古いままに
  // なるため、合成フレームを手動で進めて 1 枚だけ描画できるようにしておく。
  if (import.meta.env.DEV) {
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
          scrollDirector.update(dt);
          starfield.update(dt);
          narrative.update(dt, t);
          overlays.update();
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
      overlays,
      /** 初回入場までは null(遅延生成) */
      get gallery(): Gallery | null {
        return gallery;
      },
      /** 検証から直接モードを叩くための口 */
      enterGallery: (): void => ensureGallery().enterGallery(),
      exitGallery: (): void => gallery?.exitGallery(),
      /** 指定スクロール位置へ即座に飛ぶ(html { scroll-behavior: auto }) */
      setScroll: (y: number): void => window.scrollTo(0, y),
      /** 合成フレームを steps 回進めて 1 枚描画する。戻り値は到達した dimLevel */
      renderOnce,
    };
  }
}
