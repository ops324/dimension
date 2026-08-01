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

/** モード遷移のフェード(ms)。prefers-reduced-motion では 0 になる */
const FADE_MS = 250;
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

export class Gallery {
  private readonly engine: Engine;
  private readonly canvas: HTMLCanvasElement;
  private readonly starfield: Starfield;
  private readonly narrative: Exhibit;
  private readonly scrollDirector: ScrollDirector;

  private readonly exhibits = new Map<ExhibitId, Exhibit>();
  private readonly entries = new Map<ExhibitId, ExhibitEntry>();
  private readonly tabs = new Map<ExhibitId, HTMLButtonElement>();

  private readonly rootEl: HTMLElement;
  private readonly tabsEl: HTMLElement;
  private readonly panelRoot: HTMLElement;
  private readonly fadeEl: HTMLElement;
  private readonly drawerEl: HTMLElement;
  private readonly drawerTitleEl: HTMLElement;
  private readonly drawerBodyEl: HTMLElement;
  private readonly headIndexEl: HTMLElement;
  private readonly headEnEl: HTMLElement;
  private readonly headJpEl: HTMLElement;
  private readonly headTaglineEl: HTMLElement;
  private readonly aboutButton: HTMLButtonElement;

  private controls: OrbitControls | null = null;
  private perspective: PerspectiveExhibit | null = null;

  private mode: GalleryMode = 'narrative';
  private activeId: ExhibitId = 'hopf';
  private active: Exhibit | null = null;

  private savedScrollY = 0;
  private busy = false;
  private switchTimer = 0;
  private fadeTimer = 0;
  private reduceMotion = false;

  /** カメラトゥイーン(毎フレームのアロケーションを避けるため使い回す) */
  private readonly tweenTarget = new Vector3();
  private tweenTime = 0;
  /** perspective のカメラ誘導 */
  private readonly hint: CameraHint = { pos: new Vector3(), look: new Vector3() };
  private hintPausedUntil = 0;

