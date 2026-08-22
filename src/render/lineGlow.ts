/**
 * 線そのものが光る(Phase 36 / react-bits「Strands」から)。
 *
 * この作品の線は、これまで **平坦な帯**だった ── フラグメントは `diffuseColor` を
 * そのまま吐き、光っているように見えるのは後段の UnrealBloom がスクリーン空間で
 * にじませていたからである。ブルームは画面を見ているだけなので **深度を知らない**:
 * 奥の細く暗い線と手前の太く熱い線が、同じ形の暈をまとう。
 *
 * ここで足すのは、線が自分の断面へ持つ**距離場**である。
 *
 *   g = thick / (d + thick·0.45)      d = 芯からの距離
 *   g = g²
 *
 * 芯(d=0)で g² = (1/0.45)² ≒ 4.94 まで跳ね上がるので、HDR のまま 1 を大きく
 * 超えて **芯が白く飛ぶ**。色は芯から追い出されて暈へ移る。縁は存在しない ──
 * 距離の関数なので輪郭という概念がない。「ワイヤーフレーム」が「発光体」になる。
 *
 * ## 垂直方向は `vUv.x` である(踏み抜きやすい)
 *
 * LineMaterial の `vUv` は **x が線に垂直・y が線に沿う**。`LineSegmentsGeometry` の
 * uv は (±1, {2,1,−1,−2}) で、position.x が横のオフセット符号、position.y が
 * 始点/終点と端キャップの選択に使われるからである。three 自身の端キャップ判定も
 * `abs( vUv.y ) > 1.0`(= 線分の外側)と書かれている。したがって芯からの距離は
 * カプセルの距離になる:
 *
 *   gx = |vUv.x|                    垂直方向(0..1、1 が四角形の縁)
 *   gy = max(|vUv.y| − 1, 0)        線分の端からはみ出した分
 *   d  = √(gx² + gy²)
 *
 * ## 暈は四角形の中にしか描けない
 *
 * 距離場は無限に広がるが、描けるのは線が持つ四角形の内側だけである。だから
 * **四角形を広げる**しかない ── `linewidth` は「見かけの線幅」ではなく
 * 「暈が入る器の幅」になる。器の縁で場を 0 へ落とす窓 (1−d²)² を掛けるので、
 * 打ち切りの円は見えない(実測: cutoff 3 と 8 で見分けがつかない)。
 *
 *   四角形の幅 = 2 · CUTOFF · glowPx = 6 · glowPx
 *   thickNorm  = glowPx / (四角形の幅 / 2) = 1 / CUTOFF = 1/3   ← 定数になる
 *
 * 代償はフィルレートである。glowPx=5 なら器は 30px 幅で、現行の 2.6px の約 11.5 倍。
 *
 * ## 細分割で明るさが変わってはいけない
 *
 * narrative は辺を 16 分割して描く(投影カスケードが 4D の直線を 3D では曲線に
 * 映すため)。分割された線分は加算合成で**重なる**ので、素朴に足すと
 * 「短縮された辺ほど明るい」という物理的に無意味な差が出る ── 短縮された辺は
 * 線分が短く、暈の届く範囲により多くの線分が入るからである。しかも図がモーフする
 * あいだ辺の見かけの長さは変わり続けるので、**明るさがスクロールで勝手に揺れる**。
 *
 * したがって各線分の寄与を、その線分の画面上の長さで正規化する:
 *
 *   lenNorm = min(segLenPx, 器の幅) / 器の幅
 *
 * ・segLen ≪ 暈の半径 … 寄与が長さに比例する = 線積分。分割数に依らない
 * ・segLen ≫ 暈の半径 … 1 で飽和する。1 本の線分が暈の全域を覆うため
 *
 * 残るのはその中間だけで、そこは分割数の違い(残響・足場は 4 分割)ぶんの
 * 高々 2 倍のずれになる。薄い層は自前のゲインを持っているので吸収できる。
 *
 * ## なぜ premultipliedAlpha が要るか
 *
 * 既定の AdditiveBlending は `SRC_ALPHA, ONE` なので、寄与は alpha で頭打ちになる。
 * 芯を 1 より上へ飛ばすには `ONE, ONE` が要る ── three は premultipliedAlpha が
 * 立っているときだけそちらを選ぶ(WebGLState)。シェーダー側は rgb に
 * 乗せ切って alpha=1 を吐くので、`<premultiplied_alpha_fragment>` は恒等になる。
 */

