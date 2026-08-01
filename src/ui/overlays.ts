import { smoothstep } from '../math/ease';
import type { ScrollDirector } from '../core/scrollDirector';
import type { Chapter } from './content';

/**
 * 物語 DOM の生成と、スクロール状態からのテキスト駆動。
 *
 * 方針:
 * - コピーは content.ts、構造はここ、見た目は style.css。index.html は器だけ。
 * - 毎フレーム走るのは **数値の比較と、変化したときだけの style 書き込み**。
 *   同じ値を書き続けるとブラウザはスタイル再計算を積み上げるため、
 *   しきい値以下の変化は書かない(overlays が 60fps の足を引っ張らないこと)。
 * - レイアウト読み(getBoundingClientRect 等)は一切しない。計測は
 *   scrollDirector.remeasure() に集約されている。
 */

/** テキストの立ち上がりストローク(px)。prefers-reduced-motion では 0 */
const RISE = 26;
/** 書き込みを省略するしきい値 */
const OPACITY_EPSILON = 0.005;
const TRANSLATE_EPSILON = 0.1;
const PROGRESS_EPSILON = 0.0005;

/**
 * fonts.ready の保険。@fontsource は自己ホストなので普通は即座に解決するが、
 * 何らかの理由で解決しなくても本文が永久に隠れることがないようにする。
 */
const FONT_TIMEOUT_MS = 2500;

export interface NarrativeDom {
  /** scrollDirector へ渡すセクション(章と 1:1) */
  readonly sections: HTMLElement[];
  /** フェード対象(pin の中身) */
  readonly inners: HTMLElement[];
  readonly cta: HTMLButtonElement | null;
}

function makeEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 章の左右振り分け(エディトリアルなリズム)。
 *
 * 中央寄せは採らない: 図形は常に画面中央(カメラは原点を見続ける)なので、
 * 中央寄せにすると日本語本文がワイヤーフレームに完全に重なって読めなくなる
 * (実測で確認済み)。左右へ寄せることで本文は常に余白の中に置かれ、
 * 巨大なディスプレイ英字だけが図形と重なる ─ これは意図した重なり。
 */
function alignFor(chapter: Chapter, index: number): string {
  if (chapter.role !== 'chapter') return 'left';
  return index % 2 === 1 ? 'left' : 'right';
}

/**
 * content.ts から物語セクションを組み立てて root へ差し込む。
 * index.html にある静的プロローグ(クローラ向け)はここで置き換えられる。
 */
export function buildNarrativeDOM(root: HTMLElement, chapters: readonly Chapter[]): NarrativeDom {
  const sections: HTMLElement[] = [];
  const inners: HTMLElement[] = [];
  let cta: HTMLButtonElement | null = null;

  const fragment = document.createDocumentFragment();

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];

    const section = makeEl('section', 'chapter');
    section.id = `ch-${chapter.id}`;
    section.dataset.role = chapter.role;
    section.dataset.ch = String(i);
    section.dataset.align = alignFor(chapter, i);

    const pin = makeEl('div', 'pin');
    const inner = makeEl('div', 'chapter-inner');

    // 章番号の行: CH.04 ── 4D
    const indexRow = makeEl('p', 'ch-index');
    indexRow.append(makeEl('span', 'ch-index-no', chapter.index));
    if (chapter.unit !== undefined) {
      const rule = makeEl('span', 'ch-rule');
      rule.setAttribute('aria-hidden', 'true');
      indexRow.append(rule, makeEl('span', 'ch-index-dim', chapter.unit));
    }

    // 見出し階層: プロローグの英字が h1、日本語タイトルが h2。以降は h2 / h3
    const isPrologue = chapter.role === 'prologue';
    const en = makeEl(isPrologue ? 'h1' : 'h2', 'ch-en', chapter.en);
    // 文字数に応じてディスプレイサイズを決める(長い語ほど小さく = 常に画面幅に収まる)
    en.style.setProperty('--len', String(chapter.en.length));

    const title = makeEl(isPrologue ? 'h2' : 'h3', 'ch-title', chapter.jp.title);
    const body = makeEl('p', 'ch-body', chapter.jp.body);

    inner.append(indexRow, en, title, body);

    if (chapter.hint !== undefined) {
      const hint = makeEl('p', 'ch-hint');
      const rail = makeEl('span', 'ch-hint-rail');
      rail.setAttribute('aria-hidden', 'true');
      rail.append(makeEl('span', 'ch-hint-dot'));
      hint.append(rail, makeEl('span', 'ch-hint-label', chapter.hint));
      inner.append(hint);
    }

    if (chapter.cta !== undefined) {
      const button = makeEl('button', 'cta');
      button.type = 'button';
      button.id = 'enter-gallery';
      button.append(
        makeEl('span', 'cta-label', chapter.cta),
        makeEl('span', 'cta-arrow', '→'),
      );
      button.querySelector('.cta-arrow')?.setAttribute('aria-hidden', 'true');
      inner.append(button);
      cta = button;
    }

    const caption = makeEl('span', 'ch-caption', chapter.caption);
    caption.setAttribute('aria-hidden', 'true');

    pin.append(inner, caption);
    section.append(pin);
    fragment.append(section);

    sections.push(section);
    inners.push(inner);
  }

  root.replaceChildren(fragment);

  return { sections, inners, cta };
}

