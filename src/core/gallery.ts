import { Vector3 } from 'three';
import type * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type { Engine } from './engine';
import type { ScrollDirector } from './scrollDirector';
// 型だけの import。verbatimModuleSyntax で消えるので route.ts ⇄ gallery.ts の
// **実行時の循環参照は生じない**(route.ts は EXHIBIT_REGISTRY を値で使う)
import type { Route, Router } from './route';
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
import type { Announcer } from '../ui/components/Announcer';

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
  /** URL と履歴。モードの出入りはすべてここを通る(Phase 13) */
  readonly router: Router;
  /** 展示の切り替えを告げるライブリージョン(Phase 14b)。無くても成立する */
  readonly announcer?: Announcer;
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
  private readonly router: Router;
  private readonly announcer: Announcer | null;

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
  /**
   * 遷移中に届いた popstate を 1 つだけ預かる枠(Phase 13)。
   *
   * enterGallery / exitGallery は `busy` で早期 return し **void を返す**ので、
   * popstate 側は却下を検知できない。`busy` は幕の 40+480+40 = 560ms 続き、
   * iOS の端スワイプ連打はこれより速い。落とすと**履歴インデックスが恒久的にずれる**。
   */
  private pendingRoute: Route | null = null;

  /** カメラトゥイーン(毎フレームのアロケーションを避けるため使い回す) */
  private readonly tweenTarget = new Vector3();
  private tweenTime = 0;
  /**
   * いま構図へ掛かっている縦長ドリー倍率(Phase 12a)。
   * レジストリのホーム姿勢は横長画面で決めた値なので、縦持ちではこの倍率ぶん
   * 引かないと被写体が四辺から溢れる。resize では**前回との比**でカメラを
   * 動かすので、ユーザーが回した向き(方位角・仰角)は一切壊れない。
   */
  private dolly = 1;
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
    this.router = options.router;
    this.announcer = options.announcer ?? null;

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
      // 回転で aspect が変われば必要な引きも変わる。構図のずらし(safe area)より
      // **先に**距離を合わせる ── setViewOffset は距離を知らないので順序は自由だが、
      // 「まず被写体を画面へ収め、それから UI のぶんをずらす」という読み順に揃える
      this.syncDolly();
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

  // --- ルーティング ----------------------------------------------------------

  /**
   * popstate と初期ブートの**唯一の入口**。冪等。
   *
   * enterGallery / exitGallery / select は履歴を一切呼ばない ── 呼ぶのはここと
   * requestEnter だけなので、再帰が構造的に起きない(suppress フラグが要らない)。
   */
  applyRoute(next: Route, instant = false): void {
    // 幕が降りている最中は 1 つだけ預かる。捨てると履歴と画面が永久にずれる
    if (this.busy || this.switchTimer !== 0) {
      this.pendingRoute = next;
      return;
    }
    if (next.mode === 'gallery') {
      if (this.mode !== 'gallery') this.enterGallery(next.exhibit, instant);
      else if (next.exhibit !== this.activeId) this.select(next.exhibit);
    } else if (this.mode === 'gallery') {
      this.exitGallery(next.scrollY);
    }
  }

  /**
   * 入場要求(終章の CTA / トップナビ / skip link)。
   * 状態を先に変えず、**履歴へ書いてから** onRoute 経由で戻ってくる。
   */
  requestEnter(): void {
    if (this.mode === 'gallery' || this.busy) return;
    this.router.enter(this.activeId, window.scrollY);
  }

  /** 遷移が明けたら預かっていたルートを流す */
  private flushRoute(): void {
    const next = this.pendingRoute;
    this.pendingRoute = null;
    if (next !== null) this.applyRoute(next);
  }

  /**
   * 隠しているものを 1 枚だけ戻す。戻すものが無ければ false(= 退場が次)。
   * Esc の順序契約(没入 → ドロワー → 退場)の**解除側だけ**を切り出したもので、
   * keydown と、履歴からの退場要求がこの 1 本を共有する。
   */
  private dismissTop(): boolean {
    if (this.uiHidden) {
      this.setUiHidden(false);
      return true;
    }
    if (this.drawer.isOpen) {
      this.closeDrawer();
      return true;
    }
    return false;
  }

  // --- モード遷移 ------------------------------------------------------------

  /**
   * 物語 → ギャラリー。
   * scrollY を保存し、250ms のフェードの**裏**でシーン・DOM を差し替える。
   *
   * `instant` は深リンク入場専用。幕(.tx = z-index 80)はプリローダ(.pl = 90)の
   * **下**で動くので、そのまま被せると 1.1 秒ぶん「止まったローダー」に見えるだけになる。
   */
  enterGallery(id?: ExhibitId, instant = false): void {
    if (this.mode === 'gallery' || this.busy) return;
    this.busy = true;
    this.savedScrollY = window.scrollY;
    // 深リンクが常に hopf に落ちないよう、幕の前に指定された展示を立てておく
    if (id !== undefined) this.activeId = id;
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
      this.fade(false, undefined, instant);
      console.info(`[gallery] enter → ${this.activeId}`);
      this.flushRoute();
    }, instant);
  }

  /**
   * ギャラリー → 物語。シーンは破棄していないので復帰は即時。
   *
   * `restoreY` は履歴エントリに焼かれた scrollY。ギャラリーに居る状態で
   * リロードすると新しい Gallery の savedScrollY は 0 なので、これが唯一の手がかりになる。
   */
  exitGallery(restoreY: number | null = null): void {
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
      const y = restoreY ?? this.savedScrollY;
      window.scrollTo(0, y);
      this.scrollDirector.remeasure();
      // 章インデックスは変わらないので、これが無いと物語への復帰が無音になる
      this.announcer?.announce('物語へ戻りました');

      this.busy = false;
      this.fade(false);
      console.info(`[gallery] exit → narrative (scrollY=${Math.round(y)})`);
      this.flushRoute();
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
    // URL を今の展示へ揃える。**replaceState なので popstate は起きず**、
    // ここから applyRoute へ戻ってくる経路は無い(だから抑制フラグが要らない)
    this.router.select(id);
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
      this.flushRoute();
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
        // モードの往復は必ず履歴を通す ── UI で出入りしても URL が嘘をつかない
        if (button.dataset.mode === 'gallery') this.requestEnter();
        else this.router.leave();
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
        // 「作品だけを見ていた人が Esc で展示ごと退場させられる」ことになる。
        // 退場だけは履歴を通す ── Esc と戻るが同じ 1 本の階段を降りる
        if (!this.dismissTop()) this.router.leave();
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

  // --- 縦長ドリー ------------------------------------------------------------

  /**
   * 回転/リサイズで変わったアスペクトへ引きを合わせ直す(Phase 12a)。
   *
   * ホーム姿勢を貼り直すのではなく、**前回の倍率との比**でいまの距離を伸縮させる。
   * ユーザーが自分で回して決めた方位角・仰角・寄り具合はそのまま残り、
   * 変わるのは原点からの距離だけ ── 横 → 縦へ回した人にとっては
   * 「見ていたものが画面へ収まり直す」だけの動きになる。
   * トゥイーン中(ホーム復帰の途中)なら行き先も同じ比で連れて行く。
   */
  private syncDolly(): void {
    const next = this.engine.portraitDolly;
    const prev = this.dolly;
    if (next === prev || prev <= 0) return;
    const k = next / prev;
    this.dolly = next;

    const controls = this.ensureControls();
    const entry = this.entries.get(this.activeId);
    if (entry !== undefined) {
      controls.minDistance = entry.minDistance * next;
      controls.maxDistance = entry.maxDistance * next;
    }
    // 注視点からの相対で伸縮する。perspective の構図誘導は target を原点から
    // 動かすことがあるので、原点基準のスカラー倍では純粋なドリーにならない。
    // sub → multiplyScalar → add は Vector3 を 1 つも作らない(既存の器の上で完結)
    const target = controls.target;
    this.engine.camera.position.sub(target).multiplyScalar(k).add(target);
    if (this.tweenTime > 0) this.tweenTarget.multiplyScalar(k);
  }

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
  private fade(on: boolean, done?: () => void, instant = false): void {
    // 幕を張らない経路(深リンク入場)。プリローダの下で 1.1 秒かけて
    // 見えない幕を上げ下げするより、同期で差し替えてしまうほうが速くも正しくもある
    if (instant) {
      done?.();
      return;
    }
    if (on) {
      void this.transition.cover().then(() => done?.());
      return;
    }
    void this.transition.uncover();
    done?.();
  }

  /**
   * カメラのホーム姿勢と距離制限を適用する。instant=true は暗転中の即時適用。
   *
   * Phase 12a: ホーム位置ベクトルと min/maxDistance の**両方**へ縦長ドリーを掛ける。
   * 位置だけ引いて距離制限を据え置くと、maxDistance が新しいホーム距離より手前に
   * 来た瞬間に OrbitControls が次の update() で引き戻し、せっかく収めた構図が
   * また溢れる(hopf: home 距離 8.85 → 14.16 に対し maxDistance 40 は無事だが、
   * polytope は 5.0×1.6=8.0 に対し 20 で余裕がなくなる展示もある)。
   * min も同じ倍率で押し上げないと、寄れる下限だけが相対的に深くなり
   * 「縦持ちのときだけ図形へめり込める」という非対称が生まれる。
   */
  private applyHome(id: ExhibitId, instant: boolean): void {
    const entry = this.entries.get(id);
    const controls = this.ensureControls();
    if (entry === undefined) return;

    const dolly = this.engine.portraitDolly;
    this.dolly = dolly;
    controls.minDistance = entry.minDistance * dolly;
    controls.maxDistance = entry.maxDistance * dolly;
    this.tweenTarget.set(
      entry.home[0] * dolly,
      entry.home[1] * dolly,
      entry.home[2] * dolly,
    );

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
    /*
      読み上げは **info.jp**(日本語名)で告げる ── 日本語の TTS が
      "HOPF FIBRATION" を綴り読みする問題を、ライブリージョンでは最初から避ける。
      タグラインは足さない: 可視テキストであり、SplitText が aria-label と
      .sr-only の複製で原文を保っているので、読み手はすでに到達できる。
    */
    this.announcer?.announce(`展示 ${index} / ${total} ${info.jp}`);
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
