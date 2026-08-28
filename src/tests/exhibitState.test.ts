import { describe, expect, it } from 'vitest';

import {
  CLIFFORD_DEFAULTS,
  EXHIBIT_CODECS,
  EXHIBIT_DEFAULTS,
  HOPF_DEFAULTS,
  PERSPECTIVE_DEFAULTS,
  POLYTOPE_DEFAULTS,
  decodeState,
  encodeState,
  resolveOverrides,
} from '../core/exhibitState';
import type { ExhibitId } from '../core/gallery';

/**
 * 展示のパラメータを URL に載せる層(Phase 44)。
 *
 * `src/tests/` に route 関連の試験は 1 本も無かった。ここが守るのは
 * **壊れた入力に対する振る舞い**である ── 共有リンクは他人の手を経て届くので、
 * 「投げない・落とさない・既定へ帰る」が仕様そのものになる。
 *
 * (`route.ts` 側は `window` / `history` に触るのでこの環境では試験できない。
 *  だから符号化と復号を DOM も three も知らない純モジュールへ切り出してある。)
 */

const IDS: ExhibitId[] = ['polytope', 'perspective', 'clifford', 'hopf'];

describe('encodeState', () => {
  it('出荷時の既定は空文字 ── 何も触らなければ URL は今日と同じ', () => {
    for (const id of IDS) {
      expect(encodeState(id, EXHIBIT_DEFAULTS[id]), id).toBe('');
    }
  });

  it('既定と違う項目だけを書く', () => {
    expect(encodeState('polytope', { ...POLYTOPE_DEFAULTS, n: 9 })).toBe('n-9');
    expect(encodeState('perspective', { ...PERSPECTIVE_DEFAULTS, observer: 5, target: 6 })).toBe(
      'm-5_n-6',
    );
    expect(encodeState('hopf', { ...HOPF_DEFAULTS, distribution: 'great' })).toBe('dist-great');
  });

  it('urlencode を素通りする ── % が 1 文字も出ない', () => {
    /*
      区切りに `:` / `;` / `,` を選ぶと %3A / %3B / %2C になり、共有リンクが
      読めなくなる。機械に止めさせる。
    */
    const dirty: Record<ExhibitId, Record<string, unknown>> = {
      polytope: { ...POLYTOPE_DEFAULTS, family: 'orthoplex', n: 10, projection: 'ortho', spin: [1, 18, 35] },
      perspective: { ...PERSPECTIVE_DEFAULTS, observer: 5, target: 6, mode: 'shadow', rotate: false },
      clifford: { ...CLIFFORD_DEFAULTS, circlesU: 64, omega1: 0.375, precession: 0.125, isoclinic: true },
      hopf: { ...HOPF_DEFAULTS, fiberCount: 1200, distribution: 'fibonacci', omega2: 0.5, isoclinic: false },
    };
    for (const id of IDS) {
      const encoded = encodeState(id, dirty[id]);
      expect(encoded, id).not.toBe('');
      expect(encodeURIComponent(encoded), `${id}: ${encoded}`).toBe(encoded);
      expect(new URLSearchParams({ p: encoded }).toString(), id).toBe(`p=${encoded}`);
    }
  });
});

