import type { ScrollDirector } from '../core/scrollDirector';
import type { Chapter } from './content';
import type { Announcer } from './components/Announcer';
import { DUR, EASE, cancelAll, play } from './components/component';
import {
  reveal as revealSplit,
  splitChars,
  splitLinesBatch,
  type SplitHandle,
} from './components/SplitText';

/**
 * 物語 DOM の生成と、スクロール状態からのテキスト駆動。
 *
 * 方針:
 * - コピーは content.ts、構造はここ、見た目は style.css。index.html は器だけ。
 * - Phase 9a でテキストの出し入れを **ブロック全体の opacity フェードから
 *   振り付け(choreography)へ**置き換えた。章に入るときは
 *     英字1文字 → 日本語見出しの行 → 本文の行 → 縦組みキャプション
 *   の順に、マスクの下から立ち上がる。出るときは段差をつけずに 280ms で沈める
 *   ── 入りは語り、出は静けさ。
 * - 状態は章ごとの 4 状態機械(hidden / revealing / shown / hiding)。
 *   毎フレーム走るのは **数値の比較だけ**で、DOM を触るのは状態が変わる瞬間だけ。
 *   span は生成時にキャッシュしてあるので、フレーム中の新規確保は起きない。
 * - レイアウト読み(getBoundingClientRect 等)は分割時とリサイズ時だけ。
 *   毎フレームの計測は scrollDirector.remeasure() に集約されている。
 */

/** 書き込みを省略するしきい値 */
const PROGRESS_EPSILON = 0.0005;

/**
 * fonts.ready の保険。@fontsource は自己ホストなので普通は即座に解決するが、
 * 何らかの理由で解決しなくても本文が永久に隠れることがないようにする。
 */
const FONT_TIMEOUT_MS = 2500;
/** プリローダが退場しなかった場合でも必ず振り付けを始める保険(ms) */
const START_TIMEOUT_MS = 6000;

/* --------------------------------------------------------------- 振り付けの尺 */

/** 章に入ったと見なす localT。0.02 まで巻き戻すと出る(ヒステリシス) */
const IN_T = 0.06;
const BACK_T = 0.02;
/** 章から出る localT(役割ごと) */
const OUT_T_CHAPTER = 0.86;
const OUT_T_PROLOGUE = 0.72;
/** エピローグは CTA を押せる状態のまま最後まで残す = 出ない */
const OUT_T_NEVER = 2;

/** 英字ディスプレイ: 1 文字ごとの遅延(ms) */
const CHAR_STAGGER = 24;
/** 日本語見出し: 開始遅延と行送り */
const TITLE_DELAY = 90;
const TITLE_STAGGER = 70;
/** 本文: 開始遅延と行送り */
const BODY_DELAY = 180;
const BODY_STAGGER = 60;
/** 最後に出るもの(縦組みキャプション・スクロール誘導・CTA) */
const TAIL_DELAY = 560;
const TAIL_MS = 620;
/** 退場。段差なしの一斉フェードダウン */
const EXIT_MS = 280;
const EXIT_DROP = 10;

const enum ChapterState {
  Hidden = 0,
  Revealing = 1,
  Shown = 2,
  Hiding = 3,
}

/** 流れる帯(プロローグ / エピローグ)。一行を延々と繰り返すだけの装飾 */
const MARQUEE_PROLOGUE = 'THE FOURTH DIMENSION IS A DIRECTION — NOT A PLACE — ';
const MARQUEE_EPILOGUE = 'EVERY DIMENSION CONTAINS THE LAST — ';
/** 帯 1 本ぶんの繰り返し回数。半分がビューポート幅を超えていれば継ぎ目は見えない */
const MARQUEE_REPEAT = 8;

