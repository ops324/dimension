import { Vector2 } from 'three';

import type { Engine } from './engine';
import type { Starfield } from '../render/starfield';

/**
 * 品質ティアと AUTO 制御(プラン5節「AUTO品質制御」/ 既知の罠 #12)。
 *
 * 方針は二段構え:
 *  ① **エスカレーション起動** — いきなり最大では立ち上げない。HIGH(DPR2/MSAA4)で
 *     起動し、最初の 60 フレームの平均フレーム時間が 10ms を切っていれば ULTRA
 *     (DPR3/MSAA8/フル解像度ブルーム)へ昇格する。逆順(最大で起動→降格)は
 *     初回体験のカクつきと弱 GPU でのコンテキストロストを招くため採らない。
 *  ② **ガバナ** — 以後は 60 フレーム窓の平均を見張り、18ms 超が 2 窓続いたら
 *     1 段だけ降格する。**降格後の自動昇格はしない**(ヒステリシス)。上がるのは
 *     起動時のエスカレーション 1 回だけで、これがフリッカ(昇降の往復)を構造的に防ぐ。
 *
 * 判定は fps ではなく**フレーム時間**で行う。120Hz ProMotion 環境では 60fps でも
 * 「1 フレーム 8.3ms」であり、fps 閾値では正常な環境を誤って降格させてしまう。
 */

export type QualityTier = 'BALANCED' | 'HIGH' | 'ULTRA';
/** AUTO はガバナに委ねる。ティア名を選ぶと固定され、ガバナは黙る */
export type QualityMode = 'AUTO' | QualityTier;

export interface QualityDetail {
  readonly tier: QualityTier;
  /** 密度スケール(星・任意で展示側のファイバー数) */
  readonly density: number;
}

interface TierSpec {
  /** devicePixelRatio の上限 */
  readonly dprCap: number;
  /** MSAA サンプル数(GPU の maxSamples で engine がクランプする) */
  readonly samples: number;
  /** ブルーム内部解像度スケール。1 = drawingBuffer 等倍(mip 内部は 1/2) */
  readonly bloomScale: number;
  /** 星・ファイバーの密度スケール */
  readonly density: number;
}

const TIERS: Readonly<Record<QualityTier, TierSpec>> = {
  BALANCED: { dprCap: 1.5, samples: 2, bloomScale: 0.5, density: 0.5 },
  HIGH: { dprCap: 2, samples: 4, bloomScale: 0.5, density: 1 },
  ULTRA: { dprCap: 3, samples: 8, bloomScale: 1, density: 1 },
};

/** 降格のはしご(低 → 高)。自動で右へ進むのは起動時の 1 回だけ */
const LADDER: readonly QualityTier[] = ['BALANCED', 'HIGH', 'ULTRA'];

/** セレクタに並べる順(既定の AUTO が先頭) */
const MODES: readonly QualityMode[] = ['AUTO', 'ULTRA', 'HIGH', 'BALANCED'];

/** 判定窓のフレーム数 */
const WINDOW = 60;
/** この平均フレーム時間を切っていれば ULTRA へ昇格(120Hz なら 8.3ms) */
const ESCALATE_MS = 10;
/** ガバナの降格閾値 */
const DOWNGRADE_MS = 18;
/** 起動窓がこれを超えていたら HIGH ですら重い → 即 BALANCED */
const BOOT_BAD_MS = 22;
/** 降格に必要な連続窓数 */
const BAD_WINDOWS = 2;

export interface QualityOptions {
  readonly engine: Engine;
  readonly starfield: Starfield;
}

export class QualityController {
  private readonly engine: Engine;
  private readonly starfield: Starfield;

  private mode: QualityMode = 'AUTO';
  private tier: QualityTier = 'HIGH';

  /** フレーム時間のリングバッファ(ms)。毎フレームのアロケーションを避ける唯一の器 */
  private readonly ring = new Float64Array(WINDOW);
  private ringIndex = 0;
  private ringFilled = 0;
  private ringSum = 0;
  private sinceCheck = 0;
  /** 起動エスカレーションの判定が済んだか(以後は降格しかしない) */
  private booted = false;
  private badWindows = 0;
  private flooredLogged = false;

  /** 表示更新用。文字列は変化時にだけ組み立てる(毎フレームは触らない) */
  private readonly bufferSize = new Vector2();
  private lastReadout = '';
  private lastChipLabel = '';

