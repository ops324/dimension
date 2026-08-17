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
 *   ① ヘッダ ── 目盛りのティック + 「PARAMETERS」 + ヘアライン + タイトル
 *      (モバイルではタイトルを伏せ、代わりに手がかりの一行を出す。Phase 26)
 *   ② 本体 ── 上下がマスクで空気へ溶けるスクロール域(続きがあることの示唆)
 *   ③ グラブハンドル ── モバイルのボトムシート開閉(root の is-collapsed)
 *
 * 開閉状態を **root(呼び出し側が持つ永続コンテナ)** に置くのは Phase 7 から
 * 変わらない: パネル本体はタブ切替のたびに作り直されるので、作り直されない側に
 * 状態を持たせる。
 *
 * Phase 11 で 1 つだけ責務が増えた: **シートの実際の可視高さを --sheet-h として
 * <html> へ公開する**。それまで計器のピルは「46svh」という定数でシートを避けて
 * いたが、折り畳んだシート(つまみ + 手がかりの一行 ≒ 3.5rem)のときは画面の
 * 4 割以上が無駄に空き、逆に展開時は足りないことがあった。高さは
 * getBoundingClientRect で実測し、開閉とリサイズのときだけ書く。
 *
 * Phase 26 で開ける手段が 3 つになった: **タップ / 上下の掃き / ホイール**。
 * 畳んだシートを見た人が最初に試すのは上スワイプで、それが何も起こさないことが
 * 「わかりにくい」の実体だった。判定は sheetGesture.ts(DOM を見ない純粋関数)に置き、
 * ここは入力を集めて `setCollapsed()` へ渡すだけにしてある。
 */

import {
  h,
  play,
  prefersReducedMotion,
  EASE,
  SHEET_LAYOUT_QUERY,
  type Component,
} from '../component';
import { normalizeWheel } from '../../../core/scrollGlide';
import { decideSwipe, decideWheel } from './sheetGesture';
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
  /** button に「今この状態にある」印を立てる(プリセットの現在地。button 以外は無視) */
  setActive(key: string, active: boolean): void;
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

/**
 * 掃いた直後の click を落とす時間窓(ms)。
 *
 * boolean のフラグでは足りない ── 右ボタンのドラッグや iOS の drag-off-button では
 * `pointerup` の後に `click` が来ないので、立てたフラグが残って**次のキーボードの
 * Enter を 1 回飲む**。時刻の窓なら詰まらない。加えて click 側では
 * `event.detail !== 0`(= ポインタ由来)であることも見るので、キーボード起動は
 * どう転んでも飲まれない。
 */
const CLICK_GUARD_MS = 400;

/**
 * 初回ヒントの待ち(ms)。**幕の尺ではなくプリローダの尺で決まる。**
 *
 * `?gallery=…` の共有リンク経路は幕を飛ばす(core/gallery.ts の applyRoute(_, true))。
 * 代わりに Preloader の下パネルが EXIT_PANEL_MS(700) + EXIT_PANEL_OFFSET(60) かけて
 * 下へ抜け、破棄は更に +40ms ── つまり 800ms までシートの真上は覆われている。
 * そこより早く鳴らすと、ヒントは幕の裏で終わり hintShown だけが焼ける。
 * モード切替の経路(TransitionOverlay の OUT_L2_MS = 480)は当然この後。
 * **上の 2 つの定数のどちらかが伸びたら、ここも見直す。**
 */
const HINT_DELAY_MS = 1000;
/** ヒントの 1 往復(ms)と回数。3 回で「見落とさない」と「うるさい」の境目 */
const HINT_CYCLE_MS = 900;
const HINT_CYCLES = 3;

/**
 * 初回ヒントを鳴らしたか。**モジュールレベルであることが要件**。
 * パネルはタブ切替のたびに作り直されるので(core/gallery.ts の buildPanel)、
 * インスタンス変数だと展示 4 つで 4 回鳴る。
 */