export interface NarrativeDom {
  /** scrollDirector へ渡すセクション(章と 1:1) */
  readonly sections: HTMLElement[];
  /** 章のテキストブロック(退場フェードの対象) */
  readonly inners: HTMLElement[];
  /** 巨大ディスプレイ英字(1 文字ずつ分割する) */
  readonly ens: HTMLElement[];
  /** 日本語見出し(行分割) */
  readonly titles: HTMLElement[];
  /** 日本語本文(行分割) */
  readonly bodies: HTMLElement[];
  /** 最初に出る小さな文字(章番号・計器の読み)。控えめなフェードだけ */
  readonly heads: HTMLElement[][];
  /** 最後に出る飾り。章ごとに 0〜3 個 */
  readonly tails: HTMLElement[][];
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

/** 流れる帯を作る。同一内容を 2 枚並べ、-50% までの平行移動でループさせる */
function makeMarquee(text: string): HTMLElement {
  const strip = makeEl('div', 'mq');
  strip.setAttribute('aria-hidden', 'true');
  const track = makeEl('div', 'mq-track');
  const line = text.repeat(MARQUEE_REPEAT);
  track.append(makeEl('span', 'mq-half', line), makeEl('span', 'mq-half', line));
  strip.append(track);
  return strip;
}

/**
 * content.ts から物語セクションを組み立てて root へ差し込む。
 * index.html にある静的プロローグ(クローラ向け)はここで置き換えられる。
 */
export function buildNarrativeDOM(root: HTMLElement, chapters: readonly Chapter[]): NarrativeDom {
  const sections: HTMLElement[] = [];
  const inners: HTMLElement[] = [];
  const ens: HTMLElement[] = [];
  const titles: HTMLElement[] = [];
  const bodies: HTMLElement[] = [];
  const heads: HTMLElement[][] = [];
  const tails: HTMLElement[][] = [];
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
    const head: HTMLElement[] = [];
    const tail: HTMLElement[] = [];

    // 章番号の行: CH.04 ── 4D
    // lang="en" は器に 1 つで足りる(.ch-index-no と .ch-index-dim を覆う。
    // あいだの .ch-rule は aria-hidden なので関係しない)
    const indexRow = makeEl('p', 'ch-index');
    indexRow.lang = 'en';
    indexRow.append(makeEl('span', 'ch-index-no', chapter.index));
    if (chapter.unit !== undefined) {
      const rule = makeEl('span', 'ch-rule');
      rule.setAttribute('aria-hidden', 'true');
      indexRow.append(rule, makeEl('span', 'ch-index-dim', chapter.unit));
    }
    inner.append(indexRow);
    head.push(indexRow);

    // 計器の読み。章番号の下に小さく置く(装飾なので読み上げ対象から外す)
    if (chapter.coord !== undefined) {
      const coord = makeEl('p', 'ch-coord', chapter.coord);
      coord.setAttribute('aria-hidden', 'true');
      inner.append(coord);
      head.push(coord);
    }

    // 見出し階層: プロローグの英字が h1、日本語タイトルが h2。以降は h2 / h3
    const isPrologue = chapter.role === 'prologue';
    const en = makeEl(isPrologue ? 'h1' : 'h2', 'ch-en', chapter.en);
    /*
      日本語 TTS が TESSERACT / HEXERACT を綴り読みしないようにする(Phase 14b)。

      SplitText は replaceChildren しか呼ばず、restore() が外すのは aria-label だけ。
      つまり**静的に書いた lang はリサイズの再分割を生き延びる**。
      逆に SplitText の内部で lang を付けてはならない ── restore() が漏らす。
    */
    en.lang = 'en';
    // 文字数に応じてディスプレイサイズを決める(長い語ほど小さく = 常に画面幅に収まる)
    en.style.setProperty('--len', String(chapter.en.length));

    const title = makeEl(isPrologue ? 'h2' : 'h3', 'ch-title', chapter.jp.title);
    const body = makeEl('p', 'ch-body', chapter.jp.body);

    inner.append(en, title, body);

    if (chapter.hint !== undefined) {
      const hint = makeEl('p', 'ch-hint');
      const rail = makeEl('span', 'ch-hint-rail');
      rail.setAttribute('aria-hidden', 'true');
      rail.append(makeEl('span', 'ch-hint-dot'));
      const label = makeEl('span', 'ch-hint-label', chapter.hint);
      label.lang = 'en'; // "SCROLL"
      hint.append(rail, label);
      inner.append(hint);
      tail.push(hint);
    }

    if (chapter.cta !== undefined) {
      const button = makeEl('button', 'cta');
      button.type = 'button';
      button.id = 'enter-gallery';
      button.append(makeEl('span', 'cta-label', chapter.cta), makeEl('span', 'cta-arrow', '→'));
      button.querySelector('.cta-arrow')?.setAttribute('aria-hidden', 'true');
      inner.append(button);
      tail.push(button);
      cta = button;
    }

    const caption = makeEl('span', 'ch-caption', chapter.caption);
    caption.setAttribute('aria-hidden', 'true');
    tail.push(caption);

    pin.append(inner, caption);

    // 流れる帯は序章と終章だけ(章のあいだは静かに保つ)
    if (chapter.role === 'prologue') pin.append(makeMarquee(MARQUEE_PROLOGUE));
    else if (chapter.role === 'epilogue') pin.append(makeMarquee(MARQUEE_EPILOGUE));

    section.append(pin);
    fragment.append(section);

    sections.push(section);
    inners.push(inner);
    ens.push(en);
    titles.push(title);
    bodies.push(body);
    heads.push(head);
    tails.push(tail);
  }

