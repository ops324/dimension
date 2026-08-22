/**
 * ExhibitHeader — 展示ヘッダの振り付け(Phase 9b)。
 *
 * タブを切り替えるたび、左上の見出しは**入れ替わるのではなく、語り直される**。
 *
 *   退出 … 4 行を 220ms でそっと落とすだけ(9a の作法「退出は静かに」)。
 *          動きで見送らない ── 見送りに時間をかけると切替が重くなる。
 *   入場 … 番号がフェードで点り、英字名が SplitText の**文字**で立ち上がり
 *          (stagger 20ms)、+120ms 遅れて日本語名とタグラインが行で続く。
 *
 * DOM は index.html のものをそのまま使う(#gallery-index / #gallery-en /
 * #gallery-jp / #gallery-tagline)── id もクラスも変えない。この部品が持つのは
 * 分割ハンドルと再生中のアニメーションだけで、器の所有権は index.html にある。
 *
 * 分割は切替のたびに作り直す(テキストが変わるため)。行分割は幅に依存するので
 * `remeasure()` でリサイズにも追従する ── どちらも**そのときだけ**の計測で、
 * 毎フレームの仕事はゼロ。
 */

import { DUR, EASE, cancelAll, play, type Component } from './component';
import { reveal, splitChars, splitLinesBatch, type SplitHandle } from './SplitText';

export interface ExhibitHeaderInfo {
  /** 1 始まりの通し番号 */
  readonly index: number;
  readonly total: number;
  readonly en: string;
  readonly jp: string;
  readonly tagline: string;
}

/** 退出(静かに落とすだけ) */
const EXIT_MS = 220;
/** 英字名: 文字ごとの遅れと尺 */
const CHAR_STAGGER = 20;
const CHAR_MS = 720;
/** 日本語名・タグライン: 行ごとの遅れと、英字名からの遅れ */
const LINE_STAGGER = 60;
const LINE_DELAY = 120;
const LINE_MS = 640;

const FADE_OUT: Keyframe[] = [{ opacity: 1 }, { opacity: 0 }];
const FADE_IN: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];

export class ExhibitHeader implements Component {
  readonly el: HTMLElement;

  private readonly indexEl: HTMLElement;
  private readonly enEl: HTMLElement;
  private readonly jpEl: HTMLElement;
  private readonly taglineEl: HTMLElement;

  private readonly running: Animation[] = [];
  /** 副題だけの差し替え(setTagline)で走る分。入場の振り付けとは別に持つ */
  private readonly taglineRun: Animation[] = [];
  private enSplit: SplitHandle | null = null;
  private lineSplits: SplitHandle[] = [];
  private current: ExhibitHeaderInfo | null = null;

  constructor(root: HTMLElement) {
    this.el = root;
    this.indexEl = need(root, 'gallery-index');
    this.enEl = need(root, 'gallery-en');
    this.jpEl = need(root, 'gallery-jp');
    this.taglineEl = need(root, 'gallery-tagline');
  }

  /**
   * 退出を始める。タブを押した瞬間(= 展示の差し替えを待つ 380ms のあいだ)に
   * 呼ぶと、幕が下りるように見出しが引く。
   */
  beginExit(): void {
    if (this.current === null) return;
    cancelAll(this.running);
    for (const el of this.texts()) {
      this.running.push(play(el, FADE_OUT, { duration: EXIT_MS, easing: 'linear', fill: 'forwards' }));
    }
  }