  private readonly rootEl: HTMLElement;
  private readonly chipEl: HTMLButtonElement;
  private readonly readoutEl: HTMLElement;
  private readonly optionEls = new Map<QualityMode, HTMLButtonElement>();

  constructor(options: QualityOptions) {
    this.engine = options.engine;
    this.starfield = options.starfield;

    const ui = this.buildUI();
    this.rootEl = ui.root;
    this.chipEl = ui.chip;
    this.readoutEl = ui.readout;

    // 起動ティアを明示的に一度流す(engine の初期値と同じでも、ブルーム倍率と
    // 星密度、そして drawingBuffer のログをここで確定させたい)
    this.apply('HIGH');

    this.engine.onFrame(this.sampleFrame);
    this.engine.onResize(() => this.refreshReadout());

    // 可視性が変わった瞬間をまたいだ窓は捨てる。バックグラウンド/遮蔽状態の
    // ブラウザは rAF を間引くため、そのフレーム時間(engine が 50ms へクランプ)を
    // 混ぜると「重い環境」と誤判定して不可逆に降格してしまう ── 実測で踏んだ罠。
    document.addEventListener('visibilitychange', this.resetWindow);
  }

  /** 現在の実効ティア */
  get currentTier(): QualityTier {
    return this.tier;
  }

  /** AUTO か、手動固定されたティア名 */
  get currentMode(): QualityMode {
    return this.mode;
  }

  /**
   * 手動選択。ティアを選ぶと固定され、ガバナは黙る。
   * AUTO へ戻してもティアは戻さない ── 自動で上がるのは起動時の 1 回だけ、
   * という原則をここでも守る(ユーザーが明示的にティアを選べば当然上がる)。
   */
  setMode(mode: QualityMode): void {
    if (mode === this.mode && mode === 'AUTO') return;
    this.mode = mode;
    this.badWindows = 0;
    this.flooredLogged = false;
    if (mode !== 'AUTO') {
      this.booted = true; // 起動窓の途中で選ばれたらエスカレーションは打ち切る
      this.apply(mode);
      console.info(`[quality] pinned to ${mode} (governor off)`);
    } else {
      console.info(`[quality] AUTO (governor on, tier=${this.tier})`);
    }
    this.refreshChip();
  }

  // --- 計測 ------------------------------------------------------------------

  /**
   * engine のフレームコールバック。dt は engine 側で 50ms にクランプ済み。
   * 非表示タブでは rAF が絞られて巨大な dt になるので、そもそも標本に入れない。
   */
  private readonly sampleFrame = (dt: number): void => {
    if (document.hidden) return;

    const ms = dt * 1000;
    this.ringSum += ms - this.ring[this.ringIndex];
    this.ring[this.ringIndex] = ms;
    this.ringIndex = this.ringIndex === WINDOW - 1 ? 0 : this.ringIndex + 1;

    if (this.ringFilled < WINDOW) {
      this.ringFilled++;
      if (this.ringFilled < WINDOW) return; // 窓が埋まるまでは判定しない
    } else {
      this.sinceCheck++;
      if (this.sinceCheck < WINDOW) return;
    }
    this.sinceCheck = 0;
    this.evaluate(this.ringSum / WINDOW);
  };

  /** 計測窓を捨てて測り直す(可視性の変化時・ティア適用時) */
  private readonly resetWindow = (): void => {
    this.ring.fill(0);
    this.ringIndex = 0;
    this.ringFilled = 0;
    this.ringSum = 0;
    this.sinceCheck = 0;
    this.badWindows = 0;
  };

  private evaluate(avg: number): void {
    if (!this.booted) {
      this.booted = true;
      if (this.mode !== 'AUTO') return;
      if (avg < ESCALATE_MS) {
        this.apply('ULTRA');
        console.info(`[quality] escalated to ULTRA (avg ${avg.toFixed(1)}ms)`);
      } else if (avg > BOOT_BAD_MS) {
        this.apply('BALANCED');
        console.info(`[quality] boot window too slow (avg ${avg.toFixed(1)}ms) → BALANCED`);
      } else {
        console.info(`[quality] staying at HIGH (avg ${avg.toFixed(1)}ms)`);
      }
      return;
    }

    if (this.mode !== 'AUTO') return;

    if (avg <= DOWNGRADE_MS) {
      this.badWindows = 0;
      return;
    }
    this.badWindows++;
    if (this.badWindows < BAD_WINDOWS) return;
    this.badWindows = 0;

    const index = LADDER.indexOf(this.tier);
    if (index <= 0) {
      if (!this.flooredLogged) {
        this.flooredLogged = true;
        console.info(`[quality] governor: avg ${avg.toFixed(1)}ms but already at BALANCED`);
      }
      return;
    }
    const next = LADDER[index - 1];
    this.apply(next);
    console.info(
      `[quality] governor: avg ${avg.toFixed(1)}ms over ${BAD_WINDOWS} windows → ${next}`,
    );
  }

