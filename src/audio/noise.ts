/**
 * ホワイトノイズのバッファ(Phase 10)。
 *
 * この作品は音源ファイルを 1 つも持たない ── 雑音もまた実行時に作る。
 * 生成そのものは安くないので、**コンテキストごと・長さごとに 1 本だけ**作って
 * 使い回す(検証用のオフラインコンテキストは別のキャッシュ行になるので、
 * サンプルレートの違う器へ間違ったバッファが渡ることはない)。
 *
 * WeakMap で持つ理由: AudioContext が捨てられたらバッファも一緒に消えてほしい。
 */

const cache = new WeakMap<BaseAudioContext, Map<number, AudioBuffer>>();

/** 長さ seconds 秒のモノラル白色雑音。同じ (ctx, seconds) には同じ 1 本を返す */
export function whiteNoise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  let byLength = cache.get(ctx);
  if (byLength === undefined) {
    byLength = new Map<number, AudioBuffer>();
    cache.set(ctx, byLength);
  }

  const hit = byLength.get(seconds);
  if (hit !== undefined) return hit;

  const frames = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

  byLength.set(seconds, buffer);
  return buffer;
}

/**
 * 使い回すバッファの、どこから鳴らすかを散らす。
 *
 * 同じ 25ms を毎回鳴らすとループの癖が出る ── 開始位置だけ振れば、
 * 1 本のバッファのままで「毎回わずかに違う雑音」になる(コストは乱数 1 個)。
 */
export function noiseOffset(buffer: AudioBuffer, needed: number): number {
  const room = buffer.duration - needed;
  return room > 0 ? Math.random() * room : 0;
}
