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

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { Engine } from './core/engine';
import { createStarfield } from './render/starfield';
import { PolytopeExhibit } from './scenes/polytopeExhibit';

const canvas = document.getElementById('gl');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('DIMENSION: #gl canvas element not found');
}

const engine = new Engine(canvas);

// Phase 2 は polytope 展示の単独表示。物語シーンとギャラリー切替は Phase 3 / 7。
const exhibit = new PolytopeExhibit();
exhibit.init({ engine });

// starfield は共有オブジェクト。アクティブなシーンへ add() で付け替える(背景の連続性)
const starfield = createStarfield();
exhibit.scene.add(starfield.group);

engine.setScene(exhibit.scene);

// 正面(+z 軸上)からだと軸に揃った多胞体が「トンネル」に潰れて構造が読めない。
// 距離は engine 既定の 6 のまま、3/4 ビューになる位置へ寄せる。
engine.camera.position.set(2.7, 1.9, 5.0);
engine.camera.lookAt(0, 0, 0);

const controls = new OrbitControls(engine.camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 2.5;
controls.maxDistance = 20;
controls.enablePan = false;

engine.onFrame((dt, t) => {
  controls.update();
  starfield.update(dt);
  exhibit.update(dt, t);
});

exhibit.enter();
engine.start();
