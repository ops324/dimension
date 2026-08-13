/**
 * Drawer — 解説の引き出し(Phase 9b、Phase 15 でコーデックスへ)。
 *
 * 幾何は Phase 7 のまま(デスクトップは左から差し込む板、モバイルは下からの
 * フルシート)。変えたのは**開いたあとに何が起きるか**:
 *
 *   ① 背後をわずかに落とす暗幕。blur は敷かない ── 全画面の backdrop-filter は
 *      ギャラリー中の WebGL と真正面からフレーム時間を取り合うため。
 *   ② 見出しは SplitText の文字で立ち上がり、本文はブロックごとに 60ms ずつ遅れて
 *      浮かび上がる(**開いたときだけ**。閉じるのは一息で引く)。
 *   ③ 板の縁に 1px のグラデーションヘアライン(CSS 側の ::after)。
 *   ④ 閉じる ✕ には磁力。
 *
 * Phase 15: 中身が生 HTML の段落列から**コーデックス(図鑑)構造**になった。
 * setContent は content.ts の ExhibitCodex を受け取り、
 *   フック → 導入 → たとえ話カード → 観察 → クエスト → 図鑑データ → DEEP DIVE
 * の順で DOM を組む。従来の科学解説は DEEP DIVE(<details>)の中へ沈み、
 * 潜りたい人だけが開く。立ち上がりの階段は段落単位からブロック単位へ変わった
 * だけで、60ms の刻みも fill: backwards も同じ。
 *
 * 深い層を SplitText で動かさないのは従来と同じ理由 ── 解説は `<em>` と `<sup>`
 * を含み、行分割は textContent で組み直すので指数の組版が壊れる(S³ が S3 になる)。
 * 数式の正しさは動きより上位。
 */

import type { ExhibitCodex } from '../content';
import { EASE, cancelAll, h, play, type Component } from './component';
import { reveal, splitChars, type SplitHandle } from './SplitText';
import { magnetize, type Magnet } from './MagneticButton';

export interface DrawerOptions {
  /** 器。index.html の #gallery-drawer */
  readonly root: HTMLElement;
  /** 暗幕のクリック・閉じるボタンから呼ばれる(呼び出し側が状態を一元管理する) */
  readonly onRequestClose: () => void;
}

/** 段落の階段(ms) */
const PARA_STAGGER = 60;
const PARA_MS = 560;
const PARA_DELAY = 120;
/** 見出しの文字送り(ms) */
const TITLE_STAGGER = 16;
const TITLE_MS = 620;
/** 段落の立ち上がり(px) */
const RISE = 10;

