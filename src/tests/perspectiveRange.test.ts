import { describe, expect, it } from 'vitest';

import {
  OBSERVER_MAX,
  OBSERVER_MIN,
  TARGET_MAX,
  TARGET_MIN,
  XRAY_TARGET_MAX,
  isReachable,
  reachablePairs,
  resolveMode,
  resolvePerspective,
} from '../ui/perspectiveRange';

/**
 * PERSPECTIVE の「取りうる組」の規則(Phase 42)。
 *
 * この 1 本が守っているのは **規則の実装がひとつしか無いこと**である。
 * パネルの灰色化・`rebuild()` の正規化・キャプションの走査は、どれも
 * `isReachable` / `resolvePerspective` を通る。ここが緑なら、三者はずれない。
 */

describe('isReachable', () => {
  it('m = n は取らない', () => {
    for (let d = TARGET_MIN; d <= OBSERVER_MAX; d++) {
      expect(isReachable(d, d), `m=n=${d}`).toBe(false);
    }
  });

  it('低い側から覗く組は範囲内ならすべて取れる', () => {
    for (let m = OBSERVER_MIN; m <= OBSERVER_MAX; m++) {
      for (let n = m + 1; n <= TARGET_MAX; n++) {
        expect(isReachable(m, n), `m=${m} n=${n}`).toBe(true);
      }
    }
  });

  it('見下ろせるのは演出された場面がある次元までだけ', () => {
    // X線俯瞰の場面は平面の家(n=2)と 3D の家(n=3)の 2 つしか無い。
    // ここを緩めると buildXrayScene が n=4 でも 3D の家を出す(罠 #22 の再発)
    expect(isReachable(4, 3)).toBe(true);
    expect(isReachable(5, 3)).toBe(true);
    expect(isReachable(5, 2)).toBe(true);
    expect(isReachable(5, 4)).toBe(false);
    for (let m = OBSERVER_MIN; m <= OBSERVER_MAX; m++) {
      for (let n = XRAY_TARGET_MAX + 1; n < m; n++) {
        expect(isReachable(m, n), `見下ろす先が n=${n}`).toBe(false);
      }
    }
  });

  it('範囲の外は取らない', () => {
    expect(isReachable(OBSERVER_MIN - 1, 4)).toBe(false); // m=1(線の住人)
    expect(isReachable(OBSERVER_MAX + 1, 4)).toBe(false);
    expect(isReachable(3, TARGET_MAX + 1)).toBe(false);
  });
});

describe('reachablePairs', () => {
  it('列挙と判定が一致する', () => {
    const listed = new Set(reachablePairs().map(([m, n]) => `${m}:${n}`));
    for (let m = OBSERVER_MIN - 1; m <= OBSERVER_MAX + 1; m++) {
      for (let n = TARGET_MIN - 1; n <= TARGET_MAX + 1; n++) {
        expect(listed.has(`${m}:${n}`), `m=${m} n=${n}`).toBe(isReachable(m, n));
      }
    }
  });

  it('Phase 42 で m=5 の組が入り、(5,4) だけが落ちる', () => {
    const listed = new Set(reachablePairs().map(([m, n]) => `${m}:${n}`));
    expect(listed.has('5:6')).toBe(true);
    expect(listed.has('5:3')).toBe(true);
    expect(listed.has('5:2')).toBe(true);
    expect(listed.has('5:4')).toBe(false);
  });
});

describe('resolveMode', () => {
  it('高 → 低 は X線俯瞰しかない', () => {
    expect(resolveMode(4, 3, 'slice')).toBe('xray');
    expect(resolveMode(5, 2, 'shadow')).toBe('xray');
  });

  it('低 → 高 で X線俯瞰は選べない ── 断面へ落とす', () => {
    expect(resolveMode(3, 4, 'xray')).toBe('slice');
    expect(resolveMode(3, 4, 'shadow')).toBe('shadow');
  });
});

describe('resolvePerspective', () => {
  it('どんな入力からでも到達しうる組が出てくる', () => {
    for (let m = -2; m <= 9; m++) {
      for (let n = -2; n <= 9; n++) {
        for (const requested of ['slice', 'shadow', 'xray'] as const) {
          const r = resolvePerspective(m, n, requested);
          expect(isReachable(r.m, r.n), `(${m},${n}) → (${r.m},${r.n})`).toBe(true);
          expect(r.mode).toBe(resolveMode(r.m, r.n, requested));
        }
      }
    }
  });

  it('到達しうる組はそのまま通す(勝手に動かさない)', () => {
    for (const [m, n] of reachablePairs()) {
      const r = resolvePerspective(m, n, 'slice');
      expect([r.m, r.n], `(${m},${n})`).toEqual([m, n]);
    }
  });

  it('動かすのは n の側 ── OBSERVER は保つ', () => {
    // m=5 / n=4 は「見下ろす先に場面が無い」組。観測者を下げずに対象を上げる
    expect(resolvePerspective(5, 4, 'slice')).toEqual({ m: 5, n: 6, mode: 'slice' });
    // m = n も従来どおり n をずらして解消する
    expect(resolvePerspective(3, 3, 'slice').m).toBe(3);
    expect(resolvePerspective(3, 3, 'slice').n).toBe(4);
  });

  it('小数・範囲外も丸めてから規則へ通す', () => {
    expect(resolvePerspective(3.4, 4.6, 'slice')).toEqual({ m: 3, n: 5, mode: 'slice' });
    expect(resolvePerspective(1, 4, 'slice').m).toBe(OBSERVER_MIN);
    expect(resolvePerspective(99, 99, 'slice').m).toBe(OBSERVER_MAX);
  });
});
