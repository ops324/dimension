import { describe, it, expect } from 'vitest';
import {
  DETENT_RELEASE,
  DETENT_SNAP_EPSILON,
  DetentTrack,
  EPILOGUE_STOP_T,
  buildDetents,
  type ChapterSpan,
  type Detent,
} from '../core/detents';
import { ARROW_STEP } from '../core/scrollGlide';
import { thresholdsFor } from '../ui/chapterThresholds';
import type { ChapterRole } from '../ui/content';

/**
 * 実物と同じ幾何(Phase 34d 以降): 序章 130svh / 章 220svh ×7 / 終章 220svh、
 * `.pin` 100svh。ここでは h = 800px で解く。
 */
const H = 800;
const ROLES: readonly ChapterRole[] = [
  'prologue',
  ...Array.from({ length: 7 }, () => 'chapter' as const),
  'epilogue',
];

function spans(h = H): ChapterSpan[] {
  const heights = [1.3, ...Array.from({ length: 7 }, () => 2.2), 2.2];
  const out: ChapterSpan[] = [];
  let start = 0;
  for (let i = 0; i < heights.length; i++) {
    const th = thresholdsFor(ROLES[i]);
    out.push({
      start,
      lens: heights[i] * h - h,
      inT: th.inT,
      outT: th.outT,
      backOutT: th.backOutT,
      hasRead: ROLES[i] !== 'prologue',
    });
    start += heights[i] * h;
  }
  return out;
}

function scrollMaxOf(h = H): number {
  const total = (1.3 + 7 * 2.2 + 2.2) * h;
  return total - h;
}

function trackOf(h = H): { track: DetentTrack; detents: Detent[]; max: number } {
  const max = scrollMaxOf(h);
  const detents = buildDetents(spans(h), max);
  const track = new DetentTrack();
  track.setDetents(detents, max);
  return { track, detents, max };
}

/** 章 i の位置(localT → ドキュメント px) */
function at(i: number, t: number, h = H): number {
  const s = spans(h)[i];
  return s.start + t * s.lens;
}

/**
 * ホイールを、段に捕まるまでまわす(1 ノッチ = 100px、最大 40 回)。捕まった位置を返す。
 *
 * **1 回の巨大な delta では段に受け止められない**のが正しい ── 段は入力 1 回ぶんの
 * 手ごたえであって、遠くを名指した入力を止めるものではない。実際のホイールも
 * トラックパッドも、小さな delta を高頻度で配ってくる。
 */
function wheelUntilHeld(track: DetentTrack): number {
  for (let i = 0; i < 40 && !track.holding; i++) track.push(100);
  return track.target;
}

