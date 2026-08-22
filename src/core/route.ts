import { EXHIBIT_REGISTRY, type ExhibitId } from './gallery';

/**
 * URL を状態にする層(Phase 13)。
 *
 * ここまで DIMENSION は履歴を一切持っていなかった。結果として
 *   ① 「クリフォード・トーラスのこの展示」を人に送れない
 *   ② ギャラリー入場後のブラウザバック / iOS の端スワイプで**サイトごと離脱する**
 * の 2 つが起きていた。②はモバイルでは事故に近い。
 *
 * **`?gallery=<id>` を使う。物語 = パラメータ無し。**
 *
 * - **ハッシュは採らない** — `#gallery` は実在の id(index.html)で、章にも
 *   `ch-prologue`…`ch-epilogue` が実在する。フラグメントスクロールが起きると
 *   **物語の状態そのものである scrollY** が壊れ、ScrollDirector の毎フレーム読みと
 *   食い合う
 * - **パスは採らない** — GitHub Pages に SPA フォールバックが無い。`/gallery/hopf` は
 *   リロードで 404 になり、しかも `/dimension/` のサブパスが落ちる
 * - **`?exhibit=` とは別のキーにする(必須)** — `?exhibit=` は同じ 4 つの id を取る
 *   文書化済みのデバッグ経路で、`bootStandaloneExhibit` は #narrative / #hud /
 *   #gallery / #mode-nav を **DOM から削除する**。共有リンクがそちらへ落ちたら、
 *   受け取った人はクローム無しの開発ハーネスに閉じ込められる。
 *   `main.ts` は `?exhibit=` を**先に**判定し、そのとき Router は構築しない
 *
 * URL は必ず `new URL(window.location.href)` から組む。こうしておくと
 * `base: './'` のサブパス配信も、将来のカスタムドメインも、他のクエリも
 * ハッシュも、この層が何も知らないまま保たれる。
 */

export type Route =
  | { readonly mode: 'narrative'; readonly scrollY: number | null }
  | { readonly mode: 'gallery'; readonly exhibit: ExhibitId };

/** クエリのキー。`?exhibit=`(単独ブート)とは決して重ねない */
const PARAM = 'gallery';

/**
 * 履歴エントリに焼く状態。
 *
 * `owned` が要。**このギャラリーエントリを自分で push したか**を、エントリ自身に
 * 持たせる ── 進む/戻るでエントリと一緒に旅するので、往復しても判定がずれない。
 * 深リンクで開いた回はエントリ 0 に居るので `owned` は付かず、`leave()` は
 * `history.back()` を**呼ばない**(呼べばサイトを離れる = 直そうとしているバグそのもの)。
 */
interface RouteState {
  readonly d: 'narrative' | 'gallery';
  readonly exhibit?: ExhibitId;
  readonly owned?: boolean;
  /** 物語エントリに焼いた scrollY。ギャラリーでリロードされたときの唯一の手がかり */
  readonly y?: number;
}

/**
 * 有効な展示 id か。**この 1 本が「?gallery= / ?exhibit= が取りうる値」の唯一の判定**で、
 * `EXHIBIT_REGISTRY` から導出している ── 展示を足しても順路を組み替えても、
 * ここは書き換えなくてよい。手書きの 4 分岐を置くと順路の変更で必ず取り残される
 * (Phase 41 で main.ts に 2 つ残っていた)。
 */
export function isExhibitId(value: string | null): value is ExhibitId {
  return value !== null && EXHIBIT_REGISTRY.some((entry) => entry.id === value);
}

/**
 * URL(と、あれば履歴状態)から現在の状態を読む。
 * 未知の id は物語へ落とす ── 壊れたリンクで白画面にしない。
 */
export function parseRoute(href: string, state?: unknown): Route {
  const value = new URL(href).searchParams.get(PARAM);
  if (isExhibitId(value)) return { mode: 'gallery', exhibit: value };

  const y = (state as RouteState | null | undefined)?.y;
  return { mode: 'narrative', scrollY: typeof y === 'number' ? y : null };
}

export class Router {
  private readonly onRoute: (route: Route) => void;

  constructor(onRoute: (route: Route) => void) {
    this.onRoute = onRoute;
    window.addEventListener('popstate', this.onPopState);
  }

  /**
   * いま居るギャラリーエントリを自分で push したか。
   * `history.state` を読むので、進む/戻るを跨いでも常に現在のエントリの真実を返す。
   */
  get ownsGalleryEntry(): boolean {
    return (history.state as RouteState | null)?.owned === true;
  }

  /**
   * 物語 → ギャラリー。
   *
   * **2 回書く**のが要点。まず今居る物語エントリへ scrollY を焼き直してから、
   * ギャラリーエントリを push する。この `y` が無いと、ギャラリーに居る状態で
   * リロードして戻ったとき、新しい Gallery の savedScrollY は 0 なので
   * 序章に落とされる。
   */
  enter(exhibit: ExhibitId, fromScrollY: number): void {
    const base = new URL(window.location.href);
    base.searchParams.delete(PARAM);
    const narrative: RouteState = { d: 'narrative', y: fromScrollY };
    history.replaceState(narrative, '', base);

    const next = new URL(window.location.href);
    next.searchParams.set(PARAM, exhibit);
    const gallery: RouteState = { d: 'gallery', exhibit, owned: true };
    history.pushState(gallery, '', next);

    this.onRoute({ mode: 'gallery', exhibit });
  }

  /**
   * 展示の切り替え。**replaceState** なので 4 つのタブで履歴が汚れない
   * (戻るは常に「ギャラリーへ入る前」へ帰る)。`owned` は引き継ぐ。
   */
  select(exhibit: ExhibitId): void {
    const url = new URL(window.location.href);
    url.searchParams.set(PARAM, exhibit);
    const state: RouteState = { d: 'gallery', exhibit, owned: this.ownsGalleryEntry };
    history.replaceState(state, '', url);
  }

  /**
   * UI からの退場要求(Esc / トップナビ「物語」)。
   *
   * ギャラリーを物語の上のレイヤとみなす。自分で push したエントリに居るなら
   * `back()` — popstate が退場を駆動し、進むで戻れて、往復してもスタックが伸びない。
   * 深リンクで来た回は push していないので、置換して同期で物語へ渡す。
   */
  leave(): void {
    if (this.ownsGalleryEntry) {
      history.back();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete(PARAM);
    const state: RouteState = { d: 'narrative' };
    history.replaceState(state, '', url);
    this.onRoute({ mode: 'narrative', scrollY: null });
  }

  destroy(): void {
    window.removeEventListener('popstate', this.onPopState);
  }

  /**
   * 状態の真実は常に URL 側から読む。`event.state` は null にも、
   * 他所が書いた値にもなりうる(scrollY だけは state からしか取れないので渡す)。
   */
  private readonly onPopState = (event: PopStateEvent): void => {
    this.onRoute(parseRoute(window.location.href, event.state));
  };
}
