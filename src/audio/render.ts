/**
 * render.ts — 音を「聴かずに」検証するための計測器(Phase 10 / DEV 専用)。
 *
 * 実機で鳴らしている **同じ build 関数**を OfflineAudioContext へ差し、
 * **同じ buildChain()** を通してから波形を読む ── 測っているものと聞こえる
 * ものが同一である根拠がこの共有にある。
 *
 * 返すのは 4 つの数値だけ:
 *   peak    チェーン通過後の絶対値の最大(0.5 を超えたら大きすぎる)
 *   rms     実効値(環境音が「静か」であることの唯一の客観的証拠)
 *   durMs   -80dBFS を超えていた区間の長さ(鐘の余韻・ホバーの短さ)
 *   clipped |s| > 0.98 の標本が 1 つでもあったか
 *
 * このモジュールは main.ts から **動的 import** される。import.meta.env.DEV の
 * 分岐ごと本番ビルドから消える(バンドルに乗らない)。
 */

import { AmbientDrone } from './ambient';
import { BinauralLayer } from './binaural';
import { buildChain, LEVELS, type AudioChain } from './engine';
import {
  buildBell,
  buildClick,
  buildHover,
  buildModeShift,
  buildTab,
  buildTick,
  buildToggleOff,
  buildToggleOn,
  type SfxTarget,
} from './sfx';

/** 検証は常にこのレートで行う(実機のレートに依存しない数値を出すため) */
const SAMPLE_RATE = 48000;

/**
 * 測る前に置く助走(秒)── **この値は測定の罠そのものである**。
 *
 * DynamicsCompressor は内部利得が抑えられた状態から始まり、release(0.25s)を
 * かけて定常へ**上がって**いく。頭の 20ms に音を差して測ると、実測で
 * 定常の 0.37 倍(-8.6dB)という「実際には聞こえない小ささ」が出てしまう
 * (t0 を振って確かめた: 0.02s→0.37倍 / 0.1s→0.80倍 / 0.3s 以降は一定)。
 *
 * 実機のコンテキストは音を出す頃には十分に走っているので、**定常が本当の値**。
 * だから release より長い 0.5 秒だけ空回しし、そこから先だけを測る。
 */
const LEAD_S = 0.5;
/** 「鳴っている」と見なす下限。-80dBFS */
const SILENCE = 1e-4;
/** クリップ判定 */
const CLIP = 0.98;

/** 名前 → レンダ長(秒)。余韻が切れない長さを取る */
const DURATIONS: Readonly<Record<string, number>> = {
  hover: 0.6,
  click: 0.6,
  toggleOn: 0.6,
  toggleOff: 0.6,
  tab: 0.8,
  tick: 0.4,
  enterGallery: 1.2,
  exitGallery: 1.2,
  bell1: 3.2,
  bell2: 3.2,
  bell3: 3.2,
  bell4: 3.2,
  bell5: 3.2,
  bell6: 3.2,
  /**
   * 環境音は 3.0 秒で測る。
   *
   * 以前の 1.5 秒は**短すぎた** ── ドローンのうなりは 0.35Hz、すなわち周期
   * 2.9 秒である。1.5 秒の窓はその半周期しか含まないので、窓の位置によって
   * 実効値が最大 31% 低く出る(監査の指摘)。3.0 秒なら丸ごと一周期を含む。
   */
  ambient: 3.0,
  /** 両耳の層。いちばん遅い拍(2Hz = 周期 0.5s)を 8 周期ぶん含む長さ */
  binaural: 4.0,
};

export interface Measurement {
  readonly name: string;
  /** チェーン通過後のピーク */
  readonly peak: number;
  readonly rms: number;
  readonly durMs: number;
  readonly clipped: boolean;
  /** 鐘だけ: 支配的な周波数(Hz)と理論値 */
  readonly hz?: number;
  readonly expectedHz?: number;
}

/** 検証できる名前の一覧 */
export function names(): string[] {
  return Object.keys(DURATIONS);
}

/**
 * 1 つ鳴らして測る。
 * OfflineAudioContext は 2ch ── モノラルの音源はアップミックスで両チャンネルへ
 * 同じ波形が入るので、測定はチャンネルをまたいだ最大 / 全標本の実効値で取る。
 */
