# DIMENSION — 高次元を見る

人間は4次元以上を直接認識できない。
このサイトは、その「見えない構造」を芸術的かつ科学的に美しいビジュアルとして体験するための実験である。

**DIMENSION** is an artistic-scientific web experience for visualizing structures beyond three dimensions — the Hopf fibration, the Clifford torus, n-dimensional polytopes (n = 3…10), and the perception of one dimension seen from another.

**🌐 公開URL: https://ops324.github.io/dimension/**

## 体験 / Experience

- **物語「次元の階段」** — スクロールとともに、0次元の点が線・面・立方体・テッセラクト、そして6次元超立方体へと連続的に押し出されていく
- **HOPF FIBRATION** — S³ を満たすファイバー円のステレオ投影。GPU上で4次元回転する数百本の光の輪
- **CLIFFORD TORUS** — 4次元の二重回転により、自身を通り抜けて裏返るトーラス
- **POLYTOPE EXPLORER** — n次元超立方体・単体・正軸体(n = 3…10)。回転平面と投影法を自由に操作
- **PERSPECTIVE** — 選んだ次元の住人として別の次元を見る。断面・影・そして高次元からのX線俯瞰

## 操作 / Controls

| 操作 | 動作 |
|---|---|
| **スクロール** | 物語「次元の階段」。0D → 6D のモーフはスクロール位置に完全に追従する(巻き戻しも可) |
| **CTA「ギャラリーを探索する」** | エピローグからギャラリーへ。スクロール位置は保存され、いつでも戻れる |
| **上部タブ** | 4展示の切り替え(HOPF / CLIFFORD / POLYTOPE / PERSPECTIVE) |
| **ドラッグ・ホイール** | ギャラリー中のカメラ操作(回転・ズーム) |
| **右パネル** | 展示ごとのパラメータ。モバイルでは下からのボトムシート |
| **「解説」** | その展示の科学解説ドロワー |
| **トップナビ 物語 / ギャラリー** | モードの往復。`Esc` でもギャラリーを抜けられる |
| **ブラウザの戻る / 進む** | 物語 ⇄ ギャラリーを往復する。iOSの端スワイプでも同じ(サイトからは出ない) |
| **右下「◈ AUTO」** | 描画品質セレクタ。AUTO・ULTRA・HIGH・BALANCED(下記) |

### 共有リンク

表示中の展示は URL に載る。`?gallery=hopf` / `clifford` / `polytope` / `perspective` を
開くと、その展示から直接はじまる。タブを切り替えても履歴は増えないので、戻るは
いつでも「ギャラリーへ入る前」のスクロール位置へ帰る。

```
https://ops324.github.io/dimension/?gallery=clifford
```

### 描画品質

**HIGH(DPR 2 / MSAA 4x)で起動**し、最初の60フレームの平均フレーム時間が10msを切っていれば
**ULTRA(フルDPR上限3 / MSAA 8x / フル解像度ブルーム)へ昇格**する。以後は60フレーム窓の平均を
見張り、18ms超が2窓続いたら1段だけ降格する(降格後の自動昇格はしない)。
セレクタでティアを選ぶと固定され、自動制御は止まる。チップにホバー(または展開)すると
実効解像度とMSAAサンプル数が出る。`prefers-reduced-motion` ではグレインが静止する。

## 音 / Sound

既定はOFF。右下のチップで有効にすると、すべてランタイム合成された音が鳴る(音声ファイルは同梱していない)。
次元を跨ぐたびに基音98Hzの倍音が鐘として鳴り、両耳へわずかに高さの違う196Hzが送られて、
次元に応じた速さのうなり(0次元で毎秒2回 → 3次元で6回 → 6次元とギャラリーで10回)が耳の中に生まれる。
うなりは空気ではなく両耳の干渉で生じるため、ヘッドフォンでのみ立ち上がる。

## 技術 / Tech

- Vite + TypeScript + Three.js(完全静的サイト、外部CDN依存なし)
- 数学コアは純TypeScript(vitestによる数値検証付き)
- ファットライン + Unreal Bloom + グレード段(ビネット / フィルムグレイン / 色収差 / ディザ)
- ULTRA品質のエスカレーション起動 + フレーム時間ベースのAUTO降格
- 音響は WebAudio による完全プロシージャル合成

**設計の詳細・定数の根拠・既知の罠は [SPEC.md](SPEC.md) を参照。**

## 開発 / Development

```bash
npm install
npm run dev      # 開発サーバー
npx vitest run   # 数学コアのテスト(35件)
npm run build    # 静的ビルド → dist/
npm run preview  # 本番ビルドの確認(:4173)
```

## 公開 / Deploy

**本番は GitHub Actions で自動デプロイしている**(`.github/workflows/deploy.yml`)。
`main` へ push するたびに `vitest` → `build` → GitHub Pages への公開が走る。手動実行は
Actions タブから `workflow_dispatch` でも可能。

`dist/` は**完全な静的サイト**(サーバー処理・環境変数・API依存なし)。
`base: './'` で出力しているため、ドメイン直下でもサブパス配信でもそのまま動く。
他のホスティングへ移す場合も同じ成果物をそのまま使える:

```bash
npm run build

# Netlify — 公開ディレクトリを dist に
npx netlify deploy --prod --dir=dist

# Vercel — 静的成果物をそのまま
npx vercel deploy --prebuilt dist
```

CI で組む場合のビルドコマンドは `npm ci && npm run build`、公開ディレクトリは `dist`。
OGP画像は `public/og.jpg` を同梱している。独自ドメインで運用する場合は
`index.html` の `og:image` を絶対URL(`https://<host>/og.jpg`)にすると、
相対URLを解決しないクローラにも確実に届く。