describe('buildDetents ── 段の表', () => {
  it('段は 16 個 ── 序章の踊り場 1 + 章 7 ×(読む位置 + 踊り場) + 終章 1', () => {
    expect(buildDetents(spans(), scrollMaxOf())).toHaveLength(16);
  });

  it('序章は「読む位置」の段を持たない(スクラブ長 30svh に粒度が無い)', () => {
    const d = buildDetents(spans(), scrollMaxOf());
    // 序章の範囲に入る段は踊り場ひとつだけ
    const inPrologue = d.filter((x) => x.from < at(1, 0));
    expect(inPrologue).toHaveLength(1);
    expect(inPrologue[0].from).toBeCloseTo(at(0, 0.72), 6); // OUT_T_PROLOGUE
  });

  it('読む位置は文字の退場点から ARROW_STEP 手前(↓ 1 打鍵で必ず文字が退く)', () => {
    const d = buildDetents(spans(), scrollMaxOf());
    const outY = at(1, 0.86);
    const read = d.find((x) => x.to === outY);
    expect(read).toBeDefined();
    expect(outY - (read as Detent).at).toBe(ARROW_STEP);
  });

  it('背の高い画面では、ヒステリシスのほうが手前になるのでそちらを採る', () => {
    /*
      読む位置は 2 つの保証を同時に満たす必要がある。
        ARROW_STEP 以上手前 → ↓ 1 打鍵で文字が退く
        backOutT 以前       → 踊り場から戻ったとき文字が必ず出直す
      h = 1600 では lens = 1920、0.04 × 1920 = 76.8px > ARROW_STEP 64 なので、
      64px だけ戻す置き方だと**ヒステリシスの帯に埋まり、戻っても文字が出ない**。
    */
    const h = 1600;
    const d = buildDetents(spans(h), scrollMaxOf(h));
    const outY = at(1, 0.86, h);
    const read = d.find((x) => x.to === outY) as Detent;
    expect(outY - read.at).toBeGreaterThan(ARROW_STEP);
    expect(read.at).toBeLessThanOrEqual(at(1, 0.82, h)); // backOutT 以前
  });

  it('どの画面高でも、読む位置は必ず両方の保証を満たす', () => {
    for (const h of [560, 640, 720, 800, 900, 1080, 1200, 1440, 1600, 2160]) {
      const d = buildDetents(spans(h), scrollMaxOf(h));
      for (let i = 1; i <= 7; i++) {
        const outY = at(i, 0.86, h);
        const read = d.find((x) => x.to === outY) as Detent;
        expect(outY - read.at).toBeGreaterThanOrEqual(ARROW_STEP);
        expect(read.at).toBeLessThanOrEqual(at(i, 0.82, h) + 1e-9);
      }
    }
  });

  it('踊り場は「文字が退いてから、次章の文字が立つまで」', () => {
    const d = buildDetents(spans(), scrollMaxOf());
    const fig = d.find((x) => x.from === at(1, 0.86)) as Detent;
    expect(fig.to).toBeCloseTo(at(2, 0.06), 6);
    // 着地点は退場点より後ろ = 文字が確実に退いている
    expect(fig.at).toBeGreaterThan(at(1, 0.86));
  });

  it('終章の段は昇華の完了点(smoothstep の導関数が 0 になる位置)', () => {
    const d = buildDetents(spans(), scrollMaxOf());
    const last = d[d.length - 1];
    expect(last.at).toBeCloseTo(at(8, EPILOGUE_STOP_T), 6);
    expect(last.to).toBe(scrollMaxOf()); // 末尾はブラウザの硬い止まり
  });

  it('受け持ち範囲は重ならず、昇順に並ぶ', () => {
    const d = buildDetents(spans(), scrollMaxOf());
    for (let i = 0; i < d.length; i++) {
      expect(d[i].from).toBeLessThan(d[i].to);
      expect(d[i].at).toBeGreaterThanOrEqual(d[i].from);
      expect(d[i].at).toBeLessThan(d[i].to);
      if (i > 0) expect(d[i].from).toBeGreaterThanOrEqual(d[i - 1].to);
    }
  });
});

