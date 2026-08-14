/**
 * RotationReadout — 回転の計器(Phase 21)。
 *
 * 物語の図形は毎フレーム 6 枚の平面で回っているが、その角度はどこにも出て
 * いなかった。ここはその数値だけを置く場所で、次元の読み(「4.00 D TESSERACT」)
 * の右へ横一列に並べ、下辺をひと続きの計器の帯にする。
 *
 * **項は消えない。** 開いていない平面も薄いまま残す ── 出没させるとレイアウトが
 * 跳ねるうえ、「まだ開いていない平面がある」という構造そのものが見えなくなる。
 * 逆にスクロールを戻すと、閉じた平面の角度が 000.0° へ巻き戻ってから薄くなる ──
 * 次元を降りると回転もほどける、というシーン側の振る舞いがそのまま読める。
 *
 * 書き込みの規律は Hud と同じで、**量子化した値が変わったときだけ** DOM を触る。
 * 0.1° 刻みなので、回っている行は毎フレーム変わる(それが計器の仕事)が、
 * 止まっている行とプラトーの行は完全に黙る。
 */

import { h, type Component } from './component';

/** 表示する行の定義(シーン側の ROTATION_PLANES から綴りだけを受け取る) */
export interface ReadoutPlane {
  readonly label: string;
}

/** 「回っている」と見なす角速度(rad/s)。ゲートが閉じきった平面は 0 になる */
const OMEGA_EPS = 1e-3;
/** 角速度が 0 でも、まだ巻き戻り切っていない角度は点灯を保つ(0.1° 刻みの 5 倍) */
const ANGLE_EPS_DECI = 5;

const RAD_TO_DECIDEG = (180 / Math.PI) * 10;
/** 0.1° 刻みでの一周 */
const FULL_TURN_DECI = 3600;

export class RotationReadout implements Component {
  readonly el: HTMLElement;

  private readonly rows: HTMLElement[] = [];
  private readonly values: HTMLElement[] = [];
  /** 直近に書いた 0.1° 刻みの値。-1 は「まだ一度も書いていない」 */
  private readonly lastDeci: Int32Array;
  /** 直近の点灯状態。0/1、255 は未初期化 */
  private readonly lastLit: Uint8Array;

  constructor(root: HTMLElement, planes: readonly ReadoutPlane[]) {
    const box = h('div', 'hud-rot');

    for (const plane of planes) {
      const row = h('span', 'hud-rot-row');
      const value = h('span', 'hud-rot-deg', { text: '000.0°' });
      row.append(h('span', 'hud-rot-plane', { text: plane.label }), value);
      box.append(row);
      this.rows.push(row);
      this.values.push(value);
    }

    this.lastDeci = new Int32Array(planes.length).fill(-1);
    this.lastLit = new Uint8Array(planes.length).fill(255);

    root.append(box);
    this.el = box;
  }

  /**
   * 角度(rad)と角速度(rad/s)を受け取って書き換える。
   * 配列はシーンが使い回しているので、ここで保持はしない。
   */
  update(angles: Float64Array, omegas: Float64Array): void {
    for (let r = 0; r < this.values.length; r++) {
      // 0.1° 刻みへ量子化してから [0, 360) へ畳む。畳んでから丸めると
      // 359.95° が 360.0° になり、幅が 1 桁増えて数字が横へ跳ねる。
      let deci = Math.round(angles[r] * RAD_TO_DECIDEG) % FULL_TURN_DECI;
      if (deci < 0) deci += FULL_TURN_DECI;

      if (deci !== this.lastDeci[r]) {
        this.lastDeci[r] = deci;
        this.values[r].textContent = formatDeci(deci);
      }

      // 「動いている」か「まだ戻りきっていない」なら点灯
      const turn = deci > FULL_TURN_DECI / 2 ? FULL_TURN_DECI - deci : deci;
      const lit = omegas[r] > OMEGA_EPS || turn > ANGLE_EPS_DECI ? 1 : 0;
      if (lit !== this.lastLit[r]) {
        this.lastLit[r] = lit;
        this.rows[r].classList.toggle('is-lit', lit === 1);
      }
    }
  }

  destroy(): void {
    this.el.remove();
  }
}

/**
 * 下辺の計器の帯があれば計器を足す。単独展示ブート(?exhibit=…)では #hud ごと
 * 落としてあるので、無いことは異常ではない(Hud と同じ判断)。
 */
export function createRotationReadout(planes: readonly ReadoutPlane[]): RotationReadout | null {
  const band = document.querySelector('#hud .hud-band');
  return band instanceof HTMLElement ? new RotationReadout(band, planes) : null;
}

/** 0.1° 刻みの整数 → 「031.4°」。整数部は 3 桁固定で、桁が増えても横へ動かない */
function formatDeci(deci: number): string {
  const whole = (deci / 10) | 0;
  const frac = deci - whole * 10;
  return `${String(whole).padStart(3, '0')}.${frac}°`;
}
