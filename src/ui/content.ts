/**
 * コピーの引き口(Phase 45 以降)。
 *
 * かつてこのファイルが**日本語の全文そのもの**だった。多言語化で 4 つへ分けた:
 *
 *   `i18n/types.ts` … 辞書の型。訳の抜けをコンパイル時に落とす
 *   `i18n/ja.ts`    … 日本語の全文(**原作言語であり、コピーの正典**)
 *   `i18n/en.ts`    … 英語の全文
 *   ここ            … **どの言語かを 1 回だけ決め、引き方を 1 本だけ持つ**
 *
 * 呼び出し側の import は 1 行も変えていない ── `CHAPTERS` も
 * `polytopeTagline` も同じ名前で同じ場所から引ける。**言語を意識するのは
 * このファイルと `i18n/` だけ**で、展示・シーン・コンポーネントは
 * 最後まで「文言はここから来る」しか知らない。
 *
 * **引き方(手順)を言語ごとに書かない**のが要点である。3 桁区切り、
 * 「固有名 → 族の総称 → 数で呼ぶ」の落とし方、キャプションの
 * `モード:m:n` → `モード` のフォールバック ── これらは算術と規約であって
 * 言語ではない。片方の言語でだけ手順を直すと、もう片方が黙って古いままになる。
 */

import { COPY, MARQUEE, UI } from '../i18n';
import {
  perspectiveCaptionIn,
  perspectiveTaglineIn,
  polytopeNameIn,
  polytopeTaglineIn,
} from '../i18n/lookup';

export type {
  Chapter,
  ChapterRole,
  CodexQuest,
  CodexStat,
  ExhibitCodex,
  ExhibitInfo,
  LabelPair,
} from '../i18n/types';

/**
 * 辞書そのものと、その中でよく引く 2 つ。選択は `i18n/index.ts` が行う ──
 * ここが再エクスポートを続けるのは、呼び出し側の import を変えないため。
 */
export { COPY, MARQUEE, UI };

/* --------------------------------------------------------------------- 物語 */

export const CHAPTERS = COPY.chapters;

/** 章ごとの目標 dimLevel(scrollDirector へ渡す。毎フレーム再構築しないよう定数化) */
export const CHAPTER_DIMS: readonly number[] = CHAPTERS.map((c) => c.dim);

/**
 * 章ごとの役割。階段(`core/detents.ts`)が段の置き方を決めるのに使う
 * ── 序章は「読む位置」の段を持たず、終章は踊り場を持たない。
 * 毎フレーム再構築しないよう定数化する(`CHAPTER_DIMS` と同じ理由)。
 */
export const CHAPTER_ROLES = CHAPTERS.map((c) => c.role);

/* ------------------------------------------------------------------ ギャラリー */

export const EXHIBIT_INFO = COPY.exhibits;

/** id から展示情報を引く(未知の id では undefined) */
export function exhibitInfo(id: string) {
  return EXHIBIT_INFO.find((info) => info.id === id);
}

/* --------------------------------------------------------------------- POLYTOPE */

/*
  以下 4 本は `i18n/lookup.ts` の純関数を **この実行の辞書へ束ねただけ** の薄い
  包み。手順そのものはあちらに 1 本だけあり(理由はあちらのモジュール注)、
  ここは呼び出し側から言語を隠す役だけを負う。
*/

/** いま画面にある図形の名前。固有名が尽きたら数で呼ぶ */
export function polytopeName(family: string, n: number): string {
  return polytopeNameIn(COPY, family, n);
}

/** 見出しの副題(POLYTOPE)。頂点数・辺数は展示が持つ実物の値を渡す */
export function polytopeTagline(
  family: string,
  n: number,
  vertices: number,
  edges: number,
): string {
  return polytopeTaglineIn(COPY, family, n, vertices, edges);
}

/* ------------------------------------------------------------------ PERSPECTIVE */

/** キーは `モード:観測者m:対象n`。完全一致がなければ `モード` だけを引く */
export const PERSPECTIVE_CAPTIONS = COPY.perspective.captions;

/** キーは `m:n` */
export const PERSPECTIVE_TAGLINES = COPY.perspective.taglines;

/** (モード, m, n) のキャプション。必ず何かを返す */
export function perspectiveCaption(mode: string, m: number, n: number): string {
  return perspectiveCaptionIn(COPY, mode, m, n);
}

/** (m, n) の副題。必ず何かを返す */
export function perspectiveTagline(m: number, n: number): string {
  return perspectiveTaglineIn(COPY, m, n);
}