/** 焦点の閉じ込めが巡回する対象(Phase 14c)。押された瞬間に数え直す。
    summary は Phase 15 の DEEP DIVE ── ネイティブに焦点を受けるのに一覧から
    漏れると、そこで Tab が閉じ込めの外へ抜ける */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export class Drawer implements Component {
  readonly el: HTMLElement;

  private readonly titleEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly closeEl: HTMLButtonElement;
  private readonly scrim: HTMLElement;
  private readonly magnet: Magnet;
  private readonly onRequestClose: () => void;

  private readonly running: Animation[] = [];
  private titleSplit: SplitHandle | null = null;
  private open = false;
  private timer = 0;

  constructor(options: DrawerOptions) {
    this.el = options.root;
    this.onRequestClose = options.onRequestClose;

    this.titleEl = need(this.el, 'drawer-title');
    this.bodyEl = need(this.el, 'drawer-body');
    this.closeEl = need(this.el, 'drawer-close') as HTMLButtonElement;

    // ダイアログとしての意味づけ(aria-labelledby は index.html が持っている)
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');

    this.scrim = h('div', 'dw-scrim', { 'aria-hidden': 'true' });
    this.scrim.addEventListener('click', this.onScrim);
    this.el.parentElement?.insertBefore(this.scrim, this.el);

    /*
      本文にキーボードの停留点を与える(Phase 14c)。

      .dw-body は overflow-y: auto なのに、これまでキーボードでスクロールする手段が
      無かった。焦点の閉じ込めを足すと、これが無いと停留点が ✕ 1 つだけになり
      Tab が無反応になる ── 準拠を実際の改善へ変える 1 行でもある。
    */
    this.bodyEl.tabIndex = 0;

    this.closeEl.addEventListener('click', this.onClose);
    this.closeEl.setAttribute('data-cursor', '');
    this.magnet = magnetize(this.closeEl, { radius: 70, strength: 0.35, max: 6, labelMax: 6 });
  }

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * 中身の差し替え。**開いていないときにだけ**呼ばれる想定
   * (展示の切替はドロワーを閉じた状態で走る)。
   *
   * Phase 15: コーデックス構造で組み直す。bodyEl の**直接の子**が
   * reveal() の階段の 1 段になるので、意味のまとまり = 1 ブロックを保つこと。
   */
  setContent(title: string, codex: ExhibitCodex, deepHtml: string): void {
    this.stop();
    this.titleEl.textContent = title;
    this.bodyEl.replaceChildren(
      h('p', 'dw-hook', { text: codex.hook }),
      h('p', 'dw-intro', { text: codex.intro }),
      buildMetaphor(codex),
      buildObserve(codex),
      buildQuests(codex),
      buildStats(codex),
      buildDeep(deepHtml),
    );
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    this.el.classList.add('is-open');
    this.el.setAttribute('aria-hidden', 'false');
    this.scrim.dataset.on = 'true';
    this.el.addEventListener('keydown', this.onKeyDown);
    this.reveal();
    this.focusClose();
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.stop();
    /*
      リスナは**ここで外す**。is-open のトランジション(0.38s)の完了に載せてはならない ──
      exitGallery() は closeDrawer() と rootEl.hidden = true を同じ同期ブロックで
      実行するので、遅らせると display:none のサブツリーへフォーカスを跳ね返そうとする。
    */
    this.el.removeEventListener('keydown', this.onKeyDown);
    this.el.classList.remove('is-open');
    this.el.setAttribute('aria-hidden', 'true');
    this.scrim.dataset.on = 'false';
  }

  destroy(): void {
    this.stop();
    this.magnet.destroy();
    this.el.removeEventListener('keydown', this.onKeyDown);
    this.closeEl.removeEventListener('click', this.onClose);
    this.scrim.removeEventListener('click', this.onScrim);
    this.scrim.remove();
  }

  // --- 内部 ------------------------------------------------------------------

  private readonly onClose = (): void => this.onRequestClose();
  private readonly onScrim = (): void => this.onRequestClose();

  /**
   * 焦点の閉じ込め(Phase 14c)。
   *
   * `role="dialog" aria-modal="true"` を宣言している以上、Tab が背後へ抜けるのは
   * 仕様違反である。にもかかわらずここまで Tab の制御は 1 行も無かった。
   *
   * **Escape はここでは扱わない。** 順序の契約(没入 → ドロワー → 退場)は
   * gallery.ts の window リスナ 1 本が持っており、ここで拾うと二重に閉じる。
   *
   * 兄弟を inert にする案は採らない ── 7 要素(うち 1 つは展示ごとに作り直される)へ
   * 触ることになり、遷移の途中で例外が飛べばページが恒久的に inert になる。
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab' || !this.open) return;
    // 押された瞬間に数える。**キャッシュしない** ── setContent が本文を差し替え、
    // reveal() が見出しを再分割するので、作り置きした一覧はすぐ古くなる
    const items = this.el.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !this.el.contains(active)) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (active === last || !this.el.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };

  /**
   * ダイアログを開いたらフォーカスを ✕ へ渡す。
   * **初回だけ**は受け取られないことがある ── クラスを付けた直後の要素は
   * まだ「描画されている」と見なされず、focus() が黙って無視される。
   * 受け取れたかを確かめ、駄目なら次のタスクでもう一度だけ試す。
   */
  private readonly focusClose = (): void => {
    if (this.timer !== 0) {
      window.clearTimeout(this.timer);
      this.timer = 0;
    }
    // 「描画されているか」の判定は最新のレイアウトを要る。開くときに 1 度だけ
    // 読んで確定させてから渡す(この読みは開閉のたびの 1 回きり)
    void this.closeEl.offsetWidth;
    this.closeEl.focus({ preventScroll: true });
    if (document.activeElement === this.closeEl || !this.open) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      if (this.open) this.closeEl.focus({ preventScroll: true });
    }, 0);
  };

  /** 開いた瞬間の振り付け。見出し(文字)→ 段落(階段) */
  private reveal(): void {
    this.titleSplit = splitChars(this.titleEl, { keepWords: true });
    pushAll(
      this.running,
      reveal(this.titleSplit, {
        stagger: TITLE_STAGGER,
        duration: TITLE_MS,
        easing: EASE.outExpo,
      }),
    );

    const paragraphs = this.bodyEl.children;
    for (let i = 0; i < paragraphs.length; i++) {
      this.running.push(
        play(
          paragraphs[i],
          [
            { opacity: 0, transform: `translateY(${RISE}px)` },
            { opacity: 1, transform: 'translateY(0)' },
          ],
          {
            duration: PARA_MS,
            delay: PARA_DELAY + i * PARA_STAGGER,
            easing: EASE.outExpo,
            fill: 'backwards',
          },
        ),
      );
    }
  }

  /** 走っているものを畳み、分割したテキストを元へ戻す */
  private stop(): void {
    cancelAll(this.running);
    this.titleSplit?.restore();
    this.titleSplit = null;
    if (this.timer !== 0) {
      window.clearTimeout(this.timer);
      this.timer = 0;
    }
  }
}

