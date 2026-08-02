/**
 * Panel — グラスパネルの器と、展示が使うビルダ(Phase 9b)。
 *
 * Phase 7 の `src/ui/panel.ts` を部品へ割ったもの。**外から見える API は
 * 1 文字も変えていない** ── 4 つの展示の `buildPanel(root)` は
 * `createPanel(root, title)` を呼び、slider / segmented / toggle / readout /
 * button / divider / note を鎖のようにつなぎ、key を付けたものへ
 * setValue / setDisabled / setOptionDisabled で後から触る。
 * この facade を残したので、展示側の差分はゼロになる(数式と描画に触らない、
 * という Phase 9b の約束をファイルの粒度で守るための選択)。
 *
 * この器が自分で持つのは 3 つだけ:
 *   ① ヘッダ ── 目盛りのティック + タイトル + ヘアライン + 「PARAMETERS」
 *   ② 本体 ── 上下がマスクで空気へ溶けるスクロール域(続きがあることの示唆)
 *   ③ グラブハンドル ── モバイルのボトムシート開閉(root の is-collapsed)
 *
 * 開閉状態を **root(呼び出し側が持つ永続コンテナ)** に置くのは Phase 7 から
 * 変わらない: パネル本体はタブ切替のたびに作り直されるので、作り直されない側に
 * 状態を持たせる。
 *
 * Phase 11 で 1 つだけ責務が増えた: **シートの実際の可視高さを --sheet-h として
 * <html> へ公開する**。それまで計器のピルは「46svh」という定数でシートを避けて
 * いたが、折り畳んだシート(つまみ + 見出しだけ ≒ 3.5rem)のときは画面の
 * 4 割以上が無駄に空き、逆に展開時は足りないことがあった。高さは
 * getBoundingClientRect で実測し、開閉とリサイズのときだけ書く。
 */

import { h, SHEET_LAYOUT_QUERY, type Component } from '../component';
import { createSlider, type SliderControl, type SliderSpec } from './Slider';
import { createSegmented, type SegmentedControl, type SegmentedSpec } from './Segmented';
import { createToggle, type ToggleControl, type ToggleSpec } from './Toggle';
import { createReadout, type ReadoutSpec, type ReadoutUpdate } from './Readout';
import { createPanelButton, type ButtonControl, type ButtonSpec } from './PanelButton';

export type { SliderSpec } from './Slider';
export type { SegmentedSpec } from './Segmented';
export type { ToggleSpec } from './Toggle';
export type { ReadoutSpec, ReadoutUpdate } from './Readout';
export type { ButtonSpec } from './PanelButton';

/** key で後から触れる部品。kind による判別可能なユニオン */
export type PanelControl = SliderControl | SegmentedControl | ToggleControl | ButtonControl;

export interface PanelBuilder {
  /** 呼び出し側が渡した永続コンテナ(開閉クラスはここに付く) */
  readonly root: HTMLElement;
  /** 生成されたパネル本体 */
  readonly element: HTMLElement;
  slider(spec: SliderSpec): PanelBuilder;
  segmented(spec: SegmentedSpec): PanelBuilder;
  toggle(spec: ToggleSpec): PanelBuilder;
  readout(spec: ReadoutSpec): ReadoutUpdate;
  button(spec: ButtonSpec): PanelBuilder;
  divider(): PanelBuilder;
  note(text: string): PanelBuilder;
  /** key を付けた部品の有効・無効を切り替える(視覚状態 + 操作の遮断) */
  setDisabled(key: string, disabled: boolean): void;
  /** key を付けた部品へ外から値を反映する(コールバックは呼ばれない) */
  setValue(key: string, value: number | string | boolean): void;
  /** segmented の 1 選択肢だけを無効化する(m = n の禁止など) */
  setOptionDisabled(key: string, option: string, disabled: boolean): void;
  /** 部品のリスナと ResizeObserver を畳む(次の createPanel が自動で呼ぶ) */
  destroy(): void;
}

/**
 * root ごとの生存中パネル。次の createPanel(root) が古い方を確実に畳む ──
 * 展示側は destroy を呼ばないので、facade がその責任を引き受ける。
 */
const LIVE = new WeakMap<HTMLElement, Panel>();

/** シート開閉アニメーション(.panel-body の max-height 0.3s)の完了待ち(ms) */
const SHEET_SETTLE_MS = 340;
/** リサイズの間引き。engine と同じ 150ms に揃える(既知の罠 #5) */
const RESIZE_DEBOUNCE_MS = 150;
/** --sheet-h の折り畳み時の既定(CSS 側の fallback と同じ値) */
const SHEET_FALLBACK = '3.5rem';