  root.replaceChildren(fragment);

  return { sections, inners, ens, titles, bodies, heads, tails, cta };
}

interface OverlayOptions {
  readonly director: ScrollDirector;
  readonly chapters: readonly Chapter[];
  readonly dom: NarrativeDom;
  /** 章の境界を告げるライブリージョン(Phase 14b)。無くても成立する */
  readonly announcer?: Announcer;
}

/**
 * ネイティブにフォーカスできる要素か(Phase 14c)。
 * 章の飾り(.ch-hint / .ch-caption)まで tabindex を触らないための絞り込みで、
 * 実際に該当するのは終章の CTA ボタンだけである。
 */
function isFocusable(el: HTMLElement): boolean {
  return el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement;
}

export class Overlays {
  private readonly director: ScrollDirector;
  private readonly dom: NarrativeDom;
  private readonly words: readonly string[];
  /**
   * 章ごとの読み上げ文。**コンストラクタで前計算する**。
   * update() の中でテンプレートリテラルを組むと、それだけでフレーム経路に
   * アロケーションが生まれる(ゼロアロケーション契約 / SPEC §4.2)。
   */
  private readonly announcements: readonly string[];
  private readonly announcer: Announcer | null;

  /** 章ごとの状態と、そのとき走っているアニメーション */
  private readonly states: Uint8Array;
  private readonly anims: Animation[][];
  /** 章ごとの入退場しきい値(役割で変わる) */
  private readonly inT: Float64Array;
  private readonly outT: Float64Array;
  private readonly backT: Float64Array;

  /** 分割ハンドル(章 × 3 種)。生成時に確定し、リサイズでのみ作り直す */
  private readonly enSplits: SplitHandle[] = [];
  private readonly titleSplits: SplitHandle[] = [];
  private readonly bodySplits: SplitHandle[] = [];

  private readonly hudValue: HTMLElement | null;
  private readonly hudWord: HTMLElement | null;
  private readonly progressBar: HTMLElement | null;

  private lastDimText = '';
  private lastWordIndex = -1;
  private lastProgress = -1;
  private revealed = false;
  private armed = false;
  private startTimer = 0;

