/**
 * sfx.ts — 器械の音(Phase 10)。
 *
 * どれも 1 回鳴らすたびに小さなグラフを組んで捨てる。寿命はミリ秒単位で、
 * 発振器は stop() の時刻に自分で解体される ── プールも使い回しも要らない。
 *
 * 包絡はすべて同じ形をしている:
 *     0.0001 →(2〜5ms の直線)→ ピーク →(指数)→ 0.0001
 * 立ち上がりを直線にするのは、無音からの指数ランプが張れない(0 を終点にも
 * 始点にもできない)ため。落ちを指数にするのは、そちらが物理の減衰だから。
 *
 * この音たちは「楽器」ではなく「計器」である ── 音程を主張せず、操作の手応えの
 * 質感だけを返す。だからどれも 20〜250ms で、いちばん強い click ですら
 * ピーク 0.14(チェーン通過後に 0.035 前後)しかない。
 *
 * 各 build* は **オフラインレンダの検証からも同じ関数が呼ばれる**。
 * 実機で鳴っているものと、測っているものが同一である根拠がここにある。
 * 戻り値は「この音が終わる時刻」(秒)── レンダのバッファ長を決めるのに使う。
 */

import { audio, RAMP_FLOOR } from './engine';
import { noiseOffset, whiteNoise } from './noise';

/** 発振器を止めるまでの余裕(秒)。包絡が底に着いてから切る */
const TAIL_S = 0.02;
/** 使い回すノイズバッファの長さ(秒) */
const NOISE_POOL_S = 2;

/** レート制限(ms)。ポインタとスライダーは人間より速く動く */
const HOVER_MIN_MS = 60;
const TICK_MIN_MS = 40;
/** タブ音は「切り替わった」合図。連打とキー移動の二重発火を 1 つに畳む */
const TAB_MIN_MS = 100;
/** モード遷移音。CTA の押下と gallery のモード確定は 250ms ずれて 2 回来る */
const MODE_MIN_MS = 500;

let lastHover = -1e9;
let lastTick = -1e9;
let lastTab = -1e9;
let lastMode = -1e9;

/** 一発を差せる出力口。engine の AudioChain がそのまま満たす */
export interface SfxTarget {
  readonly ctx: BaseAudioContext;
  readonly sfx: AudioNode;
  readonly bell: AudioNode;
}

/* ------------------------------------------------------------------ 部品 */

/**
 * 包絡。attack は直線(無音からの指数が張れないため)、decay は指数。
 * decay は t0 からの秒数であって、attack のあとからではない。
 */
function envelope(
  param: AudioParam,
  t0: number,
  peak: number,
  attack: number,
  decay: number,
): void {
  param.setValueAtTime(RAMP_FLOOR, t0);
  param.linearRampToValueAtTime(peak, t0 + attack);
  param.exponentialRampToValueAtTime(RAMP_FLOOR, t0 + decay);
}

/** 正弦 1 本 + 包絡。dest へ差して終了時刻を返す */
function sine(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t0: number,
  hz: number,
  peak: number,
  attack: number,
  decay: number,
): number {
  const osc = ctx.createOscillator();
  osc.frequency.value = hz;
  const gain = ctx.createGain();
  envelope(gain.gain, t0, peak, attack, decay);
  osc.connect(gain).connect(dest);
  osc.start(t0);
  osc.stop(t0 + decay + TAIL_S);
  return t0 + decay + TAIL_S;
}

/** 雑音の一撃。filter を通してから包絡を掛ける */
function noiseBurst(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t0: number,
  filter: BiquadFilterNode,
  peak: number,
  attack: number,
  decay: number,
): number {
  const buffer = whiteNoise(ctx, NOISE_POOL_S);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  envelope(gain.gain, t0, peak, attack, decay);
  source.connect(filter).connect(gain).connect(dest);
  source.start(t0, noiseOffset(buffer, decay + TAIL_S));
  source.stop(t0 + decay + TAIL_S);
  return t0 + decay + TAIL_S;
}