  /** 新しい展示の見出しを立ち上げる(テキストの差し替えもここが行う) */
  apply(info: ExhibitHeaderInfo): void {
    cancelAll(this.running);
    this.restore();

    this.current = info;
    this.indexEl.textContent = `EXHIBIT ${pad(info.index)} / ${pad(info.total)}`;
    this.enEl.textContent = info.en;
    this.jpEl.textContent = info.jp;
    this.taglineEl.textContent = info.tagline;

    // 番号はフェードだけ。動かすのは名前の方だという序列をつける
    this.running.push(
      play(this.indexEl, FADE_IN, { duration: DUR.med, easing: EASE.outExpo, fill: 'backwards' }),
    );

    // 英字名は語を折り返しの単位に保つ(2 語の展示名が語の途中で折れないように)
    this.enSplit = splitChars(this.enEl, { keepWords: true });
    pushAll(
      this.running,
      reveal(this.enSplit, { stagger: CHAR_STAGGER, duration: CHAR_MS, easing: EASE.outExpo }),
    );

    this.lineSplits = splitLinesBatch([this.jpEl, this.taglineEl]);
    for (let i = 0; i < this.lineSplits.length; i++) {
      pushAll(
        this.running,
        reveal(this.lineSplits[i], {
          stagger: LINE_STAGGER,
          delay: LINE_DELAY + i * LINE_STAGGER,
          duration: LINE_MS,
          easing: EASE.outExpo,
        }),
      );
    }
  }

  /**
   * 副題だけを差し替える(Phase 40)。展示のパラメータが変わるたびに呼ばれる想定で、
   * **同じ文なら何もしない** ── 変わっていないのに毎回組み直すと、
   * スライダーを触るあいだ副題が延々と明滅する。
   *
   * 触るのは副題の行だけ。英字名の文字送りには手を入れない ── 設定を変えただけで
   * 見出し全体が語り直されると、切替と区別がつかなくなる。
   */
  setTagline(tagline: string): void {
    const info = this.current;
    if (info === null || info.tagline === tagline) return;
    this.current = { ...info, tagline };

    cancelAll(this.taglineRun);
    // 入場の分割がまだ無い(退出中・破棄後)なら、文字だけ入れて次の apply に任せる
    const last = this.lineSplits.length - 1;
    if (last < 0) {
      this.taglineEl.textContent = tagline;
      return;
    }

    this.lineSplits[last].restore();
    this.taglineEl.textContent = tagline;
    const [fresh] = splitLinesBatch([this.taglineEl]);
    this.lineSplits[last] = fresh;
    pushAll(
      this.taglineRun,
      reveal(fresh, { stagger: LINE_STAGGER, duration: LINE_MS, easing: EASE.outExpo }),
    );
  }

  /** リサイズ時の行の組み直し(表示中の見出しを保ったまま) */
  remeasure(): void {
    const info = this.current;
    if (info === null) return;
    cancelAll(this.running);
    this.restore();
    this.enEl.textContent = info.en;
    this.jpEl.textContent = info.jp;
    this.taglineEl.textContent = info.tagline;
    this.enSplit = splitChars(this.enEl, { keepWords: true });
    this.lineSplits = splitLinesBatch([this.jpEl, this.taglineEl]);
  }

  destroy(): void {
    cancelAll(this.running);
    this.restore();
    this.current = null;
  }

  // --- 内部 ------------------------------------------------------------------

  private restore(): void {
    cancelAll(this.taglineRun);
    this.enSplit?.restore();
    this.enSplit = null;
    for (let i = 0; i < this.lineSplits.length; i++) this.lineSplits[i].restore();
    this.lineSplits.length = 0;
    // 退出の fill: forwards を外したあとの素の状態へ戻す
    for (const el of this.texts()) el.style.opacity = '';
  }

  private texts(): readonly HTMLElement[] {
    return [this.indexEl, this.enEl, this.jpEl, this.taglineEl];
  }
}

/* ------------------------------------------------------------------ 内部 */

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function pushAll(into: Animation[], animations: readonly Animation[]): void {
  for (let i = 0; i < animations.length; i++) into.push(animations[i]);
}

/** 器の中の必須要素。index.html との契約が破れていれば早期に落とす */
function need(root: HTMLElement, id: string): HTMLElement {
  const node = root.querySelector<HTMLElement>(`#${id}`);
  if (node === null) {
    throw new Error(`DIMENSION: #${id} not found (index.html のギャラリーヘッダを確認)`);
  }
  return node;
}
