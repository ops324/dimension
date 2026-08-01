/**
 * 自作グラスパネル部品(プラン8節)。
 *
 * lil-gui は「デモ感」が出るため不採用 ── ここにあるのは range / segmented /
 * toggle / readout / button / divider / note の 7 種だけで、見た目は style.css の
 * `.panel` 以下が持つ。ラベルは日本語 + 英字アクセント(例:「FIBERS / ファイバー数」)。
 *
 * 設計の約束:
 * - **DOM 書き込みは状態が変わったときだけ**。readout の更新関数は前回値と比較して
 *   同じなら何もしない(毎フレーム呼ばれても DOM を触らない)。
 * - 生成後に外から状態を変えたい部品には `key` を付ける。以後 `setValue` /
 *   `setDisabled` / `setOptionDisabled` で参照できる(ω₂ の無効化など)。
 * - モバイルのボトムシート開閉は **root(呼び出し側が持つ永続コンテナ)** の
 *   `is-collapsed` クラスで表現する。パネル本体はタブ切替のたびに作り直されるため、
 *   開閉状態は作り直されない側に置く。
 */

export interface SliderSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** 値表示の整形。既定は String(v) */
  format?: (value: number) => string;
  onInput: (value: number) => void;
  key?: string;
  disabled?: boolean;
}

export interface SegmentedSpec {
  label: string;
  /** [値, 日本語ラベル] の並び */
  options: readonly (readonly [string, string])[];
  value: string;
  onSelect: (value: string) => void;
  key?: string;
}

export interface ToggleSpec {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  key?: string;
}

export interface ButtonSpec {
  label: string;
  onClick: () => void;
  key?: string;
}

export interface ReadoutSpec {
  label: string;
  value?: string;
}

/** readout の更新関数。同じ文字列なら DOM を触らない */
export type ReadoutUpdate = (value: string) => void;

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
}

type ControlKind = 'slider' | 'segmented' | 'toggle' | 'button';

interface Control {
  readonly kind: ControlKind;
  readonly row: HTMLElement;
  readonly input?: HTMLInputElement;
  readonly switchEl?: HTMLButtonElement;
  readonly buttons?: Map<string, HTMLButtonElement>;
  readonly valueEl?: HTMLElement;
  readonly format?: (value: number) => string;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** range の塗り分け。CSS 側は --fill を境に 2 色のグラデーションを引く */
function applyFill(input: HTMLInputElement): void {
  const min = Number(input.min);
  const max = Number(input.max);
  const span = max - min;
  const t = span > 0 ? (Number(input.value) - min) / span : 0;
  input.style.setProperty('--fill', `${(t * 100).toFixed(2)}%`);
}

class Panel implements PanelBuilder {
  readonly root: HTMLElement;
  readonly element: HTMLElement;

  private readonly body: HTMLElement;
  private readonly controls = new Map<string, Control>();

