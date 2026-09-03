/**
 * 辞書の選択(Phase 45)。**この 1 行が「どの言語で動いているか」の答え**である。
 *
 * `ui/content.ts` から切り出したのは依存の向きのため ── 器の文言
 * (`UI`)は `core/engine.ts` や `ui/components/controls/Panel.ts` のような
 * 低い層からも引かれる。それらに `ui/content.ts` を読ませると
 * 「章と展示の全文を持つモジュール」への依存が下層へ広がるので、
 * **文言だけが要る側はここを読む**。
 *
 * `ui/content.ts` は引き続き `COPY` / `UI` / `MARQUEE` を再エクスポートする
 * (呼び出し側の import を 1 行も変えないため)。
 */

import { LANG, type Lang } from './lang';
import { JA } from './ja';
import { EN } from './en';
import type { Copy } from './types';

/** 言語 → 辞書。**言語を足すときに触るのはこの表だけ** */
export const DICTS: Readonly<Record<Lang, Copy>> = { ja: JA, en: EN };

/**
 * この実行のコピー。**モジュール読み込み時に一度だけ束ねて凍らせる**
 * (理由は `lang.ts` の `LANG` の注を参照 ── 途中で変わると、既に組んだ
 * DOM と次に引く文言が食い違う)。
 */
export const COPY: Copy = DICTS[LANG];

/** 器と操作卓の文言。参照回数が多いので別名を置く */
export const UI = COPY.ui;

/** 物語の流れる帯(装飾の欧文) */
export const MARQUEE = COPY.marquee;