/** 場を打ち切る半径(glowPx の何倍か)。器の縁がそのまま打ち切り位置になる */
export const LINE_GLOW_CUTOFF = 3;

/**
 * 芯の鋭さ。`g = thick / (d + thick·k)` の k で、**芯のピークは (1/k)²** になる。
 * 0.45 は Strands の値で、ピーク 4.94 ── これが「芯が白く飛ぶ」の正体である。
 */
export const LINE_GLOW_CORE_K = 0.45;

/**
 * 暈を測る基準距離(thickNorm の何倍か)。**k を動かしても暈が動かないよう
 * 強度を補正するための支点**で、ここでの値が次元によらず一定になる。
 */
export const LINE_GLOW_HALO_REF = 2;

/**
 * 正規化した器の中での場のスケール。CUTOFF の逆数で、**定数になる** ──
 * 器の幅を glowPx に比例させているので、glowPx を動かしてもこの値は動かない。
 */
export const LINE_GLOW_THICK_NORM = 1 / LINE_GLOW_CUTOFF;

/**
 * 場の強さ。**ブラウザ実測で決めた値**(2026-08-22、第四章 4.00D / 終章 6.00D、
 * `gl.readPixels` でキャンバスの輝度を直接読んだもの)。
 *
 * ## この定数は「見え方」ではなく「露出」を決める ── ここが厄介なところ
 *
 * 芯が白く飛ぶには HDR が 1 を超える必要があり、Phase 35 の線は 0.1〜0.2 しか
 * 出していなかった。**つまり Strands の性格と現行の露出は両立しない。**
 * 暈を細くして芯を熱くすれば釣り合うかと思ったが、そうはならない ──
 * 器を縮めると `lineGlowLenNorm` の分母も縮んで係数が 1 へ早く飽和するので、
 * 明るさはむしろ上がる。**露出はこの 1 本でしか動かない。**
 *
 * 実測(キャンバス全体の平均輝度 / 本文 `.ch-body` 背後の平均輝度):
 *
 *   強度   4D 全体   4D 本文背後   6D 全体   6D 本文背後   見え方
 *   ────────────────────────────────────────────────────────────────
 *   Ph.35  0.056     0.049         0.124     0.121        平坦な帯(変更前)
 *   0.5    0.068     0.058         0.138     0.167        ほぼ変わらない
 *   1.0    0.107     0.087         0.184     0.192        暈は出るが控えめ
 *   1.5    0.132     0.103         0.243     0.303        ← 採用
 *   2.2    0.194     0.172         0.294     0.402        最も Strands に近いが
 *                                                         本文背後が 3.5 倍になる
 *
 * 1.5 は「芯が白く、色が暈に残り、内部の辺も追える」最小限の値である。
 * **上げるほど図は美しくなり、文字は読みにくくなる** ── 章テキストは図の上に
 * 出る(§7.4)ので、ここを動かすときは必ず本文背後の輝度も一緒に見ること。
 */
export const LINE_GLOW_INTENSITY = 1.5;

/**
 * 鈍らせはじめる次元。**4.0 ちょうどから効かせる** ── ここが 0 なので
 * 第四章の平地(dim = 4.00)は Strands のまま変わらない。
 *
 * 4.5 から始めると **モーフの途中(dim ≈ 4.47)に鈍化がまったく効かない**。
 * 白飛びが最大になるのは章の平地ではなく軸が伸びている最中で、実測でも
 * dim 4.47 と 5.31 が 3.6〜3.8% と、隣接する平地の 3 倍を出していた。
 */
export const LINE_GLOW_CORE_K_FROM = 4.0;
/** 6 次元での k。**ブラウザ実測で決めた値**(下の表)── 「改善」しないこと */
export const LINE_GLOW_CORE_K_MAX = 1.3;

