import { h, type Component } from './component';

/**
 * Announcer — 状態の変化を支援技術へ告げる一行(Phase 14b)。
 *
 * ここまで、作品の状態は**一度も読み上げられていなかった**。
 * `#hud` の次元カウンタ(0.00 D → 6.00 D)も展示カウンタも `aria-hidden="true"`
 * の内側にあり、これは意図した設計 ── 0.01 刻みで数を読み上げても騒音にしかならず、
 * `ImmersiveToggle` と `Gallery` がチップを `#hud` の**外**へ置いているのも同じ理由による。
 *
 * だから `#hud` はそのままにして、**変わった瞬間にだけ喋る領域**を 1 つ別に立てる。
 * ライブリージョンは「変化を告げる」ために設計された唯一の機構で、
 * 静的な要素の名前(aria-label)の書き換えはどの支援技術でも確実には読まれない。
 *
 * **`<body>` 直下に置くこと。これは要件であって好みではない。**
 * 置き場所の候補はすべて既存のルールで失格する:
 *   - `#hud` の中 …… `aria-hidden="true"` なので永久に無音
 *   - `#narrative` の中 …… ギャラリーでは `visibility: hidden`。展示の読み上げが要る
 *     まさにその場所で黙る
 *   - `#gallery` の中 …… 物語では `hidden`
 *   - `body.ui-hidden` の対象 …… 没入モードで `visibility: hidden`
 *
 * `.sr-only` は既存のものをそのまま使う(`clip-path: inset(50%)` であって
 * `display:none` でも `visibility:hidden` でもないので、アクセシビリティツリーに残る)。
 */

/**
 * 読み上げの合流窓(ms)。
 *
 * 速いフリックスクロールは 9 章の境界を続けざまに跨ぐ。1 つずつ書くと
 * `aria-live="polite"` は行列を作り、指を止めたあともしばらく読み上げが続く。
 * 220ms のあいだに届いたものは**最後の 1 つだけ**を書く ── 通り過ぎた章ではなく、
 * 「いま居る章」を告げるのが正しい。
 */
const COALESCE_MS = 220;

export class Announcer implements Component {
  readonly el: HTMLElement;

  private timer = 0;
  private pending: string | null = null;
  private last = '';

  constructor() {
    // 器は最初から空で置いておく。aria-live は「すでに在る領域の中身が変わった」
    // ときに読まれるので、要素と文字を同時に差し込むと落とす支援技術がある
    // (SoundToggle.showHint と同じ作法。あちらは要素ごと後から生えるので
    //  次フレームまで待つが、こちらは常駐なので待つ必要がない)
    this.el = h('p', 'sr-only', { role: 'status', 'aria-live': 'polite' });
  }

  /** 同じ文はスキップし、220ms のあいだに届いたものは最後の 1 つだけ書く */
  announce(text: string): void {
    const next = text.trim();
    if (next === '' || next === this.last) return;
    this.pending = next;
    if (this.timer !== 0) return;
    this.timer = window.setTimeout(this.flush, COALESCE_MS);
  }

  destroy(): void {
    if (this.timer !== 0) {
      window.clearTimeout(this.timer);
      this.timer = 0;
    }
    this.el.remove();
  }

  private readonly flush = (): void => {
    this.timer = 0;
    const next = this.pending;
    this.pending = null;
    if (next === null || next === this.last) return;
    this.last = next;
    this.el.textContent = next;
  };
}

/** `<body>` 直下へ立てる(置き場所の理由はファイル冒頭を参照) */
export function createAnnouncer(parent: HTMLElement): Announcer {
  const announcer = new Announcer();
  parent.append(announcer.el);
  return announcer;
}