  constructor(options: OverlayOptions) {
    const { director, chapters, dom } = options;

    this.director = director;
    this.dom = dom;
    this.announcer = options.announcer ?? null;
    this.words = chapters.map((c) => c.en);
    // 「第四章 4D 四つ目の方向」/「序章 見えない次元へ」。
    // 本文は読まない ── .ch-body は読み取りカーソルが既に到達できる実テキストで、
    // ライブリージョンへ流すと物語を丸ごと二重に喋ることになる
    this.announcements = chapters.map((c) =>
      `${c.caption} ${c.unit ?? ''} ${c.jp.title}`.replace(/\s+/g, ' ').trim(),
    );

    const n = chapters.length;
    this.states = new Uint8Array(n);
    this.anims = [];
    this.inT = new Float64Array(n);
    this.outT = new Float64Array(n);
    this.backT = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      this.anims.push([]);
      switch (chapters[i].role) {
        case 'prologue':
          // ページ最上部(localT = 0)で読めていなければならないので入りの敷居は 0。
          // 巻き戻しでは消さない(戻る先がない)
          this.inT[i] = 0;
          this.outT[i] = OUT_T_PROLOGUE;
          this.backT[i] = -1;
          break;
        case 'epilogue':
          this.inT[i] = IN_T;
          this.outT[i] = OUT_T_NEVER;
          this.backT[i] = BACK_T;
          break;
        default:
          this.inT[i] = IN_T;
          this.outT[i] = OUT_T_CHAPTER;
          this.backT[i] = BACK_T;
          break;
      }
    }

    this.hudValue = document.getElementById('hud-value');
    this.hudWord = document.getElementById('hud-word');
    this.progressBar = document.getElementById('progress-bar');

    if (dom.cta !== null) {
      dom.cta.addEventListener('click', this.handleCtaClick);
    }

