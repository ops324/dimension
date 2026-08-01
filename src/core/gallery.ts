import { Vector3 } from 'three';
import type * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type { Engine } from './engine';
import type { ScrollDirector } from './scrollDirector';
import type { Starfield } from '../render/starfield';
import type { Exhibit } from '../scenes/exhibit';
import { HopfExhibit } from '../scenes/hopfExhibit';
import { CliffordExhibit } from '../scenes/cliffordExhibit';
import { PolytopeExhibit } from '../scenes/polytopeExhibit';
import { PerspectiveExhibit, type CameraHint } from '../scenes/perspectiveExhibit';
import { EXHIBIT_INFO, type ExhibitInfo } from '../ui/content';
import { TransitionOverlay } from '../ui/components/TransitionOverlay';
import { Tabs } from '../ui/components/Tabs';
import { ExhibitHeader } from '../ui/components/ExhibitHeader';
import { Drawer } from '../ui/components/Drawer';
import { createHud, type Hud } from '../ui/components/Hud';
import { ImmersiveToggle } from '../ui/components/ImmersiveToggle';
import { SHEET_LAYOUT_QUERY } from '../ui/components/component';

/**
 * ギャラリーのモード状態機械(プラン3節)。
 *
 * renderer / composer / camera は engine が 1 つだけ持つ。ここがするのは
 *   ① `renderPass.scene` の差し替え(engine.setScene)
 *   ② starfield という**唯一の共有オブジェクト**をアクティブシーンへ付け替え
 *   ③ body のスクロールロックと canvas の pointer-events / touch-action の切替
 *   ④ 展示の reveal 遷移(exit → 350ms → enter)とパネル・解説の差し替え
 * の 4 つだけ。物語シーンは破棄せず保持するので「物語へ戻る」は即時に効く。
 *
 * 毎フレーム(update)は **アクティブな展示 1 つ + controls + starfield のみ**を
 * 進める。narrative / scrollDirector / overlays はギャラリー中は完全に止まる
 * (main.ts の onFrame をモードで分岐させることで実現している)。
 */

export type GalleryMode = 'narrative' | 'gallery';
export type ExhibitId = 'hopf' | 'clifford' | 'polytope' | 'perspective';

/** 展示レジストリの 1 行。カメラのホーム姿勢と距離制限もここが唯一の情報源 */
export interface ExhibitEntry {
  readonly id: ExhibitId;
  /** 入場時のカメラ位置(注視点は常に原点) */
  readonly home: readonly [number, number, number];
  readonly minDistance: number;
  readonly maxDistance: number;
  /** 遅延生成。ギャラリー初回入場時に 4 つまとめて構築する */
  create(): Exhibit;
}

/**
 * 展示レジストリ。
 *
 * polytope の出荷時既定は **cube / n=4(テッセラクト)/ 透視** ── Phase 2 の
 * n=10 は性能ストレス用の既定で、作品としての初手ではない(プラン Phase 7 の決定)。
 * n=10 はパネルの N スライダーで即座に到達できる。
 */
export const EXHIBIT_REGISTRY: readonly ExhibitEntry[] = [
  {
    id: 'hopf',
    home: [3.4, 3.0, 7.6],
    minDistance: 2.5,
    maxDistance: 40,
    create: () => new HopfExhibit(),
  },
  {
    id: 'clifford',
    home: [3.0, 2.2, 6.5],
    minDistance: 2.5,
    maxDistance: 30,
    create: () => new CliffordExhibit(),
  },
  {
    id: 'polytope',
    home: [2.7, 1.9, 5.0],
    minDistance: 2.2,
    maxDistance: 20,
    create: () => new PolytopeExhibit({ family: 'cube', n: 4, projection: 'perspective' }),
  },
  {
    id: 'perspective',
    home: [0, 1.6, 7.2],
    minDistance: 2.5,
    maxDistance: 25,
    create: () => new PerspectiveExhibit(),
  },
];

