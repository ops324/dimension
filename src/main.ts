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
import { createStarfield } from './render/starfield';
import { NarrativeScene } from './scenes/narrative';
import { HopfExhibit } from './scenes/hopfExhibit';
import { CliffordExhibit } from './scenes/cliffordExhibit';
import { PolytopeExhibit } from './scenes/polytopeExhibit';
import { PerspectiveExhibit, type CameraHint } from './scenes/perspectiveExhibit';
import type { Exhibit } from './scenes/exhibit';
import { CHAPTERS, CHAPTER_DIMS } from './ui/content';
import { Overlays, buildNarrativeDOM } from './ui/overlays';

const canvas = document.getElementById('gl');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('DIMENSION: #gl canvas element not found');
}

const engine = new Engine(canvas);
const starfield = createStarfield();

/**
 * 単独展示のブートパス(検証用)。?exhibit=hopf | clifford | polytope | perspective で
 * 物語を迂回して展示単体 + OrbitControls を起動する。Phase 7 の gallery が正式な導線に
 * なるまでの開発・レビュー用経路。
 */
type StandaloneExhibit = 'hopf' | 'clifford' | 'polytope' | 'perspective';

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

function bootStandaloneExhibit(kind: StandaloneExhibit): void {
  document.body.classList.add('mode-gallery');
  // 物語 DOM は不要なので隠す(スクロールも殺す)
  const narrativeRoot = document.getElementById('narrative');
  narrativeRoot?.remove();
  document.getElementById('hud')?.remove();
  document.getElementById('progress')?.remove();
  document.body.style.overflow = 'hidden';

  const exhibit: Exhibit =
    kind === 'hopf'
      ? new HopfExhibit()
      : kind === 'clifford'
        ? new CliffordExhibit()
        : kind === 'perspective'
          ? new PerspectiveExhibit()
          : new PolytopeExhibit();
  exhibit.init({ engine });
  exhibit.scene.add(starfield.group);
  engine.setScene(exhibit.scene);

  // Hopf の既定分布は半径 ~4 の入れ子トーラス束。斜め上から構造が読める位置に置く。
  // Clifford の静止像は半径 ~2.4 に収まるが、歳差が極へ寄ると大きく膨らむので
  // 少し引いた位置から(膨張は maxDistance まで引いて追える)。
  // Perspective は半径 ~2.4 に自動フィットするので、ほぼ正面のやや上から。
  if (kind === 'hopf') {
    engine.camera.position.set(3.4, 3.0, 7.6);
  } else if (kind === 'clifford') {
    engine.camera.position.set(3.0, 2.2, 6.5);
  } else if (kind === 'perspective') {
    engine.camera.position.set(0, 1.6, 7.2);
  } else {
    engine.camera.position.set(2.7, 1.9, 5.0);
  }
  engine.camera.lookAt(0, 0, 0);

  const controls = new OrbitControls(engine.camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 2.5;
  controls.maxDistance = kind === 'hopf' ? 40 : kind === 'clifford' ? 30 : 20;
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
    const renderOnce = (steps = 1): void => {
      const count = steps > 0 ? Math.floor(steps) : 1;
      const dt = 1 / 60;
      let t = engine.time;
      for (let i = 0; i < count; i++) {
        t += dt;
        controls.update();
        starfield.update(dt);
        exhibit.update(dt, t);
      }
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

  // resize は engine が debounce(150ms)して配る。セクション高は svh 基準なので
  // アドレスバーの伸縮では変わらないが、回転や幅変更では必ず測り直す(既知の罠 #5)
  engine.onResize(() => scrollDirector.remeasure());

  engine.onFrame((dt, t) => {
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
    const renderOnce = (steps = 1): number => {
      const count = steps > 0 ? Math.floor(steps) : 1;
      const dt = 1 / 60;
      let t = engine.time;
      for (let i = 0; i < count; i++) {
        t += dt;
        scrollDirector.update(dt);
        starfield.update(dt);
        narrative.update(dt, t);
        overlays.update();
      }
      engine.postfx.composer.render();
      return scrollDirector.dimLevel;
    };

    (window as unknown as Record<string, unknown>).__DIMENSION__ = {
      engine,
      narrative,
      scrollDirector,
      overlays,
      /** 指定スクロール位置へ即座に飛ぶ(html { scroll-behavior: auto }) */
      setScroll: (y: number): void => window.scrollTo(0, y),
      /** 合成フレームを steps 回進めて 1 枚描画する。戻り値は到達した dimLevel */
      renderOnce,
    };
  }
}
