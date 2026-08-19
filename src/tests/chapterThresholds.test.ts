import { describe, it, expect } from 'vitest';
import {
  BACK_OUT_T_CHAPTER,
  BACK_OUT_T_PROLOGUE,
  BACK_T,
  HYSTERESIS,
  IN_T,
  OUT_T_CHAPTER,
  OUT_T_PROLOGUE,
  chapterMove,
  thresholdsFor,
  type ChapterThresholds,
} from '../ui/chapterThresholds';

/** 1 章ぶんの状態機械。localT の列を流して、出し入れの回数を数える */
function run(
  th: ChapterThresholds,
  ts: readonly number[],
  startShown = false,
): { shown: boolean; reveals: number; hides: number } {
  let shown = startShown;
  let reveals = 0;
  let hides = 0;
  for (const t of ts) {
    const move = chapterMove(shown, t, th.inT, th.backT, th.outT, th.backOutT);
    if (move === 1) {
      shown = true;
      reveals++;
    } else if (move === -1) {
      shown = false;
      hides++;
    }
  }
  return { shown, reveals, hides };
}

const CHAPTER = thresholdsFor('chapter');
const PROLOGUE = thresholdsFor('prologue');
const EPILOGUE = thresholdsFor('epilogue');

describe('しきい値の定義', () => {
  it('入り側と出側のヒステリシス幅が等しい', () => {
    expect(IN_T - BACK_T).toBeCloseTo(HYSTERESIS, 12);
    expect(OUT_T_CHAPTER - BACK_OUT_T_CHAPTER).toBeCloseTo(HYSTERESIS, 12);
    expect(OUT_T_PROLOGUE - BACK_OUT_T_PROLOGUE).toBeCloseTo(HYSTERESIS, 12);
  });

  it('終章は出ない ── localT が 1 に丸められる以上、到達しない値である', () => {
    expect(EPILOGUE.outT).toBeGreaterThan(1);
    expect(EPILOGUE.backOutT).toBeGreaterThan(1);
  });

  it('序章は巻き戻しでは消えない(戻る先がない)', () => {
    expect(PROLOGUE.inT).toBe(0);
    expect(PROLOGUE.backT).toBeLessThan(0);
  });
});

describe('chapterMove ── 章', () => {
  it('IN_T で出て、その手前では出ない', () => {
    expect(chapterMove(false, IN_T, CHAPTER.inT, CHAPTER.backT, CHAPTER.outT, CHAPTER.backOutT)).toBe(1);
    expect(
      chapterMove(false, IN_T - 1e-6, CHAPTER.inT, CHAPTER.backT, CHAPTER.outT, CHAPTER.backOutT),
    ).toBe(0);
  });

  it('OUT_T を超えて引っ込み、ちょうどでは引っ込まない', () => {
    expect(
      chapterMove(true, OUT_T_CHAPTER + 1e-6, CHAPTER.inT, CHAPTER.backT, CHAPTER.outT, CHAPTER.backOutT),
    ).toBe(-1);
    expect(
      chapterMove(true, OUT_T_CHAPTER, CHAPTER.inT, CHAPTER.backT, CHAPTER.outT, CHAPTER.backOutT),
    ).toBe(0);
  });

  it('BACK_T を下回ると巻き戻しで引っ込む', () => {
    expect(
      chapterMove(true, BACK_T - 1e-6, CHAPTER.inT, CHAPTER.backT, CHAPTER.outT, CHAPTER.backOutT),
    ).toBe(-1);
    expect(chapterMove(true, BACK_T, CHAPTER.inT, CHAPTER.backT, CHAPTER.outT, CHAPTER.backOutT)).toBe(0);
  });

  it('出たあとは BACK_OUT_T まで戻らないと出直さない(出側のヒステリシス)', () => {
    // 0.86 を超えて退場 → 0.83 ではまだ出ない → 0.82 で出直す
    expect(run(CHAPTER, [0.5, 0.9]).shown).toBe(false);
    expect(run(CHAPTER, [0.5, 0.9, 0.83]).shown).toBe(false);
    expect(run(CHAPTER, [0.5, 0.9, 0.83, BACK_OUT_T_CHAPTER]).shown).toBe(true);
  });
});