class Panel implements PanelBuilder, Component {
  readonly root: HTMLElement;
  readonly element: HTMLElement;
  /** Component 契約の代表要素 */
  get el(): HTMLElement {
    return this.element;
  }

  private readonly head: HTMLElement;
  private readonly body: HTMLElement;
  private readonly grab: HTMLButtonElement;
  private readonly keyed = new Map<string, PanelControl>();
  private readonly all: Component[] = [];
  /** シートの実測。展開時の高さは一度測れば以後は即座に確定できる */
  private lastExpanded = 0;
  private settleTimer = 0;
  private resizeTimer = 0;

  constructor(root: HTMLElement, title: string) {
    this.root = root;
    root.replaceChildren();

    const panel = h('div', 'panel');

    // ヘッダ = モバイルではボトムシートのつまみ(グラブハンドル)を兼ねる
    const head = h('div', 'panel-head');
    const kicker = h('div', 'panel-kicker');
    kicker.append(
      h('span', 'panel-tick', { 'aria-hidden': 'true' }),
      h('span', 'panel-kicker-text', { text: 'PARAMETERS', lang: 'en' }),
      h('span', 'panel-rule', { 'aria-hidden': 'true' }),
    );

    this.grab = h('button', 'panel-grab', {
      type: 'button',
      'aria-label': '操作パネルの開閉',
      'data-cursor': '',
    });
    this.grab.append(h('span', 'panel-grab-bar'));
    this.grab.addEventListener('click', this.onGrab);
    this.grab.setAttribute(
      'aria-expanded',
      root.classList.contains('is-collapsed') ? 'false' : 'true',
    );

    head.append(kicker, h('h3', 'panel-title', { text: title }), this.grab);
    this.head = head;

    this.body = h('div', 'panel-body');
    panel.append(head, this.body);
    root.append(panel);

    this.element = panel;

    LIVE.get(root)?.destroy();
    LIVE.set(root, this);

    // 開閉アニメーションが本当に終わった瞬間 ── 尺の見積もりではなく事実で測る。
    // reduced-motion では遷移そのものが無くこのイベントは来ないが、その場合は
    // 折り畳み直後の即時実測がそのまま終値になっている。
    this.body.addEventListener('transitionend', this.onBodyTransitionEnd);
    window.addEventListener('resize', this.onResize);

    // 初期値の配布は**マイクロタスクへ 1 段遅らせる**。展示の buildPanel は
    // `createPanel(root, title).slider(…).segmented(…)` と鎖で書くので、
    // コンストラクタの時点では本体がまだ空 ── ここで測ると「見出しだけの高さ」を
    // 展開時の高さとして配ってしまう(タブ切替で実測した不具合)。
    // マイクロタスクは同期の組み立てが終わった直後に走るので、測るのは完成品になる。
    queueMicrotask(() => {
      if (LIVE.get(this.root) === this) this.publishSheetHeight(true);
    });
  }

  slider(spec: SliderSpec): PanelBuilder {
    return this.add(createSlider(spec), spec.key);
  }

  segmented(spec: SegmentedSpec): PanelBuilder {
    return this.add(createSegmented(spec), spec.key);
  }

  toggle(spec: ToggleSpec): PanelBuilder {
    return this.add(createToggle(spec), spec.key);
  }

  button(spec: ButtonSpec): PanelBuilder {
    return this.add(createPanelButton(spec), spec.key);
  }

  readout(spec: ReadoutSpec): ReadoutUpdate {
    const control = createReadout(spec);
    this.body.append(control.el);
    this.all.push(control);
    return control.update;
  }

  divider(): PanelBuilder {
    this.body.append(h('div', 'pn-divider', { 'aria-hidden': 'true' }));
    return this;
  }

  note(text: string): PanelBuilder {
    this.body.append(h('p', 'pn-note', { text }));
    return this;
  }

  setDisabled(key: string, disabled: boolean): void {
    this.keyed.get(key)?.setDisabled(disabled);
  }

  setValue(key: string, value: number | string | boolean): void {
    const control = this.keyed.get(key);
    if (control === undefined) return;
    switch (control.kind) {
      case 'slider':
        control.setValue(Number(value));
        return;
      case 'segmented':
        control.setValue(String(value));
        return;
      case 'toggle':
        control.setValue(value === true);
        return;
      default:
        return; // button に値はない
    }
  }

  setOptionDisabled(key: string, option: string, disabled: boolean): void {
    const control = this.keyed.get(key);
    if (control !== undefined && control.kind === 'segmented') {
      control.setOptionDisabled(option, disabled);
    }
  }