/* ------------------------------------------------------- コーデックスの部品

   ラベルは「EN / 日本語」の複合。EN はモノスペースの飾りなので aria-hidden にし、
   読み上げには日本語だけを通す(タブやナビと同じ規律)。
*/

function label(en: string, jp: string): HTMLElement {
  const node = h('p', 'dw-label');
  node.append(
    h('span', 'dw-label-en', { text: en, lang: 'en', 'aria-hidden': 'true' }),
    h('span', 'dw-label-jp', { text: jp }),
  );
  return node;
}

/** たとえ話カード。1 展示に 1 本だけの比喩を、額に入れて飾る */
function buildMetaphor(codex: ExhibitCodex): HTMLElement {
  const card = h('section', 'dw-card');
  card.append(
    label('ANALOGY', 'たとえるなら'),
    h('p', 'dw-card-title', { text: codex.metaphorTitle }),
    h('p', 'dw-card-body', { text: codex.metaphor }),
  );
  return card;
}

/** 観察ポイント。◆ のマーカーは CSS(::before)が打つ */
function buildObserve(codex: ExhibitCodex): HTMLElement {
  const section = h('section', 'dw-observe');
  const list = h('ul', 'dw-observe-list');
  for (const item of codex.observe) list.append(h('li', undefined, { text: item }));
  section.append(label('OBSERVE', 'いま見えているもの'), list);
  return section;
}

/** クエスト。番号 + 命令形タイトル + 「何が見られるか」の予告 */
function buildQuests(codex: ExhibitCodex): HTMLElement {
  const section = h('section', 'dw-quests');
  section.append(label('TRY THIS', 'やってみよう'));
  for (let i = 0; i < codex.quests.length; i++) {
    const quest = codex.quests[i];
    const row = h('div', 'dw-quest');
    const num = h('span', 'dw-quest-num', {
      text: String(i + 1).padStart(2, '0'),
      'aria-hidden': 'true',
    });
    const text = h('div', 'dw-quest-text');
    text.append(
      h('p', 'dw-quest-title', { text: quest.title }),
      h('p', 'dw-quest-body', { text: quest.body }),
    );
    row.append(num, text);
    section.append(row);
  }
  return section;
}

/** 図鑑データ。dl で組む(label と value の対は意味的にも定義リスト) */
function buildStats(codex: ExhibitCodex): HTMLElement {
  const section = h('section', 'dw-stats');
  const grid = h('dl', 'dw-stat-grid');
  for (const stat of codex.stats) {
    const cell = h('div', 'dw-stat');
    cell.append(
      h('dt', 'dw-stat-label', { text: stat.label, lang: 'en' }),
      h('dd', 'dw-stat-value', { text: stat.value }),
    );
    grid.append(cell);
  }
  section.append(label('DATA', '図鑑データ'), grid);
  return section;
}

/**
 * DEEP DIVE。従来の科学解説がまるごとここに沈む。
 * <details> を使うのは、開閉の状態管理・キーボード操作・読み上げが
 * ネイティブに揃うため(自前のトグルで作り直す理由がない)。
 */
function buildDeep(deepHtml: string): HTMLElement {
  const details = h('details', 'dw-deep');
  const summary = h('summary', 'dw-deep-summary');
  summary.append(
    h('span', 'dw-deep-en', { text: 'DEEP DIVE', lang: 'en', 'aria-hidden': 'true' }),
    h('span', 'dw-deep-jp', { text: 'もっと深く潜る' }),
    h('span', 'dw-deep-glyph', { text: '◇', 'aria-hidden': 'true' }),
  );
  const body = h('div', 'dw-deep-body');
  // 解説は content.ts の定数のみ(外部入力は入らない)
  body.innerHTML = deepHtml;
  details.append(summary, body);
  return details;
}

/* ------------------------------------------------------------------ 内部 */

function pushAll(into: Animation[], animations: readonly Animation[]): void {
  for (let i = 0; i < animations.length; i++) into.push(animations[i]);
}

function need(root: HTMLElement, id: string): HTMLElement {
  const node = root.querySelector<HTMLElement>(`#${id}`);
  if (node === null) {
    throw new Error(`DIMENSION: #${id} not found (index.html の解説ドロワーを確認)`);
  }
  return node;
}