    // フォント適用後に本文を出す + セクション再計測(行送りが変わって高さが動くため)
    const fonts = document.fonts;
    if (fonts !== undefined) {
      fonts.ready.then(this.reveal, this.reveal);
    }
    window.setTimeout(this.reveal, FONT_TIMEOUT_MS);
    // プリローダが start() を呼ばない事故でも、テキストが永久に伏せられないように
    this.startTimer = window.setTimeout(this.start, START_TIMEOUT_MS);
  }

  /**
   * 振り付けを始める。テキストを行 / 文字へ分割し、以後 update() が状態機械を回す。
   * プリローダが上下パネルを割りはじめる瞬間に main.ts から呼ぶ ──
   * 開いていく隙間の向こうで、序章がちょうど立ち上がる。
   */
  readonly start = (): void => {
    if (this.armed) return;
    this.armed = true;
    if (this.startTimer !== 0) {
      window.clearTimeout(this.startTimer);
      this.startTimer = 0;
    }
    this.reveal();
    this.buildSplits();
    // 行がブロックへ組み直されたぶん、章の高さが動き得る。測り直してから走らせる
    this.director.remeasure();
  };

  /**
   * 行分割のやり直し(リサイズ時)。engine.onResize は 150ms デバウンス済み。
   * 表示中の章は表示のまま、伏せている章は伏せたまま作り直す。
   */
  remeasure(): void {
    if (!this.armed) return;

    for (let i = 0; i < this.states.length; i++) {
      cancelAll(this.anims[i]);
      // 進行中だったものは終端の状態へ丸める
      if (this.states[i] === ChapterState.Revealing) this.states[i] = ChapterState.Shown;
      else if (this.states[i] === ChapterState.Hiding) this.states[i] = ChapterState.Hidden;
    }

    this.restoreSplits();
    this.buildSplits();

    for (let i = 0; i < this.states.length; i++) {
      if (this.states[i] === ChapterState.Shown) this.applyShown(i);
      else this.applyHidden(i);
    }
  }

  /** 毎フレーム(scrollDirector.update の後)に呼ぶ */
  update(): void {
    const locals = this.director.chapterLocals;

    if (this.armed) {
      for (let i = 0; i < this.states.length; i++) {
        const t = locals[i];
        const state = this.states[i];
        if (state === ChapterState.Hidden || state === ChapterState.Hiding) {
          if (t >= this.inT[i] && t <= this.outT[i]) this.revealChapter(i);
        } else if (t > this.outT[i] || t < this.backT[i]) {
          this.hideChapter(i);
        }
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

    // 章の境界。比較は 1 本のまま(lastWordIndex を再利用する)なので、
    // 毎フレームのコストは増えない ── 増えるのは状態が変わったフレームだけ
    const index = this.director.chapterIndex;
    if (index !== this.lastWordIndex) {
      this.lastWordIndex = index;
      if (this.hudWord !== null) this.hudWord.textContent = this.words[index] ?? '';
      // armed の前はプリローダ自身が role="status" を持っている。
      // 2 つのライブリージョンが同時に喋らないよう、幕が上がってから告げる
      if (this.armed) this.announcer?.announce(this.announcements[index] ?? '');
    }

    if (this.progressBar !== null) {
      const progress = this.director.globalProgress;
      if (Math.abs(progress - this.lastProgress) >= PROGRESS_EPSILON) {
        this.progressBar.style.transform = `scaleX(${progress.toFixed(4)})`;
        this.lastProgress = progress;
      }
    }
  }

  // --- 振り付け --------------------------------------------------------------

  /** 分割の生成。本文は全章まとめて 1 回のレイアウトで測る */
  private buildSplits(): void {
    const { ens, titles, bodies } = this.dom;
    for (let i = 0; i < ens.length; i++) this.enSplits.push(splitChars(ens[i]));

    const lines = splitLinesBatch([...titles, ...bodies]);
    const n = titles.length;
    for (let i = 0; i < n; i++) {
      this.titleSplits.push(lines[i]);
      this.bodySplits.push(lines[n + i]);
    }

    // 初期状態は全章伏せ。直後の update() が「いま居る章」だけを立ち上げる
    for (let i = 0; i < ens.length; i++) this.applyHidden(i);
  }

  private restoreSplits(): void {
    for (let i = 0; i < this.enSplits.length; i++) this.enSplits[i].restore();
    for (let i = 0; i < this.titleSplits.length; i++) this.titleSplits[i].restore();
    for (let i = 0; i < this.bodySplits.length; i++) this.bodySplits[i].restore();
    this.enSplits.length = 0;
    this.titleSplits.length = 0;
    this.bodySplits.length = 0;
  }

  /** 入場。英字 → 見出し → 本文 → 飾り の順に立ち上げる */
  private revealChapter(index: number): void {
    const anims = this.anims[index];
    cancelAll(anims);
    this.states[index] = ChapterState.Revealing;

    const inner = this.dom.inners[index];
    inner.style.opacity = '1';
    inner.style.transform = '';

    // 章番号と計器の読みは最初に、ごく控えめに点る(立ち上がりは持たせない)
    const head = this.dom.heads[index];
    for (let k = 0; k < head.length; k++) {
      head[k].style.opacity = '';
      anims.push(
        play(head[k], [{ opacity: 0, translate: '0 6px' }, { opacity: 1, translate: 'none' }], {
          duration: DUR.med,
          easing: EASE.outExpo,
          fill: 'backwards',
        }),
      );
    }

    push(anims, revealSplit(this.enSplits[index], { stagger: CHAR_STAGGER }));
    push(
      anims,
      revealSplit(this.titleSplits[index], {
        stagger: TITLE_STAGGER,
        delay: TITLE_DELAY,
        duration: DUR.slow,
      }),
    );
    push(
      anims,
      revealSplit(this.bodySplits[index], {
        stagger: BODY_STAGGER,
        delay: BODY_DELAY,
        duration: DUR.slow,
      }),
    );

    // 飾りは最後。translate(個別プロパティ)を使い、
    // .ch-caption が持つ transform: translateY(-50%) の中心合わせを壊さない
    const tail = this.dom.tails[index];
    for (let k = 0; k < tail.length; k++) {
      tail[k].style.opacity = '';
      tail[k].style.pointerEvents = '';
      if (isFocusable(tail[k])) tail[k].removeAttribute('tabindex');
      anims.push(
        play(tail[k], [{ opacity: 0, translate: '0 8px' }, { opacity: 1, translate: 'none' }], {
          duration: TAIL_MS,
          delay: TAIL_DELAY,
          easing: EASE.outExpo,
          fill: 'backwards',
        }),
      );
    }

    const last = anims[anims.length - 1];
    if (last !== undefined) {
      last.onfinish = (): void => {
        if (this.states[index] === ChapterState.Revealing) this.states[index] = ChapterState.Shown;
      };
    }
  }

  /** 退場。段差をつけず、ブロックごと静かに沈める */
  private hideChapter(index: number): void {
    const anims = this.anims[index];
    cancelAll(anims);
    this.states[index] = ChapterState.Hiding;

    const inner = this.dom.inners[index];
    const anim = play(
      inner,
      [
        { opacity: 1, transform: 'translateY(0)' },
        { opacity: 0, transform: `translateY(${EXIT_DROP}px)` },
      ],
      { duration: EXIT_MS, easing: EASE.inoutSoft, fill: 'forwards' },
    );
    anim.onfinish = (): void => {
      if (this.states[index] !== ChapterState.Hiding) return;
      this.states[index] = ChapterState.Hidden;
      this.applyHidden(index);
    };
    anims.push(anim);

    // 縦組みキャプションは pin 直下(inner の外)なので個別に落とす
    const tail = this.dom.tails[index];
    for (let k = 0; k < tail.length; k++) {
      if (inner.contains(tail[k])) continue;
      anims.push(
        play(tail[k], [{ opacity: 1 }, { opacity: 0 }], {
          duration: EXIT_MS,
          easing: EASE.inoutSoft,
          fill: 'forwards',
        }),
      );
    }
  }

  /** 伏せた状態をインラインスタイルで固定する(アニメーションは残さない) */
  private applyHidden(index: number): void {
    cancelAll(this.anims[index]);
    const inner = this.dom.inners[index];
    inner.style.opacity = '0';
    inner.style.transform = '';
    this.enSplits[index]?.conceal();
    this.titleSplits[index]?.conceal();
    this.bodySplits[index]?.conceal();
    const head = this.dom.heads[index];
    for (let k = 0; k < head.length; k++) head[k].style.opacity = '0';
    /*
      伏せている CTA が「見えないまま押せる」状態にならないようにする。

      Phase 14c まで、ここは opacity と pointer-events しか切っていなかった。
      どちらも**タブ順からは外さない** ── そして opacity はアウトラインにも効くので、
      .cta:focus-visible の枠線も見えない。結果として `#enter-gallery` は
      「文書内で最初にフォーカスできる要素」でありながら、見えも読み上げられも
      しないボタンだった(ロード直後の Tab 一回で着地し、Enter でギャラリーへ飛ぶ)。

      tabIndex = -1 で経路そのものを閉じる。代わりの、ラベルのある入口は
      index.html の #skip-gallery(:focus-visible でだけ現れる)が引き受ける。
    */
    const tail = this.dom.tails[index];
    for (let k = 0; k < tail.length; k++) {
      tail[k].style.opacity = '0';
      tail[k].style.pointerEvents = 'none';
      if (isFocusable(tail[k])) tail[k].tabIndex = -1;
    }
  }

  /** 表示状態を即座に確定する(リサイズ後の復元用) */
  private applyShown(index: number): void {
    cancelAll(this.anims[index]);
    const inner = this.dom.inners[index];
    inner.style.opacity = '1';
    inner.style.transform = '';
    this.enSplits[index]?.expose();
    this.titleSplits[index]?.expose();
    this.bodySplits[index]?.expose();
    const head = this.dom.heads[index];
    for (let k = 0; k < head.length; k++) head[k].style.opacity = '';
    const tail = this.dom.tails[index];
    for (let k = 0; k < tail.length; k++) {
      tail[k].style.opacity = '';
      tail[k].style.pointerEvents = '';
      if (isFocusable(tail[k])) tail[k].removeAttribute('tabindex');
    }
  }

  // --- その他 ----------------------------------------------------------------

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

/** 配列を伸ばすだけの小道具(spread でのテンポラリ配列生成を避ける) */
function push(target: Animation[], source: readonly Animation[]): void {
  for (let i = 0; i < source.length; i++) target.push(source[i]);
}