export interface GalleryOptions {
  readonly engine: Engine;
  readonly canvas: HTMLCanvasElement;
  readonly starfield: Starfield;
  /** 物語シーン(破棄せず保持し、戻るときはこのシーンへ差し替えるだけ) */
  readonly narrative: Exhibit;
  /** 物語へ戻ったあとのセクション再計測に使う */
  readonly scrollDirector: ScrollDirector;
}

/** タブ切替の reveal フェードアウト待ち(ms)。展示側の REVEAL_RATE と噛み合う値 */
const SWITCH_MS = 380;
/** カメラのホーム復帰トゥイーン(ms)と追従レート */
const TWEEN_MS = 600;
const TWEEN_RATE = 7;

/** perspective のカメラ誘導を無視する時間(ms)。操作が終わってから 6 秒は譲る */
const HINT_PAUSE_MS = 6000;
/** ヒントへの追従速度(expSmooth 相当)。~0.5 秒で寄る */
const HINT_RATE = 3.2;

/** controls.target の復帰先。共有の読み取り専用ベクタ(mutate 禁止) */
const ORIGIN = new Vector3(0, 0, 0);

/**
 * キャンバスの「単タップ」判定(Phase 11)。
 * OrbitControls のドラッグと食い合わないよう、移動 8px 未満・350ms 未満に限る。
 * この条件を満たす操作は構図をほとんど動かさないので、意図は「見たい」だけ。
 */
const TAP_MOVE_PX = 8;
const TAP_MS = 350;

export class Gallery {
  private readonly engine: Engine;
  private readonly canvas: HTMLCanvasElement;
  private readonly starfield: Starfield;
  private readonly narrative: Exhibit;
  private readonly scrollDirector: ScrollDirector;

  private readonly exhibits = new Map<ExhibitId, Exhibit>();
  private readonly entries = new Map<ExhibitId, ExhibitEntry>();

  private readonly rootEl: HTMLElement;
  private readonly panelRoot: HTMLElement;
  private readonly tabsEl: HTMLElement;
  /** モード遷移の幕(Phase 9a で #mode-fade の単純な暗転から置き換え) */
  private readonly transition = new TransitionOverlay();
  private readonly drawerEl: HTMLElement;
  private readonly aboutButton: HTMLButtonElement;

  /** ギャラリークローム(Phase 9b でコンポーネント化) */
  private readonly tabs: Tabs;
  private readonly header: ExhibitHeader;
  private readonly drawer: Drawer;
  private readonly hud: Hud | null;
  /** クロームを退かせるチップ。#hud の**外**に立つ(#hud は aria-hidden) */
  private readonly immersive: ImmersiveToggle;

  private controls: OrbitControls | null = null;
  private perspective: PerspectiveExhibit | null = null;

  private mode: GalleryMode = 'narrative';
  private activeId: ExhibitId = 'hopf';
  private active: Exhibit | null = null;

  private savedScrollY = 0;
  private busy = false;
  private switchTimer = 0;
  private reduceMotion = false;

  /** カメラトゥイーン(毎フレームのアロケーションを避けるため使い回す) */
  private readonly tweenTarget = new Vector3();
  private tweenTime = 0;
  /** perspective のカメラ誘導 */
  private readonly hint: CameraHint = { pos: new Vector3(), look: new Vector3() };
  private hintPausedUntil = 0;

  // --- 没入モードとセーフエリア(Phase 11) ---
  /** ボトムシート版レイアウトか。CSS と同じ 1 本の条件から取る */
  private readonly sheetLayout: MediaQueryList | null;
  private uiHidden = false;
  /** Panel が実測して配るシートの可視高さ(CSS px) */
  private sheetHeight = 0;
  /** キャンバスの単タップ判定 */
  private tapId = -1;
  private tapX = 0;
  private tapY = 0;
  private tapAt = 0;