describe('DetentTrack ── 踏み面は連続、蹴上げは 1 段', () => {
  it('章の中(モーフとカメラが動く区間)は自由 ── 波面のピークで止まれる', () => {
    const { track } = trackOf();
    track.reset(at(1, 0)); // 第〇章の頭
    track.push(192); // 波面のピーク localT 0.20 は 192px 先
    expect(track.target).toBeCloseTo(at(1, 0.2), 6);
    expect(track.holding).toBe(false);
    // さらに小刻みに動かしても、どこにでも止まれる
    track.push(7);
    expect(track.target).toBeCloseTo(at(1, 0.2) + 7, 6);
  });

  it('下っていくと「読む位置」で受け止められる(振り付けが完成する)', () => {
    const { track } = trackOf();
    track.reset(at(1, 0.5));
    // ホイールをまわし続ける ── 退場点の手前で必ず受け止められる
    expect(wheelUntilHeld(track)).toBeCloseTo(at(1, 0.86) - ARROW_STEP, 6);
    expect(track.target).toBeLessThan(at(1, 0.86)); // まだ文字は出ている
  });

  it('読む位置からホイール 1 ノッチで「図だけ」へ ── これが微調整', () => {
    const { track } = trackOf();
    track.reset(at(1, 0.5));
    const read = wheelUntilHeld(track);

    track.push(100); // 1 ノッチ
    expect(track.target).toBeGreaterThan(at(1, 0.86)); // 文字が退いている
    expect(track.target).not.toBe(read);
    expect(track.holding).toBe(true);
  });

  it('↓ 1 打鍵でも同じ ── 段の抜け幅は ARROW_STEP と同じにしてある', () => {
    expect(DETENT_RELEASE).toBe(ARROW_STEP);
    const { track } = trackOf();
    track.reset(at(1, 0.5));
    wheelUntilHeld(track);
    track.push(ARROW_STEP);
    expect(track.target).toBeGreaterThan(at(1, 0.86));
  });

  it('死んだ 124svh が 1 段になる ── 踊り場から次章の文字が立つ位置へ', () => {
    const { track } = trackOf();
    track.reset(at(1, 0.5));
    wheelUntilHeld(track); // 読む位置
    track.push(100); // 図だけ
    const fig = track.target;

    track.push(100); // もう 1 段
    expect(track.target).toBeGreaterThanOrEqual(at(2, 0.06));
    // 従来はここまで 992px(= 踊り場の幅)を回す必要があった
    expect(track.target - fig).toBeGreaterThan(800);
  });

  it('閾値に届かない入力では動かない(これが段の手ごたえ)', () => {
    const { track } = trackOf();
    track.reset(at(1, 0.5));
    const read = wheelUntilHeld(track);
    track.push(20);
    track.push(20);
    expect(track.target).toBe(read);
    track.push(20); // 合計 60 < 64
    expect(track.target).toBe(read);
    track.push(20); // 合計 80 ≥ 64 → 抜ける
    expect(track.target).not.toBe(read);
  });

  it('抜けるときの余りは持ち越す(入力を捨てない)', () => {
    const { track } = trackOf();
    track.reset(at(1, 0.5));
    wheelUntilHeld(track);
    track.push(100); // 踊り場へ

    // 踊り場から大きく抜けると、余り(300 − 64 = 236)がそのまま先へ乗る
    const exit = at(2, 0.06); // 踊り場の受け持ちの終わり = 次章の文字が立つ点
    track.push(300);
    expect(track.target).toBeCloseTo(exit + (300 - DETENT_RELEASE), 6);
  });

  it('戻りも同じ段数で戻る(可逆)', () => {
    const { track } = trackOf();
    track.reset(at(1, 0.5));
    const read = wheelUntilHeld(track);
    track.push(100); // → 図だけ
    track.push(-100); // → 読む位置へ戻る
    expect(track.target).toBeCloseTo(read, 6);
  });

  it('Space / PageDown は次の段へ、PageUp は前の段へ', () => {
    const { track, detents } = trackOf();
    track.reset(0);
    track.stepDetent(1);
    expect(track.target).toBeCloseTo(detents[0].at, 6);
    track.stepDetent(1);
    expect(track.target).toBeCloseTo(detents[1].at, 6);
    track.stepDetent(-1);
    expect(track.target).toBeCloseTo(detents[0].at, 6);
  });

  it('段が尽きたら端へ(キーボードだけが取り残されない)', () => {
    const { track, max } = trackOf();
    track.reset(max - 1);
    track.stepDetent(1);
    expect(track.target).toBe(max);
    track.reset(0);
    track.stepDetent(-1);
    expect(track.target).toBe(0);
  });

  it('Home / End は段を素通りする ── 末尾に立てなくなってはいけない', () => {
    const { track, max } = trackOf();
    track.reset(at(8, 0.5));
    track.to(max);
    expect(track.target).toBe(max);
    expect(track.holding).toBe(false);
    track.to(0);
    expect(track.target).toBe(0);
  });

  it('外部スクロール(タッチ・スクロールバー・履歴復元)は段に吸わせない', () => {
    const { track } = trackOf();
    // 読む位置の受け持ち範囲のど真ん中へ、外から置かれた
    const inside = at(1, 0.86) - 10;
    track.reset(inside);
    expect(track.target).toBe(inside); // 1px も動かさない
    expect(track.holding).toBe(false);
  });

  it('段の表が組み直されても読者は動かない(resize / fonts.ready)', () => {
    const { track } = trackOf();
    track.reset(at(1, 0.5));
    wheelUntilHeld(track);
    const before = track.target;

    const h2 = 900;
    track.setDetents(buildDetents(spans(h2), scrollMaxOf(h2)), scrollMaxOf(h2));
    expect(track.target).toBe(before);
  });

  it('力を加えない ── 入力が無ければ目標は 1px も動かない', () => {
    const { track } = trackOf();
    track.reset(at(1, 0.5));
    const held = wheelUntilHeld(track);
    for (let i = 0; i < 100; i++) track.push(0);
    expect(track.target).toBe(held);
  });

  it('上限の外へは出ない', () => {
    const { track, max } = trackOf();
    track.reset(max);
    for (let i = 0; i < 50; i++) track.push(500);
    expect(track.target).toBeLessThanOrEqual(max);
    track.reset(0);
    for (let i = 0; i < 50; i++) track.push(-500);
    expect(track.target).toBeGreaterThanOrEqual(0);
  });

  it('先頭から末尾まで、ホイールのノッチ数が減る(死んだ区間を畳んだぶん)', () => {
    const { track, max } = trackOf();
    track.reset(0);
    let n = 0;
    while (track.target < max && n < 500) {
      track.push(100);
      n++;
    }
    const plain = Math.ceil(max / 100); // 段が無ければ 1 ノッチ = 100px
    expect(plain).toBe(144);
    expect(n).toBe(74);
    // 畳んだのは踊り場 8 本ぶん。読むところの距離は 1px も削っていない
    expect(plain - n).toBe(70);
  });

  it('トラックパッドの小さな delta には手ごたえが出る(64px 積んではじめて動く)', () => {
    const { track } = trackOf();
    track.reset(at(1, 0.5));
    const read = wheelUntilHeld(track);
    const offsets: number[] = [];
    for (let i = 0; i < 5; i++) {
      track.push(20);
      offsets.push(track.target - read);
    }
    // 20 × 3 = 60 < 64 までは動かず、4 回目(80)で抜ける
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(0);
    expect(offsets[2]).toBe(0);
    expect(offsets[3]).toBeGreaterThan(0);
  });

  it('章の頭から終章まで、段を数えると 16 段(格子が全章で揃っている)', () => {
    const { track, max } = trackOf();
    track.reset(0);
    const stops: number[] = [];
    for (let i = 0; i < 40; i++) {
      const before = track.target;
      track.stepDetent(1);
      if (track.target === before || track.target === max) break;
      stops.push(track.target);
    }
    expect(stops).toHaveLength(16);
    // 章と章の「読む位置」の間隔は、どこも同じ(220svh = 1760px @h800)
    const reads = stops.filter((_, i) => i >= 1 && (i - 1) % 2 === 0);
    for (let i = 1; i < reads.length - 1; i++) {
      expect(reads[i] - reads[i - 1]).toBeCloseTo(2.2 * H, 6);
    }
  });
});

