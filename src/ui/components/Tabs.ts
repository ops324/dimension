/**
 * Tabs — 展示タブ帯(Phase 9b)。
 *
 * 1 つのタブは 3 段組み: 通し番号(01)/ 英字名 / 日本語名。
 * アクティブを示すのは**タブの下を滑る 2px のグラデーション下線**だけで、
 * タブそのものは色の濃さしか変えない ── 器が光るのではなく、指標が動く。
 * アクティブの番号にだけ「/ 04」が点り、いま何番目を見ているかが数で残る。
 *
 * 下線は Segmented と同じ createSlidingPill を使う(見た目を似せるのではなく、
 * 同じ 1 本のコードを共有する)。FLIP の計測が走るのは選択・リサイズ・
 * フォント適用のときだけで、毎フレームは 1 度も測らない。
 *
 * キーボード: role=tablist の作法どおり ← → で移動、Home / End で両端へ。
 * tabindex は roving(選択中だけ 0)で、Tab キーの一撃で帯を通り抜けられる。
 *
 * 横スクロール(モバイル)では下線もタブと一緒にスクロールする ── 下線は
 * スクロール容器の中の絶対配置なので、位置合わせのための購読は要らない。
 */

import { h, type Component } from './component';
import { magnetize, type Magnet } from './MagneticButton';
import { createSlidingPill, type SlidingPill } from './controls/Segmented';

export interface TabItem {
  readonly id: string;
  /** 英字名(Unbounded) */
  readonly en: string;
  /** 日本語名 */
  readonly jp: string;
}

export interface TabsOptions {
  /** 器。index.html の #gallery-tabs(role=tablist) */
  readonly container: HTMLElement;
  readonly items: readonly TabItem[];
  readonly active: string;
  readonly onSelect: (id: string) => void;
  /** タブが制御するパネルの id(aria-controls / aria-labelledby を結ぶ) */
  readonly panelId?: string;
  /** 選択時に横スクロールを滑らせるか(reduced-motion では false) */
  readonly smoothScroll?: boolean;
}

/** 下線の滑り(ms) */
const SLIDE_MS = 380;
/** 下線をタブの左右から食い込ませる量(px) */
const INSET = 12;

export class Tabs implements Component {
  readonly el: HTMLElement;

  private readonly tabs = new Map<string, HTMLButtonElement>();
  private readonly order: string[] = [];
  private readonly magnets: Magnet[] = [];
  private readonly indicator: SlidingPill;
  private readonly onSelect: (id: string) => void;
  private readonly panelId: string | null;
  private smooth: boolean;
  private activeId: string;

  constructor(options: TabsOptions) {
    this.el = options.container;
    this.onSelect = options.onSelect;
    this.panelId = options.panelId ?? null;
    this.smooth = options.smoothScroll !== false;
    this.activeId = options.active;

    const fragment = document.createDocumentFragment();
    const total = pad(options.items.length);

    for (let i = 0; i < options.items.length; i++) {
      const item = options.items[i];
      const tab = h('button', 'gal-tab', {
        type: 'button',
        role: 'tab',
        id: `gal-tab-${item.id}`,
        'data-cursor': '',
      });
      tab.dataset.exhibit = item.id;
      if (this.panelId !== null) tab.setAttribute('aria-controls', this.panelId);

      const index = h('span', 'gal-tab-idx');
      index.append(
        h('span', 'gal-tab-num', { text: pad(i + 1) }),
        // 「/ 04」は常に存在させる(点滅で幅が動くと下線の幾何が揺れる)
        h('span', 'gal-tab-of', { text: `/${total}` }),
      );

      tab.append(
        index,
        h('span', 'gal-tab-en', { text: item.en }),
        h('span', 'gal-tab-jp', { text: item.jp }),
      );
      tab.addEventListener('click', this.onClick);

      fragment.append(tab);
      this.tabs.set(item.id, tab);
      this.order.push(item.id);
    }

    this.el.replaceChildren(fragment);
    this.el.addEventListener('keydown', this.onKeyDown);

    this.indicator = createSlidingPill(this.el, {
      className: 'gal-tab-ind',
      insetX: INSET,
      duration: SLIDE_MS,
    });

    // 磁力は控えめ(radius 60 / strength 0.2)── 帯の中で寄りすぎない
    for (const tab of this.tabs.values()) {
      this.magnets.push(
        magnetize(tab, {
          radius: 60,
          strength: 0.2,
          max: 5,
          labelMax: 8,
          labelSelector: '.gal-tab-en',
        }),
      );
    }

    this.paint(false);
  }

