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

import * as THREE from 'three';
import { Engine } from './core/engine';
import { createStarfield } from './render/starfield';

const canvas = document.getElementById('gl');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('DIMENSION: #gl canvas element not found');
}

const engine = new Engine(canvas);

const scene = new THREE.Scene();

const starfield = createStarfield();
scene.add(starfield.group);

// --- 仮のヒーローオブジェクト(Phase 2 の polytopeExhibit で置き換えて削除する) -----------
// 基礎輝度 0.8: ACES + 加算合成で白飛びさせずにブルームだけを乗せる(既知の罠 #6)
const heroMaterial = new THREE.LineBasicMaterial({
  color: new THREE.Color(0x4fd8ff).multiplyScalar(0.8),
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const hero = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)),
  heroMaterial,
);
hero.name = 'phase0.smokeTestCube';
scene.add(hero);
// -----------------------------------------------------------------------------------------

engine.setScene(scene);

engine.onFrame((dt) => {
  starfield.update(dt);
  hero.rotation.y += dt * 0.28;
  hero.rotation.x += dt * 0.17;
});

engine.start();
