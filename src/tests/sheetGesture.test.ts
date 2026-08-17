import { describe, it, expect } from 'vitest';
import {
  decideSwipe,
  decideWheel,
  SWIPE_MIN_PX,
  WHEEL_MIN_PX,
} from '../ui/components/controls/sheetGesture';
import { normalizeWheel } from '../core/scrollGlide';

describe('掃きの閾値', () => {
  it('閾値の 1px 手前は掃きではない', () => {
    expect(decideSwipe(0, -(SWIPE_MIN_PX - 1))).toBe('tap');
    expect(decideSwipe(0, SWIPE_MIN_PX - 1)).toBe('tap');
  });

  it('ちょうど閾値で掃きになる(境界を含む)', () => {
    expect(decideSwipe(0, -SWIPE_MIN_PX)).toBe('open');
    expect(decideSwipe(0, SWIPE_MIN_PX)).toBe('close');
  });

  it('閾値を越えれば当然掃き', () => {
    expect(decideSwipe(0, -(SWIPE_MIN_PX + 1))).toBe('open');
    expect(decideSwipe(0, SWIPE_MIN_PX + 1)).toBe('close');
  });

  it('動いていない指はタップ', () => {
    expect(decideSwipe(0, 0)).toBe('tap');
  });
});

describe('掃きの向き', () => {
  it('上へ掃けば開く、下へ掃けば閉じる ── トグルではない', () => {
    expect(decideSwipe(0, -80)).toBe('open');
    expect(decideSwipe(0, 80)).toBe('close');
  });

  it('斜めでも縦が優勢なら通る', () => {
    expect(decideSwipe(10, -40)).toBe('open');
    expect(decideSwipe(-10, 40)).toBe('close');
  });

  it('横が優勢な振りは弾く(タブ帯を送った指の行き過ぎ)', () => {
    expect(decideSwipe(40, 30)).toBe('tap');
    expect(decideSwipe(-40, -30)).toBe('tap');
  });

  it('縦横が同値ならどちらとも言えないので動かさない', () => {
    expect(decideSwipe(40, -40)).toBe('tap');
    expect(decideSwipe(-40, 40)).toBe('tap');
  });
});

describe('ホイール', () => {
  it('下へ送れば開き、上へ送れば閉じる', () => {
    expect(decideWheel(100)).toBe('open');
    expect(decideWheel(-100)).toBe('close');
  });

  it('取るに足らない量は無視する', () => {
    expect(decideWheel(WHEEL_MIN_PX - 1)).toBe('tap');
    expect(decideWheel(-(WHEEL_MIN_PX - 1))).toBe('tap');
    expect(decideWheel(0)).toBe('tap');
  });

  it('ちょうど閾値で通る', () => {
    expect(decideWheel(WHEEL_MIN_PX)).toBe('open');
    expect(decideWheel(-WHEEL_MIN_PX)).toBe('close');
  });

  it('行単位(Firefox)のノッチが正規化を通れば閾値を越える', () => {
    // 素の deltaY は 3 で、px として読むと閾値(6)に届かない ── ここが罠
    expect(decideWheel(3)).toBe('tap');
    expect(decideWheel(normalizeWheel(3, 1, 812))).toBe('open');
    expect(decideWheel(normalizeWheel(-3, 1, 812))).toBe('close');
  });

  it('px 単位(Chrome/Safari)のノッチはそのまま通る', () => {
    expect(decideWheel(normalizeWheel(100, 0, 812))).toBe('open');
    expect(decideWheel(normalizeWheel(-100, 0, 812))).toBe('close');
  });
});
