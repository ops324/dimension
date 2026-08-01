/**
 * Preloader — 到着の体験(Phase 9a)。
 *
 * 進捗は**演出ではなく実測**である。
 *   0.12  マウント直後(スクリプトが動いた事実)
 *   0.55  document.fonts.ready(組版が確定した)
 *   0.85  エンジンの初回フレーム(GL が絵を出した)
 *   1.00  さらに 250ms の落ち着き
 * 表示は最低 1100ms 保つ ── 速すぎる環境で「一瞬光って消える」のを避けるため。
 *
 * 退出は 3 拍:
 *   ① ワードマークの文字が上へ落ちながら消える
 *   ② 進捗ヘアラインが画面幅いっぱいへ伸びる(画面を切る線になる)
 *   ③ その線を境に、上下 2 枚のパネルが分かれて生きた星空が現れる
 * ③の分割位置はヘアラインの実測 Y をそのまま使う(--pl-split)ので、
 * 「線が開いた」ように見える。
 */

import { DUR, EASE, h, motionTime, play, type Component } from './component';
import { hide, splitChars, type SplitHandle } from './SplitText';

/** 進捗の到達点 */
const P_BOOT = 0.12;
const P_FONTS = 0.55;
const P_FRAME = 0.85;

/** 初回フレーム後、100% へ上げるまでの落ち着き(ms) */
const SETTLE_MS = 250;
/** 最低表示時間(ms)。これを割って消えることはない */
const MIN_DISPLAY_MS = 1100;
/** 表示進捗がターゲットへ寄る指数レート(1/s) */
const EASE_RATE = 6.5;
/** fonts.ready / 初回フレームが来ないときの保険(ms) */
const FONT_TIMEOUT_MS = 2500;
const FRAME_TIMEOUT_MS = 5000;

/** 到着のワードマーク:1 文字ごとの遅延(ms) */
const CHAR_STAGGER = 28;

/** 退出の各拍(ms) */
const EXIT_CHAR_MS = 420;
const EXIT_CHAR_STAGGER = 18;
const EXIT_RAIL_DELAY = 140;
const EXIT_RAIL_MS = 480;
const EXIT_PART_AT = 560;
const EXIT_PANEL_MS = 700;
const EXIT_PANEL_OFFSET = 60;

const WORDMARK = 'DIMENSION';
const CAPTION = '次元を準備しています';

export interface PreloaderOptions {
  /** 上下パネルが割れはじめる瞬間 = 背後の作品が現れはじめる合図 */
  readonly onReveal?: () => void;
  /** DOM を完全に畳んだあと */
  readonly onDone?: () => void;
}

export class Preloader implements Component {
  readonly el: HTMLElement;

  private readonly panelTop: HTMLElement;
  private readonly panelBottom: HTMLElement;
  private readonly mark: HTMLElement;
  private readonly rail: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly percent: HTMLElement;

  private readonly options: PreloaderOptions;
  private split: SplitHandle | null = null;

  private target = P_BOOT;
  private shown = 0;
  private lastFillWritten = -1;
  private lastPercentText = '';

  private rafId = 0;
  private prevTime = 0;
  private readonly timers: number[] = [];
  private readonly startedAt = performance.now();

  private frameSignalled = false;
  private exiting = false;
  private destroyed = false;

  constructor(options: PreloaderOptions = {}) {
    this.options = options;

    this.el = h('div', 'pl', {
      role: 'status',
      'aria-live': 'polite',
      'aria-label': 'DIMENSION を読み込んでいます',
    });

    this.panelTop = h('div', 'pl-panel pl-panel-top', { 'aria-hidden': 'true' });
    this.panelBottom = h('div', 'pl-panel pl-panel-bottom', { 'aria-hidden': 'true' });

    const stack = h('div', 'pl-stack', { 'aria-hidden': 'true' });
    this.mark = h('p', 'pl-mark', { text: WORDMARK });
    this.rail = h('div', 'pl-rail');
    this.fill = h('div', 'pl-fill');
    this.rail.append(this.fill);
    this.caption = h('p', 'pl-caption', { text: CAPTION });
    stack.append(this.mark, this.rail, this.caption);

    this.percent = h('p', 'pl-percent', { 'aria-hidden': 'true', text: '00' });

    this.el.append(this.panelTop, this.panelBottom, stack, this.percent);
  }

