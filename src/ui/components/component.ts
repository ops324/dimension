/**
 * コンポーネント契約(Phase 9a)。
 *
 * 依存ゼロ・フレームワークなしの Vanilla TS。すべての UI 部品はこの 1 本の
 * 契約に従う ── `el` を持ち、`destroy()` で自分の DOM とリスナーを完全に畳む。
 *
 * 動きの規約:
 * - 一度きりの reveal に CSS @keyframes を増やさない。WAAPI(element.animate)で
 *   宣言し、イージングと尺は tokens.css と対になった EASE / DUR から取る。
 * - `prefers-reduced-motion: reduce` の判定は**モジュールレベルで 1 回だけ**行う
 *   (部品ごとに matchMedia を持たない)。play() が duration/delay を 0 にし、
 *   移動系のプロパティ(transform / clip-path)をキーフレームから落とす。
 */

export interface Component {
  readonly el: HTMLElement;
  destroy(): void;
}

/**
 * イージング。tokens.css の --ease-* と 1:1 で対応する写し。
 * WAAPI は CSS 変数を解決しないため TS 側に実値を持つ必要がある。
 */
export const EASE = {
  outExpo: 'cubic-bezier(0.16, 1, 0.3, 1)',
  outQuint: 'cubic-bezier(0.22, 1, 0.36, 1)',
  inoutSoft: 'cubic-bezier(0.65, 0, 0.35, 1)',
} as const;

/** 尺(ms)。tokens.css の --t-* と 1:1 */
export const DUR = {
  fast: 180,
  med: 420,
  slow: 800,
  reveal: 1100,
} as const;

/* ------------------------------------------------------------------ DOM 構築 */

/** h() の属性。`text` だけ textContent として特別扱いする */
export interface HAttrs {
  readonly text?: string;
  readonly [attr: string]: string | undefined;
}

/**
 * 最小の DOM ビルダ。すべてのコンポーネントがこれ 1 本で DOM を組む。
 * innerHTML は使わない(この作品では文字列 HTML の注入経路を持たない)。
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  attrs?: HAttrs,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (attrs !== undefined) {
    for (const key in attrs) {
      const value = attrs[key];
      if (value === undefined) continue;
      if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value);
    }
  }
  return node;
}

/* ------------------------------------------------- prefers-reduced-motion */

const motionQuery: MediaQueryList | null =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

/** モジュールレベルに 1 つだけ持つ判定。部品側で matchMedia を張らない */
export function prefersReducedMotion(): boolean {
  return motionQuery !== null && motionQuery.matches;
}

/** 設定変更の購読。戻り値を呼ぶと解除する */
export function onMotionPreferenceChange(handler: (reduced: boolean) => void): () => void {
  if (motionQuery === null) return () => undefined;
  const listener = (event: MediaQueryListEvent): void => handler(event.matches);
  motionQuery.addEventListener('change', listener);
  return () => motionQuery.removeEventListener('change', listener);
}

/** 移動を伴うプロパティ。reduced-motion ではキーフレームから落とす */
const MOTION_PROPS = ['transform', 'clipPath', 'clip-path', 'translate', 'rotate', 'scale'];

/**
 * WAAPI 再生の唯一の入口。
 *
 * reduced-motion では **duration / delay を 0 にし、移動系プロパティを捨てる**。
 * 最終フレームの opacity 等はそのまま適用されるので、
 * 「動かないが、到達状態は同じ」になる(要素が消えたままにならない)。
 */
export function play(
  target: Element,
  frames: Keyframe[],
  options: KeyframeAnimationOptions,
): Animation {
  if (!prefersReducedMotion()) return target.animate(frames, options);

  const flat: Keyframe[] = [];
  for (let i = 0; i < frames.length; i++) {
    const source = frames[i];
    const copy: Keyframe = {};
    for (const key in source) {
      if (MOTION_PROPS.indexOf(key) >= 0) continue;
      copy[key] = source[key];
    }
    flat.push(copy);
  }
  return target.animate(flat, { ...options, duration: 0, delay: 0, endDelay: 0 });
}

/** reduced-motion では 0 を返す尺ヘルパ(setTimeout の待ちなど) */
export function motionTime(ms: number): number {
  return prefersReducedMotion() ? 0 : ms;
}

/**
 * アニメーションを畳んで配列を空にする。
 *
 * **完了済みも必ず cancel する**: fill: 'forwards' で終わったアニメーションは
 * 完了後も値を保持し続け、あとからインラインスタイルを書いても上書きされない。
 * cancel することで効果が外れ、要素は素のスタイルへ戻る。
 */
export function cancelAll(animations: Animation[]): void {
  for (let i = 0; i < animations.length; i++) {
    const anim = animations[i];
    anim.onfinish = null;
    anim.oncancel = null;
    anim.cancel();
  }
  animations.length = 0;
}