function biquad(
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  hz: number,
  q: number,
): BiquadFilterNode {
  const node = ctx.createBiquadFilter();
  node.type = type;
  node.frequency.value = hz;
  node.Q.value = q;
  return node;
}

/* -------------------------------------------------------------- 合成本体 */

/** ホバー: 1800Hz をハイパスの向こうで一瞬だけ。ほとんど「気配」 */
export function buildHover(target: SfxTarget, t0: number): number {
  const { ctx } = target;
  const highpass = biquad(ctx, 'highpass', 800, 0.707);
  const osc = ctx.createOscillator();
  osc.frequency.value = 1800;
  const gain = ctx.createGain();
  envelope(gain.gain, t0, 0.05, 0.002, 0.045);
  osc.connect(highpass).connect(gain).connect(target.sfx);
  osc.start(t0);
  osc.stop(t0 + 0.045 + TAIL_S);
  return t0 + 0.045 + TAIL_S;
}

/**
 * クリック: 低い正弦の芯(240Hz)+ 2400Hz 帯の雑音の爪。
 * freq / peak を差し替えると、そのままトグルの ON / OFF になる。
 */
export function buildClick(target: SfxTarget, t0: number, hz = 240, peak = 0.14): number {
  const { ctx } = target;
  const body = sine(ctx, target.sfx, t0, hz, peak, 0.003, 0.08);
  const band = biquad(ctx, 'bandpass', 2400, 1);
  // 爪は芯の強さに比例させる(小さいクリックほど爪も小さい)
  const tip = noiseBurst(ctx, target.sfx, t0, band, 0.05 * (peak / 0.14), 0.002, 0.025);
  return Math.max(body, tip);
}

/** トグル ON: 少し高い 320Hz。「上がった」ことを音程が語る */
export function buildToggleOn(target: SfxTarget, t0: number): number {
  return buildClick(target, t0, 320, 0.14);
}

/** トグル OFF: 低い 210Hz */
export function buildToggleOff(target: SfxTarget, t0: number): number {
  return buildClick(target, t0, 210, 0.14);
}

/** タブ: 600 → 1800Hz を 140ms で掃く雑音 + 軽いクリックの層 */
export function buildTab(target: SfxTarget, t0: number): number {
  const { ctx } = target;
  const band = biquad(ctx, 'bandpass', 600, 1.4);
  band.frequency.setValueAtTime(600, t0);
  band.frequency.linearRampToValueAtTime(1800, t0 + 0.14);
  const sweep = noiseBurst(ctx, target.sfx, t0, band, 0.07, 0.004, 0.14);
  const click = buildClick(target, t0, 240, 0.06);
  return Math.max(sweep, click);
}

/** ティック: スライダーの目盛り。2600Hz を 18ms だけ */
export function buildTick(target: SfxTarget, t0: number): number {
  return sine(target.ctx, target.sfx, t0, 2600, 0.02, 0.002, 0.018);
}

/**
 * モード遷移: 110 → 165Hz(完全五度)を 250ms で滑る + 300Hz 帯の雑音のうねり。
 * 帰りは 165 → 110 ── 同じ音程差を逆にたどる。
 */
export function buildModeShift(target: SfxTarget, t0: number, inward = true): number {
  const { ctx } = target;
  const from = inward ? 110 : 165;
  const to = inward ? 165 : 110;

  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(from, t0);
  osc.frequency.linearRampToValueAtTime(to, t0 + 0.25);
  const gain = ctx.createGain();
  envelope(gain.gain, t0, 0.16, 0.005, 0.25);
  osc.connect(gain).connect(target.sfx);
  osc.start(t0);
  osc.stop(t0 + 0.25 + TAIL_S);

  // 雑音は 200ms かけて満ちてから 300ms で引く(扉が開く空気)
  const band = biquad(ctx, 'bandpass', 300, 0.9);
  const buffer = whiteNoise(ctx, NOISE_POOL_S);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const swell = ctx.createGain();
  swell.gain.setValueAtTime(RAMP_FLOOR, t0);
  swell.gain.linearRampToValueAtTime(0.04, t0 + 0.2);
  swell.gain.exponentialRampToValueAtTime(RAMP_FLOOR, t0 + 0.5);
  source.connect(band).connect(swell).connect(target.sfx);
  source.start(t0, noiseOffset(buffer, 0.5 + TAIL_S));
  source.stop(t0 + 0.5 + TAIL_S);

  return t0 + 0.5 + TAIL_S;
}

