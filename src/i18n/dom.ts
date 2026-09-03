/**
 * index.html に静的に書いてある文言を、選ばれた言語へ書き換える(Phase 45)。
 *
 * **なぜ静的マークアップを残したままにするのか。** index.html の日本語は
 * ①JS を実行しないクローラのための本文(序章の h1 + 導入文)と
 * ②器のラベル(スキップリンク・ナビ・解説ボタン)の 2 種類ある。①は
 * `overlays.ts` の `buildNarrativeDOM()` が丸ごと差し替えるので触らない。
 * ここが受け持つのは②と、`<title>` / meta / OGP である。
 *
 * **キーの文字列で引く汎用の仕組み(`data-i18n="chrome.navLabel"`)を採らない。**
 * それは型検査を素通りするので、辞書のフィールドを改名した瞬間に静かに
 * 空文字が入る。代わりに**セレクタと辞書のフィールドを 1 対 1 で並べた表**を
 * ここに書く ── フィールドを消せばコンパイラが落ちる。
 *
 * 対象が見つからないときは黙って飛ばす。単独展示ブート(`?exhibit=`)は
 * #narrative / #mode-nav などを DOM から**削除する**ので、無いのが正常である。
 */

import { LANG, OG_LOCALE, applyDocumentLang } from './lang';
import { UI } from './index';
import type { LabelPair } from './types';

/** 可視テキストを差し替える */
function text(selector: string, value: string): void {
  const el = document.querySelector(selector);
  if (el !== null) el.textContent = value;
}

/** 属性を差し替える(aria-label / alt など) */
function attr(selector: string, name: string, value: string): void {
  document.querySelector(selector)?.setAttribute(name, value);
}

/**
 * meta タグの content を差し替える。キーは `name` か `property` のどちらか
 * ── OGP は `property`、description と Twitter Card は `name` である。
 */
function meta(key: 'name' | 'property', value: string, content: string): void {
  attr(`meta[${key}="${value}"]`, 'content', content);
}

/**
 * 「訳文 + 欧文」の二段組みを流し込む。**空の側は空文字のまま置く** ──
 * style.css の `:empty` 規則が畳むので、ここで DOM を消す必要はない。
 *
 * 英語では欧文の側が空になるので、`aria-hidden` を**外す**必要がある:
 * index.html は `<span class="nav-en" aria-hidden="true">` と書いてあり、
 * 訳文の側にラベルが入っているあいだはそれが正しいが、
 * ここで扱う 2 か所(ナビ・解説ボタン)はどちらも**訳文の側が主**なので、
 * 実際に空になるのは欧文の側だけである。空要素の aria-hidden は無害なので、
 * 属性はそのままにしてある(Drawer 側は主従が逆なので、あちらは条件付き)。
 */
function pair(selector: string, textSel: string, latinSel: string, value: LabelPair): void {
  const root = document.querySelector(selector);
  if (root === null) return;
  const t = root.querySelector(textSel);
  if (t !== null) t.textContent = value.text;
  const l = root.querySelector(latinSel);
  if (l !== null) l.textContent = value.latin;
}

/**
 * 起動時に 1 回だけ呼ぶ。**プリローダより先**に呼ぶこと ── `<html lang>` が
 * 合っていないあいだに支援技術が読み始めると、言語を間違えた声で始まる。
 */
export function applyStaticCopy(): void {
  applyDocumentLang(LANG);

  // --- 文書のメタ情報 ---
  document.title = UI.doc.title;
  meta('name', 'description', UI.doc.description);
  meta('property', 'og:locale', OG_LOCALE[LANG]);
  meta('property', 'og:title', UI.doc.title);
  meta('property', 'og:description', UI.doc.ogDescription);
  meta('property', 'og:image:alt', UI.doc.ogImageAlt);
  meta('name', 'twitter:title', UI.doc.title);
  meta('name', 'twitter:description', UI.doc.ogDescription);

  // --- 器のラベル ---
  text('#skip-gallery', UI.chrome.skipToGallery);
  attr('#gl', 'aria-label', UI.chrome.canvasLabel);
  attr('#mode-nav', 'aria-label', UI.chrome.navLabel);
  pair('#mode-nav [data-mode="narrative"]', '.nav-jp', '.nav-en', UI.chrome.navNarrative);
  pair('#mode-nav [data-mode="gallery"]', '.nav-jp', '.nav-en', UI.chrome.navGallery);
  attr('#gallery-tabs', 'aria-label', UI.chrome.tabsLabel);
  pair('#about-toggle', '.gh-about-jp', '.gh-about-en', UI.chrome.about);
  attr('#drawer-close', 'aria-label', UI.chrome.drawerClose);
}