  constructor(options: GalleryOptions) {
    this.engine = options.engine;
    this.canvas = options.canvas;
    this.starfield = options.starfield;
    this.narrative = options.narrative;
    this.scrollDirector = options.scrollDirector;

    for (const entry of EXHIBIT_REGISTRY) this.entries.set(entry.id, entry);

    this.rootEl = requireEl('gallery');
    this.panelRoot = requireEl('gallery-panel');
    this.tabsEl = requireEl('gallery-tabs');
    this.transition.mount(document.body);
    this.drawerEl = requireEl('gallery-drawer');
    this.aboutButton = requireEl('about-toggle') as HTMLButtonElement;

    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (query) {
      this.reduceMotion = query.matches;
      query.addEventListener('change', (event) => {
        this.reduceMotion = event.matches;
        this.tabs.setSmoothScroll(!event.matches);
      });
    }

    // パネルは展示が切り替わるたびに作り直される tabpanel。タブ側から
    // aria-labelledby を張るので、ロールはここで一度だけ与えておく
    this.panelRoot.setAttribute('role', 'tabpanel');

    this.tabs = new Tabs({
      container: this.tabsEl,
      items: EXHIBIT_REGISTRY.map((entry) => {
        const info = infoFor(entry.id);
        return { id: entry.id, en: info.en, jp: info.jp };
      }),
      active: this.activeId,
      panelId: 'gallery-panel',
      smoothScroll: !this.reduceMotion,
      onSelect: (id) => this.select(id as ExhibitId),
    });

    this.header = new ExhibitHeader(requireEl('gallery-head'));
    this.drawer = new Drawer({
      root: this.drawerEl,
      onRequestClose: () => this.closeDrawer(),
    });
    this.hud = createHud();
    this.immersive = new ImmersiveToggle(() => this.setUiHidden(!this.uiHidden));
    this.immersive.mount(document.body);

    this.sheetLayout = window.matchMedia?.(SHEET_LAYOUT_QUERY) ?? null;
    this.sheetLayout?.addEventListener('change', () => this.syncSafeArea());

    // 行分割は幅に依存する。engine.onResize は 150ms デバウンス済みなので、
    // ここでの組み直しは「リサイズが落ち着いたら 1 回」に収まる
    this.engine.onResize(() => {
      if (this.mode !== 'gallery') return;
      this.header.remeasure();
      this.syncSafeArea();
    });

    this.wireChrome();
  }

  /** いまギャラリーモードか(main.ts の onFrame 分岐がこれを読む) */
  get isGallery(): boolean {
    return this.mode === 'gallery';
  }

  get currentMode(): GalleryMode {
    return this.mode;
  }

  /** 表示中の展示(検証フックから触る) */
  get activeExhibit(): Exhibit | null {
    return this.active;
  }

  get activeExhibitId(): ExhibitId {
    return this.activeId;
  }

  // --- モード遷移 ------------------------------------------------------------

  /**
   * 物語 → ギャラリー。
   * scrollY を保存し、250ms のフェードの**裏**でシーン・DOM を差し替える。
   */
  enterGallery(): void {
    if (this.mode === 'gallery' || this.busy) return;
    this.busy = true;
    this.savedScrollY = window.scrollY;
    // モード遷移が受理された合図(Phase 10 の音づけが購読する。誰も聞かなくても成立する)
    window.dispatchEvent(new CustomEvent<GalleryMode>('dimension:mode', { detail: 'gallery' }));

    this.fade(true, () => {
      this.ensureExhibits();

      this.mode = 'gallery';
      document.body.classList.remove('mode-narrative');
      document.body.classList.add('mode-gallery', 'has-gallery');
      document.body.style.overflow = 'hidden';
      this.rootEl.hidden = false;
      this.updateNavState();

      const exhibit = this.exhibits.get(this.activeId);
      if (exhibit !== undefined) {
        this.active = exhibit;
        this.engine.setScene(exhibit.scene);
        exhibit.scene.add(this.starfield.group); // add() は付け替え(前の親から自動で外れる)
        exhibit.enter();
        this.applyHome(this.activeId, true);
        this.buildPanel(exhibit);
        this.applyInfo(this.activeId);
      }

      const controls = this.ensureControls();
      controls.enabled = true;

      // パネルが組み上がって --sheet-h が確定してから構図をずらす
      this.syncSafeArea();

      this.busy = false;
      this.fade(false);
      console.info(`[gallery] enter → ${this.activeId}`);
    });
  }

