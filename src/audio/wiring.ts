/**
 * wiring.ts — 音と作品をつなぐ唯一の場所(Phase 10)。
 *
 * 方針は「**委譲だけ**」。既存のコンポーネントには一行も足さない ──
 * document 1 枚に張った数個のリスナーと、gallery が投げる CustomEvent、
 * それに engine の毎フレームだけを見る。音を消せば、この経路は
 * 最初の 1 回の真偽判定で全部止まる(OFF のときの仕事はゼロに近い)。
 *
 * ここが知っていること:
 *   ・どの DOM がどの音を持つか(セレクタ表)
 *   ・次元の階を跨いだ瞬間(scrollDirector.dimLevel の床が変わった瞬間)
 *   ・いまの次元が両耳の拍を何 Hz にするか(Phase 12b)
 * ここが知らないこと:
 *   ・音の作り方(sfx.ts)・鳴らしてよいか(engine.ts)
 */

import type { Engine } from '../core/engine';
import type { ScrollDirector } from '../core/scrollDirector';
import { audio } from './engine';
import {
  bell,
  click,
  enterGallery,
  exitGallery,
  hover,
  tab,
  tick,
  toggleOff,
  toggleOn,
} from './sfx';

/**
 * ホバー音を持つ要素。Cursor.ts の HOVER_SELECTOR と同じ考え方で、
 * **意味を持つ要素 + 逃げ道の data-cursor** で拾う。パネルの操作子
 * (.pn-switch / .pn-seg-btn / .pn-range / .gal-tab / .q-opt …)は
 * すべて button か input なので、クラス名を列挙する必要はない。
 */
const HOVER_SELECTOR =
  'a[href], button, summary, [data-cursor],' +
  '[role="button"], [role="switch"], [role="tab"], input[type="range"]';

/** 押した音を持つ要素(タブは dimension:tab が担当するのでここには含めない) */
const CLICK_SELECTOR = 'a[href], button, [role="button"]';
const SWITCH_SELECTOR = '[role="switch"]';
const TAB_SELECTOR = '[role="tab"]';
/** 音チップ自身は自前で確認音を鳴らす(二重に鳴らさない) */
const SELF_SELECTOR = '#sound-chip';

/** 階の判定に足すヒステリシス。境界上での往復チャタリングを避ける */
const FLOOR_HYSTERESIS = 0.02;
/** 鐘のある次元の範囲 */
const BELL_MIN = 1;
const BELL_MAX = 6;
/** 「まだ一度も測っていない」を表す番兵 */
const NOT_PRIMED = -999;

/**
 * 次元 → 両耳の拍(Hz)。**鐘とまったく同じ算術の階段**である。
 *
 * 鐘は次元がひとつ上がるごとに +99Hz(倍音列の次の節)へ移る。同じ足し算を
 * 「高さ」ではなく「拍」に適用したのがこの直線で、傾きは 4/3:
 *
 *     0D → 2.00Hz(δ)   3D → 6.00Hz(θ)   6D → 10.00Hz(α)
 *
 * 低い次元ほど遅く、次元が積み上がるほど速く脈を打つ。効能の話ではない ──
 * 階段を上がるという一本の比喩を、音程に続いて拍でももう一度なぞるだけである。
 */
const BEAT_BASE_HZ = 2;
const BEAT_PER_DIM_HZ = 4 / 3;
/** 階段が張る帯。物語の外(ギャラリー・単独展示)は上端で据え置く */
const BEAT_MIN_HZ = 2;
const BEAT_MAX_HZ = 10;

export interface AudioWiringOptions {
  readonly engine: Engine;
  /** 物語モードが無いブート(?exhibit=…)では null */
  readonly scrollDirector?: ScrollDirector | null;
}

export class AudioWiring {
  private readonly director: ScrollDirector | null;

  /** 直前のフレームの階。毎フレーム作るのは数値だけ */
  private floor = NOT_PRIMED;
  /** body のクラスを毎フレーム読まないためのキャッシュ */
  private narrative: boolean;
  /** 直近にホバー音を出した要素。同じ要素の中の移動では鳴らさない */
  private hovered: Element | null = null;

  /** DEV 検証用: 鳴らした鐘の次元を順に記録する(本番ではそもそも積まない) */
  readonly bells: number[] = [];

  constructor(options: AudioWiringOptions) {
    this.director = options.scrollDirector ?? null;
    this.narrative = !document.body.classList.contains('mode-gallery');

    document.addEventListener('pointerover', this.onPointerOver, {
      capture: true,
      passive: true,
    });
    // クリックは **バブル**で受ける ── 要素自身のハンドラが先に走り終えて
    // いるので、トグルの aria-checked は「押したあとの状態」を指している
    document.addEventListener('click', this.onClick);
    document.addEventListener('input', this.onInput, { passive: true });

    window.addEventListener('dimension:enter-gallery', this.onEnterGallery);
    window.addEventListener('dimension:tab', this.onTab);
    window.addEventListener('dimension:mode', this.onMode);

    // 実ループ。ヘッドレス検証(main.ts の renderOnce)も **同じ step** を叩く
    options.engine.onFrame(this.step);
  }

