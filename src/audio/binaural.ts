/**
 * binaural.ts — 耳の中で生まれる拍(Phase 12b)。
 *
 * 左右の耳に、**ほんのわずかに高さの違う正弦**を 1 本ずつ置く。片方だけを聴いても
 * ただの持続音で、うなりはどこにも無い ── 二つの音は空気の中で出会わないからである。
 * 拍が現れるのは両耳で聴いたときだけで、それは空間ではなく聴き手の中で起きる。
 * この層が「ヘッドフォンを」と一行だけ添える理由がここにある。
 *
 * 構造は片側につき 3 ノードしかない:
 *
 *     Oscillator(sine, fc ∓ beat/2) → Gain(0.05) → StereoPanner(∓1) → [共有の fade] → ambient
 *
 * ・搬送波 fc = 196Hz。これは 98×2、すなわち **1D の鐘そのもの**である。
 *   六つの鐘(196 / 294 / 392 / 490 / 588 / 686Hz)はすべて 98Hz の倍音列に
 *   乗っているので、この持続音はどの鐘が鳴っても濁らない。
 * ・分け方は **対称**。L = fc − beat/2、R = fc + beat/2 ── 中心の高さを釘で
 *   打ち留める。拍が 2Hz から 10Hz まで動いても、片側の振れは ±5Hz に収まり、
 *   「音程が上がっていく」とは聞こえない(動くのは拍だけ)。
 * ・片側 0.05。チェーンを通ると -48dBFS で、196Hz の等ラウドネス(ISO 226)で
 *   読み直すとドローンより 2dB ほど下 ── 存在はするが、前には出ない。
 *
 * **この層の gain には、どんな LFO も挿してはならない。** 音量を揺らした瞬間、
 * うなりは片耳だけでも聞こえる「断続音(isochronic)」に変わり、両耳でしか
 * 生まれないという性質そのものが失われる。ここは設計上いちばん硬い制約である。
 *
 * 立ち上がり・引き・**止めたらグラフを捨てる**寿命は AmbientDrone と同じ作法。
 * エンジンはドローンとこの層を必ず一緒に起こし、一緒に寝かせる。
 */

/** 搬送波。98Hz(鐘の基音)の 2 倍音 = 1D の鐘 */
const CARRIER_HZ = 196;
/** 片側の音量。LFO を掛けない ── ここは定数でなければならない */
const SIDE_GAIN = 0.05;
/** 既定の拍(Hz)。α 帯。物語の外(ギャラリー・単独展示)ではここで据え置く */
const DEFAULT_BEAT_HZ = 10;

/** 立ち上がり / 引きの既定の尺(秒)。ドローンと揃える */
const FADE_S = 2.5;
/** フェード終了からノードを畳むまでの余裕(ms) */
const TEARDOWN_PAD_MS = 80;
/** 指数フェードの底(0 は指数ランプの終点にできない) */
const FLOOR = 0.0001;

/**
 * 拍の書き込みの間引き。
 *
 * 呼び出しは毎フレーム来る(60Hz)が、そのすべてを AudioParam へ流すと
 * オートメーションの予定表が 1 秒に 60 個ずつ伸びていく。**聞こえない差**は
 * 書かない ── 0.02Hz 未満の変化、または前回の書き込みから 120ms 以内は捨てる。
 */
const BEAT_EPSILON_HZ = 0.02;
const BEAT_MIN_MS = 120;
/**
 * 拍を動かすときの時定数(秒)。
 *
 * setTargetAtTime は a-rate ── サンプル単位で滑らかに寄っていくので、
 * どれだけ細かく呼んでも段差(ジッパーノイズ)にならない。τ=0.8s は
 * 「気づいたときにはもう変わっている」速さで、階を跨ぐ動きより一呼吸遅い。
 */
const BEAT_GLIDE_TAU = 0.8;

export interface BinauralTarget {
  readonly ctx: BaseAudioContext;
  /** 接続先(engine の ambient カテゴリ gain) */
  readonly dest: AudioNode;
}

export class BinauralLayer {
  private readonly ctx: BaseAudioContext;
  private readonly dest: AudioNode;
  /** StereoPanner を持たない古い環境ではこの層ごと出さない(ドローンは鳴る) */
  private readonly supported: boolean;

  /** フェード用の gain。これが null = グラフが存在しない */
  private fade: GainNode | null = null;
  private left: OscillatorNode | null = null;
  private right: OscillatorNode | null = null;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly nodes: AudioNode[] = [];
  private teardownTimer = 0;

  /** いま鳴らしている(= 最後に書き込んだ)拍 */
  private beat = DEFAULT_BEAT_HZ;
  /** 最後に拍を書いた時刻(ms)。sfx のレート制限と同じ時計を使う */
  private lastWriteMs = -1e9;