  /** ギャラリー → 物語。シーンは破棄していないので復帰は即時 */
  exitGallery(): void {
    if (this.mode === 'narrative' || this.busy) return;
    this.busy = true;
    window.dispatchEvent(new CustomEvent<GalleryMode>('dimension:mode', { detail: 'narrative' }));

    this.fade(true, () => {
      // 切替待ちのタイマーが残っていると、物語へ戻ったあとに展示シーンへ
      // 差し替えられてしまう(swap 側でもモードを見ているが、二重に止める)
      if (this.switchTimer !== 0) {
        window.clearTimeout(this.switchTimer);
        this.switchTimer = 0;
      }
      this.closeDrawer();
      // 没入モードは展示を出た時点で解く(物語のテキストが読めなくなる)
      this.setUiHidden(false);
      this.active?.exit();
      this.active = null;

      this.mode = 'narrative';
      document.body.classList.remove('mode-gallery');
      document.body.classList.add('mode-narrative');
      document.body.style.overflow = '';
      this.rootEl.hidden = true;
      this.updateNavState();
      // 物語はスクロールで読む画面なので、構図のずらしは必ず解く
      this.engine.clearSafeArea();

      if (this.controls !== null) this.controls.enabled = false;

      this.engine.setScene(this.narrative.scene);
      this.narrative.scene.add(this.starfield.group);
      this.narrative.enter();

      // スクロールバーが戻って高さが変わり得るので、位置を戻してから測り直す
      window.scrollTo(0, this.savedScrollY);
      this.scrollDirector.remeasure();

      this.busy = false;
      this.fade(false);
      console.info(`[gallery] exit → narrative (scrollY=${Math.round(this.savedScrollY)})`);
    });
  }

  /**
   * 展示の切り替え。
   * exit() で reveal を 0 へ落とし、~380ms 待ってからシーンを差し替える
   * (差し替えを待つ間も前の展示が update され続けるのでフェードが見える)。
   */
  select(id: ExhibitId): void {
    if (this.mode !== 'gallery' || id === this.activeId || this.switchTimer !== 0) return;
    const next = this.exhibits.get(id);
    if (next === undefined) return;

    this.active?.exit();
    // 切り替えが受理された合図(Phase 10 の音づけが購読する)
    window.dispatchEvent(new CustomEvent<ExhibitId>('dimension:tab', { detail: id }));
    // タブの下線と見出しは**押した瞬間に**動きはじめる ── 展示の差し替えを
    // 待つ 380ms のあいだ、UI だけが先に次の展示を指している状態を作る
    this.tabs.setActive(id);
    this.header.beginExit();

    const swap = (): void => {
      this.switchTimer = 0;
      // 待っている間に物語へ戻された場合は何もしない(シーンを奪い返さない)
      if (this.mode !== 'gallery') return;
      this.activeId = id;
      this.active = next;
      this.engine.setScene(next.scene);
      next.scene.add(this.starfield.group);
      next.enter();
      this.applyHome(id, false);
      this.buildPanel(next);
      this.applyInfo(id);
      // 展示ごとにシートの中身の高さが違う ── 開いたまま切り替えたときは
      // --sheet-h も構図のずらしも新しい高さへ揃え直す
      this.syncSafeArea();
      console.info(`[gallery] switch → ${id}`);
    };

    if (this.reduceMotion) {
      swap();
      return;
    }
    this.switchTimer = window.setTimeout(swap, SWITCH_MS);
  }

  // --- 毎フレーム ------------------------------------------------------------

