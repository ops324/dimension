/**
 * 引き方(Phase 45)。**辞書 1 つを受け取って、そこから文言を組む純関数だけ**。
 *
 * `ui/content.ts` はこれらを `COPY`(選ばれた言語)へ束ねて再エクスポートする
 * ので、呼び出し側は言語を知らないままでいられる。**それでもここを別に切る
 * 理由は 2 つある**:
 *
 *   ① **手順を言語ごとに書かない。** 3 桁区切り、「固有名 → 族の総称 →
 *      数で呼ぶ」の落とし方、`モード:m:n` → `モード` のフォールバック ──
 *      これらは算術と規約であって言語ではない。ja.ts と en.ts の両方に
 *      手順を置くと、片方だけ直したときにもう片方が黙って古いままになる
 *   ② **両方の言語を同じ試験で突ける。** `LANG` に束ねた関数しか無いと、
 *      Node のテストは既定言語しか見られない ── 「到達しうる全組に専用の
 *      一文がある」のような不変条件は、**どの言語でも**成り立っていなければ
 *      意味がない(`src/tests/content.test.ts` は両辞書を回している)
 */

import type { Copy } from './types';

/** 3 桁区切り。ロケールに依らせない(`toLocaleString` は環境で揺れる) */
export function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * いま画面にある図形の名前。固有名が尽きたら「n 次元の◯◯」へ落ちる。
 *
 * **落ち方が作品の一部**である。超立方体の固有名は 6 で打ち止めにしてあり、
 * 7 から先を数で呼ぶのは辞書に語が無いからではなく、終章の
 * 「名前がまだ足りないだけだ」をここで実演するため ── N スライダーを
 * 6 → 7 へ動かした人は、名前が名前でなくなる瞬間を見る。
 * 語を足して「直さない」こと(各言語の名前表のコメントも参照)。
 */
export function polytopeNameIn(copy: Copy, family: string, n: number): string {
  const named = copy.polytope.names[family]?.[n];
  if (named !== undefined) return named;
  const kind = copy.polytope.kinds[family] ?? copy.polytope.fallbackKind;
  return copy.polytope.byNumber(n, kind);
}

/**
 * 見出しの副題。**この展示も設定でここが変わる**(Phase 41、PERSPECTIVE と同じ作法)。
 *
 * 元は「n = 3 から 10 へ ── 規則だけが、先へ行く」の固定文で、展示の説明では
 * あっても**いま何を見ているか**は言っていなかった。n=7 で入場する設計にした以上、
 * 128 頂点 / 448 辺の密な影が「散らかっている」ではなく「一歩進んだ」と読めることが要る ──
 * **数を名乗った瞬間に、毛玉は証拠に変わる**。
 *
 * 名前は言語(そして 7 で尽きる)、数は算術(どこまでも続く)。日本語が漢数字と
 * 算用数字を混ぜ、英語が綴った数と算用数字を混ぜているのはそのためで、崩さないこと。
 *
 * 頂点数・辺数は**展示が持っている実物の値を渡す** ── ここで数え直すと、
 * パネルの VERTICES / EDGES と食い違う可能性を持ち込むことになる。
 */
export function polytopeTaglineIn(
  copy: Copy,
  family: string,
  n: number,
  vertices: number,
  edges: number,
): string {
  return copy.polytope.tagline(
    polytopeNameIn(copy, family, n),
    grouped(vertices),
    grouped(edges),
  );
}

/**
 * (モード, 観測者 m, 対象 n) に対応するキャプション。
 * 個別の組が未定義ならモード共通の一文へ落とす(必ず何かを返す)。
 */
export function perspectiveCaptionIn(copy: Copy, mode: string, m: number, n: number): string {
  const table = copy.perspective.captions;
  return table[`${mode}:${m}:${n}`] ?? table[mode] ?? '';
}

/** (m, n) の副題。未定義の組は次元差から組み立てる(必ず何かを返す) */
export function perspectiveTaglineIn(copy: Copy, m: number, n: number): string {
  return copy.perspective.taglines[`${m}:${n}`] ?? copy.perspective.taglineFallback(m, n);
}