  destroy(): void {
    document.removeEventListener('pointerover', this.onPointerOver, true);
    document.removeEventListener('click', this.onClick);
    document.removeEventListener('input', this.onInput);
    window.removeEventListener('dimension:enter-gallery', this.onEnterGallery);
    window.removeEventListener('dimension:tab', this.onTab);
    window.removeEventListener('dimension:mode', this.onMode);
  }

  // --- ポインタ --------------------------------------------------------------

  private readonly onPointerOver = (event: Event): void => {
    if (!audio.enabled) return; // OFF のときはここで終わる(closest すら呼ばない)
    const target = event.target;
    if (!(target instanceof Element)) return;

    const hit = target.closest(HOVER_SELECTOR);
    if (hit === null) {
      this.hovered = null;
      return;
    }
    // 同じ操作子の中を動いているあいだは 1 回だけ(子要素を跨ぐたびに鳴らさない)
    if (hit === this.hovered) return;
    this.hovered = hit;
    hover();
  };

  private readonly onClick = (event: Event): void => {
    if (!audio.enabled) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(SELF_SELECTOR) !== null) return;

    // タブは gallery が受理した瞬間(dimension:tab)に鳴らす ── 押しても
    // 切り替わらないことがある(切替中・同じタブ)ので、押下では鳴らさない
    if (target.closest(TAB_SELECTOR) !== null) return;

    const toggle = target.closest(SWITCH_SELECTOR);
    if (toggle !== null) {
      if (toggle.getAttribute('aria-checked') === 'true') toggleOn();
      else toggleOff();
      return;
    }

    if (target.closest(CLICK_SELECTOR) !== null) click();
  };

  /** スライダーのドラッグ。tick() 側が 40ms のレート制限を持つ */
  private readonly onInput = (event: Event): void => {
    if (!audio.enabled) return;
    const target = event.target;
    if (target instanceof HTMLInputElement && target.type === 'range') tick();
  };

  // --- 作品からの合図 --------------------------------------------------------

  /** CTA を押した瞬間(モードが確定する 250ms 前)。押した手応えはここで返す */
  private readonly onEnterGallery = (): void => {
    enterGallery();
  };

  private readonly onTab = (): void => {
    tab();
  };

  /**
   * モードが変わった。CTA 経由の入場は enterGallery() が先に鳴っているので、
   * sfx 側の 500ms のレート制限が二度鳴りを畳む。
   */
  private readonly onMode = (event: Event): void => {
    const detail = (event as CustomEvent<string>).detail;
    this.narrative = detail !== 'gallery';
    if (detail === 'gallery') enterGallery();
    else exitGallery();
  };

  // --- 次元の鐘 --------------------------------------------------------------

  /**
   * 毎フレーム。**アロケーションなし・数値の比較だけ**。
   *
   * ひとつは連続量 ── dimLevel をそのまま拍(Hz)へ写す。書き込みの間引きは
   * 層の側が持っているので、ここは毎フレーム素直に差し出してよい。
   * もうひとつは離散量 ── dimLevel の床が変わった瞬間に鐘を撞く。上りでも
   * 下りでも撞くので、下りると低い倍音が返ってくる(階段を降りている音)。
   *
   * public なのは、rAF が止まるヘッドレス検証から同じ関数を叩けるようにするため
   * (二重に呼ばれても、床が動いていなければ何もしない)。
   */
  readonly step = (): void => {
    const director = this.director;

    // 物語のときだけ次元が拍を決める。ギャラリーと単独展示では上端で据え置く
    audio.setBeat(
      director === null || !this.narrative
        ? BEAT_MAX_HZ
        : clampBeat(BEAT_BASE_HZ + BEAT_PER_DIM_HZ * director.dimLevel),
    );

    if (director === null) return;

    const floor = Math.floor(director.dimLevel + FLOOR_HYSTERESIS);

    // 最初の 1 フレームは「いまの階」を覚えるだけ(読み込み直後に鳴らさない)
    if (this.floor === NOT_PRIMED) {
      this.floor = floor;
      return;
    }
    // 黙っているあいだも階の追従だけは続ける(ON にした瞬間に鳴りださない)
    if (!audio.enabled || !this.narrative) {
      this.floor = floor;
      return;
    }
    if (floor === this.floor) return;

    this.floor = floor;
    const k = floor < BELL_MIN ? BELL_MIN : floor > BELL_MAX ? BELL_MAX : floor;
    bell(k);
    if (import.meta.env.DEV) this.bells.push(k);
  };
}

/** 帯の外へは出さない(章の次元が 0..6 の外へ出ても発振器を壊さない) */
function clampBeat(hz: number): number {
  return hz < BEAT_MIN_HZ ? BEAT_MIN_HZ : hz > BEAT_MAX_HZ ? BEAT_MAX_HZ : hz;
}

/** 唯一の接続口。main.ts がクローム構築後に 1 回だけ呼ぶ */
export function initAudioWiring(options: AudioWiringOptions): AudioWiring {
  return new AudioWiring(options);
}