  /**
   * ギャラリーモードのフレーム更新。**アロケーションは一切しない**。
   * 呼ぶのはアクティブな展示・OrbitControls・starfield だけ。
   */
  update(dt: number, t: number): void {
    const exhibit = this.active;
    const controls = this.controls;
    if (exhibit === null || controls === null) return;

    if (this.tweenTime > 0) this.tweenTime -= dt;

    // perspective の構図誘導が優先(2 次元世界ビュー等)。ユーザー操作中は黙る
    const perspective = this.perspective;
    const hinted =
      perspective !== null &&
      exhibit === perspective &&
      performance.now() >= this.hintPausedUntil &&
      perspective.getCameraHint(this.hint);

    if (hinted) {
      const k = 1 - Math.exp(-HINT_RATE * dt);
      this.engine.camera.position.lerp(this.hint.pos, k);
      controls.target.lerp(this.hint.look, k);
    } else if (this.tweenTime > 0) {
      const k = 1 - Math.exp(-TWEEN_RATE * dt);
      this.engine.camera.position.lerp(this.tweenTarget, k);
      controls.target.lerp(ORIGIN, k);
    }

    controls.update();
    this.starfield.update(dt);
    exhibit.update(dt, t);
  }

  /**
   * composer の後に走る第2パス(perspective の神視点インセット)。
   * 通常は engine.onAfterRender が展示側の renderInset を直接呼ぶので不要だが、
   * rAF が止まるヘッドレス検証(main.ts の renderOnce)から同じ順序で叩けるようにする。
   */
  afterRender(renderer: THREE.WebGLRenderer): void {
    const perspective = this.perspective;
    if (perspective !== null && this.active === perspective) {
      perspective.renderInset(renderer);
    }
  }

  // --- 内部: 生成 ------------------------------------------------------------

  /** 4 展示を初回入場時にまとめて構築する(以後はキャッシュ済みで再入場は即時) */
  private ensureExhibits(): void {
    if (this.exhibits.size > 0) return;
    const t0 = performance.now();
    for (const entry of EXHIBIT_REGISTRY) {
      const exhibit = entry.create();
      exhibit.init({ engine: this.engine });
      this.exhibits.set(entry.id, exhibit);
      if (exhibit instanceof PerspectiveExhibit) this.perspective = exhibit;
    }
    console.info(`[gallery] exhibits built in ${(performance.now() - t0).toFixed(0)}ms`);
  }

