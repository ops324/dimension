import { DetentTrack, buildDetents, type ChapterSpan } from './detents';
import type { ScrollDirector } from './scrollDirector';
import { ScrollGlide, keyIntent, normalizeWheel } from './scrollGlide';
import { thresholdsFor } from '../ui/chapterThresholds';
import type { ChapterRole } from '../ui/content';

/**
 * ホイール / キーボードのスクロールを滑走させる層(Phase 24)。
 *
 * 立て付け:
 * - `wheel` を `passive: false` で受けて **preventDefault し、自分で `scrollTo` を書く**。
 *   ネイティブスクロールの離散的なノッチが、そのまま図形の飛びになっていた。
 * - 書くのは **rAF の中、`scrollDirector.update()` の直前**。同じフレームで
 *   文字(DOM)と図形(WebGL)が同じ scrollY を見るので、両者は原理的にずれない。
 * - **目標に着いている間は 1 バイトも書かない**(`glide.settled`)。タッチの
 *   ネイティブ慣性・スクロールバーのドラッグ・履歴復元は、これまでどおり素通りする。
 * - 外部で位置が動いたら(タッチ・`scrollTo`・ブラウザの復元)、次のフレームで
 *   検出して再同期する ── 「自分が最後に書いた値」と実測の差だけを見る。
 *
 * 触らないもの:
 * - `mode-gallery` の間は完全に沈黙する(ホイールは OrbitControls のドリー)。
 * - `prefers-reduced-motion: reduce` ではリスナーすら張らない。慣性は
 *   この設定が最初に断るものなので、機能を減らすのではなく**元のブラウザへ返す**。
 * - Ctrl/⌘ + ホイールはブラウザのズーム。奪うと拡大できなくなる。
 * - 自前のスクロール領域(ドロワー本文など)の上では preventDefault しない。
 */

/** 実測 scrollY と「自分が最後に書いた値」の差がこれを超えたら外部由来とみなす(px) */
const RESYNC_EPSILON = 2;

/** スクロール上限の測り直し間隔(秒)。scrollHeight の読みは強制同期レイアウトを招く */
const REMEASURE_INTERVAL = 0.5;

/** 祖先をたどってスクロール領域を探す深さの上限 */
const ANCESTOR_LIMIT = 8;

export interface SmoothScroll {
  /** 毎フレーム、**scrollDirector.update() より前に**呼ぶ */
  update(dt: number): void;
  /** 外部が `scrollTo` したあとに呼ぶ(慣性を持ち越さない) */
  sync(): void;
  /** セクション高が変わったとき(resize / fonts.ready)に呼ぶ */
  remeasure(): void;
  /** リスナーを外す */
  dispose(): void;
  /** リスナーが張られているか(reduced-motion では false) */
  readonly enabled: boolean;
}

const viewportHeight = (): number =>
  Math.max(1, window.visualViewport?.height ?? window.innerHeight);

const scrollMax = (): number =>
  Math.max(0, document.documentElement.scrollHeight - viewportHeight());

/**
 * その要素自身か祖先が「自分でスクロールする箱」か。
 * ドロワー本文やタブの帯の上でホイールを奪うと、中身が動かなくなる。
 */
const inNativeScrollArea = (target: EventTarget | null): boolean => {
  let el = target instanceof Element ? target : null;
  for (let i = 0; i < ANCESTOR_LIMIT && el !== null; i++) {
    if (el.scrollHeight - el.clientHeight > 1) {
      const overflow = getComputedStyle(el).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') return true;
    }
    el = el.parentElement;
  }
  return false;
};

/** 物語モードか。ギャラリー中はホイールも矢印も展示のものになる */
const inNarrative = (): boolean => !document.body.classList.contains('mode-gallery');

/** キーボードのスクロールは「どこにもフォーカスが無いとき」だけ引き受ける */
const focusIsIdle = (): boolean => {
  const el = document.activeElement;
  return el === null || el === document.body || el === document.documentElement;
};

/** ページ送りのキー。段があるときは「次の段へ」に読み替える */
const isPageKey = (key: string): boolean =>
  key === 'PageDown' || key === 'PageUp' || key === ' ' || key === 'Spacebar';

export interface SmoothScrollOptions {
  /**
   * 階段(Phase 34e)。**`director` と `roles` が両方揃ったときだけ**働く ──
   * 単独展示ブートやテストでは省略でき、そのとき挙動は Phase 24 のままになる。
   */
  readonly director?: ScrollDirector;
  readonly roles?: readonly ChapterRole[];
}