interface OverlayOptions {
  readonly director: ScrollDirector;
  readonly chapters: readonly Chapter[];
  readonly dom: NarrativeDom;
}

export class Overlays {
  private readonly director: ScrollDirector;
  private readonly inners: readonly HTMLElement[];
  private readonly words: readonly string[];

  /** 章ごとのフェードプロファイル [inStart, inLen, outStart, outLen] × n */
  private readonly profiles: Float64Array;
  private readonly lastOpacity: Float64Array;
  private readonly lastTranslate: Float64Array;

  private readonly hudValue: HTMLElement | null;
  private readonly hudWord: HTMLElement | null;
  private readonly progressBar: HTMLElement | null;

  private lastDimText = '';
  private lastWordIndex = -1;
  private lastProgress = -1;
  private reduceMotion = false;
  private revealed = false;

  constructor(options: OverlayOptions) {
    const { director, chapters, dom } = options;

    this.director = director;
    this.inners = dom.inners;
    this.words = chapters.map((c) => c.en);

    const n = chapters.length;
    this.profiles = new Float64Array(n * 4);
    this.lastOpacity = new Float64Array(n).fill(-1);
    this.lastTranslate = new Float64Array(n).fill(Number.NaN);

    for (let i = 0; i < n; i++) {
      const o = i * 4;
      switch (chapters[i].role) {
        case 'prologue':
          // ページ最上部で即座に読める必要があるので入りのフェードはなし
          this.profiles[o] = 0;
          this.profiles[o + 1] = 0;
          this.profiles[o + 2] = 0.55;
          this.profiles[o + 3] = 0.3;
          break;
        case 'epilogue':
          // CTA を押せる状態のまま最後まで残す(出のフェードなし)
          this.profiles[o] = 0.05;
          this.profiles[o + 1] = 0.25;
          this.profiles[o + 2] = 1;
          this.profiles[o + 3] = 0;
          break;
        default:
          this.profiles[o] = 0.05;
          this.profiles[o + 1] = 0.2;
          this.profiles[o + 2] = 0.75;
          this.profiles[o + 3] = 0.2;
          break;
      }
    }

    this.hudValue = document.getElementById('hud-value');
    this.hudWord = document.getElementById('hud-word');
    this.progressBar = document.getElementById('progress-bar');

    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (query) {
      this.reduceMotion = query.matches;
      query.addEventListener('change', (event) => {
        this.reduceMotion = event.matches;
      });
    }

    if (dom.cta !== null) {
      dom.cta.addEventListener('click', this.handleCtaClick);
    }

    // フォント適用後に本文を出す + セクション再計測(行送りが変わって高さが動くため)
    const fonts = document.fonts;
    if (fonts !== undefined) {
      fonts.ready.then(this.reveal, this.reveal);
    }
    window.setTimeout(this.reveal, FONT_TIMEOUT_MS);
  }

  /** 毎フレーム(scrollDirector.update の後)に呼ぶ */
  update(): void {
    const locals = this.director.chapterLocals;
    const rise = this.reduceMotion ? 0 : RISE;
    const profiles = this.profiles;

    for (let i = 0; i < this.inners.length; i++) {
      const localT = locals[i];
      const o = i * 4;
      const inLen = profiles[o + 1];
      const outLen = profiles[o + 3];
      const a = inLen > 0 ? smoothstep((localT - profiles[o]) / inLen) : 1;
      const b = outLen > 0 ? smoothstep((localT - profiles[o + 2]) / outLen) : 0;

      const opacity = a * (1 - b);
      const translate = (1 - a) * rise - b * rise;

      if (
        Math.abs(opacity - this.lastOpacity[i]) >= OPACITY_EPSILON ||
        Math.abs(translate - this.lastTranslate[i]) >= TRANSLATE_EPSILON
      ) {
        const node = this.inners[i];
        node.style.opacity = opacity.toFixed(3);
        node.style.setProperty('--ty', `${translate.toFixed(2)}px`);
        this.lastOpacity[i] = opacity;
        this.lastTranslate[i] = translate;
      }
    }

    // 次元カウンタ: 表示文字列が変わったときだけ DOM を触る
    if (this.hudValue !== null) {
      const text = this.director.dimLevel.toFixed(2);
      if (text !== this.lastDimText) {
        this.hudValue.textContent = text;
        this.lastDimText = text;
      }
    }

    if (this.hudWord !== null) {
      const index = this.director.chapterIndex;
      if (index !== this.lastWordIndex) {
        this.hudWord.textContent = this.words[index] ?? '';
        this.lastWordIndex = index;
      }
    }

    if (this.progressBar !== null) {
      const progress = this.director.globalProgress;
      if (Math.abs(progress - this.lastProgress) >= PROGRESS_EPSILON) {
        this.progressBar.style.transform = `scaleX(${progress.toFixed(4)})`;
        this.lastProgress = progress;
      }
    }
  }

  private readonly reveal = (): void => {
    if (this.revealed) return;
    this.revealed = true;
    document.body.classList.add('fonts-ready');
    this.director.remeasure();
  };

  private readonly handleCtaClick = (): void => {
    // main.ts がこのイベントを購読し、gallery を遅延生成してモード遷移する
    window.dispatchEvent(new CustomEvent('dimension:enter-gallery'));
  };
}