/**
 * 芯の鋭さ ── 次元が上がるほど鈍らせる(Phase 36a)。
 *
 * 4 次元までは Strands のままでよかったが、**5 次元から白飛びが目に立つ**。
 * 辺の本数が 32 → 80 → 192 と増え、加算合成でピークどうしが重なるからで、
 * 実測でも輝度 0.85 超の画素は 1.25% → 2.57% → 5.61% と約 4.5 倍になっていた。
 *
 * 強度を下げれば白飛びは減るが、**暈も一緒に沈む**。分けて効かせるノブがこの k で、
 * 芯のピークが (1/k)² なのに対し暈は (1/(REF+k))² としか動かない ──
 * k を上げると芯だけが速く落ちる。
 *
 * ブラウザ実測(強度は下の `glowIntensityFor` で自動補正済み。
 * blown = 輝度 0.85 超の画素の割合 / sat = 点灯部の平均彩度):
 *
 *   k     芯ピーク   5D blown   5D 彩度   6D blown   6D 彩度
 *   ─────────────────────────────────────────────────────────
 *   0.45  7.41       2.57%      0.585     5.61%      0.571   ← Strands のまま
 *   0.60  4.69       1.54%      0.590     4.16%      0.553
 *   0.80  3.06       0.81%      0.594     2.92%      0.565
 *   1.00  2.25       0.42%      0.611     2.09%      0.577
 *   1.30  1.61       0.21%      0.627     1.54%      0.594   ← 採用(6D)
 *   1.70  1.18       0.21%      0.644     0.90%      0.607
 *
 * 基準は **4 次元の 1.25% / 彩度 0.608**。k=1.3 まで上げると 6 次元がそこへ戻り、
 * **彩度も 0.571 → 0.594 と上がる** ── 白飛びが引くぶん、色が戻ってくる。
 */
export function coreKFor(dimLevel: number): number {
  const span = 6 - LINE_GLOW_CORE_K_FROM;
  const t = (dimLevel - LINE_GLOW_CORE_K_FROM) / span;
  const u = t > 0 ? (t < 1 ? t : 1) : 0;
  return LINE_GLOW_CORE_K + (LINE_GLOW_CORE_K_MAX - LINE_GLOW_CORE_K) * u;
}

/**
 * 強度 ── k の補正込み。
 *
 * k を上げると芯も暈も下がるので、**暈が動かないぶんだけ強度で戻す**。支点は
 * d = REF·thick の位置で、そこでの値 (1/(REF+k))²·I が k によらず一定になるよう解く:
 *
 *   I(k) = I₀ · ((REF + k) / (REF + k₀))²
 *
 * 補正は導出であって調整値ではない ── **k を変えたらここは自動で追従する。**
 * 残るのは「芯がどれだけ鈍るか」だけになり、暈は次元によらず同じ濃さで出る。
 */
export function glowIntensityFor(dimLevel: number, base = LINE_GLOW_INTENSITY): number {
  const k = coreKFor(dimLevel);
  const ratio = (LINE_GLOW_HALO_REF + k) / (LINE_GLOW_HALO_REF + LINE_GLOW_CORE_K);
  return base * ratio * ratio;
}

/** 芯のピーク(= d=0 での場の値)。白飛びの直接の原因なので、試験で縛る */
export function lineGlowCorePeak(dimLevel: number, base = LINE_GLOW_INTENSITY): number {
  const k = coreKFor(dimLevel);
  return glowIntensityFor(dimLevel, base) / (k * k);
}

/** glowPx の下限・上限(px)。下限は「暈と呼べる最小」、上限は低次元での広がり */
export const LINE_GLOW_PX_MIN = 3;
export const LINE_GLOW_PX_MAX = 6;

/**
 * 次元に応じた暈の広がり(px)。
 *
 * **暈の半径は辺の間隔より小さくなければならない。** 大きくなった瞬間に隣の辺と
 * 融合して、線画ではなく面になる ── これは Phase 12a の監査が線幅について
 * 既に指摘していたこと(narrative.ts の LINE_WIDTH のノート)と同じ現象で、
 * 暈のほうが半径が大きいぶん先に起きる。
 *
 * 6-cube は 192 辺を 4-cube の 32 辺と同じ画面面積へ詰めるので、次元が上がるほど
 * 締める。実測(CPU ラスタライザ、760px 高): 4 次元で 5px、6 次元で 3px。
 * 低次元は辺が数本しかないので上限で頭打ちにする。
 *
 * 読み筋としても素直である ── **次元が上がるほど、光の取り分が減る。**
 */