/**
 * 次元の鐘。
 *
 * 基音 f0 = 99Hz を置き、k 次元は **(k+1) 倍音**を鳴らす:
 *     1D→198  2D→297  3D→396  4D→495  5D→594  6D→693 (Hz)
 * 次元がひとつ増えるということは、同じ弦の上の次の節へ移ることである ──
 * 倍音列そのものが「次元の階段」になっている。上がるときも下りるときも鳴らすので、
 * 下りは低い倍音が返ってくる。
 *
 * 基音が 99Hz なのは、この倍音列が**ソルフェジオ音階と重なる**からである
 * (396 / 495 / 594 / 693 = 解放・つながり・関係・直観)。私たちの 3D が 396Hz。
 * 98Hz からの隔たりはわずか 1% ── 倍音列という構造は何ひとつ変えていない。
 *
 * 音色は 1 : 2.76 : 5.40 の非調和倍音(教会の鐘の古典的な比)で、上ほど速く消える。
 * 頭に 8ms の雑音の爪を足すと、金属ではなくガラスの鐘になる。
 */
export function buildBell(target: SfxTarget, t0: number, k: number): number {
  const { ctx } = target;
  const f = 99 * (k + 1);
  const peak = 0.3;

  const fundamental = sine(ctx, target.bell, t0, f, peak, 0.002, 1.8);
  sine(ctx, target.bell, t0, f * 2.76, peak * 0.3, 0.002, 0.6);
  sine(ctx, target.bell, t0, f * 5.4, peak * 0.12, 0.002, 0.3);

  // 撞木の爪。いちばん上の部分音の帯だけを叩く
  const band = biquad(ctx, 'bandpass', f * 5.4, 0.9);
  noiseBurst(ctx, target.bell, t0, band, 0.03, 0.001, 0.008);

  return fundamental;
}

/* ------------------------------------------------------- 実機側の呼び出し口 */

/**
 * 鳴らす。**OFF のときは bus が null なので、ここで全部落ちる**
 * ── 呼び出し側は「音が有効かどうか」を知らなくてよい。
 */
function play(build: (target: SfxTarget, t0: number) => number): void {
  const bus = audio.bus;
  if (bus === null) return;
  build(bus, bus.ctx.currentTime);
}

export function hover(): void {
  const now = performance.now();
  if (now - lastHover < HOVER_MIN_MS) return;
  lastHover = now;
  play(buildHover);
}

export function click(): void {
  play(buildClick);
}

export function toggleOn(): void {
  play(buildToggleOn);
}

export function toggleOff(): void {
  play(buildToggleOff);
}

export function tab(): void {
  const now = performance.now();
  if (now - lastTab < TAB_MIN_MS) return;
  lastTab = now;
  play(buildTab);
}

export function tick(): void {
  const now = performance.now();
  if (now - lastTick < TICK_MIN_MS) return;
  lastTick = now;
  play(buildTick);
}

/** ギャラリーへ入る */
export function enterGallery(): void {
  const now = performance.now();
  if (now - lastMode < MODE_MIN_MS) return;
  lastMode = now;
  play((target, t0) => buildModeShift(target, t0, true));
}

/** 物語へ帰る */
export function exitGallery(): void {
  const now = performance.now();
  if (now - lastMode < MODE_MIN_MS) return;
  lastMode = now;
  play((target, t0) => buildModeShift(target, t0, false));
}

/** 次元の鐘。k は 1..6 に丸めて呼ぶこと(wiring が担保している) */
export function bell(k: number): void {
  play((target, t0) => buildBell(target, t0, k));
}
