/**
 * SplitText — マスク付きテキスト分割(Phase 9a)。
 *
 * 行(または文字)をひとつずつ `overflow: hidden` のマスクで包み、内側の span を
 * translateY させて「下から立ち上がる」reveal を作る。CSS @keyframes は増やさず、
 * 実際の再生は WAAPI(component.ts の play)に委ねる。
 *
 * 行検出:
 *   ① 語(欧文)・1 文字(和文)単位の一時 span へ分解して DOM へ入れる
 *   ② `offsetTop` を読み、同じ値のものを 1 行としてまとめる
 *   ③ 行ごとにマスク + 内側 span を組み直す
 * 和文には空白がないため、②の単位は「欧文の語」か「1 文字」で切る
 * (`UNIT_RE`)。①→②→③を要素ごとに回すとレイアウトが要素数ぶん走るので、
 * 複数要素は `splitLinesBatch()` で**書き→読み→書き**の 3 相にまとめる
 * (強制レイアウトは 1 回で済む)。
 *
 * アクセシビリティ:
 *   分割で生まれた span はすべて `aria-hidden`。読み上げは container に載せた
 *   `aria-label`(元テキスト)と、視覚だけ隠した複製(.sr-only)が担う。
 *   両方置くのは、`aria-label` が効く要素と効かない要素があるため ──
 *   見出しやボタンは名前を持てるが、`<p>`(generic ロール)は名前を持てず
 *   ラベルが無視される。複製があればどちらの経路でも文はちょうど一度届く。
 *
 * 毎フレームのコストはゼロ: 生成時に span をキャッシュし、以後は reveal / hide
 * の呼び出し時にしか DOM を触らない。
 */

import { DUR, EASE, play, prefersReducedMotion } from './component';

export type SplitKind = 'lines' | 'chars';
export type SplitFrom = 'below' | 'above';

export interface SplitHandle {
  readonly el: HTMLElement;
  readonly kind: SplitKind;
  /** マスクの内側 = 実際に transform を受ける span 群(生成時に確定) */
  readonly parts: readonly HTMLElement[];
  /** 伏せた状態をインラインスタイルで固定する(reveal 前 / hide 後) */
  conceal(from?: SplitFrom): void;
  /** インラインスタイルを外して素の表示状態へ戻す */
  expose(): void;
  /** 分割前のテキストへ完全に戻す(リサイズ時の再分割で使う) */
  restore(): void;
}

export interface RevealOptions {
  /** 部品ごとの遅延(ms) */
  readonly stagger?: number;
  /** 全体の開始遅延(ms) */
  readonly delay?: number;
  readonly duration?: number;
  readonly easing?: string;
  /** どちらから立ち上がるか。既定は下(below) */
  readonly from?: SplitFrom;
}

export interface HideOptions {
  readonly stagger?: number;
  readonly delay?: number;
  readonly duration?: number;
  readonly easing?: string;
  /** どちらへ抜けるか。既定は下(below) */
  readonly to?: SplitFrom;
  /** 併せて opacity も 0 へ落とす(マスクの外へ出し切らない見せ方) */
  readonly fade?: boolean;
}

/** マスクの外へ出す距離。行高の 112% ─ 半行分の余裕を足して確実に隠す */
const OFFSET = 112;

/**
 * 計測単位。欧文は語ごと、それ以外(和文・記号)は 1 文字ずつ。
 * `u` フラグ + `.` でサロゲートペアを 1 単位として拾う。
 */
