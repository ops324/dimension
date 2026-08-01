import { Vector2 } from 'three';

import type { Engine } from './engine';
import type { Starfield } from '../render/starfield';
import { BLOOM_BASE_RADIUS, BLOOM_BASE_STRENGTH } from '../render/postfx';
import { createSlidingPill, type SlidingPill } from '../ui/components/controls/Segmented';

/**
 * 品質ティアと AUTO 制御(プラン5節「AUTO品質制御」/ 既知の罠 #12)。
 *
 * 方針は三段構え:
 *  ① **エスカレーション起動** — いきなり最大では立ち上げない。HIGH(DPR2/MSAA4)で
 *     起動し、最初の 60 フレームの平均フレーム時間が 10ms を切っていれば ULTRA
 *     (DPR3/MSAA8)へ昇格する。逆順(最大で起動→降格)は初回体験のカクつきと
 *     弱 GPU でのコンテキストロストを招くため採らない。
 *  ② **ガバナ** — 以後は 60 フレーム窓の平均を見張り、18ms 超が 2 窓続いたら
 *     1 段だけ降格する。
 *  ③ **再昇格は 1 セッションに 1 回だけ**(Phase 12a)。降格したあと 20 窓
 *     (≒ 1200 フレーム / 20 秒)続けて 12ms を切っていたら、1 段だけ戻す。
 *     Phase 11 までは降格が不可逆で、**読み込み中の 1 回のしゃっくりだけで
 *     実機が最後まで BALANCED に釘付けになっていた**(監査の指摘)。
 *     「1 回だけ」に制限することで、往復するフリッカは構造的に起きない ──
 *     上がれる回数が有限なので、昇降のループが定義上つくれない。
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
  /** ブルームの強さ。**bloomScale とペアで**決める(下の表の注を読むこと) */
  readonly bloomStrength: number;
  /** ブルームの mip 合成半径。低解像度ブルームのにじみを締めるのはこちら */
  readonly bloomRadius: number;
  /** 星・ファイバーの密度スケール */
  readonly density: number;
}

/**
 * ティア表(Phase 12a で光の 3 つを組にして再調律)。
 *
 * **bloomScale を単独で動かしてはならない。** 内部解像度を変えると同じ strength /
 * radius でもにじみの性格が変わるので、この表では 3 つを必ず組で持つ。
 * 基準値(BLOOM_BASE_*)は postfx.ts が持つ ULTRA の実測調律で、ここはそこからの
 * **差分だけ**を書く ── 数値の二重管理を作らないため。
 *
 *   HIGH  : scale 0.5 → 1.0 と引き換えに strength 0.40 → 0.32。
 *           監査は「scale 1 にすると HIGH と ULTRA の出力がバイト単位で一致する」
 *           = HIGH が ULTRA と見分けのつかない絵になる、と指摘した。半解像度の
 *           mip でにじませていたぶんが芯へ戻るので、強さを落とさないと**同じ
 *           絵がただ明るくなる**。0.32 は「芯は締まったまま、総光量は据え置き」の値。
 *   BALANCED: scale 0.5 → 0.75 と引き換えに radius 0.25 → 0.18。
 *           解像度を上げるだけだと弱い端末での負荷が増えるだけなので、
 *           半径を締めて「弱いがボケていない」光にする。strength は基準のまま ──
 *           BALANCED で暗くすると、そもそも線の細い端末で作品が沈む。
 *   ULTRA : 基準そのまま。ここを動かすときは postfx.ts の調律ノートから直すこと。
 */
const TIERS: Readonly<Record<QualityTier, TierSpec>> = {
  BALANCED: {
    dprCap: 1.5,
    samples: 2,
    bloomScale: 0.75,
    bloomStrength: BLOOM_BASE_STRENGTH,
    bloomRadius: 0.18,
    density: 0.5,
  },
  HIGH: {
    dprCap: 2,
    samples: 4,
    bloomScale: 1,
    bloomStrength: 0.32,
    bloomRadius: BLOOM_BASE_RADIUS,
    density: 1,
  },
  ULTRA: {
    dprCap: 3,
    samples: 8,
    bloomScale: 1,
    bloomStrength: BLOOM_BASE_STRENGTH,
    bloomRadius: BLOOM_BASE_RADIUS,
    density: 1,
  },
};

/** ティアのはしご(低 → 高)。自動で右へ進むのは起動時の 1 回 + 再昇格の 1 回まで */
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
/**
 * 再昇格の閾値(Phase 12a)。降格の 18ms とのあいだに 6ms の不感帯を置く ──
 * 12〜18ms のあいだをうろつく端末は、上がりも下がりもしない。
 */
const REESCALATE_MS = 12;
/**
 * 再昇格に必要な連続窓数。60 フレーム窓 × 20 ≒ 1200 フレーム(60fps で約 20 秒)。
 * 降格の 2 窓に対して 10 倍の慎重さ ── 「重いかも」には素早く、
 * 「もう軽い」には十分な証拠がそろってから応じる、という非対称は意図的。
 */