  /**
   * DOM を差し込み、文字分割と進捗ループを始める。
   * **エンジン起動より前に同期で呼ぶこと**(TTI を守るため await は挟まない)。
   */
  mount(parent: HTMLElement): void {
    parent.append(this.el);

    // ワードマークは 1 文字ずつマスクで包んで持ち上げる
    this.split = splitChars(this.mark);
    revealChars(this.split);

    this.writeFill(0);
    this.writePercent(0);

    // フォント:自己ホストなので通常は即解決。解決しない環境でも先へ進める
    const fonts = document.fonts;
    if (fonts !== undefined) {
      fonts.ready.then(this.signalFonts, this.signalFonts);
    } else {
      this.signalFonts();
    }
    this.after(FONT_TIMEOUT_MS, this.signalFonts);
    this.after(FRAME_TIMEOUT_MS, this.signalFirstFrame);

    this.prevTime = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  /** engine.onFirstFrame から呼ぶ。GL が最初の 1 枚を出した合図 */
  readonly signalFirstFrame = (): void => {
    if (this.frameSignalled || this.destroyed) return;
    this.frameSignalled = true;
    this.target = Math.max(this.target, P_FRAME);
    this.after(SETTLE_MS, () => {
      this.target = 1;
    });
  };

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.rafId !== 0) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    for (let i = 0; i < this.timers.length; i++) window.clearTimeout(this.timers[i]);
    this.timers.length = 0;
    this.el.remove();
    this.options.onDone?.();
  }

  // --- 内部 ------------------------------------------------------------------

  private readonly signalFonts = (): void => {
    if (this.destroyed) return;
    this.target = Math.max(this.target, P_FONTS);
  };

  /** 表示進捗をターゲットへ寄せる。DOM 書き込みは値が動いたときだけ */
  private readonly tick = (now: number): void => {
    const dt = Math.min((now - this.prevTime) / 1000, 0.1);
    this.prevTime = now;

    const k = 1 - Math.exp(-EASE_RATE * dt);
    this.shown += (this.target - this.shown) * k;
    if (this.target - this.shown < 0.002) this.shown = this.target;

    this.writeFill(this.shown);
    this.writePercent(this.shown);

    const ready = this.target >= 1 && this.shown >= 0.999;
    const waited = now - this.startedAt >= MIN_DISPLAY_MS;
    if (ready && waited) {
      this.rafId = 0;
      this.beginExit();
      return;
    }
    this.rafId = requestAnimationFrame(this.tick);
  };

  private writeFill(value: number): void {
    // 途中は 0.2% 未満の差を書かない。ただし 100% ちょうどは必ず一度書き切る
    if (value !== 1 && Math.abs(value - this.lastFillWritten) < 0.002) return;
    if (value === this.lastFillWritten) return;
    this.lastFillWritten = value;
    this.fill.style.transform = `scaleX(${value.toFixed(4)})`;
  }

  private writePercent(value: number): void {
    const text = String(Math.round(value * 100)).padStart(2, '0');
    if (text === this.lastPercentText) return;
    this.lastPercentText = text;
    this.percent.textContent = text;
  }

  /** 退出。3 拍のあと自分の DOM を消す */
  private beginExit(): void {
    if (this.exiting || this.destroyed) return;
    this.exiting = true;
    this.el.classList.add('is-exiting');

    // ① 文字が上へ落ちながら消える
    if (this.split !== null) {
      hide(this.split, {
        stagger: EXIT_CHAR_STAGGER,
        duration: EXIT_CHAR_MS,
        easing: EASE.outExpo,
        to: 'above',
        fade: true,
      });
    }
    play(this.caption, [{ opacity: 1 }, { opacity: 0 }], {
      duration: DUR.med,
      easing: EASE.inoutSoft,
      fill: 'forwards',
    });
    play(this.percent, [{ opacity: 1 }, { opacity: 0 }], {
      duration: DUR.med,
      delay: 120,
      easing: EASE.inoutSoft,
      fill: 'forwards',
    });

    // ② ヘアラインが画面幅へ伸びる ── 分割の「切り口」になる線
    const railWidth = Math.max(1, this.rail.offsetWidth);
    const scale = (window.innerWidth + 8) / railWidth;
    play(
      this.rail,
      [{ transform: 'scaleX(1)' }, { transform: `scaleX(${scale.toFixed(3)})` }],
      {
        duration: EXIT_RAIL_MS,
        delay: EXIT_RAIL_DELAY,
        easing: EASE.outQuint,
        fill: 'forwards',
      },
    );

    // ③ 線の位置でパネルを割る
    this.after(motionTime(EXIT_PART_AT), () => this.partPanels());
  }

  private partPanels(): void {
    if (this.destroyed) return;

    // 分割位置 = ヘアラインの実測 Y。線がそのまま開くように見せる
    const y = Math.round(this.rail.getBoundingClientRect().top + 0.5);
    const split = y > 0 && y < window.innerHeight ? y : Math.round(window.innerHeight / 2);
    this.el.style.setProperty('--pl-split', `${split}px`);

    play(this.rail, [{ opacity: 1 }, { opacity: 0 }], {
      duration: DUR.med,
      delay: 160,
      easing: EASE.inoutSoft,
      fill: 'forwards',
    });

    this.options.onReveal?.();

    play(this.panelTop, [{ transform: 'translateY(0)' }, { transform: 'translateY(-100%)' }], {
      duration: EXIT_PANEL_MS,
      easing: EASE.inoutSoft,
      fill: 'forwards',
    });
    play(
      this.panelBottom,
      [{ transform: 'translateY(0)' }, { transform: 'translateY(100%)' }],
      {
        duration: EXIT_PANEL_MS,
        delay: EXIT_PANEL_OFFSET,
        easing: EASE.inoutSoft,
        fill: 'forwards',
      },
    );

    this.after(motionTime(EXIT_PANEL_MS + EXIT_PANEL_OFFSET + 40), () => this.destroy());
  }

  private after(ms: number, fn: () => void): void {
    const id = window.setTimeout(() => {
      const at = this.timers.indexOf(id);
      if (at >= 0) this.timers.splice(at, 1);
      if (!this.destroyed) fn();
    }, ms);
    this.timers.push(id);
  }
}

/**
 * 到着の一拍目。文字が下から立ち上がる。
 * fill: 'backwards' により delay 中も伏せた状態が保たれるので、
 * 挿入直後に一瞬だけ全文字が見えることはない(reduced-motion では即時表示)。
 */
function revealChars(split: SplitHandle): void {
  split.expose();
  const parts = split.parts;
  for (let i = 0; i < parts.length; i++) {
    play(parts[i], [{ transform: 'translateY(112%)' }, { transform: 'translateY(0)' }], {
      duration: DUR.reveal,
      delay: 120 + i * CHAR_STAGGER,
      easing: EASE.outExpo,
      fill: 'backwards',
    });
  }
}