  destroy(): void {
    this.grab.removeEventListener('click', this.onGrab);
    this.body.removeEventListener('transitionend', this.onBodyTransitionEnd);
    window.removeEventListener('resize', this.onResize);
    if (this.settleTimer !== 0) window.clearTimeout(this.settleTimer);
    if (this.resizeTimer !== 0) window.clearTimeout(this.resizeTimer);
    for (let i = 0; i < this.all.length; i++) this.all[i].destroy();
    this.all.length = 0;
    this.keyed.clear();
    this.element.remove();
    if (LIVE.get(this.root) === this) LIVE.delete(this.root);
  }

  // --- 内部 ------------------------------------------------------------------

  private readonly onGrab = (): void => {
    const collapsed = this.root.classList.toggle('is-collapsed');
    this.grab.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    // 折り畳みの終値は「つまみ + 見出し」の高さで**遷移を待たずに確定できる**ので
    // 即座に配り、展開側は 340ms 後の実測で仕上げる(初回だけ遅れる)
    this.publishSheetHeight();
    if (this.settleTimer !== 0) window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(this.onSettled, SHEET_SETTLE_MS);
  };

  private readonly onSettled = (): void => {
    this.settleTimer = 0;
    this.publishSheetHeight(true);
  };

  /** max-height の遷移が終わった = シートの高さが確定した */
  private readonly onBodyTransitionEnd = (event: TransitionEvent): void => {
    if (event.propertyName !== 'max-height' || event.target !== this.body) return;
    this.publishSheetHeight(true);
  };

  private readonly onResize = (): void => {
    if (this.resizeTimer !== 0) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(this.onResizeSettled, RESIZE_DEBOUNCE_MS);
  };

  private readonly onResizeSettled = (): void => {
    this.resizeTimer = 0;
    this.lastExpanded = 0; // 幅が変われば展開時の高さも変わる
    this.publishSheetHeight(true);
  };

  /**
   * シートの可視高さを --sheet-h(<html>)と `dimension:sheet` イベントで配る。
   *
   * ボトムシート版レイアウトでないときは property を消す ── CSS 側の
   * `var(--sheet-h, …)` が既定へ戻り、デスクトップの側面ドックの高さが
   * うっかりモバイル用の算術へ流れ込むことがない。
   *
   * @param settled 遷移が終わっている前提で root を実測してよいか
   */
  private publishSheetHeight(settled = false): void {
    const root = document.documentElement;
    if (!window.matchMedia?.(SHEET_LAYOUT_QUERY).matches) {
      root.style.removeProperty('--sheet-h');
      emitSheetHeight(0);
      return;
    }

    const collapsed = this.root.classList.contains('is-collapsed');
    let height: number;
    if (collapsed) {
      // 畳んだシートの高さ = ヘッダ(つまみ)だけ。本体の遷移とは無関係に確定する
      height = this.head.getBoundingClientRect().height;
    } else if (settled || this.lastExpanded === 0) {
      height = this.root.getBoundingClientRect().height;
      if (settled) this.lastExpanded = height;
    } else {
      height = this.lastExpanded;
    }

    root.style.setProperty('--sheet-h', height > 0 ? `${height.toFixed(1)}px` : SHEET_FALLBACK);
    emitSheetHeight(height);
  }

  private add(control: PanelControl, key: string | undefined): PanelBuilder {
    this.body.append(control.el);
    // 滑るピルは「DOM に入った直後」でないと測れない。1 部品につき 1 回、
    // 組み立て時にだけ強制レイアウトを許す(以後はリサイズ通知に任せる)
    if (control.kind === 'segmented') control.layout();
    this.all.push(control);
    if (key !== undefined) this.keyed.set(key, control);
    return this;
  }
}

/**
 * `root` の中身を作り直してグラスパネルを組み立てる。
 * 展示の `buildPanel(root)` から呼ぶ想定(タブ切替のたびに作り直される)。
 */
export function createPanel(root: HTMLElement, title: string): PanelBuilder {
  return new Panel(root, title);
}

/** 同じ値の連投で購読側(gallery のセーフエリア)を無駄に起こさない */
let lastEmitted = -1;

/**
 * シート高の通知。誰も聞いていなくても成立する ── CSS は --sheet-h を直接読み、
 * この合図は「構図をずらす側(gallery → engine.setSafeArea)」のためだけにある。
 */
function emitSheetHeight(height: number): void {
  const rounded = Math.round(height);
  if (rounded === lastEmitted) return;
  lastEmitted = rounded;
  window.dispatchEvent(new CustomEvent<number>('dimension:sheet', { detail: rounded }));
}