const REESCALATE_WINDOWS = 20;

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
  /** 起動エスカレーションの判定が済んだか */
  private booted = false;
  private badWindows = 0;
  private flooredLogged = false;
  /** 一度でも自動で降格したか(再昇格の前提条件) */
  private downgraded = false;
  /** 再昇格を使ったか。**1 セッションに 1 回だけ** ── これがフリッカの構造的な蓋 */
  private reescalated = false;
  /** REESCALATE_MS を切っている連続窓数 */
  private goodWindows = 0;

  /** 表示更新用。文字列は変化時にだけ組み立てる(毎フレームは触らない) */
  private readonly bufferSize = new Vector2();
  private lastReadout = '';
  private lastChipLabel = '';

  private readonly rootEl: HTMLElement;
  private readonly chipEl: HTMLButtonElement;
  private readonly readoutEl: HTMLElement;
  private readonly optionEls = new Map<QualityMode, HTMLButtonElement>();
  /** 選択中を示す滑るピル(Segmented と同じ 1 本のコードを共有する) */
  private readonly pill: SlidingPill;

  constructor(options: QualityOptions) {
    this.engine = options.engine;
    this.starfield = options.starfield;

    const ui = this.buildUI();
    this.rootEl = ui.root;
    this.chipEl = ui.chip;
    this.readoutEl = ui.readout;
    this.pill = ui.pill;

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
    this.goodWindows = 0;
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
    this.goodWindows = 0;
  };

  private evaluate(avg: number): void {
    if (!this.booted) {
      this.booted = true;
      if (this.mode !== 'AUTO') return;
      if (avg < ESCALATE_MS) {
        this.apply('ULTRA');
        console.info(`[quality] escalated to ULTRA (avg ${avg.toFixed(1)}ms)`);
      } else if (avg > BOOT_BAD_MS) {
        // 起動窓が重いのは「弱い端末」だけでなく「読み込みと重なった 1 窓」でも
        // 起こる。ここも降格として数え、あとで実測が伴えば 1 回だけ戻れるようにする
        this.downgraded = true;
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
      this.considerReescalation(avg);
      return;
    }
    this.badWindows++;
    this.goodWindows = 0;
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
    this.downgraded = true;
    this.apply(next);
    console.info(
      `[quality] governor: avg ${avg.toFixed(1)}ms over ${BAD_WINDOWS} windows → ${next}`,
    );
  }

  /**
   * 降格からの復帰(Phase 12a)。**1 セッションに 1 回だけ**、1 段だけ戻す。
   *
   * 前提は 3 つ ── ① 一度は自動で降格している ② まだ 1 回も戻していない
   * ③ REESCALATE_WINDOWS 窓**連続**で REESCALATE_MS を切っている。
   * 途中で 1 窓でも 12ms を超えたら数え直し(下の goodWindows=0)なので、
   * 「たまたま軽い瞬間があった」では上がらない。
   */
  private considerReescalation(avg: number): void {
    if (this.reescalated || !this.downgraded) return;
    if (avg >= REESCALATE_MS) {
      this.goodWindows = 0;
      return;
    }
    this.goodWindows++;
    if (this.goodWindows < REESCALATE_WINDOWS) return;

    // 使い切りの権利はここで必ず消費する(天井にいて上がれない場合も含む)──
    // そうしないと最上位のまま数え続けて、次の降格の直後に即座に戻ってしまう
    this.reescalated = true;
    const index = LADDER.indexOf(this.tier);
    if (index >= LADDER.length - 1) return;

    const next = LADDER[index + 1];
    this.apply(next);
    console.info(
      `[quality] governor: avg ${avg.toFixed(1)}ms under ${REESCALATE_MS}ms ` +
        `for ${REESCALATE_WINDOWS} windows → re-escalated to ${next} (once per session)`,
    );
  }

  // --- 適用 ------------------------------------------------------------------

  private apply(tier: QualityTier): void {
    const spec = TIERS[tier];
    this.tier = tier;
    // 直前の窓は「別のティアの」フレーム時間。次の判定は新しいティアで測り直す
    this.resetWindow();

    this.engine.setQuality({ samples: spec.samples, dpr: spec.dprCap });
    // 光の 3 つは必ず一緒に配る(TIERS の注記のとおり組で意味を持つ)
    this.engine.postfx.setBloomScale(spec.bloomScale);
    this.engine.postfx.setBloomStrength(spec.bloomStrength);
    this.engine.postfx.setBloomRadius(spec.bloomRadius);
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
        `samples=${this.engine.postfx.samples} ` +
        `bloom=×${spec.bloomScale}/s${spec.bloomStrength}/r${spec.bloomRadius} ` +
        `buffer=${this.bufferSize.x}×${this.bufferSize.y}`,
    );
  }

  // --- UI --------------------------------------------------------------------

  private buildUI(): {
    root: HTMLElement;
    chip: HTMLButtonElement;
    readout: HTMLElement;
    pill: SlidingPill;
  } {
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
    // 選択の表現はパネルの segmented と同じ「滑るピル」。畳んでいるあいだは
    // 幅が測れないので、開いた瞬間に moveTo(animate=false) で置き直す
    const pill = createSlidingPill(opts, { className: 'q-pill', matchY: true });
    for (const mode of MODES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'q-opt';
      button.textContent = mode;
      button.dataset.cursor = '';
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

    return { root, chip, readout, pill };
  }

  private setOpen(open: boolean): void {
    this.rootEl.dataset.open = open ? 'true' : 'false';
    this.chipEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      this.refreshReadout();
      // display が付いた直後 = ここではじめて選択肢の幅が測れる
      this.pill.moveTo(this.optionEls.get(this.mode) ?? null, false);
    }
  }

  private refreshChip(): void {
    const label = `◈ ${this.mode}`;
    if (label !== this.lastChipLabel) {
      this.lastChipLabel = label;
      this.chipEl.textContent = label;
    }
    let active: HTMLButtonElement | null = null;
    for (const [mode, button] of this.optionEls) {
      const on = mode === this.mode;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) active = button;
    }
    this.pill.moveTo(active, true);
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
