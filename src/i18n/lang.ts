/**
 * 言語の決定層(Phase 45)。
 *
 * ここまで DIMENSION は日本語だけの作品だった。**この層が持つのは「どの言語か」
 * の 1 ビットだけ**で、訳文そのものは `ja.ts` / `en.ts` が持つ。
 *
 * 優先順位は 4 段。上が強い:
 *
 *   ① `?lang=en` …… URL。**共有リンクに言語が乗る**ので、送った相手にも
 *      同じ言語で届く。`route.ts` の「状態は URL に載せる」(Phase 44)と同じ作法
 *   ② localStorage … 一度スイッチを押したら次回以降ずっとそれ。
 *      **③ より強い**のが要点で、日本語 OS の人が英語を選んだなら、それは
 *      OS の設定より新しい情報である
 *   ③ navigator.languages … OS / ブラウザの言語設定。**初回訪問時だけ**見る
 *   ④ 既定 = `en`。①〜③のどれとも当たらないときだけ落ちてくる ── 日本語環境は
 *      ③ で `ja` に当たるので、ここへ来るのはフランス語環境などになる。
 *      原作言語は `ja` だが、**読める人の数**で選ぶ
 *
 * **`route.ts` のキーとは重ねない。** あちらが所有するのは `gallery` と `p` の
 * 2 本で、`lang` はこちらの持ち物 ── `route.ts` は「他のクエリを何も知らないまま
 * 保つ」と宣言しており(`new URL(location.href)` から組み直す)、実際に
 * `lang` はモードの出入りを跨いで生き残る。逆にこちらは `gallery` / `p` に
 * 触らないので、言語を変えても見ている展示とそのパラメータは保たれる。
 *
 * **切り替えはリロードで行う**(`setLang`)。物語 DOM は
 * `buildNarrativeDOM(root, CHAPTERS)` が一度だけ組み、SplitText が行分割して
 * span をキャッシュし、ScrollDirector が章の高さを実測している ── 生きたまま
 * 差し替えるにはその 3 つを解いて組み直すことになる。言語の切り替えは
 * 一セッションに 0〜1 回の操作なので、**壊れない方を採る**。scrollY は
 * `route.ts` が履歴エントリへ焼いてあるので、リロードしても読んでいた位置へ戻る。
 */

export type Lang = 'ja' | 'en';

/** 対応言語。スイッチの並び順もこれ(原作言語を先頭に置く) */
export const LANGS: readonly Lang[] = ['ja', 'en'];

/**
 * 既定。上の ④ ── **`ja` ではない**ことに意味がある(モジュール冒頭の注を参照)。
 */
export const DEFAULT_LANG: Lang = 'en';

/** URL のクエリキー。`route.ts` の `gallery` / `p` とは決して重ねない */
export const LANG_PARAM = 'lang';

/** localStorage のキー。音の設定(`dimension.sound`)と同じ名前空間に置く */
const STORAGE_KEY = 'dimension.lang';

export function isLang(value: string | null | undefined): value is Lang {
  return value === 'ja' || value === 'en';
}

/**
 * 言語を決める。**副作用を持たない純関数**で、入力は 3 つとも呼び出し側が渡す ──
 * `window` を直接読まないので、Node のテストからそのまま優先順位を検証できる
 * (実際に `src/tests/lang.test.ts` が 4 段すべてを突いている)。
 *
 * `navigator.languages` は `['ja-JP', 'ja', 'en-US']` のような**タグの列**で来る。
 * 地域を落として先頭一致で見るので `ja-JP` も `en-GB` も拾える。列の順が
 * そのまま利用者の優先度なので、**先に当たったものを採る**。
 */
export function resolveLang(
  href: string,
  stored: string | null,
  preferred: readonly string[],
): Lang {
  // ① URL
  const fromUrl = new URL(href).searchParams.get(LANG_PARAM);
  if (isLang(fromUrl)) return fromUrl;

  // ② 記憶した選択
  if (isLang(stored)) return stored;

  // ③ OS / ブラウザの言語設定。地域タグを落として先頭一致
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0];
    if (isLang(base)) return base;
  }

  // ④ 既定
  return DEFAULT_LANG;
}

/**
 * localStorage の読み。**プライベートブラウジングや設定で例外を投げる**ので
 * 必ず包む(`SoundToggle` が同じ理由で同じことをしている)。
 */
function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* 書けなくても動く。URL に載るので、少なくともその 1 回は効く */
  }
}

/**
 * この実行における言語。**モジュール読み込み時に一度だけ決めて凍らせる。**
 *
 * 凍らせるのが要点で、`content.ts` はこの値でモジュール本体を束ねる ──
 * 途中で変わると、既に組んだ DOM と次に引く文言が食い違う。変更は
 * `setLang()` = リロードだけが行える。
 *
 * Node(テスト・ビルド時の型検査)には `window` が無いので既定へ落とす。
 */
export const LANG: Lang =
  typeof window === 'undefined'
    ? DEFAULT_LANG
    : resolveLang(window.location.href, readStored(), navigator.languages ?? [navigator.language]);

/** HTML の `lang` 属性に載せる BCP 47 タグ */
const HTML_LANG: Readonly<Record<Lang, string>> = { ja: 'ja', en: 'en' };

/** OGP の `og:locale`(下線区切りであることに注意 ── ハイフンではない) */
export const OG_LOCALE: Readonly<Record<Lang, string>> = { ja: 'ja_JP', en: 'en_US' };

/**
 * `<html lang>` を実際の言語へ合わせる。
 *
 * index.html は `lang="ja"` で出荷される(JS を実行しないクローラと、
 * 静的マークアップに残した日本語の導入文がそこにあるため)。英語で読む回は
 * ここで書き換える ── **合っていない `lang` は支援技術の読み上げ言語を
 * 間違わせる**ので、装飾ではなく機能である。
 *
 * `data-lang` も併せて立てる。CSS 側は `:lang()` で足りるが、
 * 属性セレクタの方が「言語で見た目を出し分けている」箇所を grep しやすい。
 */
export function applyDocumentLang(lang: Lang = LANG): void {
  const root = document.documentElement;
  root.lang = HTML_LANG[lang];
  root.dataset.lang = lang;
}

/**
 * 言語を切り替える。記憶して、URL へ書いて、リロードする。
 *
 * **`?lang=` は既定言語でも必ず書く。** 「既定と一致する状態は書かない」は
 * `route.ts` の `applyState` の作法だが、ここでは逆にする ── 既定は
 * `navigator.languages` に依存するので、URL から落とすと**受け取った人の
 * 環境で別の言語になる**。共有リンクの言語が送り手の意図どおり届くこと、が
 * この機能の要件である。
 *
 * 他のクエリ(`gallery` / `p` / ハッシュ)には触らない。見ている展示と
 * そのパラメータは、言語を変えても保たれる。
 */
export function setLang(next: Lang): void {
  if (next === LANG) return;
  writeStored(next);
  const url = new URL(window.location.href);
  url.searchParams.set(LANG_PARAM, next);
  // `assign` ではなく `replace`。言語の切り替えで履歴を伸ばすと、
  // 「戻る」が前の言語の同じ画面へ戻ることになり、出口が遠ざかる
  window.location.replace(url.toString());
}