  constructor(root: HTMLElement, title: string) {
    this.root = root;
    root.replaceChildren();

    const panel = el('div', 'panel');

    // ヘッダ = モバイルではボトムシートのつまみ(グラブハンドル)を兼ねる
    const head = el('div', 'panel-head');
    const grab = el('button', 'panel-grab');
    grab.type = 'button';
    grab.setAttribute('aria-label', '操作パネルの開閉');
    grab.append(el('span', 'panel-grab-bar'));
    grab.addEventListener('click', () => {
      const collapsed = root.classList.toggle('is-collapsed');
      grab.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
    grab.setAttribute('aria-expanded', root.classList.contains('is-collapsed') ? 'false' : 'true');

    head.append(el('h3', 'panel-title', title), grab);

    this.body = el('div', 'panel-body');
    panel.append(head, this.body);
    root.append(panel);

    this.element = panel;
  }

  slider(spec: SliderSpec): PanelBuilder {
    const row = el('div', 'pn-row pn-row-slider');
    const head = el('div', 'pn-head');
    const label = el('span', 'pn-label', spec.label);
    const format = spec.format ?? ((v: number): string => String(v));
    const valueEl = el('span', 'pn-value', format(spec.value));
    head.append(label, valueEl);

    const input = el('input', 'pn-range');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(spec.value);
    input.setAttribute('aria-label', spec.label);
    applyFill(input);

    input.addEventListener('input', () => {
      const v = Number(input.value);
      applyFill(input);
      valueEl.textContent = format(v);
      spec.onInput(v);
    });

    row.append(head, input);
    this.body.append(row);

    const control: Control = { kind: 'slider', row, input, valueEl, format };
    this.register(spec.key, control);
    if (spec.disabled === true) setControlDisabled(control, true);
    return this;
  }

  segmented(spec: SegmentedSpec): PanelBuilder {
    const row = el('div', 'pn-row pn-row-seg');
    row.append(el('span', 'pn-label', spec.label));

    const track = el('div', 'pn-seg');
    track.setAttribute('role', 'group');
    track.setAttribute('aria-label', spec.label);

    const buttons = new Map<string, HTMLButtonElement>();
    for (const [value, jp] of spec.options) {
      const button = el('button', 'pn-seg-btn');
      button.type = 'button';
      button.dataset.value = value;
      button.textContent = jp;
      button.setAttribute('aria-pressed', value === spec.value ? 'true' : 'false');
      if (value === spec.value) button.classList.add('is-active');
      button.addEventListener('click', () => {
        if (button.disabled) return;
        this.applySegmentValue(buttons, value);
        spec.onSelect(value);
      });
      track.append(button);
      buttons.set(value, button);
    }

    row.append(track);
    this.body.append(row);
    this.register(spec.key, { kind: 'segmented', row, buttons });
    return this;
  }

  toggle(spec: ToggleSpec): PanelBuilder {
    const row = el('div', 'pn-row pn-row-toggle');
    const label = el('span', 'pn-label', spec.label);

    const switchEl = el('button', 'pn-switch');
    switchEl.type = 'button';
    switchEl.setAttribute('role', 'switch');
    switchEl.setAttribute('aria-label', spec.label);
    switchEl.setAttribute('aria-checked', spec.value ? 'true' : 'false');
    switchEl.classList.toggle('is-on', spec.value);
    switchEl.append(el('span', 'pn-switch-knob'));

    switchEl.addEventListener('click', () => {
      if (switchEl.disabled) return;
      const next = switchEl.getAttribute('aria-checked') !== 'true';
      switchEl.setAttribute('aria-checked', next ? 'true' : 'false');
      switchEl.classList.toggle('is-on', next);
      spec.onChange(next);
    });

    row.append(label, switchEl);
    this.body.append(row);
    this.register(spec.key, { kind: 'toggle', row, switchEl });
    return this;
  }

  readout(spec: ReadoutSpec): ReadoutUpdate {
    const row = el('div', 'pn-row pn-row-readout');
    const valueEl = el('span', 'pn-readout-value', spec.value ?? '—');
    row.append(el('span', 'pn-label', spec.label), valueEl);
    this.body.append(row);

    let last = valueEl.textContent ?? '';
    return (value: string): void => {
      if (value === last) return;
      last = value;
      valueEl.textContent = value;
    };
  }

  button(spec: ButtonSpec): PanelBuilder {
    const row = el('div', 'pn-row pn-row-button');
    const button = el('button', 'pn-button');
    button.type = 'button';
    button.textContent = spec.label;
    button.addEventListener('click', () => {
      if (!button.disabled) spec.onClick();
    });
    row.append(button);
    this.body.append(row);
    this.register(spec.key, { kind: 'button', row, buttons: new Map([['', button]]) });
    return this;
  }

  divider(): PanelBuilder {
    const rule = el('div', 'pn-divider');
    rule.setAttribute('aria-hidden', 'true');
    this.body.append(rule);
    return this;
  }

  note(text: string): PanelBuilder {
    this.body.append(el('p', 'pn-note', text));
    return this;
  }

  setDisabled(key: string, disabled: boolean): void {
    const control = this.controls.get(key);
    if (control !== undefined) setControlDisabled(control, disabled);
  }

  setValue(key: string, value: number | string | boolean): void {
    const control = this.controls.get(key);
    if (control === undefined) return;

    if (control.kind === 'slider' && control.input !== undefined) {
      const v = Number(value);
      if (Number(control.input.value) === v) return;
      control.input.value = String(v);
      applyFill(control.input);
      if (control.valueEl !== undefined && control.format !== undefined) {
        control.valueEl.textContent = control.format(v);
      }
      return;
    }

    if (control.kind === 'segmented' && control.buttons !== undefined) {
      this.applySegmentValue(control.buttons, String(value));
      return;
    }

    if (control.kind === 'toggle' && control.switchEl !== undefined) {
      const on = value === true;
      control.switchEl.setAttribute('aria-checked', on ? 'true' : 'false');
      control.switchEl.classList.toggle('is-on', on);
    }
  }

  setOptionDisabled(key: string, option: string, disabled: boolean): void {
    const button = this.controls.get(key)?.buttons?.get(option);
    if (button === undefined) return;
    button.disabled = disabled;
    button.classList.toggle('is-disabled', disabled);
  }

  // --- 内部 ------------------------------------------------------------------

  private register(key: string | undefined, control: Control): void {
    if (key !== undefined) this.controls.set(key, control);
  }

  private applySegmentValue(buttons: Map<string, HTMLButtonElement>, value: string): void {
    for (const [key, button] of buttons) {
      const active = key === value;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }
}

function setControlDisabled(control: Control, disabled: boolean): void {
  control.row.classList.toggle('is-disabled', disabled);
  if (control.input !== undefined) control.input.disabled = disabled;
  if (control.switchEl !== undefined) control.switchEl.disabled = disabled;
  if (control.buttons !== undefined) {
    for (const button of control.buttons.values()) button.disabled = disabled;
  }
}

/**
 * `root` の中身を作り直してグラスパネルを組み立てる。
 * 展示の `buildPanel(root)` から呼ぶ想定(タブ切替のたびに作り直される)。
 */
export function createPanel(root: HTMLElement, title: string): PanelBuilder {
  return new Panel(root, title);
}