  /** OrbitControls は一度だけ作る。モードでは enabled を切り替えるだけ */
  private ensureControls(): OrbitControls {
    if (this.controls !== null) return this.controls;

    const controls = new OrbitControls(this.engine.camera, this.canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.enabled = false;

    // ユーザーが触ったら、こちらからのカメラ誘導はしばらく黙る
    const pause = (): void => {
      this.hintPausedUntil = performance.now() + HINT_PAUSE_MS;
      this.tweenTime = 0;
    };
    controls.addEventListener('start', pause);
    controls.addEventListener('end', pause);

    this.controls = controls;
    return controls;
  }

  /** トップナビ・解説トグル・CTA 以外の常設操作をつなぐ */
  private wireChrome(): void {
    this.aboutButton.addEventListener('click', () => this.toggleDrawer());

    for (const button of document.querySelectorAll<HTMLButtonElement>('#mode-nav [data-mode]')) {
      button.addEventListener('click', () => {
        if (button.dataset.mode === 'gallery') this.enterGallery();
        else this.exitGallery();
      });
    }

    // シートの高さは Panel が実測して配る。構図をずらす側はここで受ける
    window.addEventListener('dimension:sheet', (event) => {
      const height = (event as CustomEvent<number>).detail;
      if (typeof height !== 'number' || height === this.sheetHeight) return;
      this.sheetHeight = height;
      this.syncSafeArea();
    });

    // キャンバスの単タップで没入モードを往復する(ドラッグとは食い合わない)
    this.canvas.addEventListener('pointerdown', this.onCanvasDown);
    this.canvas.addEventListener('pointerup', this.onCanvasUp);
    this.canvas.addEventListener('pointercancel', this.onCanvasCancel);

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.mode === 'gallery') {
        // 順序は契約: 隠しているものから先に戻す。ここで止めないと
        // 「作品だけを見ていた人が Esc で展示ごと退場させられる」ことになる
        if (this.uiHidden) this.setUiHidden(false);
        else if (this.drawer.isOpen) this.closeDrawer();
        else this.exitGallery();
      }
    });
  }

  // --- 没入モード ------------------------------------------------------------

  /**
   * クロームの在/不在。display:none にはしない ── タブリストと tabpanel の
   * aria 関係、フォーカスの行き先、下線の幾何が一度に壊れるため、
   * 不透明度 + visibility + pointer-events の 3 点で「そこに在るが見えない」を作る。
   */
  private setUiHidden(hidden: boolean): void {
    if (hidden === this.uiHidden) return;
    this.uiHidden = hidden;
    document.body.classList.toggle('ui-hidden', hidden);
    this.immersive.setHidden(hidden);
    // 神視点インセットは WebGL の第2パスなので CSS では消えない。展示へ直接伝える
    this.perspective?.setChromeHidden(hidden);
    // 没入中は画面が丸ごと作品なので、構図のずらしも解く
    this.syncSafeArea();
    // 隠した瞬間にフォーカスが見えない要素へ残らないようにする
    if (hidden) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && this.rootEl.contains(active)) active.blur();
    }
  }

  private readonly onCanvasDown = (event: PointerEvent): void => {
    if (this.mode !== 'gallery' || !event.isPrimary || event.button > 0) {
      this.tapId = -1;
      return;
    }
    this.tapId = event.pointerId;
    this.tapX = event.clientX;
    this.tapY = event.clientY;
    this.tapAt = event.timeStamp;
  };

  private readonly onCanvasUp = (event: PointerEvent): void => {
    if (this.tapId !== event.pointerId) return;
    this.tapId = -1;
    if (this.mode !== 'gallery' || this.busy || this.drawer.isOpen) return;
    // タップでの没入切替はタッチのみ。マウスのクリックは OrbitControls の
    // 慣性停止と衝突して誤爆する(レビュー判断) — デスクトップはアイチップで
    if (event.pointerType !== 'touch') return;
    if (event.timeStamp - this.tapAt > TAP_MS) return;
    const dx = event.clientX - this.tapX;
    const dy = event.clientY - this.tapY;
    if (dx * dx + dy * dy > TAP_MOVE_PX * TAP_MOVE_PX) return;
    this.setUiHidden(!this.uiHidden);
  };

  private readonly onCanvasCancel = (): void => {
    this.tapId = -1;
  };

  // --- セーフエリア ----------------------------------------------------------

  /**
   * UI が覆っている帯を engine へ伝える(Phase 11)。
   *
   * 上 = タブ帯の下端(ナビ + タブ棚の実測)、下 = シートの可視高さ。
   * ボトムシート版レイアウトのときだけ意味を持つので、それ以外では必ず解除する ──
   * デスクトップは左右のドックなので上下の構図は動かさない。
   * 呼ばれるのは入場・タブ切替・シート開閉・リサイズ・没入切替だけで、
   * 毎フレームのコストはゼロ。
   */
  private syncSafeArea(): void {
    if (this.mode !== 'gallery' || this.uiHidden || this.sheetLayout?.matches !== true) {
      this.engine.clearSafeArea();
      return;
    }
    const top = this.tabsEl.getBoundingClientRect().bottom;
    this.engine.setSafeArea(top, this.sheetHeight);
  }

  // --- 内部: 遷移の部品 ------------------------------------------------------

  /**
   * モード遷移の幕(TransitionOverlay)。
   *
   * `fade(true, done)` は「幕が覆い切った瞬間に done を呼ぶ」── 旧 #mode-fade と
   * 同じ契約なので、呼び出し側(enterGallery / exitGallery)は変わらない。
   * done の中で展示を差し替えて enter() すると、その reveal は幕が上がっていく
   * あいだに進む ── 幕と絵の立ち上がりが噛み合う。
   * reduced-motion では TransitionOverlay 側がアニメーションを使わず一瞬で切る。
   */
  private fade(on: boolean, done?: () => void): void {
    if (on) {
      void this.transition.cover().then(() => done?.());
      return;
    }
    void this.transition.uncover();
    done?.();
  }

  /** カメラのホーム姿勢と距離制限を適用する。instant=true は暗転中の即時適用 */
  private applyHome(id: ExhibitId, instant: boolean): void {
    const entry = this.entries.get(id);
    const controls = this.ensureControls();
    if (entry === undefined) return;

    controls.minDistance = entry.minDistance;
    controls.maxDistance = entry.maxDistance;
    this.tweenTarget.set(entry.home[0], entry.home[1], entry.home[2]);

    if (instant || this.reduceMotion) {
      this.engine.camera.position.copy(this.tweenTarget);
      this.engine.camera.lookAt(0, 0, 0);
      controls.target.set(0, 0, 0);
      controls.update();
      this.tweenTime = 0;
      return;
    }
    this.tweenTime = TWEEN_MS / 1000;
  }

  private buildPanel(exhibit: Exhibit): void {
    this.panelRoot.replaceChildren();
    exhibit.buildPanel(this.panelRoot);
  }

  /**
   * ヘッダ・解説ドロワー・計器の中身を差し替える(状態変化時のみの DOM 書き込み)。
   * 見出しの振り付け(番号のフェード → 英字名の文字送り → 日本語名と一文)は
   * ExhibitHeader が持つ ── ここは「どの展示か」を渡すだけ。
   */
  private applyInfo(id: ExhibitId): void {
    const info = infoFor(id);
    const total = EXHIBIT_REGISTRY.length;
    const index = EXHIBIT_REGISTRY.findIndex((entry) => entry.id === id) + 1;

    this.header.apply({ index, total, en: info.en, jp: info.jp, tagline: info.tagline });
    this.drawer.setContent(`${info.jp} / ${info.en}`, info.explanation);
    this.hud?.setExhibit(index, total);
    this.tabs.setActive(id);
    // perspective の神視点インセットとパネルが重ならないよう、モードを CSS へ伝える
    this.rootEl.dataset.exhibit = id;
  }

  private updateNavState(): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>('#mode-nav [data-mode]')) {
      const active = button.dataset.mode === this.mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-current', active ? 'true' : 'false');
    }
  }

  private toggleDrawer(): void {
    if (this.drawer.isOpen) this.closeDrawer();
    else this.openDrawer();
  }

  private openDrawer(): void {
    this.drawer.show();
    this.aboutButton.setAttribute('aria-expanded', 'true');
    // モバイルではドロワーが全画面シートになり、トップナビと重なる
    document.body.classList.add('drawer-open');
  }

  private closeDrawer(): void {
    if (!this.drawer.isOpen) return;
    // 閉じたあとフォーカスが宙に浮かないよう、**中にいたときだけ**呼び出し元へ返す
    const returning = this.drawerEl.contains(document.activeElement);
    this.drawer.hide();
    this.aboutButton.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('drawer-open');
    if (returning) this.aboutButton.focus({ preventScroll: true });
  }
}

// --- モジュール内ヘルパー ----------------------------------------------------

function requireEl(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLElement)) {
    throw new Error(`DIMENSION: #${id} not found (index.html のギャラリーシェルを確認)`);
  }
  return node;
}

function infoFor(id: string): ExhibitInfo {
  const info = EXHIBIT_INFO.find((entry) => entry.id === id);
  if (info === undefined) throw new Error(`DIMENSION: EXHIBIT_INFO に ${id} がない`);
  return info;
}