  constructor(target: BinauralTarget) {
    this.ctx = target.ctx;
    this.dest = target.dest;
    this.supported = typeof this.ctx.createStereoPanner === 'function';
  }

  /** グラフが生きているか(検証フックが読む) */
  get active(): boolean {
    return this.fade !== null;
  }

  /** 検証フック: いまの拍と、左右の実際の高さ(Hz)。グラフが無ければ 0 */
  get beatHz(): number {
    return this.beat;
  }

  get leftHz(): number {
    return this.left === null ? 0 : this.left.frequency.value;
  }

  get rightHz(): number {
    return this.right === null ? 0 : this.right.frequency.value;
  }

  /**
   * 立ち上げ。引きの途中でも同じグラフのまま吸い戻す(ドローンと同じ理由 ──
   * 素早く off → on したときに二重に鳴らさないため)。
   */
  start(fadeSec = FADE_S): void {
    if (!this.supported) return;
    this.cancelTeardown();
    const t = this.ctx.currentTime;

    if (this.fade === null) this.build();
    const fade = this.fade;
    if (fade === null) return;

    const g = fade.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(FLOOR, g.value), t);
    g.exponentialRampToValueAtTime(1, t + fadeSec);
  }

  /** 引き。フェードし終えてからノードを畳む(次の start() で作り直す) */
  stop(fadeSec = FADE_S): void {
    const fade = this.fade;
    if (fade === null) return;

    const t = this.ctx.currentTime;
    const g = fade.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(FLOOR, g.value), t);
    g.exponentialRampToValueAtTime(FLOOR, t + fadeSec);

    this.cancelTeardown();
    this.teardownTimer = globalThis.setTimeout(
      () => this.teardown(),
      fadeSec * 1000 + TEARDOWN_PAD_MS,
    );
  }

  /**
   * 拍を変える。**毎フレーム呼んでよい**(間引きはここが持つ)。
   *
   * グラフが無いときは値を覚えるだけ ── 次の start() がその拍から立ち上がる。
   * 黙っているあいだも階に追従しておくことで、ON にした瞬間から正しい拍で鳴る。
   */
  setBeat(hz: number): void {
    // 否定形で書く: hz が NaN のとき比較は false になり、そのまま弾かれる
    if (!(Math.abs(hz - this.beat) > BEAT_EPSILON_HZ)) return;
    const now = performance.now();
    if (now - this.lastWriteMs < BEAT_MIN_MS) return;

    this.lastWriteMs = now;
    this.beat = hz;

    const left = this.left;
    const right = this.right;
    if (left === null || right === null) return;

    const t = this.ctx.currentTime;
    const half = hz / 2;
    left.frequency.setTargetAtTime(CARRIER_HZ - half, t, BEAT_GLIDE_TAU);
    right.frequency.setTargetAtTime(CARRIER_HZ + half, t, BEAT_GLIDE_TAU);
  }

  // --- 内部 ------------------------------------------------------------------

  private build(): void {
    const ctx = this.ctx;

    const fade = ctx.createGain();
    fade.gain.value = FLOOR;
    fade.connect(this.dest);
    this.fade = fade;

    const half = this.beat / 2;
    this.left = this.addSide(CARRIER_HZ - half, -1, fade);
    this.right = this.addSide(CARRIER_HZ + half, 1, fade);
  }

  /**
   * 片側 1 本。**入場では滑らせない** ── いまの拍をそのまま置く
   * (setTargetAtTime で入ると、フェードインのあいだ拍が動いてしまう)。
   */
  private addSide(hz: number, pan: number, dest: AudioNode): OscillatorNode {
    const ctx = this.ctx;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(hz, ctx.currentTime);

    // ここは定数。振幅を揺らした瞬間に片耳でも聞こえる拍(isochronic)になる
    const gain = ctx.createGain();
    gain.gain.value = SIDE_GAIN;

    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;

    osc.connect(gain).connect(panner).connect(dest);
    osc.start();

    this.sources.push(osc);
    this.nodes.push(gain, panner);
    return osc;
  }

  private cancelTeardown(): void {
    if (this.teardownTimer === 0) return;
    globalThis.clearTimeout(this.teardownTimer);
    this.teardownTimer = 0;
  }

  private teardown(): void {
    this.teardownTimer = 0;
    for (let i = 0; i < this.sources.length; i++) {
      const source = this.sources[i];
      try {
        source.stop();
      } catch {
        // 二重 stop は無害
      }
      source.disconnect();
    }
    for (let i = 0; i < this.nodes.length; i++) this.nodes[i].disconnect();
    this.fade?.disconnect();
    this.sources.length = 0;
    this.nodes.length = 0;
    this.fade = null;
    this.left = null;
    this.right = null;
  }
}