let hintShown = false;

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
  private readonly grabBar: HTMLElement;
  private readonly keyed = new Map<string, PanelControl>();
  private readonly all: Component[] = [];
  /** シートの実測。展開時の高さは一度測れば以後は即座に確定できる */
  private lastExpanded = 0;
  private settleTimer = 0;
  private resizeTimer = 0;
  /** 追っている指の pointerId。-1 は「誰も触っていない」 */
  private activePointer = -1;
  private startX = 0;
  private startY = 0;
  /** 最後に掃きで開閉した時刻(event.timeStamp)。直後の click を落とすために見る */
  private swipedAt = Number.NEGATIVE_INFINITY;

  constructor(root: HTMLElement, title: string) {
    this.root = root;
    root.replaceChildren();

    const panel = h('div', 'panel');

    // ヘッダ = モバイルではボトムシートのつまみ(グラブハンドル)を兼ねる
    const head = h('div', 'panel-head');
    const kicker = h('div', 'panel-kicker');
    /*
      手がかりの 2 つは `.panel-rule` の**後ろ**へ置く ── あのヘアラインは
      flex: 1 1 auto なので、間に挟まれるだけで手がかりを右端まで押してくれる
      (`.dw-deep-glyph` の margin-left: auto を借りる必要はない)。

      どちらも aria-hidden。可視文字はボタンの読み上げ名の先頭に入れてあり
      (下記)、ここを読ませると同じ語が二度読まれる。
      lang も付けない ── <html lang="ja"> が既定で、`lang="en"` を持つ
      `.panel-kicker-text` の方が例外である。
    */
    kicker.append(
      h('span', 'panel-tick', { 'aria-hidden': 'true' }),
      h('span', 'panel-kicker-text', { text: 'PARAMETERS', lang: 'en' }),
      h('span', 'panel-rule', { 'aria-hidden': 'true' }),
      h('span', 'panel-hint', { text: '操作する', 'aria-hidden': 'true' }),
      h('span', 'panel-chevron', { 'aria-hidden': 'true' }),
    );

    /*
      読み上げ名を**可視文字から始める**(WCAG 2.5.3 Label in Name)。
      `.panel-grab` は inset: 0 でヘッダ全域を覆うので、「操作する」は
      ボタンの中に見えている文字として知覚される ── 名前がそれを含まないと、
      音声入力で「操作する」と言っても一致しない。
      括弧の中は、開閉するものだと分かるように残した説明である。
    */
    this.grab = h('button', 'panel-grab', {
      type: 'button',
      'aria-label': '操作する(操作パネルの開閉)',
      'data-cursor': '',
    });
    this.grabBar = h('span', 'panel-grab-bar');
    this.grab.append(this.grabBar);
    this.grab.addEventListener('click', this.onGrab);
    this.grab.addEventListener('pointerdown', this.onPointerDown);
    this.grab.addEventListener('pointerup', this.onPointerUp);
    this.grab.addEventListener('pointercancel', this.onPointerCancel);
    this.grab.addEventListener('wheel', this.onWheel, { passive: true });
    this.grab.setAttribute(
      'aria-expanded',
      root.classList.contains('is-collapsed') ? 'false' : 'true',
    );

    head.append(kicker, h('h3', 'panel-title', { text: title }), this.grab);
    this.head = head;

    this.body = h('div', 'panel-body');
    panel.append(head, this.body);
    root.append(panel);
    // 起動時は畳んだ状態(index.html が is-collapsed を持つ)。器が本体を隠す前に合わせる
    this.syncInert(root.classList.contains('is-collapsed'));

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
      if (LIVE.get(this.root) !== this) return;
      this.publishSheetHeight(true);
      this.maybeHint();
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

  setActive(key: string, active: boolean): void {
    const control = this.keyed.get(key);
    if (control !== undefined && control.kind === 'button') control.setActive(active);
  }

  destroy(): void {
    this.grab.removeEventListener('click', this.onGrab);
    this.grab.removeEventListener('pointerdown', this.onPointerDown);
    this.grab.removeEventListener('pointerup', this.onPointerUp);
    this.grab.removeEventListener('pointercancel', this.onPointerCancel);
    this.grab.removeEventListener('wheel', this.onWheel);
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

  /**
   * **`is-collapsed` を書く唯一の場所**(Phase 26 でタップ・掃き・ホイールの
   * 3 入口から呼ばれるようになったので、書き手をここへ寄せた)。
   *
   * 同じ状態への再適用は**無音で帰る**。これが効くのはホイールで、あの入力は
   * 1 回の意図で何十発も飛んでくる ── 早期 return が無いと publishSheetHeight と
   * 340ms のタイマーを何度も起こし直すことになる。
   *
   * 注意: `syncInert` と `publishSheetHeight` の呼び出し元はここだけではない。
   * コンストラクタと onResizeSettled からも呼ばれ、そちらは回転・幅変更で
   * シート版 ⇄ 側面ドックが入れ替わる経路である ── 消してはならない。
   */
  private setCollapsed(next: boolean): void {
    if (this.root.classList.contains('is-collapsed') === next) return;
    this.root.classList.toggle('is-collapsed', next);
    this.grab.setAttribute('aria-expanded', next ? 'false' : 'true');
    this.syncInert(next);
    // 折り畳みの終値は「つまみ + 手がかりの一行」の高さで**遷移を待たずに確定できる**
    // ので即座に配り、展開側は 340ms 後の実測で仕上げる(初回だけ遅れる)
    this.publishSheetHeight();
    if (this.settleTimer !== 0) window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(this.onSettled, SHEET_SETTLE_MS);
  }

  /**
   * タップ(と Enter / Space)。掃きの直後に来た click だけを落とす。
   *
   * `event.detail !== 0` が「ポインタ由来」の判定 ── キーボードで押した click は
   * detail が 0 なので、フラグの状態がどうあれ**絶対に飲まれない**。
   */
  private readonly onGrab = (event: MouseEvent): void => {
    if (event.detail !== 0 && event.timeStamp - this.swipedAt < CLICK_GUARD_MS) return;
    this.setCollapsed(!this.root.classList.contains('is-collapsed'));
  };

  /*
    掃きの入口。**pointerType で分岐しない**のは意図した選択である ──
    キャンバスのタップ判定は `pointerType === 'touch'` で絞っており(そちらは
    マウスの click が OrbitControls と衝突するため)、その結果あの判定は
    マウスのハーネスでは検証できない。ここは絞らないので、合成ポインタの
    ドラッグがそのまま本番の道を通る。「揃えよう」として絞らないこと。
  */

  private readonly onPointerDown = (event: PointerEvent): void => {
    /*
      1 本目だけを追う。56px の帯に指が 2 本乗るのは普通のことで、
      2 本目が起点を上書きすると 1 本目の pointerup が他人の起点で dy を
      計算して勝手に開閉する ── キャンバスのタップ判定が既に同じ形で防いでいる。
    */
    if (this.activePointer !== -1 || !event.isPrimary || event.button !== 0) return;
    this.activePointer = event.pointerId;
    this.startX = event.clientX;
    this.startY = event.clientY;
    /*
      キャプチャは必須。56px の帯から 24px 掃けば指はすぐ帯の外へ出る。
      タッチには暗黙のキャプチャがあるがマウスには無いので、これが無いと
      マウスのドラッグで pointerup を取り落とす。

      try で囲むのは、`setPointerCapture` が「その pointerId が今アクティブで
      ない」ときに NotFoundError を投げる仕様だから ── 本物の pointerdown では
      起きないが、**合成イベントでは必ず起きる**。ここで例外が抜けると
      検証ハーネスがこの経路を一度も通せなくなる(そして本番でも、通ったことの
      ない道が残る)。捕まえた場合も判定そのものは終値だけで成り立つので、
      失うのは「帯の外まで指を追える」ことだけである。
    */
    try {
      this.grab.setPointerCapture(event.pointerId);
    } catch {
      /* 追従できないだけ。掃きの判定は pointerup の座標で成立する */
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointer) return;
    this.activePointer = -1;
    const intent = decideSwipe(event.clientX - this.startX, event.clientY - this.startY);
    if (intent === 'tap') return; // 掃きでないものは click に任せる(二重処理をしない)
    this.swipedAt = event.timeStamp;
    this.setCollapsed(intent === 'close');
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === this.activePointer) this.activePointer = -1;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    // ブラウザのズーム / トラックパッドのピンチ(core/smoothScroll.ts と同じ先例)
    if (event.ctrlKey || event.metaKey) return;
    const intent = decideWheel(
      normalizeWheel(event.deltaY, event.deltaMode, window.innerHeight),
    );
    if (intent === 'tap') return;
    this.setCollapsed(intent === 'close');
  };

  /**
   * つまみバーを 1 セッションに一度だけ息づかせる(Phase 26)。
   *
   * 静的な手がかり(明度・日本語の一行・シェブロン)で足りているはずだが、
   * 畳んだシートは画面の端にあって視線が最後に行く場所なので、最初の一度だけ
   * 「ここは動く」と言っておく。reduced-motion では play() が尺を 0 にするより前に
   * ここで弾く ── 3 回の往復は「静止した到達状態」に意味が無いため。
   */
  private maybeHint(): void {
    if (hintShown || prefersReducedMotion()) return;
    if (!(window.matchMedia?.(SHEET_LAYOUT_QUERY).matches ?? false)) return;
    if (!this.root.classList.contains('is-collapsed')) return;
    hintShown = true;
    play(
      this.grabBar,
      [
        { opacity: 1, transform: 'translate(-50%, 0)' },
        { opacity: 0.45, transform: 'translate(-50%, -2px)' },
        { opacity: 1, transform: 'translate(-50%, 0)' },
      ],
      {
        duration: HINT_CYCLE_MS,
        iterations: HINT_CYCLES,
        delay: HINT_DELAY_MS,
        easing: EASE.inoutSoft,
      },
    );
  }

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

  /**
   * 畳んだシートの中身をタブ順から外す(Phase 14c)。
   *
   * 折り畳みは `max-height: 0; opacity: 0; overflow: hidden` で作られている ──
   * display:none でも visibility:hidden でも inert でもないので、**畳んだままの
   * スライダー・セグメント・トグルが十数個、そっくりタブ順に残っていた**。
   * つまみから Tab すると不可視のコントロールを延々と通過することになり、
   * スキップリンクを足す意味を正面から損なう。
   *
   * `role="tabpanel"` と aria-controls の関係は既に正しいので触らない ──
   * ここで閉じるのは順序だけである。
   *
   * **ボトムシート版レイアウトのときだけ**であることが要件(実測で踏んだ)。
   * `is-collapsed` は器に常時付いているが、折り畳みの CSS は
   * SHEET_LAYOUT_QUERY の中にしか無い ── デスクトップの側面ドックは
   * `is-collapsed` のままでも全開なので、そこで inert にすると
   * **見えている操作子がキーボードから消える**。
   */
  private syncInert(collapsed: boolean): void {
    const sheet = window.matchMedia?.(SHEET_LAYOUT_QUERY).matches ?? false;
    this.body.inert = collapsed && sheet;
  }

  private readonly onResizeSettled = (): void => {
    this.resizeTimer = 0;
    this.lastExpanded = 0; // 幅が変われば展開時の高さも変わる
    // 回転や幅変更でシート版 ⇄ 側面ドックが入れ替わりうる。タブ順も揃え直す
    this.syncInert(this.root.classList.contains('is-collapsed'));
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
      /*
        畳んだシートの高さ = ヘッダ(つまみ)+ シート下端の余白。

        ヘッダだけを測るのは、本体の遷移(max-height → 0)の**途中の高さ**を
        拾わないため ── 畳むボタンを押した直後にここが呼ばれる。

        ただし Phase 14a で `.panel`(= this.element。this.root は外側の器)は
        `padding-bottom: var(--sa-b)` を持った(ホームインジケータ帯のぶん)。
        この余白はヘッダの矩形の**外**にあるので、足さないと --sheet-h が
        --sa-b ぶん過小報告し、上に積むチップがシートへ食い込む
        (実測で 34px 重なった)。padding は静的な値なので、
        本体の遷移とは無関係という性質は保たれる。
      */
      height =
        this.head.getBoundingClientRect().height +
        parseFloat(getComputedStyle(this.element).paddingBottom || '0');
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