export async function render(name: string): Promise<Measurement> {
  const seconds = DURATIONS[name];
  if (seconds === undefined) throw new Error(`[audio] 未知の音 ${name}`);

  const ctx = new OfflineAudioContext(
    2,
    Math.ceil((seconds + LEAD_S) * SAMPLE_RATE),
    SAMPLE_RATE,
  );
  const chain = buildChain(ctx, LEVELS.master);

  if (name === 'ambient') {
    // ドローンの立ち上がりは 2.5 秒。助走のあいだに満ちていてほしいので、
    // **定常状態**を測るために立ち上がりだけ 20ms へ縮める(音の中身は同じ)
    new AmbientDrone({ ctx, dest: chain.ambient }).start(0.02);
  } else if (name === 'binaural') {
    // 両耳の層**だけ**をチェーンへ差す。ドローンと混ぜないので、左右の分離と
    // 拍(R の高さ − L の高さ)を汚れのない波形から直接読める
    new BinauralLayer({ ctx, dest: chain.ambient }).start(0.02);
  } else {
    build(name, chain, LEAD_S);
  }

  const buffer = await ctx.startRendering();
  const stats = measure(buffer, Math.round(LEAD_S * SAMPLE_RATE));

  if (name.startsWith('bell')) {
    const k = Number(name.slice(4));
    return { name, ...stats, hz: dominantHz(buffer, 120, 1400), expectedHz: 98 * (k + 1) };
  }
  return { name, ...stats };
}

/** 全部測って表にする(PR 本文へそのまま貼れる形) */
export async function renderAll(): Promise<Measurement[]> {
  const out: Measurement[] = [];
  for (const name of names()) out.push(await render(name));
  return out;
}

// --- 内部 --------------------------------------------------------------------

function build(name: string, chain: AudioChain, t0: number): void {
  const target: SfxTarget = chain;
  switch (name) {
    case 'hover':
      buildHover(target, t0);
      return;
    case 'click':
      buildClick(target, t0);
      return;
    case 'toggleOn':
      buildToggleOn(target, t0);
      return;
    case 'toggleOff':
      buildToggleOff(target, t0);
      return;
    case 'tab':
      buildTab(target, t0);
      return;
    case 'tick':
      buildTick(target, t0);
      return;
    case 'enterGallery':
      buildModeShift(target, t0, true);
      return;
    case 'exitGallery':
      buildModeShift(target, t0, false);
      return;
    default:
      if (name.startsWith('bell')) {
        buildBell(target, t0, Number(name.slice(4)));
        return;
      }
      throw new Error(`[audio] 未知の音 ${name}`);
  }
}

/** from 標本目から末尾までを測る(頭の助走は窓に入れない) */
function measure(
  buffer: AudioBuffer,
  from: number,
): {
  peak: number;
  rms: number;
  durMs: number;
  clipped: boolean;
} {
  let peak = 0;
  let sum = 0;
  let count = 0;
  let first = -1;
  let last = -1;

  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = from; i < data.length; i++) {
      const value = data[i];
      const abs = value < 0 ? -value : value;
      if (abs > peak) peak = abs;
      sum += value * value;
      count++;
      if (abs > SILENCE) {
        if (first < 0 || i < first) first = i;
        if (i > last) last = i;
      }
    }
  }

  return {
    peak: round(peak),
    rms: round(count > 0 ? Math.sqrt(sum / count) : 0),
    durMs: first < 0 ? 0 : Math.round(((last - first + 1) / buffer.sampleRate) * 1000),
    clipped: peak > CLIP,
  };
}

/**
 * 支配的な周波数を粗く求める(Goertzel)。
 *
 * FFT を持ち込まないための最小の道具。1Hz 刻みで候補周波数の複素振幅を出し、
 * いちばん強いものを返す。減衰する正弦のスペクトルは裾を引くが、山の位置は
 * 動かないので「鐘の基音が 196Hz か」を確かめるにはこれで足りる。
 */
function dominantHz(buffer: AudioBuffer, from: number, to: number): number {
  const rate = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  // 撞いた瞬間の雑音の爪を避け、余韻の頭 0.4 秒だけを見る
  const start = Math.floor((LEAD_S + 0.05) * rate);
  const length = Math.min(Math.floor(0.4 * rate), data.length - start);

  let bestHz = 0;
  let bestPower = -1;
  for (let hz = from; hz <= to; hz++) {
    const w = (2 * Math.PI * hz) / rate;
    const coeff = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < length; i++) {
      const s0 = data[start + i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    if (power > bestPower) {
      bestPower = power;
      bestHz = hz;
    }
  }
  return bestHz;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
