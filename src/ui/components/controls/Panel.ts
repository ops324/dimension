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
 */

import { h, type Component } from '../component';
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

class Panel implements PanelBuilder, Component {
  readonly root: HTMLElement;
  readonly element: HTMLElement;
  /** Component 契約の代表要素 */
  get el(): HTMLElement {
    return this.element;
  }

  private readonly body: HTMLElement;
  private readonly grab: HTMLButtonElement;
  private readonly keyed = new Map<string, PanelControl>();
  private readonly all: Component[] = [];

  constructor(root: HTMLElement, title: string) {
    this.root = root;
    root.replaceChildren();

    const panel = h('div', 'panel');

    // ヘッダ = モバイルではボトムシートのつまみ(グラブハンドル)を兼ねる
    const head = h('div', 'panel-head');
    const kicker = h('div', 'panel-kicker');
    kicker.append(
      h('span', 'panel-tick', { 'aria-hidden': 'true' }),
      h('span', 'panel-kicker-text', { text: 'PARAMETERS' }),
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

    this.body = h('div', 'panel-body');
    panel.append(head, this.body);
    root.append(panel);

    this.element = panel;

    LIVE.get(root)?.destroy();
    LIVE.set(root, this);
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
  };

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