const UNIT_RE = /[A-Za-z0-9][A-Za-z0-9'’\-]*|\s+|./gsu;

/** 行グループの判定しきい値(px)。同一行の微小なズレを吸収する */
const LINE_EPSILON = 3;

/* ------------------------------------------------------------------ 文字分割 */

export interface SplitCharsOptions {
  /**
   * 語(空白で区切られた塊)を折り返しの単位に保つ。
   *
   * 1 文字ずつのマスクは inline-block の原子的インラインなので、行分割の
   * アルゴリズムは**文字と文字のあいだでも改行してよい**と判断する。
   * 1 語の見出し(9a の `.ch-en`)では起こり得なかったが、2 語以上の
   * 展示名(HOPF FIBRATION)では語の途中で折れてしまう。
   * true にすると語ごとに nowrap の器で包み、改行は空白の位置だけに戻る。
   */
  readonly keepWords?: boolean;
}

/**
 * 表示英字(ディスプレイワード)を 1 文字ずつマスクで包む。
 *
 * `.ch-en` は `background-clip: text` のグラデーション文字なので、そのまま
 * 子 span を作るとクリップ対象が壊れる。ここでは **各文字の内側 span へ、語全体の
 * 幅ぶんに引き伸ばしたグラデーションを x オフセット付きで再構成**して貼り直し、
 * 見た目の連続性を保ったまま 1 文字ずつ動かせるようにする。
 */
export function splitChars(el: HTMLElement, options: SplitCharsOptions = {}): SplitHandle {
  const original = el.textContent ?? '';
  const gradient = readGradient(el);
  const keepWords = options.keepWords === true;

  const parts: HTMLElement[] = [];
  const fragment = document.createDocumentFragment();
  /** keepWords のときだけ使う、いま組み立て中の語の器 */
  let word: HTMLElement | null = null;

  for (const char of Array.from(original)) {
    if (char.trim() === '') {
      // 空白はマスクに包まない(inline-block 化すると幅が変わる)
      word = null;
      fragment.append(document.createTextNode(char));
      continue;
    }
    const mask = document.createElement('span');
    mask.className = 'sp-char';
    mask.setAttribute('aria-hidden', 'true');
    const inner = document.createElement('span');
    inner.className = 'sp-char-in';
    inner.textContent = char;
    mask.append(inner);

    if (keepWords) {
      if (word === null) {
        word = document.createElement('span');
        word.className = 'sp-word';
        word.setAttribute('aria-hidden', 'true');
        fragment.append(word);
      }
      word.append(mask);
    } else {
      fragment.append(mask);
    }
    parts.push(inner);
  }

  el.setAttribute('aria-label', original);
  el.replaceChildren(srCopy(original), fragment);

  if (gradient !== null) applyGradient(el, parts, gradient);

  return makeHandle(el, 'chars', parts, original, gradient);
}

/* -------------------------------------------------------------------- 行分割 */

/** 単一要素の行分割。内部的には 1 要素だけの batch */
export function splitLines(el: HTMLElement): SplitHandle {
  return splitLinesBatch([el])[0];
}

/**
 * 複数要素をまとめて行分割する。
 * 書き(単位 span 挿入)→ 読み(offsetTop)→ 書き(マスク構築)の 3 相に分け、
 * 強制同期レイアウトを全体で 1 回に抑える。
 */
export function splitLinesBatch(elements: readonly HTMLElement[]): SplitHandle[] {
  const originals: string[] = [];
  const units: HTMLElement[][] = [];

  // --- 相 1: 書き ---
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const text = el.textContent ?? '';
    originals.push(text);

    const spans: HTMLElement[] = [];
    const fragment = document.createDocumentFragment();
    const matches = text.match(UNIT_RE) ?? [];
    for (let k = 0; k < matches.length; k++) {
      const span = document.createElement('span');
      span.textContent = matches[k];
      fragment.append(span);
      spans.push(span);
    }
    el.replaceChildren(fragment);
    units.push(spans);
  }

  // --- 相 2: 読み(この間 DOM へ書かない) ---
  const groups: string[][][] = [];
  for (let i = 0; i < elements.length; i++) {
    const spans = units[i];
    const lines: string[][] = [];
    let current: string[] | null = null;
    let top = Number.NEGATIVE_INFINITY;

    for (let k = 0; k < spans.length; k++) {
      const span = spans[k];
      const y = span.offsetTop;
      if (current === null || y - top > LINE_EPSILON) {
        current = [];
        lines.push(current);
        top = y;
      }
      current.push(span.textContent ?? '');
    }
    groups.push(lines);
  }

  // --- 相 3: 書き ---
  const handles: SplitHandle[] = [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const parts: HTMLElement[] = [];
    const fragment = document.createDocumentFragment();

    for (const line of groups[i]) {
      const text = line.join('').replace(/^\s+|\s+$/g, '');
      if (text === '') continue;
      const mask = document.createElement('span');
      mask.className = 'sp-line';
      mask.setAttribute('aria-hidden', 'true');
      const inner = document.createElement('span');
      inner.className = 'sp-line-in';
      inner.textContent = text;
      mask.append(inner);
      fragment.append(mask);
      parts.push(inner);
    }

    el.setAttribute('aria-label', originals[i]);
    el.replaceChildren(srCopy(originals[i]), fragment);
    handles.push(makeHandle(el, 'lines', parts, originals[i], null));
  }

  return handles;
}

/* ------------------------------------------------------------------ 再生 */

/**
 * 立ち上がり。マスクの外(下)から 0 へ。
 * 走っている間だけアニメーションが値を持ち(fill: backwards で delay 中も伏せる)、
 * 終わればインラインスタイルのない**素の表示状態**へ自然に着地する
 * ── fill: forwards を積み上げないための設計。
 */
