import { beforeEach, describe, expect, it } from 'vitest';

/**
 * URL と履歴の層(Phase 13 / 44、この試験は Phase 44b)。
 *
 * `exhibitState.test.ts` の頭注は「route.ts 側は window / history に触るので
 * この環境では試験できない」と書いていたが、**触るのはこの 2 つだけ**である。
 * 差し替えられるなら試験できる ── そして試験されていなかったからこそ、
 * 「共有リンクを受け取った人だけパラメータが URL に載らない」が
 * 3 つの緑のテストファイルの下をすり抜けた。
 *
 * スタブは**読み込みより先に**置く。`route.ts` は `EXHIBIT_REGISTRY` を値で
 * 使うので import 連鎖は `gallery.ts` 経由で three と 4 展示まで届くが、
 * どれもモジュール読み込みの時点では DOM を触らない ── 触るものが入った瞬間に
 * ここが落ちるのは、その事実を機械に見張らせているということでもある。
 */

interface HistoryCall {
  readonly kind: 'push' | 'replace' | 'back';
  readonly url: string;
  readonly state: unknown;
}

const calls: HistoryCall[] = [];
let href = 'https://dimension.test/';
/** いま居る履歴エントリの state。**素のナビゲーションでは null** ── これが要 */
let entryState: unknown = null;

const globals = globalThis as unknown as Record<string, unknown>;

globals.window = {
  get location(): { href: string } {
    return { href };
  },
  addEventListener(): void {},
  removeEventListener(): void {},
  matchMedia(): { matches: boolean; addEventListener(): void; removeEventListener(): void } {
    return { matches: false, addEventListener(): void {}, removeEventListener(): void {} };
  },
};

globals.history = {
  get state(): unknown {
    return entryState;
  },
  pushState(state: unknown, _title: string, url: string | URL): void {
    entryState = state;
    href = String(url);
    calls.push({ kind: 'push', url: href, state });
  },
  replaceState(state: unknown, _title: string, url: string | URL): void {
    entryState = state;
    href = String(url);
    calls.push({ kind: 'replace', url: href, state });
  },
  back(): void {
    calls.push({ kind: 'back', url: href, state: entryState });
  },
};

const { Router, parseRoute } = await import('../core/route');

/** その URL を、その履歴状態で開いた直後の世界にする */
function openedAt(url: string, state: unknown = null): void {
  href = url;
  entryState = state;
  calls.length = 0;
}

beforeEach(() => {
  openedAt('https://dimension.test/');
});

describe('parseRoute', () => {
  it('?gallery=<id> を読み、p は中身を知らないまま運ぶ', () => {
    const route = parseRoute('https://dimension.test/?gallery=clifford&p=w1-0.4');
    expect(route.mode).toBe('gallery');
    if (route.mode !== 'gallery') return;
    expect(route.exhibit).toBe('clifford');
    expect(route.state).toBe('w1-0.4');
  });

  it('未知の id は物語へ落とす ── 壊れたリンクで白画面にしない', () => {
    expect(parseRoute('https://dimension.test/?gallery=nope').mode).toBe('narrative');
    expect(parseRoute('https://dimension.test/?gallery=').mode).toBe('narrative');
  });

  it('物語の scrollY は履歴状態からだけ取れる', () => {
    const route = parseRoute('https://dimension.test/', { d: 'narrative', y: 940 });
    expect(route).toEqual({ mode: 'narrative', scrollY: 940 });
    expect(parseRoute('https://dimension.test/')).toEqual({ mode: 'narrative', scrollY: null });
  });
});

describe('Router.setState — 共有リンクを受け取った回(Phase 44b)', () => {
  it('深リンクで開いた回でも p が URL へ載る', () => {
    /*
      **これが Phase 44b の回帰**。`?gallery=` を直接開いたエントリはブラウザが
      作ったもので `history.state === null` ── 関門を `history.state` に置くと、
      Phase 44 が直そうとした当の経路(リンクを受け取った人)だけが落ちる。
    */
    openedAt('https://dimension.test/?gallery=clifford');
    new Router(() => {}).setState('w1-0.4');
    expect(href).toContain('p=w1-0.4');
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('replace');
  });

  it('p を持つリンクを受け取って値を変えると、URL が追従する ── 嘘をつかない', () => {
    // 追従しないと、受け取った人が転送した URL に**誰も見ていない絵**が入る
    openedAt('https://dimension.test/?gallery=clifford&p=w1-0.4');
    const router = new Router(() => {});
    router.setState('w1-0.5');
    expect(href).toContain('p=w1-0.5');
    expect(href).not.toContain('w1-0.4');
    // 既定へ戻したら p ごと消える(何も触っていない URL と同じ姿へ帰る)
    router.setState(null);
    expect(href).toBe('https://dimension.test/?gallery=clifford');
  });

  it('素のエントリへ焼いても owned は立たない ── 戻るでサイトを離脱しない', () => {
    openedAt('https://dimension.test/?gallery=clifford');
    const router = new Router(() => {});
    router.setState('w1-0.4');
    expect(router.ownsGalleryEntry).toBe(false);

    calls.length = 0;
    router.leave();
    expect(calls.some((call) => call.kind === 'back')).toBe(false);
    expect(href).toBe('https://dimension.test/');
  });

  it('CTA から入った回は owned を引き継ぐ', () => {
    const router = new Router(() => {});
    router.enter('clifford', 1234);
    expect(router.ownsGalleryEntry).toBe(true);
    router.setState('w1-0.4');
    expect(href).toContain('p=w1-0.4');
    expect(router.ownsGalleryEntry).toBe(true);
  });

  it('物語に居るあいだは何も書かない', () => {
    openedAt('https://dimension.test/', { d: 'narrative', y: 940 });
    new Router(() => {}).setState('w1-0.4');
    expect(calls).toHaveLength(0);
    expect(href).toBe('https://dimension.test/');
  });

  it('他のクエリもハッシュも、この層は知らないまま保つ', () => {
    openedAt('https://dimension.test/sub/?utm=mail&gallery=hopf#ch-d4');
    new Router(() => {}).setState('fib-1200');
    expect(href).toContain('utm=mail');
    expect(href).toContain('p=fib-1200');
    expect(href).toContain('#ch-d4');
    expect(href.startsWith('https://dimension.test/sub/')).toBe(true);
  });
});

describe('Router.select', () => {
  it('前の展示の p を必ず落とす ── 短い名前は展示ごとに重なる', () => {
    // polytope の `n`(次元)と perspective の `n`(対象)は別のもの
    openedAt('https://dimension.test/?gallery=polytope&p=n-9');
    new Router(() => {}).select('perspective', null);
    expect(href).toBe('https://dimension.test/?gallery=perspective');
  });

  it('replaceState なので 4 つのタブで履歴が伸びない', () => {
    const router = new Router(() => {});
    router.enter('polytope', 0);
    calls.length = 0;
    router.select('perspective', null);
    router.select('clifford', null);
    router.select('hopf', 'fib-1200');
    expect(calls.every((call) => call.kind === 'replace')).toBe(true);
    expect(href).toContain('gallery=hopf');
    expect(href).toContain('p=fib-1200');
  });
});
