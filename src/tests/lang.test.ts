import { describe, expect, it } from 'vitest';

import { DEFAULT_LANG, LANGS, isLang, resolveLang } from '../i18n/lang';

/**
 * 言語の決定(Phase 45)。
 *
 * `resolveLang` は**副作用を持たない純関数**で、URL・記憶した選択・
 * ブラウザの言語設定の 3 つを引数で受け取る ── だからここで 4 段の
 * 優先順位を丸ごと突ける。`LANG`(実際に使われる値)は window を読むので、
 * Node からはこちらを試験する(`i18n/lang.ts` のモジュール注)。
 */

const BASE = 'https://example.com/';

describe('resolveLang', () => {
  it('① URL がいちばん強い ── 記憶も OS 設定も上書きする', () => {
    expect(resolveLang(`${BASE}?lang=en`, 'ja', ['ja-JP', 'ja'])).toBe('en');
    expect(resolveLang(`${BASE}?lang=ja`, 'en', ['en-US'])).toBe('ja');
  });

  it('URL は他のクエリと混ざっていても読める', () => {
    expect(resolveLang(`${BASE}?gallery=hopf&lang=ja&p=abc`, null, ['en-US'])).toBe('ja');
  });

  it('未知の値は無視して次の段へ落ちる ── 壊れたリンクで白画面にしない', () => {
    expect(resolveLang(`${BASE}?lang=fr`, 'ja', ['en-US'])).toBe('ja');
    expect(resolveLang(`${BASE}?lang=`, null, ['ja-JP'])).toBe('ja');
  });

  it('② 記憶した選択は OS 設定より強い ── 押した操作のほうが新しい情報である', () => {
    expect(resolveLang(BASE, 'en', ['ja-JP', 'ja'])).toBe('en');
    expect(resolveLang(BASE, 'ja', ['en-US', 'en'])).toBe('ja');
  });

  it('③ 初回訪問は OS / ブラウザの言語設定を見る(地域タグは落とす)', () => {
    expect(resolveLang(BASE, null, ['ja-JP', 'en-US'])).toBe('ja');
    expect(resolveLang(BASE, null, ['en-GB'])).toBe('en');
    // 大文字小文字は問わない
    expect(resolveLang(BASE, null, ['JA-jp'])).toBe('ja');
  });

  it('列の順が利用者の優先度 ── 先に当たったものを採る', () => {
    expect(resolveLang(BASE, null, ['en-US', 'ja-JP'])).toBe('en');
    expect(resolveLang(BASE, null, ['ja', 'en'])).toBe('ja');
    // 対応していない言語は読み飛ばして、次の当たりを探す
    expect(resolveLang(BASE, null, ['fr-FR', 'de', 'ja-JP'])).toBe('ja');
  });

  it('④ どれとも当たらなければ既定 ── そして既定は ja ではない', () => {
    expect(resolveLang(BASE, null, [])).toBe(DEFAULT_LANG);
    expect(resolveLang(BASE, null, ['fr-FR', 'de-DE'])).toBe(DEFAULT_LANG);
    /*
      既定が `en` であることは判断であって偶然ではない ── 日本語環境は
      ③ で `ja` に当たるので、④ へ落ちてくるのはフランス語環境などである。
      原作言語は `ja` だが、ここは**読める人の数**で選ぶ。
    */
    expect(DEFAULT_LANG).toBe('en');
  });

  it('返す値は必ず対応言語のどれか', () => {
    const inputs: [string, string | null, string[]][] = [
      [BASE, null, []],
      [`${BASE}?lang=zh`, 'zh', ['zh-CN']],
      [BASE, 'klingon', ['tlh']],
    ];
    for (const [href, stored, preferred] of inputs) {
      expect(LANGS).toContain(resolveLang(href, stored, preferred));
    }
  });
});

describe('isLang', () => {
  it('対応言語だけを通す', () => {
    for (const lang of LANGS) expect(isLang(lang)).toBe(true);
    for (const value of ['zh', 'ja-JP', 'EN', '', null, undefined]) {
      expect(isLang(value), String(value)).toBe(false);
    }
  });
});
