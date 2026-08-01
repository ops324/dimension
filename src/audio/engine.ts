/**
 * AudioEngine — 音の中枢(Phase 10)。
 *
 * 設計の柱:
 * - **既定は無音**。localStorage に 'on' が書かれるまで AudioContext すら作らない。
 *   自動再生は一切しない ── 鳴るのは「ユーザーが選んだ」かつ「操作が一度あった」
 *   の両方が満たされたときだけ。
 * - すべての音は同じチェーンを通る:
 *     カテゴリ gain(ambient / sfx / bell)→ master → DynamicsCompressor → 出力
 *   末端のコンプレッサは音作りではなく**安全装置**(-12dB / ratio 12)。
 *   どの音がどう重なっても、ここから先へ 0dBFS を突き抜けたものは出て行かない。
 * - master は決してハードカットしない。0 との往復は必ずランプ ── 瞬間的な段差は
 *   スピーカーで「プツッ」というクリックになる。
 * - AudioContext が無い環境(SSR・古いブラウザ)では、この API 全体が**静かな
 *   no-op** に落ちる。呼び出し側に分岐を持たせない。
 */

import { AmbientDrone } from './ambient';
import { BinauralLayer } from './binaural';

/** 出力レベル。すべてこの順に掛かってからコンプレッサへ入る */
export const LEVELS = {
  master: 0.5,
  ambient: 0.16,
  sfx: 0.5,
  bell: 0.35,
} as const;

/** 設定の保存先。値は 'on' | 'off'、キーが無い = まだ一度も選んでいない */
export const STORAGE_KEY = 'dimension.sound';

/**
 * master のフェード。**上りと下りで尺が違う**。
 *
 * 下り(0.3s)は引きの余韻。上り(0.06s)は、ON にした直後に鳴らす確認音を
 * 満額で聞かせるため ── 0.3 秒かけて上げると、80ms で減衰する確認音が
 * ランプの底に埋もれて事実上聞こえない(実測で踏んだ)。60ms でも段差ではなく
 * ランプなので、クリックノイズは出ない。
 */
const FADE_IN_S = 0.06;
const FADE_OUT_S = 0.3;
/** ドローンの立ち上がり / 引き(秒) */
const AMBIENT_FADE_S = 2.5;
/** OFF にしてからコンテキストを眠らせるまで(ms)。ドローンの引きより長く取る */
const SUSPEND_DELAY_MS = 3200;
/** 指数ランプの底 */
const FLOOR = 0.0001;

/** 音のカテゴリ 3 系統 + master。オフラインレンダ(検証)も同じ器を作る */
export interface AudioChain {
  readonly ctx: BaseAudioContext;
  readonly master: GainNode;
  readonly limiter: DynamicsCompressorNode;
  readonly ambient: GainNode;
  readonly sfx: GainNode;
  readonly bell: GainNode;
}

/** `dimension:sound` の detail。UI(SoundToggle)はこれだけを見る */
export interface SoundDetail {
  readonly enabled: boolean;
}

/**
 * 出力チェーンを組む。**唯一の定義**であり、実機もオフライン検証もここを通る
 * ── 「測った音」と「聞こえる音」がずれない根拠がこの共有にある。
 */
export function buildChain(ctx: BaseAudioContext, masterLevel: number): AudioChain {
  // 安全装置。knee 24dB でゆるく効きはじめ、ratio 12 で頭を押さえる
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -12;
  limiter.knee.value = 24;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  limiter.connect(ctx.destination);

  const master = ctx.createGain();
  master.gain.value = masterLevel;
  master.connect(limiter);

  const ambient = ctx.createGain();
  ambient.gain.value = LEVELS.ambient;
  ambient.connect(master);

  const sfx = ctx.createGain();
  sfx.gain.value = LEVELS.sfx;
  sfx.connect(master);

  const bell = ctx.createGain();
  bell.gain.value = LEVELS.bell;
  bell.connect(master);

  return { ctx, master, limiter, ambient, sfx, bell };
}

/** AudioContext のコンストラクタ。無い環境では null(以後すべて no-op) */
function contextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** localStorage は例外を投げうる(プライベートモード等)。読み書きとも黙って諦める */
function readPreference(): 'on' | 'off' | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'on' || value === 'off' ? value : null;
  } catch {
    return null;
  }
}

