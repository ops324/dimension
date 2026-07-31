# DIMENSION — 高次元を見る

人間は4次元以上を直接認識できない。
このサイトは、その「見えない構造」を芸術的かつ科学的に美しいビジュアルとして体験するための実験である。

**DIMENSION** is an artistic-scientific web experience for visualizing structures beyond three dimensions — the Hopf fibration, the Clifford torus, n-dimensional polytopes (n = 3…10), and the perception of one dimension seen from another.

## 体験 / Experience

- **物語「次元の階段」** — スクロールとともに、0次元の点が線・面・立方体・テッセラクト、そして6次元超立方体へと連続的に押し出されていく
- **HOPF FIBRATION** — S³ を満たすファイバー円のステレオ投影。GPU上で4次元回転する数百本の光の輪
- **CLIFFORD TORUS** — 4次元の二重回転により、自身を通り抜けて裏返るトーラス
- **POLYTOPE EXPLORER** — n次元超立方体・単体・正軸体(n = 3…10)。回転平面と投影法を自由に操作
- **PERSPECTIVE** — 選んだ次元の住人として別の次元を見る。断面・影・そして高次元からのX線俯瞰

## 技術 / Tech

- Vite + TypeScript + Three.js(完全静的サイト)
- 数学コアは純TypeScript(vitestによる数値検証付き)
- ファットライン + Unreal Bloom + フィルムグレイン、ULTRA品質の自動エスカレーション

## 開発 / Development

```bash
npm install
npm run dev      # 開発サーバー
npx vitest run   # 数学コアのテスト
npm run build    # 静的ビルド → dist/
```