describe('decodeState', () => {
  it('往復する', () => {
    const cases: [ExhibitId, Record<string, unknown>][] = [
      ['polytope', { family: 'simplex', n: 5, projection: 'ortho' }],
      ['polytope', { spin: [1, 2, 18] }],
      ['perspective', { observer: 5, target: 6, mode: 'shadow', rotate: false }],
      ['clifford', { circlesU: 48, circlesV: 12, isoclinic: true, omega1: 0.4 }],
      ['hopf', { fiberCount: 24, distribution: 'great', precession: 0.125 }],
    ];
    for (const [id, patch] of cases) {
      const params = { ...EXHIBIT_DEFAULTS[id], ...patch };
      expect(decodeState(id, encodeState(id, params)), `${id} ${JSON.stringify(patch)}`).toEqual(
        patch,
      );
    }
  });

  it('未知のキーは黙って無視する ── 新しい Phase の URL を古いビルドが開いても落ちない', () => {
    expect(decodeState('polytope', 'n-9_futurething-42')).toEqual({ n: 9 });
    expect(decodeState('polytope', 'futurething-42')).toEqual({});
  });

  it('壊れた値はそのペアだけ捨て、決して投げない', () => {
    const broken = [
      'n-abc',
      'n-999',
      'n--5',
      'n-',
      '-9',
      '',
      '___',
      'n',
      'n-9_',
      '_n-9',
      'fam-banana',
      'spin-1.abc.3',
      'spin-1.999',
      `junk-${'x'.repeat(1000)}`,
    ];
    for (const raw of broken) {
      expect(() => decodeState('polytope', raw), raw).not.toThrow();
      const out = decodeState('polytope', raw);
      // 通ってよいのは範囲内の n だけ
      expect(Object.keys(out).filter((k) => k !== 'n'), raw).toEqual([]);
    }
    expect(decodeState('polytope', 'n-9_')).toEqual({ n: 9 });
  });

  it('union の外の族は捨てる ── makePolytope の唯一の即クラッシュ経路', () => {
    /*
      `makePolytope` の switch には default 節が無く、未知の族では undefined を
      返して `poly.vertices` で落ちる。ここが唯一の関門である。
    */
    expect(decodeState('polytope', 'fam-banana')).toEqual({});
    expect(decodeState('polytope', 'fam-cube')).toEqual({ family: 'cube' });
    expect(decodeState('hopf', 'dist-spiral')).toEqual({});
    expect(decodeState('perspective', 'mode-telepathy')).toEqual({});
  });

  it('範囲外の数値は捨てる(展示側の clamp に頼らない)', () => {
    expect(decodeState('polytope', 'n-2')).toEqual({});
    expect(decodeState('polytope', 'n-11')).toEqual({});
    expect(decodeState('perspective', 'm-1')).toEqual({});
    expect(decodeState('perspective', 'm-9')).toEqual({});
    expect(decodeState('hopf', 'w1-99')).toEqual({});
    expect(decodeState('clifford', 'u-1')).toEqual({});
  });

  it('回転平面の空の選択と「既定に従う」を区別する', () => {
    // null(既定に従う)は書かない。空の選択は spin-x として往復する
    expect(encodeState('polytope', { ...POLYTOPE_DEFAULTS, spin: null })).toBe('');
    expect(encodeState('polytope', { ...POLYTOPE_DEFAULTS, spin: [] })).toBe('spin-x');
    expect(decodeState('polytope', 'spin-x')).toEqual({ spin: [] });
    expect(decodeState('polytope', '')).toEqual({});
  });

  it('平面キーは重複を落として昇順に並ぶ(同じ状態なら同じ URL)', () => {
    const a = encodeState('polytope', { ...POLYTOPE_DEFAULTS, spin: [18, 1, 18, 2] });
    const b = encodeState('polytope', { ...POLYTOPE_DEFAULTS, spin: [1, 2, 18] });
    expect(a).toBe(b);
    expect(a).toBe('spin-1.2.18');
  });
});

describe('resolveOverrides', () => {
  it('p が無い既存リンクは出荷時の既定で開く', () => {
    for (const id of IDS) {
      expect(resolveOverrides(id, null), id).toEqual(EXHIBIT_DEFAULTS[id]);
    }
  });

  it('差分だけを既定へ重ねる', () => {
    expect(resolveOverrides('polytope', 'n-9')).toEqual({ ...POLYTOPE_DEFAULTS, n: 9 });
  });
});

describe('符号化表', () => {
  it('展示ごとに短い名前が重複しない', () => {
    for (const id of IDS) {
      const shorts = EXHIBIT_CODECS[id].map((f) => f.short);
      expect(new Set(shorts).size, id).toBe(shorts.length);
    }
  });

  it('短い名前に区切り文字を含まない', () => {
    // `-` を含むと「最初の - で切る」規則に噛み合わず、`_` を含むとペアが割れる
    for (const id of IDS) {
      for (const field of EXHIBIT_CODECS[id]) {
        expect(field.short, `${id}.${field.short}`).not.toContain('-');
        expect(field.short, `${id}.${field.short}`).not.toContain('_');
        expect(field.short.length, `${id}.${field.short}`).toBeGreaterThan(0);
      }
    }
  });

  it('4 展示すべてに表がある ── 展示を足して書き忘れたら型で止まる', () => {
    // Record<ExhibitId, …> なのでコンパイル時にも守られる。値としても確かめる
    for (const id of IDS) {
      expect(EXHIBIT_CODECS[id].length, id).toBeGreaterThan(0);
      expect(EXHIBIT_DEFAULTS[id], id).toBeTypeOf('object');
    }
  });
});