function writePreference(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    // 保存できない環境では「このセッションのあいだだけ」の設定として振る舞う
  }
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private chain: AudioChain | null = null;
  private drone: AmbientDrone | null = null;
  /** ドローンの隣。必ず同じ合図で起き、同じ合図で寝る */
  private binaural: BinauralLayer | null = null;

  private on = false;
  private stored: 'on' | 'off' | null = null;
  /**
   * 最後に受け取った拍。**層より先に届いた値がここで待つ** ── 音を入れる前から
   * 物語は進んでいるので、生まれたばかりの層にまずこれを渡す。渡さないと
   * 既定の 10Hz で立ち上がってから今の拍へ滑ることになり、入場で拍が動く。
   * NaN = まだ一度も届いていない(層は自分の既定のまま立ち上がる)。
   */
  private pendingBeat = Number.NaN;
  /** ユーザー操作が一度でもあったか。これが立つまで AudioContext を作らない */
  private gestured = false;
  private booted = false;
  private suspendTimer = 0;

  /** この環境で音を出せるか */
  get available(): boolean {
    return contextCtor() !== null;
  }

  /** 設定が ON か(音が実際に鳴っているかとは別 ── 操作前は文脈が眠っている) */
  get enabled(): boolean {
    return this.on;
  }

  /** ユーザーが一度でも選んだことがあるか。初回訪問の誘い(パルス)の判定に使う */
  get hasPreference(): boolean {
    return this.stored !== null;
  }

  /** 検証フック: グラフが立っているか / コンテキストの状態 */
  get ambientActive(): boolean {
    return this.drone !== null && this.drone.active;
  }

  /** 検証フック: 両耳の層(まだ一度も鳴らしていなければ null) */
  get binauralLayer(): BinauralLayer | null {
    return this.binaural;
  }

  get contextState(): string {
    return this.ctx === null ? 'none' : this.ctx.state;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  /**
   * いま音を差してよい出力口。**無効・非可視・環境なしのときは null** を返す ──
   * sfx 側はこの 1 回の判定で全部落ちるので、OFF のときの実行コストはゼロに近い。
   */
  get bus(): AudioChain | null {
    if (!this.on) return null;
    if (typeof document !== 'undefined' && document.hidden) return null;
    return this.chain;
  }

  /**
   * 起動。**エンジンより先に呼んでよい**(何も作らないので)。
   * ここでするのは「最初のユーザー操作を捕まえる網を張る」ことだけ。
   */
  init(): void {
    if (this.booted) return;
    this.booted = true;

    this.stored = readPreference();
    this.on = this.stored === 'on';

    if (!this.available) {
      // 音を出せない環境。設定だけは UI へ配って、以後は何もしない
      this.on = false;
      this.dispatch();
      return;
    }

    // capture で捕まえる: 途中で誰かが伝播を止めても最初の一撃は必ず届く
    document.addEventListener('pointerdown', this.onGesture, { capture: true, passive: true });
    document.addEventListener('keydown', this.onGesture, { capture: true, passive: true });
    document.addEventListener('visibilitychange', this.onVisibility);

    this.dispatch();
  }

  /**
   * ON / OFF。**クリックから呼ばれる**ので、これ自体がユーザー操作として通用する
   * (ブラウザの自動再生ポリシーはこの呼び出しを「ジェスチャの中」と見なす)。
   */
  setEnabled(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.stored = on ? 'on' : 'off';
    writePreference(on);

    if (this.available) {
      this.gestured = true;
      if (on) this.engage();
      else this.disengage();
    }

    this.dispatch();
  }

  toggle(): void {
    this.setEnabled(!this.on);
  }

  /**
   * 拍(Hz)を差し出す。**毎フレーム呼んでよい** ── 間引きは層の側が持つ。
   *
   * 層がまだ無ければ何も起きない(= 音を出せない環境・一度も ON にしていない
   * 訪問では完全な no-op)。黙っているあいだの呼び出しは値を覚えるだけで、
   * 発振器は畳まれたまま ── 次に ON にした瞬間、その拍から立ち上がる。
   */
  setBeat(hz: number): void {
    this.pendingBeat = hz;
    this.binaural?.setBeat(hz);
  }

  // --- 内部 ------------------------------------------------------------------

  /** 最初のユーザー操作。設定が ON のまま戻ってきた訪問はここで目を覚ます */
  private readonly onGesture = (): void => {
    if (this.gestured) return;
    this.gestured = true;
    document.removeEventListener('pointerdown', this.onGesture, true);
    document.removeEventListener('keydown', this.onGesture, true);
    if (this.on) this.engage();
  };

  /** 見えていないタブで発振器を回し続けない(電池) */
  private readonly onVisibility = (): void => {
    const ctx = this.ctx;
    if (ctx === null) return;
    if (document.hidden) {
      void ctx.suspend();
      return;
    }
    if (this.on) void ctx.resume();
  };

  /** 鳴らしはじめる。コンテキストが無ければここで初めて作る */
  private engage(): void {
    if (this.suspendTimer !== 0) {
      window.clearTimeout(this.suspendTimer);
      this.suspendTimer = 0;
    }
    const chain = this.ensureChain();
    if (chain === null || this.ctx === null) return;

    void this.ctx.resume();
    this.ramp(chain.master.gain, LEVELS.master, FADE_IN_S);

    if (this.drone === null) {
      this.drone = new AmbientDrone({ ctx: chain.ctx, dest: chain.ambient });
    }
    this.drone.start(AMBIENT_FADE_S);

    // 両耳の層はドローンと**同じ合図・同じ尺**で立ち上がる。別の口(トグル)を
    // 持たせない ── 「音を出すか」以外の選択をこの作品は要求しない
    if (this.binaural === null) {
      this.binaural = new BinauralLayer({ ctx: chain.ctx, dest: chain.ambient });
      // 立ち上げる前に「いまの拍」を渡す(グラフはまだ無いので値を覚えるだけ)。
      // NaN のときは層の既定のまま ── どちらにせよ入場で拍は動かない
      this.binaural.setBeat(this.pendingBeat);
    }
    this.binaural.start(AMBIENT_FADE_S);
  }

  /** 黙らせる。ドローンは自分の 2.5 秒で引き、そのあとコンテキストを眠らせる */
  private disengage(): void {
    const chain = this.chain;
    if (chain === null) return;

    this.ramp(chain.master.gain, 0, FADE_OUT_S);
    this.drone?.stop(AMBIENT_FADE_S);
    this.binaural?.stop(AMBIENT_FADE_S);

    if (this.suspendTimer !== 0) window.clearTimeout(this.suspendTimer);
    this.suspendTimer = window.setTimeout(() => {
      this.suspendTimer = 0;
      if (this.on) return; // 待っているあいだに ON へ戻された
      void this.ctx?.suspend();
    }, SUSPEND_DELAY_MS);
  }

  private ensureChain(): AudioChain | null {
    if (this.chain !== null) return this.chain;
    if (!this.gestured) return null; // 操作前に文脈を作らない(自動再生を疑われない)

    const Ctor = contextCtor();
    if (Ctor === null) return null;

    try {
      // latencyHint 'interactive' = 操作に対する遅れを最小にする(既定だが明示する)
      const ctx = new Ctor({ latencyHint: 'interactive' });
      this.ctx = ctx;
      // 立ち上がりは無音から。engage() がランプで持ち上げる
      this.chain = buildChain(ctx, 0);
      console.info(`[audio] context ${ctx.sampleRate}Hz / state=${ctx.state}`);
      return this.chain;
    } catch (error) {
      console.warn('[audio] AudioContext を作れなかった', error);
      return null;
    }
  }

  /** 段差を作らない値の移動。現在値を必ずアンカーしてからランプする */
  private ramp(param: AudioParam, to: number, seconds: number): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const t = ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(to, t + seconds);
  }

  private dispatch(): void {
    if (typeof window === 'undefined') return;
    const detail: SoundDetail = { enabled: this.on };
    window.dispatchEvent(new CustomEvent<SoundDetail>('dimension:sound', { detail }));
  }
}

/** 音は 1 つしかない。モジュール単位のシングルトン */
export const audio = new AudioEngine();

/** 指数ランプの底(sfx / ambient が共有する) */
export const RAMP_FLOOR = FLOOR;
