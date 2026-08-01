/**
 * ambient.ts — この空間そのものの音(Phase 10)。
 *
 * 「静かで、高価で、科学的」。既定音量では意識の下に沈んでいて、消したときに
 * はじめて「何かがあった」と気づく程度の質量しか持たない。
 *
 * 中身は 3 つの層でできている:
 *
 *   ① ドローン   55.00Hz と 55.35Hz の正弦を同じ強さで重ねる。差の 0.35Hz が
 *                 うなりになって、およそ 2.9 秒周期でゆっくり明滅する ──
 *                 これがこの空間の**呼吸**。110.7Hz(ほぼ 2 倍音)を弱く足して
 *                 芯を与え、220Hz のローパス(Q 0.5)で上を全部落とす。
 *   ② 雑音床     帯域 480Hz のバンドパスを通した白色雑音を -26dB 相当で敷く。
 *                 中心周波数を 0.07Hz(≈14 秒周期)の LFO で ±180Hz 揺らす ──
 *                 遠くを吹いている太陽風。
 *   ③ シマー     1244Hz(D#6 付近)の正弦をごく薄く。その音量をさらに 0.05Hz で
 *                 揺らす。単体では聞き取れないが、抜くと空気が死ぬ層。
 *
 * 立ち上がりと引きはどちらも 2.5 秒の指数フェード。**停止したらグラフを捨てる**
 * ── 次の start() で作り直す。常時走らせて gain だけ 0 にしておくより、
 * 発振器が本当に止まるぶん CPU に対して正直な設計になる。
 */

import { whiteNoise } from './noise';

/** 立ち上がり / 引きの既定の尺(秒) */
const FADE_S = 2.5;
/** フェード終了からノードを畳むまでの余裕(ms) */
const TEARDOWN_PAD_MS = 80;
/** 指数フェードの底(0 は指数ランプの終点にできない) */
const FLOOR = 0.0001;

/** ドローンの 2 本。差の 0.35Hz が「呼吸」になる */
const DRONE_A_HZ = 55.0;
const DRONE_B_HZ = 55.35;
const DRONE_GAIN = 0.5;
/** ほぼ 2 倍音。芯を与えるだけなので薄く */
const DRONE_C_HZ = 110.7;
const DRONE_C_GAIN = 0.18;
/** ドローンのローパス(倍音を全部落として「遠さ」を作る) */
const LOWPASS_HZ = 220;
const LOWPASS_Q = 0.5;

/** 雑音床 */
const NOISE_SECONDS = 2;
const NOISE_BAND_HZ = 480;
const NOISE_BAND_Q = 0.7;
const NOISE_GAIN = 0.05;
const NOISE_LFO_HZ = 0.07;
const NOISE_LFO_DEPTH_HZ = 180;

/** シマー */
const SHIMMER_HZ = 1244;
const SHIMMER_GAIN = 0.012;
const SHIMMER_LFO_HZ = 0.05;
const SHIMMER_LFO_DEPTH = 0.008;

export interface AmbientTarget {
  readonly ctx: BaseAudioContext;
  /** 接続先(engine の ambient カテゴリ gain) */
  readonly dest: AudioNode;
}

export class AmbientDrone {
  private readonly ctx: BaseAudioContext;
  private readonly dest: AudioNode;

  /** フェード用の gain。これが null = グラフが存在しない */
  private fade: GainNode | null = null;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly nodes: AudioNode[] = [];
  private teardownTimer = 0;

  constructor(target: AmbientTarget) {
    this.ctx = target.ctx;
    this.dest = target.dest;
  }

  /** グラフが生きているか(検証フックが読む) */
  get active(): boolean {
    return this.fade !== null;
  }

  /**
   * 立ち上げ。すでに生きていれば(引きの途中でも)そのグラフのまま吸い戻す ──
   * 素早く off → on したときに 2 つ目のドローンが重ならないようにするため。
   */
  start(fadeSec = FADE_S): void {
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

  // --- 内部 ------------------------------------------------------------------

  private build(): void {
    const ctx = this.ctx;

    const fade = ctx.createGain();
    fade.gain.value = FLOOR;
    fade.connect(this.dest);
    this.fade = fade;

    // ① ドローン ── 3 本の正弦を 1 つのローパスへまとめる
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = LOWPASS_HZ;
    lowpass.Q.value = LOWPASS_Q;
    lowpass.connect(fade);
    this.nodes.push(lowpass);

    this.addSine(DRONE_A_HZ, DRONE_GAIN, lowpass);
    this.addSine(DRONE_B_HZ, DRONE_GAIN, lowpass);
    this.addSine(DRONE_C_HZ, DRONE_C_GAIN, lowpass);

    // ② 雑音床 ── ループする 2 秒の白色雑音を狭い帯域だけ通す
    const noise = ctx.createBufferSource();
    noise.buffer = whiteNoise(ctx, NOISE_SECONDS);
    noise.loop = true;

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = NOISE_BAND_HZ;
    band.Q.value = NOISE_BAND_Q;

    const noiseGain = ctx.createGain();
    noiseGain.gain.value = NOISE_GAIN;

    noise.connect(band).connect(noiseGain).connect(fade);
    this.sources.push(noise);
    this.nodes.push(band, noiseGain);

    // 帯域の中心をゆっくり掃く(≈14 秒周期)= 遠くの太陽風
    this.addLfo(NOISE_LFO_HZ, NOISE_LFO_DEPTH_HZ, band.frequency);

    // ③ シマー ── 音量そのものを 0.05Hz で揺らす
    const shimmer = ctx.createOscillator();
    shimmer.frequency.value = SHIMMER_HZ;
    const shimmerGain = ctx.createGain();
    shimmerGain.gain.value = SHIMMER_GAIN;
    shimmer.connect(shimmerGain).connect(fade);
    shimmer.start();
    this.sources.push(shimmer);
    this.nodes.push(shimmerGain);

    this.addLfo(SHIMMER_LFO_HZ, SHIMMER_LFO_DEPTH, shimmerGain.gain);
  }

  private addSine(hz: number, gainValue: number, dest: AudioNode): void {
    const osc = this.ctx.createOscillator();
    osc.frequency.value = hz;
    const gain = this.ctx.createGain();
    gain.gain.value = gainValue;
    osc.connect(gain).connect(dest);
    osc.start();
    this.sources.push(osc);
    this.nodes.push(gain);
  }

  private addLfo(hz: number, depth: number, param: AudioParam): void {
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = hz;
    const depthGain = this.ctx.createGain();
    depthGain.gain.value = depth;
    lfo.connect(depthGain).connect(param);
    lfo.start();
    this.sources.push(lfo);
    this.nodes.push(depthGain);
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
        // 二重 stop は無害。すでに止まっていれば何もすることはない
      }
      source.disconnect();
    }
    for (let i = 0; i < this.nodes.length; i++) this.nodes[i].disconnect();
    this.fade?.disconnect();
    this.sources.length = 0;
    this.nodes.length = 0;
    this.fade = null;
  }
}
