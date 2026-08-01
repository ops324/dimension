/**
 * TransitionOverlay — モード遷移の幕(Phase 9a、旧 #mode-fade の置き換え)。
 *
 * 単純な暗転をやめ、**下から上へ拭き上げる 2 枚の幕**にする。
 *   cover()   ── 薄い色層 → 深い層(#05060f)の順に scaleY(origin: bottom)で
 *                画面を覆う。その上端を 1px のグラデーションヘアラインが先導する。
 *                覆い切ったところで解決し、呼び出し側が中身を差し替える。
 *   uncover() ── 同じ幕が origin: top で縮み、下から作品が現れる。
 *
 * ヘアラインは幕の**子ではなく兄弟**。子にすると scaleY に巻き込まれて 1px が
 * 潰れるため、幕の縁と同じ軌跡(translateY)を独立に描かせている。
 * scaleY(p) origin bottom の上端は H(1−p)、origin top で縮む幕の下端も H·s ──
 * どちらも translateY(100%)→translateY(0) の同じ 1 本で表せる。
 *
 * prefers-reduced-motion: アニメーションを一切使わず、クラスで一瞬に切り替える。
 */

import { EASE, h, prefersReducedMotion, type Component } from './component';

/** 深い層の尺(ms)。仕様どおり 480 */
const L1_MS = 480;
/** 深い層の遅れ。薄い色層が先に立ち上がる */
const L1_DELAY = 40;
/** 薄い色層の尺(ms) */
const L2_MS = 460;
/** ヘアラインの尺。幕より短い = 常に縁を先導する */
const EDGE_MS = 440;
/** 覆い切ってから中身を差し替えるまでの静止(ms) */
const HOLD_MS = 40;
/** 退出時: 深い層 / 薄い色層 */
const OUT_L1_MS = 440;
const OUT_L2_MS = 480;
const OUT_L2_DELAY = 60;
/** 入場時、ヘアラインが点るまでの尺(退出時は PULSE が明滅を内包する) */
const EDGE_IN_MS = 140;

export class TransitionOverlay implements Component {
  readonly el: HTMLElement;

  private readonly l1: HTMLElement;
  private readonly l2: HTMLElement;
  private readonly edge: HTMLElement;
  private readonly running: Animation[] = [];
  private timer = 0;

  constructor() {
    this.el = h('div', 'tx', { 'aria-hidden': 'true' });
    this.l2 = h('div', 'tx-layer tx-l2');
    this.l1 = h('div', 'tx-layer tx-l1');
    this.edge = h('div', 'tx-edge');
    this.el.append(this.l2, this.l1, this.edge);
  }

  mount(parent: HTMLElement): void {
    parent.append(this.el);
  }

  /** 画面を覆う。解決した時点が「差し替えてよい瞬間」 */
  cover(): Promise<void> {
    this.stop();
    this.el.dataset.active = 'true';

    if (prefersReducedMotion()) {
      this.el.classList.add('is-cut');
      return this.wait(0);
    }

    this.setOrigin('bottom');
    this.l1.style.transform = 'scaleY(1)';
    this.l2.style.transform = 'scaleY(1)';
    this.edge.style.transform = 'translateY(0)';
    this.edge.style.opacity = '1';

    // fill: 'backwards' ── delay 中も開始状態を保つ(素の「覆った状態」が一瞬見えない)。
    // 終了後は fill を残さないので、要素は上で書いたインラインの最終状態へ着地する。
    this.run(this.l2.animate(SCALE_IN, { duration: L2_MS, easing: EASE.inoutSoft, fill: BACK }));
    this.run(
      this.l1.animate(SCALE_IN, {
        duration: L1_MS,
        delay: L1_DELAY,
        easing: EASE.inoutSoft,
        fill: BACK,
      }),
    );
    this.run(
      this.edge.animate(EDGE_TRAVEL, { duration: EDGE_MS, easing: EASE.inoutSoft, fill: BACK }),
    );
    this.run(this.edge.animate(FADE_IN, { duration: EDGE_IN_MS, easing: 'linear', fill: BACK }));

    return this.wait(L1_DELAY + L1_MS + HOLD_MS);
  }

  /** 幕を上へ抜く。作品は下から現れる */
  uncover(): Promise<void> {
    this.stop();

    if (prefersReducedMotion()) {
      this.el.classList.remove('is-cut');
      this.el.dataset.active = 'false';
      return Promise.resolve();
    }

    this.setOrigin('top');
    // ヘアラインは幕の下端へ回り込み、同じ軌跡をもう一度上る
    this.edge.style.transform = 'translateY(0)';
    this.edge.style.opacity = '0';

    this.run(
      this.l1.animate(SCALE_OUT, { duration: OUT_L1_MS, easing: EASE.inoutSoft, fill: BACK }),
    );
    this.run(
      this.l2.animate(SCALE_OUT, {
        duration: OUT_L2_MS,
        delay: OUT_L2_DELAY,
        easing: EASE.inoutSoft,
        fill: BACK,
      }),
    );
    this.run(
      this.edge.animate(EDGE_TRAVEL, { duration: OUT_L1_MS, easing: EASE.inoutSoft, fill: BACK }),
    );
    this.run(this.edge.animate(PULSE, { duration: OUT_L1_MS, easing: 'linear', fill: BACK }));

    this.l1.style.transform = 'scaleY(0)';
    this.l2.style.transform = 'scaleY(0)';

    return this.wait(OUT_L2_DELAY + OUT_L2_MS).then(() => {
      this.el.dataset.active = 'false';
    });
  }

  destroy(): void {
    this.stop();
    this.el.remove();
  }

  // --- 内部 ------------------------------------------------------------------

  private setOrigin(origin: 'top' | 'bottom'): void {
    this.l1.style.transformOrigin = `50% ${origin}`;
    this.l2.style.transformOrigin = `50% ${origin}`;
  }

  private run(animation: Animation): void {
    this.running.push(animation);
  }

  private stop(): void {
    for (let i = 0; i < this.running.length; i++) this.running[i].cancel();
    this.running.length = 0;
    if (this.timer !== 0) {
      window.clearTimeout(this.timer);
      this.timer = 0;
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer = window.setTimeout(() => {
        this.timer = 0;
        resolve();
      }, ms);
    });
  }
}

/* --- キーフレーム定数(毎回のオブジェクト生成を避けて使い回す) --- */

/** delay 中も開始状態を保つ。終了後は素のインラインスタイルへ着地させる */
const BACK: FillMode = 'backwards';

const SCALE_IN: Keyframe[] = [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }];
const SCALE_OUT: Keyframe[] = [{ transform: 'scaleY(1)' }, { transform: 'scaleY(0)' }];
const EDGE_TRAVEL: Keyframe[] = [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }];
const FADE_IN: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];
/** 退出のヘアライン: 素早く点り、着いたところで消える */
const PULSE: Keyframe[] = [
  { opacity: 0, offset: 0 },
  { opacity: 1, offset: 0.18 },
  { opacity: 1, offset: 0.72 },
  { opacity: 0, offset: 1 },
];