describe('境界のジッタ ── これが Phase 34a で直したもの', () => {
  /*
    退場点で数 px 揺れる状況。ヒステリシスが無かった頃は、揺れるたびに
    revealChapter が走って 1.29 秒の振り付けがフル再生されていた。
    OUT_T の一点で入りも出も判定していたのが原因。
  */
  it('OUT_T をまたぐ往復で、退場は 1 回きり・再入場は起きない', () => {
    const jitter: number[] = [0.5];
    for (let i = 0; i < 20; i++) jitter.push(OUT_T_CHAPTER + 0.001, OUT_T_CHAPTER - 0.001);

    const r = run(CHAPTER, jitter);
    expect(r.reveals).toBe(1); // 最初の 0.5 で 1 回出るだけ
    expect(r.hides).toBe(1);
    expect(r.shown).toBe(false);
  });

  it('IN_T をまたぐ往復でも、入場は 1 回きり(入り側は元から効いている)', () => {
    const jitter: number[] = [];
    for (let i = 0; i < 20; i++) jitter.push(IN_T + 0.001, IN_T - 0.001);

    const r = run(CHAPTER, jitter);
    expect(r.reveals).toBe(1);
    expect(r.hides).toBe(0);
    expect(r.shown).toBe(true);
  });

  it('ヒステリシス幅ぎりぎりの揺れ(0.039)でも往復しない', () => {
    const jitter: number[] = [0.5];
    const lo = OUT_T_CHAPTER - HYSTERESIS + 0.001;
    for (let i = 0; i < 20; i++) jitter.push(OUT_T_CHAPTER + 0.001, lo);

    expect(run(CHAPTER, jitter).reveals).toBe(1);
  });
});

describe('連続スクロールでは章がふつうに出入りする', () => {
  /** 章を 0 → 1 → 0 と往復。刻みはヒステリシス幅より細かくする */
  function sweep(from: number, to: number, step: number): number[] {
    const out: number[] = [];
    const sign = to > from ? 1 : -1;
    for (let t = from; sign * (to - t) >= 0; t += sign * step) out.push(t);
    return out;
  }

  it('下りで 1 回出て 1 回引っ込む', () => {
    const r = run(CHAPTER, sweep(0, 1, 0.005));
    expect(r.reveals).toBe(1);
    expect(r.hides).toBe(1);
    expect(r.shown).toBe(false);
  });

  it('巻き戻すと同じ道を戻る ── 出直して、また引っ込む', () => {
    const r = run(CHAPTER, [...sweep(0, 1, 0.005), ...sweep(1, 0, 0.005)]);
    expect(r.reveals).toBe(2);
    expect(r.hides).toBe(2);
    expect(r.shown).toBe(false);
  });
});

describe('chapterMove ── 序章と終章の特例', () => {
  it('序章はページ最上部(localT = 0)で読めている', () => {
    expect(
      chapterMove(false, 0, PROLOGUE.inT, PROLOGUE.backT, PROLOGUE.outT, PROLOGUE.backOutT),
    ).toBe(1);
  });

  it('序章は巻き戻しでは消えない', () => {
    const r = run(PROLOGUE, [0.5, 0.0]);
    expect(r.shown).toBe(true);
    expect(r.hides).toBe(0);
  });

  it('序章は OUT_T_PROLOGUE で退き、BACK_OUT_T_PROLOGUE で出直す', () => {
    expect(run(PROLOGUE, [0.5, OUT_T_PROLOGUE + 1e-6]).shown).toBe(false);
    expect(run(PROLOGUE, [0.5, 0.8, 0.7]).shown).toBe(false);
    expect(run(PROLOGUE, [0.5, 0.8, BACK_OUT_T_PROLOGUE]).shown).toBe(true);
  });

  it('終章は最後まで退かない(CTA を押せる状態のまま残す)', () => {
    const r = run(EPILOGUE, sweepTo1());
    expect(r.shown).toBe(true);
    expect(r.hides).toBe(0);
  });

  function sweepTo1(): number[] {
    const out: number[] = [];
    for (let t = 0; t <= 1.0001; t += 0.005) out.push(Math.min(t, 1));
    return out;
  }
});
