/**
 * 重力レンズドライバ(Phase 17)── カーソルの下で時空が歪む。
 *
 * ポインタ位置を追いかけて postfx.setLens() を毎フレーム駆動する、それだけの
 * 小さな部品。歪みの実体は GradePass のシェーダー側(postfx.ts の LENS_* 定数)
 * にあり、ここは「どこに・どれだけ」を運ぶ配線に徹する。
 *
 * 実装上の約束:
 * - Cursor と同じ環境ゲート: `(pointer: fine)` かつ `(hover: hover)` かつ
 *   reduced-motion でないときだけ作る。作らなければ uLens.z は 0 のままで、
 *   シェーダーのレンズ節は uniform 分岐ごとスキップされる(コストゼロ)。
 * - 位置はリング(10/s)より重い 7/s で追う ── 質量が遅れて付いてくる感じ。
 *   強さは入 3.5/s で滲み出て、ポインタがウィンドウを離れたら同じ率で消える。
 * - engine.onFrame に購読解除は無いので、このドライバはページと同寿命。
 *   毎フレームの新規アロケーションなし。
 */

import type { Engine } from '../core/engine';
import { prefersReducedMotion } from './components/component';

/** 位置の追従レート(1/s)。1 - exp(-rate·dt) で寄せる */
const POS_RATE = 7;
/** 強さのフェードレート(1/s) */
const AMOUNT_RATE = 3.5;
/** これ以下の強さは 0 とみなして uniform を眠らせる */
const SLEEP_EPS = 0.001;

export class LensDriver {
  /** ポインタの生位置(CSS px) */
  private px = 0;
  private py = 0;
  /** イージング後の位置(CSS px) */
  private ex = 0;
  private ey = 0;

  private targetAmount = 0;
  private amount = 0;
  /** 一度でもポインタを見たか(初回は位置をスナップする) */
  private seen = false;
  /** 眠っている(= uniform が 0 で安定している)か。無移動時の setLens を省く */
  private asleep = true;

  constructor(private readonly engine: Engine) {
    window.addEventListener('pointermove', this.onMove, { passive: true });
    window.addEventListener('pointerout', this.onOut, { passive: true });
    window.addEventListener('blur', this.onLeave);
    engine.onFrame(this.tick);
  }

  private readonly onMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    this.px = event.clientX;
    this.py = event.clientY;
    if (!this.seen) {
      this.seen = true;
      this.ex = this.px;
      this.ey = this.py;
    }
    this.targetAmount = 1;
  };

  /** relatedTarget が null = ポインタがウィンドウの外へ出た(Cursor と同じ判定) */
  private readonly onOut = (event: PointerEvent): void => {
    if (event.relatedTarget === null) this.onLeave();
  };

  private readonly onLeave = (): void => {
    this.targetAmount = 0;
  };

  private readonly tick = (dt: number): void => {
    if (!this.seen) return;

    const kp = 1 - Math.exp(-POS_RATE * dt);
    this.ex += (this.px - this.ex) * kp;
    this.ey += (this.py - this.ey) * kp;

    const ka = 1 - Math.exp(-AMOUNT_RATE * dt);
    this.amount += (this.targetAmount - this.amount) * ka;

    if (this.amount < SLEEP_EPS && this.targetAmount === 0) {
      // 消え切った瞬間に一度だけ 0 を書き、以後は黙る(シェーダー分岐も眠る)
      if (!this.asleep) {
        this.asleep = true;
        this.amount = 0;
        this.engine.postfx.setLens(0.5, 0.5, 0);
      }
      return;
    }
    this.asleep = false;

    // CSS px → UV(左下原点)。エンジンと同じく visualViewport の実高さを優先する
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, Math.floor(window.visualViewport?.height ?? window.innerHeight));
    this.engine.postfx.setLens(this.ex / width, 1 - this.ey / height, this.amount);
  };
}

/**
 * 環境を見てドライバを作る。作らない条件では **null** を返し、
 * uLens は初期値 (0.5, 0.5, 0) のまま ── シェーダーは恒等で回り続ける。
 */
export function createLensDriver(engine: Engine): LensDriver | null {
  if (prefersReducedMotion()) return null;
  if (typeof window.matchMedia !== 'function') return null;
  if (!window.matchMedia('(pointer: fine)').matches) return null;
  if (!window.matchMedia('(hover: hover)').matches) return null;
  return new LensDriver(engine);
}