export const createSmoothScroll = (options: SmoothScrollOptions = {}): SmoothScroll => {
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  const glide = new ScrollGlide();
  glide.setMax(scrollMax());
  glide.reset(window.scrollY);

  const director = options.director ?? null;
  const roles = options.roles ?? null;
  /** 段。無ければ Phase 24 のまま(目標は glide が直に持つ) */
  const track = director !== null && roles !== null ? new DetentTrack() : null;
  track?.reset(window.scrollY);
  /** 段の表を組んだときの実測の版。−1 は「まだ組んでいない」 */
  let detentEpoch = -1;
  /** 使い回す作業配列(入力のたびに 9 個のオブジェクトを作らない) */
  const spans: ChapterSpan[] = [];

  /**
   * 段の表を、**実測が変わっていたら**組み直す。
   * 入力のたびに数の比較 1 回だけ通る ── `remeasure()` の呼び出し点は 6 箇所あり、
   * うち 2 つは `Overlays` の内側なので「呼ばれたら教える」では取りこぼす。
   */
  const refreshDetents = (): void => {
    if (track === null || director === null || roles === null) return;
    if (director.measureEpoch === detentEpoch) return;
    detentEpoch = director.measureEpoch;

    spans.length = 0;
    for (let i = 0; i < roles.length; i++) {
      const th = thresholdsFor(roles[i]);
      spans.push({
        start: director.starts[i],
        lens: director.lens[i],
        inT: th.inT,
        outT: th.outT,
        backOutT: th.backOutT,
        // 序章は「読む位置」の段を持たない(スクラブ長 30svh に粒度が無い)
        hasRead: roles[i] !== 'prologue',
      });
    }
    track.setDetents(buildDetents(spans, director.scrollLimit), director.scrollLimit);
  };

  /** 相対入力。段があれば段が目標を決め、無ければ glide が直に積む */
  const pushInput = (delta: number): void => {
    if (track === null) {
      glide.push(delta);
      return;
    }
    refreshDetents();
    track.push(delta);
    glide.to(track.target);
  };

  /** 絶対入力(Home / End)。**段は素通りする** ── 端へ行けなくなってはいけない */
  const toInput = (y: number): void => {
    if (track === null) {
      glide.to(y);
      return;
    }
    refreshDetents();
    track.to(y);
    glide.to(track.target);
  };

  /** ページ送り。段があるときは「次の段へ」 ── キーボードだけが取り残されない */
  const pageInput = (dir: 1 | -1, delta: number): void => {
    if (track === null) {
      glide.push(delta);
      return;
    }
    refreshDetents();
    track.stepDetent(dir);
    glide.to(track.target);
  };

  /** 外部要因での位置変化。段には吸わせない(読者が置いた位置を動かさない) */
  const resyncTo = (y: number): void => {
    glide.reset(y);
    track?.reset(y);
  };

  /** 自分が最後に書いた位置。実測との差が外部スクロールの検出そのもの */
  let written = window.scrollY;
  /** 前回 scrollMax() を読んでからの経過(秒) */
  let sinceMeasure = 0;

  const remeasure = (): void => {
    glide.setMax(scrollMax());
    // 段の表も組み直す。呼び出し側(main.ts)は scrollDirector.remeasure() を
    // **先に**呼ぶので、ここで読む starts / lens は必ず新しい
    refreshDetents();
    sinceMeasure = 0;
  };

  /** 入力が来た瞬間に、上限が古ければ測り直す(rAF の外なのでレイアウト読みが安全) */
  const measureIfStale = (): void => {
    if (sinceMeasure >= REMEASURE_INTERVAL) remeasure();
  };

  const sync = (): void => {
    resyncTo(window.scrollY);
    written = glide.value;
  };

  const onWheel = (event: WheelEvent): void => {
    if (!inNarrative()) return;
    // ブラウザのズーム(Ctrl/⌘ + ホイール、トラックパッドのピンチ)は奪わない
    if (event.ctrlKey || event.metaKey) return;
    if (event.defaultPrevented) return;
    /*
      キャンセルできないホイールは**ブラウザが既にスクロールを適用済み**という意味。
      ここで delta を積むと、ネイティブの移動量と自分の滑走が二重に効いて
      1 ノッチが 1.1 ノッチぶん進む(実測: CDP の合成ジェスチャで 300px → 335.5px)。
      奪えないものは奪わない ── 素通しさせて、次のフレームの再同期に任せる。
    */
    if (!event.cancelable) return;
    if (inNativeScrollArea(event.target)) return;

    measureIfStale();
    event.preventDefault();
    pushInput(normalizeWheel(event.deltaY, event.deltaMode, viewportHeight()));
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!inNarrative() || event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // ボタンやチップにフォーカスがあるなら、Space はその操作。奪ってはいけない
    if (!focusIsIdle()) return;

    measureIfStale();
    const intent = keyIntent(event.key, event.shiftKey, viewportHeight(), glide.max);
    if (intent === null) return;

    event.preventDefault();
    if (!('delta' in intent)) {
      toInput(intent.to);
    } else if (isPageKey(event.key)) {
      // Space / PageUp / PageDown は「次の段へ」。段が無ければ従来どおり 0.9 画面
      pageInput(intent.delta >= 0 ? 1 : -1, intent.delta);
    } else {
      pushInput(intent.delta);
    }
  };

  if (!reduceMotion) {
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
  }

  return {
    enabled: !reduceMotion,

    update(dt: number): void {
      if (reduceMotion) return;
      sinceMeasure += dt;

      const y = window.scrollY > 0 ? window.scrollY : 0;
      // 外部(タッチ・スクロールバー・scrollTo・ブラウザの復元)が動かした
      if (Math.abs(y - written) > RESYNC_EPSILON) {
        resyncTo(y);
        written = y;
        return;
      }
      // 着いている間は書かない ── ネイティブのスクロールと競合させないための契約
      if (glide.settled) {
        written = y;
        return;
      }
      // ギャラリーへ入ったなど、走行中にモードが変わったら慣性を捨てる
      if (!inNarrative()) {
        resyncTo(y);
        written = y;
        return;
      }

      const next = glide.step(dt);
      window.scrollTo(0, next);
      written = next;
    },

    sync,
    remeasure,

    dispose(): void {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
    },
  };
};
