import { describe, expect, it } from 'vitest';

import {
  PERSPECTIVE_CAPTIONS,
  PERSPECTIVE_TAGLINES,
  perspectiveCaption,
  perspectiveTagline,
} from '../ui/content';

/** パネルで実際に選べる範囲(perspectiveExhibit の OBSERVER/TARGET と同じ) */
const OBSERVERS = [2, 3, 4];
const TARGETS = [2, 3, 4, 5, 6];
const MODES = ['slice', 'shadow', 'xray'];

/** m ≠ n の到達しうる全組 */
function reachable(): [number, number][] {
  const out: [number, number][] = [];
  for (const m of OBSERVERS) for (const n of TARGETS) if (m !== n) out.push([m, n]);
  return out;
}

describe('perspectiveTagline', () => {
  it('到達しうる 12 組すべてに専用の一文がある(フォールバックへ落ちない)', () => {
    const combos = reachable();
    expect(combos.length).toBe(12);
    for (const [m, n] of combos) {
      expect(PERSPECTIVE_TAGLINES[`${m}:${n}`], `m=${m} n=${n} の副題が無い`).toBeTypeOf('string');
    }
  });

  it('既定の入口(m=3 / n=4)の一文は変えない', () => {
    // この展示の核。設定に追従させても、既定ではこれが出ること
    expect(perspectiveTagline(3, 4)).toBe('あなたはテッセラクトに対して、二次元人だ');
  });

  it('組が違えば一文も違う ── 設定を変えたのに同じ文、が起きない', () => {
    const seen = new Set(reachable().map(([m, n]) => perspectiveTagline(m, n)));
    expect(seen.size).toBe(12);
  });

  it('表に無い組でも必ず何かを返し、見下ろす側かどうかで言い分ける', () => {
    expect(perspectiveTagline(5, 9)).toContain('9');
    expect(perspectiveTagline(9, 5)).toContain('見下ろ');
  });
});

describe('perspectiveCaption', () => {
  it('到達しうる全 (モード, m, n) で空文字にならない', () => {
    for (const mode of MODES) {
      for (const [m, n] of reachable()) {
        // モードの整合(低い側から = 断面/影、高い側から = X線)だけを見る
        if (mode === 'xray' ? m <= n : m >= n) continue;
        expect(perspectiveCaption(mode, m, n), `${mode}:${m}:${n}`).not.toBe('');
      }
    }
  });

  it('個別の組が無ければモード共通の一文へ落ちる', () => {
    expect(PERSPECTIVE_CAPTIONS['shadow:4:5']).toBeUndefined();
    expect(perspectiveCaption('shadow', 4, 5)).toBe(PERSPECTIVE_CAPTIONS['shadow']);
  });
});