describe('snapTarget ── タッチ(指が離れて慣性も終わったあと)', () => {
  it('踏み面では何もしない ── 読者が図を見て止まった場所は動かさない', () => {
    const { track } = trackOf();
    // モーフの最中、波面のピーク
    expect(track.snapTarget(at(1, 0.2))).toBeNull();
    // 読んでいる最中
    expect(track.snapTarget(at(1, 0.5))).toBeNull();
    // 次章に入った直後
    expect(track.snapTarget(at(2, 0.1))).toBeNull();
  });

  it('踊り場の前半で止まったら「図だけ」の位置へ', () => {
    const { track, detents } = trackOf();
    const fig = detents.find((d) => d.from === at(1, 0.86)) as Detent;
    expect(track.snapTarget(fig.at + 40)).toBeCloseTo(fig.at, 6);
    expect(track.snapTarget(fig.from + 5)).toBeCloseTo(fig.at, 6);
  });

  it('踊り場の後半で止まったら、次章の文字が立つ位置へ送る', () => {
    const { track, detents } = trackOf();
    const fig = detents.find((d) => d.from === at(1, 0.86)) as Detent;
    expect(track.snapTarget(fig.to - 40)).toBeCloseTo(fig.to, 6);
    // 中点のすぐ先
    expect(track.snapTarget((fig.at + fig.to) / 2 + 1)).toBeCloseTo(fig.to, 6);
  });

  it('もう段に居るなら何もしない ── 自分の寄せが生む scrollend でループしない', () => {
    const { track, detents } = trackOf();
    const fig = detents.find((d) => d.from === at(1, 0.86)) as Detent;
    expect(track.snapTarget(fig.at)).toBeNull();
    // scrollTo の着地は端末画素へ丸められる。その幅では動かない
    expect(track.snapTarget(fig.at + DETENT_SNAP_EPSILON - 0.5)).toBeNull();
    expect(track.snapTarget(fig.at - DETENT_SNAP_EPSILON + 0.5)).toBeNull();
  });

  it('読む位置の受け持ちの後半は、解き直して踊り場の着地点まで行く(境界で止まらない)', () => {
    const { track, detents } = trackOf();
    const outY = at(1, 0.86);
    const read = detents.find((d) => d.to === outY) as Detent;
    const fig = detents.find((d) => d.from === outY) as Detent;
    // 読む位置の受け持ち [read.at, outY) の後半 → outY へ → そこは踊り場の前半 → fig.at
    expect(track.snapTarget(outY - 5)).toBeCloseTo(fig.at, 6);
    // 前半なら読む位置そのもの
    expect(track.snapTarget(read.at + 5)).toBeCloseTo(read.at, 6);
  });

  it('終章の段でも同じ ── 前半なら昇華の完了点、後半なら末尾', () => {
    const { track, max } = trackOf();
    const stop = at(8, EPILOGUE_STOP_T);
    expect(track.snapTarget(stop + 20)).toBeCloseTo(stop, 6);
    expect(track.snapTarget(max - 20)).toBeCloseTo(max, 6);
  });

  it('上限と下限を超えない', () => {
    const { track, max } = trackOf();
    const v = track.snapTarget(max);
    expect(v === null || (v >= 0 && v <= max)).toBe(true);
    const w = track.snapTarget(0);
    expect(w === null || (w >= 0 && w <= max)).toBe(true);
  });

  it('段が無ければ(表が空)何もしない', () => {
    const t = new DetentTrack();
    t.setDetents([], 10000);
    expect(t.snapTarget(1234)).toBeNull();
  });
});