  // --- 適用 ------------------------------------------------------------------

  private apply(tier: QualityTier): void {
    const spec = TIERS[tier];
    this.tier = tier;
    // 直前の窓は「別のティアの」フレーム時間。次の判定は新しいティアで測り直す
    this.resetWindow();

    this.engine.setQuality({ samples: spec.samples, dpr: spec.dprCap });
    this.engine.postfx.setBloomScale(spec.bloomScale);
    this.starfield.setDensity(spec.density);

    // 展示側が**任意で**購読できる緩い口。誰も聞いていなくても成立する設計にしておく
    // (ハードワイヤしない ── 展示はティアを知らなくても正しく動く)
    const detail: QualityDetail = { tier, density: spec.density };
    window.dispatchEvent(new CustomEvent<QualityDetail>('dimension:quality', { detail }));

    this.refreshChip();
    this.refreshReadout();

    this.engine.getDrawingBufferSize(this.bufferSize);
    console.info(
      `[quality] tier=${tier} dpr=${this.engine.renderer.getPixelRatio()} ` +
        `samples=${this.engine.postfx.samples} bloom=×${spec.bloomScale} ` +
        `buffer=${this.bufferSize.x}×${this.bufferSize.y}`,
    );
  }

  // --- UI --------------------------------------------------------------------

  private buildUI(): { root: HTMLElement; chip: HTMLButtonElement; readout: HTMLElement } {
    let root = document.getElementById('quality');
    if (!(root instanceof HTMLElement)) {
      root = document.createElement('div');
      root.id = 'quality';
      document.body.append(root);
    }
    root.dataset.open = 'false';

    const readout = document.createElement('p');
    readout.className = 'q-readout';
    readout.id = 'quality-readout';

    const opts = document.createElement('div');
    opts.className = 'q-opts';
    opts.id = 'quality-menu';
    for (const mode of MODES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'q-opt';
      button.textContent = mode;
      button.setAttribute('aria-pressed', mode === this.mode ? 'true' : 'false');
      button.addEventListener('click', () => {
        this.setMode(mode);
        this.setOpen(false);
      });
      opts.append(button);
      this.optionEls.set(mode, button);
    }

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'q-chip';
    chip.id = 'quality-chip';
    chip.setAttribute('aria-expanded', 'false');
    chip.setAttribute('aria-controls', 'quality-menu');
    chip.setAttribute('aria-label', '描画品質');
    chip.addEventListener('click', () => this.setOpen(root.dataset.open !== 'true'));

    root.replaceChildren(readout, opts, chip);

    // 外側をつつんだら畳む(ギャラリー中は canvas が pointer-events:auto なので
    // キャンバスのドラッグ開始でも閉じる = 視界を邪魔しない)
    document.addEventListener('pointerdown', (event) => {
      if (root.dataset.open !== 'true') return;
      const target = event.target;
      if (target instanceof Node && root.contains(target)) return;
      this.setOpen(false);
    });

    return { root, chip, readout };
  }

  private setOpen(open: boolean): void {
    this.rootEl.dataset.open = open ? 'true' : 'false';
    this.chipEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) this.refreshReadout();
  }

  private refreshChip(): void {
    const label = `◈ ${this.mode}`;
    if (label !== this.lastChipLabel) {
      this.lastChipLabel = label;
      this.chipEl.textContent = label;
    }
    for (const [mode, button] of this.optionEls) {
      const active = mode === this.mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  /** 実効解像度の表示。**変化したときだけ** DOM へ書く */
  private refreshReadout(): void {
    this.engine.getDrawingBufferSize(this.bufferSize);
    const text =
      `${this.tier} · ${this.bufferSize.x}×${this.bufferSize.y} · ` +
      `${this.engine.postfx.samples}x`;
    if (text === this.lastReadout) return;
    this.lastReadout = text;
    this.readoutEl.textContent = text;
  }
}