  /** 外から選択を反映する(gallery.select が受理したときにだけ呼ばれる) */
  setActive(id: string): void {
    if (!this.tabs.has(id)) return;
    const changed = id !== this.activeId;
    this.activeId = id;
    this.paint(changed);
  }

  /** reduced-motion の切替。横スクロールの滑りだけを持つ */
  setSmoothScroll(smooth: boolean): void {
    this.smooth = smooth;
  }

  destroy(): void {
    this.el.removeEventListener('keydown', this.onKeyDown);
    for (const tab of this.tabs.values()) tab.removeEventListener('click', this.onClick);
    for (let i = 0; i < this.magnets.length; i++) this.magnets[i].destroy();
    this.magnets.length = 0;
    this.indicator.destroy();
    this.tabs.clear();
    this.el.replaceChildren();
  }

  // --- 内部 ------------------------------------------------------------------

  private readonly onClick = (event: MouseEvent): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const id = target.dataset.exhibit;
    if (id !== undefined) this.onSelect(id);
  };

  /**
   * ← → で移動、Home / End で両端。フォーカスは即座に移し、選択は
   * gallery へ**要求**する(切替の途中なら断られる ── そのときも
   * フォーカスは動いたままなので、Enter でもう一度頼める)。
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const count = this.order.length;
    if (count === 0) return;
    const from = this.order.indexOf(this.focusedId());
    let next = -1;

    switch (event.key) {
      case 'ArrowLeft':
        next = (from <= 0 ? count : from) - 1;
        break;
      case 'ArrowRight':
        next = from < 0 ? 0 : (from + 1) % count;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = count - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const id = this.order[next];
    /*
      **手動アクティベーション**(Phase 14c)。矢印キーは焦点を移すだけで、
      選択は Enter / Space(button の既定動作 = click)に委ねる。

      それまでは矢印 1 回ごとに onSelect が走っていた ── 展示の入れ替えは
      380ms のシーン再構築を伴うので、4 展示を矢印で通過するだけで
      4 回の再構築が積み上がる(読み上げも 4 回)。WAI-ARIA が
      「タブの切り替えが高コストなときは手動を採る」としているのは、まさにこの形。

      **マウスとタッチの挙動は 1 ミリも変わらない**(click は従来どおり選択する)。
    */
    this.tabs.get(id)?.focus({ preventScroll: true });
  };

  /** いまフォーカスがあるタブ。帯の外にフォーカスがあれば選択中を返す */
  private focusedId(): string {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.dataset.exhibit !== undefined) {
      return active.dataset.exhibit;
    }
    return this.activeId;
  }

  private paint(animate: boolean): void {
    let activeTab: HTMLButtonElement | null = null;
    for (const [id, tab] of this.tabs) {
      const on = id === this.activeId;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      if (on) activeTab = tab;
    }

    this.indicator.moveTo(activeTab, animate);
    if (activeTab === null) return;

    if (this.panelId !== null) {
      document.getElementById(this.panelId)?.setAttribute('aria-labelledby', activeTab.id);
    }

    // モバイルではタブ帯が横スクロールする。選択されたタブを必ず見える位置へ。
    // scrollIntoView は祖先まで巻き込むので、この容器の scrollLeft だけを動かす
    const track = this.el;
    if (track.scrollWidth > track.clientWidth) {
      const left = activeTab.offsetLeft - (track.clientWidth - activeTab.offsetWidth) / 2;
      track.scrollTo({
        left: left > 0 ? left : 0,
        behavior: this.smooth ? 'smooth' : 'auto',
      });
    }
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