  constructor(options: GalleryOptions) {
    this.engine = options.engine;
    this.canvas = options.canvas;
    this.starfield = options.starfield;
    this.narrative = options.narrative;
    this.scrollDirector = options.scrollDirector;

    for (const entry of EXHIBIT_REGISTRY) this.entries.set(entry.id, entry);

    this.rootEl = requireEl('gallery');
    this.tabsEl = requireEl('gallery-tabs');
    this.panelRoot = requireEl('gallery-panel');
    this.fadeEl = requireEl('mode-fade');
    this.drawerEl = requireEl('gallery-drawer');
    this.drawerTitleEl = requireEl('drawer-title');
    this.drawerBodyEl = requireEl('drawer-body');
    this.headIndexEl = requireEl('gallery-index');
    this.headEnEl = requireEl('gallery-en');
    this.headJpEl = requireEl('gallery-jp');
    this.headTaglineEl = requireEl('gallery-tagline');
    this.aboutButton = requireEl('about-toggle') as HTMLButtonElement;

    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (query) {
      this.reduceMotion = query.matches;
      query.addEventListener('change', (event) => {
        this.reduceMotion = event.matches;
      });
    }

    this.buildTabs();
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

      this.busy = false;
      this.fade(false);
      console.info(`[gallery] enter → ${this.activeId}`);
    });
  }

  /** ギャラリー → 物語。シーンは破棄していないので復帰は即時 */
  exitGallery(): void {
    if (this.mode === 'narrative' || this.busy) return;
    this.busy = true;

    this.fade(true, () => {
      // 切替待ちのタイマーが残っていると、物語へ戻ったあとに展示シーンへ
      // 差し替えられてしまう(swap 側でもモードを見ているが、二重に止める)
      if (this.switchTimer !== 0) {
        window.clearTimeout(this.switchTimer);
        this.switchTimer = 0;
      }
      this.closeDrawer();
      this.active?.exit();
      this.active = null;

      this.mode = 'narrative';
      document.body.classList.remove('mode-gallery');
      document.body.classList.add('mode-narrative');
      document.body.style.overflow = '';
      this.rootEl.hidden = true;
      this.updateNavState();

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
    this.updateTabs(id);

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

  private buildTabs(): void {
    const fragment = document.createDocumentFragment();
    for (const entry of EXHIBIT_REGISTRY) {
      const info = infoFor(entry.id);
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'gal-tab';
      tab.dataset.exhibit = entry.id;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', entry.id === this.activeId ? 'true' : 'false');
      tab.classList.toggle('is-active', entry.id === this.activeId);

      const en = document.createElement('span');
      en.className = 'gal-tab-en';
      en.textContent = info.en;
      const jp = document.createElement('span');
      jp.className = 'gal-tab-jp';
      jp.textContent = info.jp;
      tab.append(en, jp);

      tab.addEventListener('click', () => this.select(entry.id));
      fragment.append(tab);
      this.tabs.set(entry.id, tab);
    }
    this.tabsEl.replaceChildren(fragment);
  }

  /** トップナビ・解説トグル・CTA 以外の常設操作をつなぐ */
  private wireChrome(): void {
    this.aboutButton.addEventListener('click', () => this.toggleDrawer());
    document.getElementById('drawer-close')?.addEventListener('click', () => this.closeDrawer());

    for (const button of document.querySelectorAll<HTMLButtonElement>('#mode-nav [data-mode]')) {
      button.addEventListener('click', () => {
        if (button.dataset.mode === 'gallery') this.enterGallery();
        else this.exitGallery();
      });
    }

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.mode === 'gallery') {
        if (this.drawerEl.classList.contains('is-open')) this.closeDrawer();
        else this.exitGallery();
      }
    });
  }

  // --- 内部: 遷移の部品 ------------------------------------------------------

  /**
   * フェードオーバーレイ。reduced-motion では transition が無効なので、
   * 待ち時間も 0 にして「即座に切り替わる」挙動へ揃える。
   */
  private fade(on: boolean, done?: () => void): void {
    if (this.fadeTimer !== 0) {
      window.clearTimeout(this.fadeTimer);
      this.fadeTimer = 0;
    }
    this.fadeEl.classList.toggle('is-on', on);
    if (done === undefined) return;
    this.fadeTimer = window.setTimeout(
      () => {
        this.fadeTimer = 0;
        done();
      },
      this.reduceMotion ? 0 : FADE_MS,
    );
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

  /** ヘッダ・解説ドロワーの中身を差し替える(状態変化時のみの DOM 書き込み) */
  private applyInfo(id: ExhibitId): void {
    const info = infoFor(id);
    const index = EXHIBIT_REGISTRY.findIndex((entry) => entry.id === id);
    this.headIndexEl.textContent = `EXHIBIT ${String(index + 1).padStart(2, '0')}`;
    this.headEnEl.textContent = info.en;
    this.headJpEl.textContent = info.jp;
    this.headTaglineEl.textContent = info.tagline;
    this.drawerTitleEl.textContent = `${info.jp} / ${info.en}`;
    // 解説は content.ts の定数のみ(外部入力は入らない)
    this.drawerBodyEl.innerHTML = info.explanation;
    this.updateTabs(id);
    // perspective の神視点インセットとパネルが重ならないよう、モードを CSS へ伝える
    this.rootEl.dataset.exhibit = id;
  }

  private updateTabs(id: ExhibitId): void {
    let activeTab: HTMLButtonElement | null = null;
    for (const [key, tab] of this.tabs) {
      const active = key === id;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      if (active) activeTab = tab;
    }

    // モバイルではタブ帯が横スクロールする。選択されたタブを必ず見える位置へ。
    // scrollIntoView は祖先まで巻き込むので、この容器の scrollLeft だけを動かす
    const track = this.tabsEl;
    if (activeTab !== null && track.scrollWidth > track.clientWidth) {
      const left = activeTab.offsetLeft - (track.clientWidth - activeTab.offsetWidth) / 2;
      track.scrollTo({
        left: left > 0 ? left : 0,
        behavior: this.reduceMotion ? 'auto' : 'smooth',
      });
    }
  }

  private updateNavState(): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>('#mode-nav [data-mode]')) {
      const active = button.dataset.mode === this.mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-current', active ? 'true' : 'false');
    }
  }

  private toggleDrawer(): void {
    if (this.drawerEl.classList.contains('is-open')) this.closeDrawer();
    else this.openDrawer();
  }

  private openDrawer(): void {
    this.drawerEl.classList.add('is-open');
    this.drawerEl.setAttribute('aria-hidden', 'false');
    this.aboutButton.setAttribute('aria-expanded', 'true');
    // モバイルではドロワーが全画面シートになり、トップナビと重なる
    document.body.classList.add('drawer-open');
  }

  private closeDrawer(): void {
    this.drawerEl.classList.remove('is-open');
    this.drawerEl.setAttribute('aria-hidden', 'true');
    this.aboutButton.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('drawer-open');
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