export function reveal(handle: SplitHandle, options: RevealOptions = {}): Animation[] {
  const stagger = options.stagger ?? 70;
  const delay = options.delay ?? 0;
  const duration = options.duration ?? DUR.reveal;
  const easing = options.easing ?? EASE.outExpo;
  const sign = options.from === 'above' ? -1 : 1;

  handle.expose();

  const animations: Animation[] = [];
  const parts = handle.parts;
  for (let i = 0; i < parts.length; i++) {
    animations.push(
      play(
        parts[i],
        [{ transform: `translateY(${sign * OFFSET}%)` }, { transform: 'translateY(0)' }],
        {
          duration,
          delay: delay + i * stagger,
          easing,
          fill: 'backwards',
        },
      ),
    );
  }
  return animations;
}

/** 退出。既定は下へ沈める。fade: true で opacity も落とす */
export function hide(handle: SplitHandle, options: HideOptions = {}): Animation[] {
  const stagger = options.stagger ?? 0;
  const delay = options.delay ?? 0;
  const duration = options.duration ?? DUR.med;
  const easing = options.easing ?? EASE.inoutSoft;
  const sign = options.to === 'above' ? -1 : 1;
  const fade = options.fade === true;

  const from: Keyframe = { transform: 'translateY(0)' };
  const to: Keyframe = { transform: `translateY(${sign * OFFSET}%)` };
  if (fade) {
    from.opacity = 1;
    to.opacity = 0;
  }

  const animations: Animation[] = [];
  const parts = handle.parts;
  for (let i = 0; i < parts.length; i++) {
    animations.push(
      play(parts[i], [from, to], {
        duration,
        delay: delay + i * stagger,
        easing,
        fill: 'forwards',
      }),
    );
  }
  return animations;
}

/* ------------------------------------------------------------------ 内部 */

function makeHandle(
  el: HTMLElement,
  kind: SplitKind,
  parts: HTMLElement[],
  original: string,
  gradient: string | null,
): SplitHandle {
  return {
    el,
    kind,
    parts,
    conceal(from: SplitFrom = 'below'): void {
      const sign = from === 'above' ? -1 : 1;
      // reduced-motion では移動させない ── opacity だけで伏せる
      const value = prefersReducedMotion() ? '' : `translateY(${sign * OFFSET}%)`;
      for (let i = 0; i < parts.length; i++) {
        parts[i].style.transform = value;
        if (value === '') parts[i].style.opacity = '0';
      }
    },
    expose(): void {
      for (let i = 0; i < parts.length; i++) {
        parts[i].style.transform = '';
        parts[i].style.opacity = '';
      }
    },
    restore(): void {
      el.replaceChildren(document.createTextNode(original));
      el.removeAttribute('aria-label');
      if (gradient !== null) el.style.backgroundImage = '';
    },
  };
}

/** 視覚には出さず、支援技術にだけ届ける元テキストの複製 */
function srCopy(text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'sr-only';
  span.textContent = text;
  return span;
}

/**
 * グラデーション文字かどうか。none ならただの色文字。
 * background-clip: text が使えない環境では復元しない ── そこで color: transparent を
 * 撒くと文字が丸ごと消えるため(style.css の @supports フォールバックと同じ判断)。
 */
function readGradient(el: HTMLElement): string | null {
  const supported =
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    (CSS.supports('background-clip', 'text') || CSS.supports('-webkit-background-clip', 'text'));
  if (!supported) return null;
  const image = window.getComputedStyle(el).backgroundImage;
  return image === '' || image === 'none' ? null : image;
}

/**
 * 語全体で 1 本だったグラデーションを、文字ごとの span へ復元する。
 * background-size を語幅に固定し、background-position を -x でずらすことで
 * 「切り出した窓」を並べ直す ── 見た目は分割前と同一になる。
 */
function applyGradient(el: HTMLElement, parts: HTMLElement[], gradient: string): void {
  // offsetLeft は使わない: .ch-en は filter を持つため offsetParent が
  // 子 span と一致せず、差分がずれる(グラデーションの窓が語の外へ出て
  // 先頭文字が塗られなくなる)。ビューポート基準の矩形なら常に整合する。
  const box = el.getBoundingClientRect();
  const width = box.width;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const x = part.getBoundingClientRect().left - box.left;
    part.style.backgroundImage = gradient;
    part.style.backgroundSize = `${width.toFixed(2)}px 100%`;
    part.style.backgroundPosition = `${(-x).toFixed(2)}px 0`;
    part.style.backgroundRepeat = 'no-repeat';
    part.style.setProperty('-webkit-background-clip', 'text');
    part.style.setProperty('background-clip', 'text');
    part.style.color = 'transparent';
  }
  // 親のグラデーションは子が肩代わりしたので消す(二重描画を避ける)
  el.style.backgroundImage = 'none';
}