export function glowPxFor(dimLevel: number): number {
  const raw = 9 - dimLevel;
  if (!(raw > LINE_GLOW_PX_MIN)) return LINE_GLOW_PX_MIN;
  return raw < LINE_GLOW_PX_MAX ? raw : LINE_GLOW_PX_MAX;
}

/**
 * 暈が収まる四角形の幅(px)= `LineMaterial.linewidth` へ渡す値。
 * **これは見かけの線幅ではない**(見かけの太さを決めるのは glowPx のほう)。
 */
export function lineGlowQuadWidth(glowPx: number): number {
  return 2 * LINE_GLOW_CUTOFF * glowPx;
}

/**
 * 場の値(純関数 / テスト用)。シェーダーの式と**同じ順序**で書いてある。
 *
 * @param d       芯からの正規化距離(0 = 芯、1 = 器の縁)
 * @param lenNorm 線分長の正規化係数 min(segLenPx, 器の幅) / 器の幅 ∈ [0,1]
 */
export function lineGlowGain(
  d: number,
  lenNorm: number,
  thickNorm = LINE_GLOW_THICK_NORM,
  intensity = LINE_GLOW_INTENSITY,
  coreK = LINE_GLOW_CORE_K,
): number {
  const dn = d > 0 ? (d < 1 ? d : 1) : 0;
  const g = thickNorm / (dn + thickNorm * coreK);
  const w = 1 - dn * dn;
  return g * g * (w * w) * intensity * lenNorm;
}

/** 線分長の正規化係数(純関数 / テスト用) */
export function lineGlowLenNorm(segLenPx: number, quadWidthPx: number): number {
  if (!(quadWidthPx > 0)) return 0;
  const capped = segLenPx < quadWidthPx ? segLenPx : quadWidthPx;
  return capped > 0 ? capped / quadWidthPx : 0;
}

// --- シェーダー片 -----------------------------------------------------------------
// 注入は depthWidth.ts が一手に引き受ける ── `onBeforeCompile` はマテリアルに
// 1 つしか置けないので、持ち主を 2 つにすると後から書いたほうが前を黙って消す。

/** 頂点シェーダーへ足す宣言(既存の uniform 宣言と同じ置換に相乗りする) */
export const GLOW_VERT_DECL = /* glsl */ `varying float vGlowLen;`;

/**
 * 頂点シェーダーの本体へ足す 1 行。`ndcStart` / `ndcEnd` / `resolution` /
 * `linewidth` がすべて視界に入っている位置(= 深度線幅と同じアンカー)で書く。
 * NDC は画面高 `resolution.y` に対して 2 を張るので、px は ndc·0.5·resolution。
 *
 * 正規化の基準に使う `linewidth` は**深度で振る前の素の値**である。幾何量ではなく
 * 正規化定数なので、深度で ±20% 揺れないほうが安定する。
 */
export const GLOW_VERT_BODY = /* glsl */ `vGlowLen = min( length( ( ndcEnd.xy - ndcStart.xy ) * 0.5 * resolution ), linewidth ) / max( linewidth, 1e-6 );`;

/** フラグメントシェーダーへ足す宣言 */
export const GLOW_FRAG_DECL = /* glsl */ `uniform vec3 uLineGlow;
varying float vGlowLen;`;

/** フラグメントシェーダーの置換アンカー(three r185 の実物から採取。単一箇所) */
export const GLOW_FRAG_ANCHOR = 'gl_FragColor = vec4( diffuseColor.rgb, alpha );';

/**
 * uLineGlow = (thickNorm, intensity, coreK)。
 * `alpha` はここまでで `opacity`(と端キャップの被覆)を通った値なので、
 * 既存の不透明度の扱いはそのまま生きる。
 */
export const GLOW_FRAG_BODY = /* glsl */ `float gx = abs( vUv.x );
			float gy = max( abs( vUv.y ) - 1.0, 0.0 );
			float gd = min( sqrt( gx * gx + gy * gy ), 1.0 );
			float gg = uLineGlow.x / ( gd + uLineGlow.x * uLineGlow.z );
			gg *= gg;
			float gw = 1.0 - gd * gd;
			gw *= gw;
			gl_FragColor = vec4( diffuseColor.rgb * ( gg * gw * uLineGlow.y * vGlowLen * alpha ), 1.0 );`;
