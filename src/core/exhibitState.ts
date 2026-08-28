/**
 * 展示のパラメータを URL に載せる層(Phase 44)。
 *
 * Phase 13 で URL が持つようになったのは**モードと展示 id** だけだった。だから
 * 「クリフォード・トーラスのこの設定」は人に送れず、リロードすれば既定へ戻る。
 * ここはその 2 つを同時に直す ── **URL に載れば、送れるし、戻れる。**
 *
 * ## この層が守る規則
 *
 * ① **route.ts が所有するクエリキーは 2 本だけ**(`gallery` と `p`)。
 *    平たくキーを増やす(`?gallery=perspective&observer=3&target=4`)と、展示を
 *    切り替えるたびに前の展示のキーが残って**嘘の URL** ができる。消すには
 *    「消してよいキーの一覧」を route.ts が持つ必要があり、それは
 *    「URL は必ず `new URL(location.href)` から組み、この層は他のクエリを
 *    何も知らないまま保つ」という Phase 13 の設計の破壊であり、同時に
 *    「手書きの一覧は順路の変更で必ず取り残される」という罠そのものになる。
 *    予約キー 1 本なら `delete('p')` の 1 行で完全に掃除できる。
 *
 * ② **名前付きのペアで並べる。**`fib-600_dist-rings_w1-0.25`。
 *    区切りは `_`(ペア間)と `-`(キー/値)で、どちらも
 *    `application/x-www-form-urlencoded` を素通りする(`%` が一切出ない)。
 *    値に `.` を含む(`0.25`)ので**ペア区切りに `.` は使えない**。
 *    位置で並べる案(`p=cube.7.perspective`)は却下した ── この作品は Phase を
 *    重ねてパラメータが増え続けるので、位置を 1 つ挿入した瞬間に
 *    **既存の共有リンクが黙って別の絵になる**。
 *
 * ③ **未知のキーは無視する。**新しい Phase の URL を古いビルドが開いても落ちない。
 *
 * ④ **既定と一致する値は書かない。**何も触らなければ URL は今日とバイト単位で同じ。
 *
 * ⑤ **壊れた値では決して投げない。**そのペアを捨てて既定へ落とす
 *    (Phase 13 の「壊れたリンクで白画面にしない」を符号化層まで延長したもの)。
 *    とくに `family` の検証は必須である ── `makePolytope` は default 節を持たず、
 *    未知の族で `undefined` を返して `poly.vertices` で落ちる。**唯一の即クラッシュ経路。**
 *
 * ## localStorage を採らない
 *
 * 「リロードで既定へ戻る」は URL に載った時点で自動的に直る。localStorage が
 * 追加で買うのは「タブを閉じて後日、素の URL で来た」場合だけで、その代わりに
 * **Phase 41 の契約を壊す** ── 終章の CTA は「七次元から、はじめる」と名乗り、
 * 着地は polytope / cube / n=7 である。前回 n=10 で去った人に n=10 を復元すると
 * CTA が名乗った数と副題が食い違う。しかも `content.test.ts` は静的なので
 * **落ちずに壊れる**。URL と混ぜれば、送り手も受け手も見たことのない絵ができる ──
 * 共有を直すための機能が共有を壊す。
 *
 * ## three も DOM も import しない
 *
 * vitest はこのリポジトリでは **node 環境・jsdom なし**で走る(既存 16 本が
 * すべて純関数なのはその帰結)。符号化と復号は「体感を決める層」ではないが、
 * **壊れた入力に対する振る舞いが仕様そのもの**なので試験に載せる必要がある。
 * だから型だけの import に留める(`verbatimModuleSyntax` で実行時に消える)。
 */

import type { ExhibitId } from './gallery';

/* ------------------------------------------------------------ 出荷時の既定 */

/**
 * 各展示の出荷時の既定。**`EXHIBIT_REGISTRY` の `create()` はここを渡す。**
 *
 * 以前は registry のクロージャに直接書いてあり、クラス側のコンストラクタにも
 * `?? 10` のような別の既定があった(polytope は registry が 7、クラスが 10)。
 * 「既定と一致するなら URL に書かない」を判定する側がそのどちらを見るかで
 * 答えが変わるので、**出荷時の既定はここ 1 箇所**に置く。
 * クラス側の `??` は `?exhibit=` の単独ブート用のフォールバックとして残る。
 */
export const POLYTOPE_DEFAULTS = {
  family: 'cube',
  n: 7,
  projection: 'perspective',
  spin: null,
} as const;

export const PERSPECTIVE_DEFAULTS = {
  observer: 3,
  target: 4,
  mode: 'slice',
  rotate: true,
} as const;

export const CLIFFORD_DEFAULTS = {
  circlesU: 36,
  circlesV: 36,
  isoclinic: false,
  omega1: 0.22,
  omega2: 0.13,
  precession: 0.05,
} as const;

export const HOPF_DEFAULTS = {
  fiberCount: 600,
  distribution: 'rings',
  isoclinic: true,
  omega1: 0.25,
  omega2: 0.16,
  precession: 0.07,
} as const;

/* ------------------------------------------------------------------ 符号化 */

/** 復号の結果。展示のコンストラクタへそのまま渡せる形 */
export type ExhibitOverrides = Record<string, unknown>;

interface Field {
  /** URL に出る短い名前。展示ごとに一意であればよい */
  readonly short: string;
  /** params から読む。既定と同じなら null(= 書かない) */
  read(params: ExhibitOverrides): string | null;
  /** 生の文字列を検証して書き込む。不正なら**何もしない**(投げない) */
  write(raw: string, out: ExhibitOverrides): void;
}

/** ペア間の区切り。urlencode を素通りし、値に現れない文字 */
const PAIR = '_';
/** キーと値の区切り。**最初の 1 個だけ**で切る(値が `-` を含んでよい) */
const KV = '-';
/** 整数リストの区切り。値の中でだけ使う */
const LIST = '.';

/** 小数の書式。3 桁で丸め、末尾の 0 を落とす(0.25 → "0.25"、0.5 → "0.5") */
function formatNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function intField(short: string, key: string, min: number, max: number, def: number): Field {
  return {
    short,
    read: (p) => {
      const value = p[key];
      if (typeof value !== 'number' || value === def) return null;
      return String(Math.round(value));
    },
    write: (raw, out) => {
      const value = Number(raw);
      if (!Number.isFinite(value)) return;
      const rounded = Math.round(value);
      if (rounded < min || rounded > max) return;
      out[key] = rounded;
    },
  };
}

function numField(short: string, key: string, min: number, max: number, def: number): Field {
  return {
    short,
    read: (p) => {
      const value = p[key];
      if (typeof value !== 'number' || value === def) return null;
      return formatNumber(value);
    },
    write: (raw, out) => {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < min || value > max) return;
      out[key] = value;
    },
  };
}

function enumField(short: string, key: string, values: readonly string[], def: string): Field {
  return {
    short,
    read: (p) => {
      const value = p[key];
      if (typeof value !== 'string' || value === def) return null;
      return values.includes(value) ? value : null;
    },
    // union の検証はここが唯一の関門。`makePolytope` は未知の族で undefined を
    // 返して落ちるので、素通しにしてはいけない
    write: (raw, out) => {
      if (values.includes(raw)) out[key] = raw;
    },
  };
}

function boolField(short: string, key: string, def: boolean): Field {
  return {
    short,
    read: (p) => {
      const value = p[key];
      if (typeof value !== 'boolean' || value === def) return null;
      return value ? '1' : '0';
    },
    write: (raw, out) => {
      if (raw === '1') out[key] = true;
      else if (raw === '0') out[key] = false;
    },
  };
}

/**
 * 整数の並び(回転平面のキー)。`null` は「既定に従う」を意味するので書かない。
 * 空の選択は `spin-` ではなく **`spin-x`** と書く ── 空文字の値は
 * 「キーだけがある」と見分けが付かない。
 */
function intListField(short: string, key: string, min: number, max: number): Field {
  const EMPTY = 'x';
  return {
    short,
    read: (p) => {
      const value = p[key];
      if (!Array.isArray(value)) return null;
      const list = value.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (list.length === 0) return EMPTY;
      return [...new Set(list.map((v) => Math.round(v)))].sort((a, b) => a - b).join(LIST);
    },
    write: (raw, out) => {
      if (raw === EMPTY) {
        out[key] = [];
        return;
      }
      const list: number[] = [];
      for (const part of raw.split(LIST)) {
        const value = Number(part);
        if (!Number.isFinite(value)) return; // 1 つでも壊れていたらこのペアごと捨てる
        const rounded = Math.round(value);
        if (rounded < min || rounded > max) return;
        list.push(rounded);
      }
      if (list.length > 0) out[key] = [...new Set(list)].sort((a, b) => a - b);
    },
  };
}

/**
 * 展示ごとの符号化表。
 *
 * `Record<ExhibitId, …>` にしてあるので、**展示を足して表を書き忘れると
 * コンパイルが通らない**。route.ts の `isExhibitId` が
 * 「取りうる id の判定を 1 本に寄せる」のと同じ狙いで、手書きの分岐が
 * 順路の変更に取り残されるのを型で止める。
 *
 * ここに**無い**パラメータは意図的に載せていない:
 *   ・polytope `dist` … UI が無く、実効値は形状ごとに自動で伸びる
 *                       (載せた値と見えている絵が対応しない)
 *   ・hopf `tilt` … UI が無い
 *   ・perspective `family` … 専用の操作子が無く(プリセット経由のみ)、
 *                       `sphere` を共有された人はパネルから戻せない
 * **載せるなら、先に操作子を作ること。**
 */
export const EXHIBIT_CODECS: Record<ExhibitId, readonly Field[]> = {
  polytope: [
    enumField('fam', 'family', ['cube', 'simplex', 'orthoplex'], POLYTOPE_DEFAULTS.family),
    intField('n', 'n', 3, 10, POLYTOPE_DEFAULTS.n),
    enumField('proj', 'projection', ['perspective', 'ortho'], POLYTOPE_DEFAULTS.projection),
    // 平面キーは i·16 + j(i<j<16)なので 0..255 に収まる
    intListField('spin', 'spin', 0, 255),
  ],
  perspective: [
    intField('m', 'observer', 2, 5, PERSPECTIVE_DEFAULTS.observer),
    intField('n', 'target', 2, 6, PERSPECTIVE_DEFAULTS.target),
    enumField('mode', 'mode', ['slice', 'shadow', 'xray'], PERSPECTIVE_DEFAULTS.mode),
    boolField('rot', 'rotate', PERSPECTIVE_DEFAULTS.rotate),
  ],
  clifford: [
    intField('u', 'circlesU', 12, 64, CLIFFORD_DEFAULTS.circlesU),
    intField('v', 'circlesV', 12, 64, CLIFFORD_DEFAULTS.circlesV),
    boolField('iso', 'isoclinic', CLIFFORD_DEFAULTS.isoclinic),
    numField('w1', 'omega1', 0, 0.6, CLIFFORD_DEFAULTS.omega1),
    numField('w2', 'omega2', 0, 0.6, CLIFFORD_DEFAULTS.omega2),
    numField('pre', 'precession', 0, 0.15, CLIFFORD_DEFAULTS.precession),
  ],
  hopf: [
    intField('fib', 'fiberCount', 24, 1200, HOPF_DEFAULTS.fiberCount),
    enumField('dist', 'distribution', ['rings', 'great', 'fibonacci'], HOPF_DEFAULTS.distribution),
    boolField('iso', 'isoclinic', HOPF_DEFAULTS.isoclinic),
    numField('w1', 'omega1', 0, 0.6, HOPF_DEFAULTS.omega1),
    numField('w2', 'omega2', 0, 0.6, HOPF_DEFAULTS.omega2),
    numField('pre', 'precession', 0, 0.2, HOPF_DEFAULTS.precession),
  ],
};

/** 出荷時の既定(復号のフォールバック / registry の `create()` が渡す値) */
export const EXHIBIT_DEFAULTS: Record<ExhibitId, ExhibitOverrides> = {
  polytope: POLYTOPE_DEFAULTS,
  perspective: PERSPECTIVE_DEFAULTS,
  clifford: CLIFFORD_DEFAULTS,
  hopf: HOPF_DEFAULTS,
};

/**
 * 展示の params を URL の値へ。既定と一致する項目は書かないので、
 * 何も触っていなければ空文字(= `p` を付けない)になる。
 */
export function encodeState(id: ExhibitId, params: ExhibitOverrides): string {
  const parts: string[] = [];
  for (const field of EXHIBIT_CODECS[id]) {
    const value = field.read(params);
    if (value !== null && value !== '') parts.push(`${field.short}${KV}${value}`);
  }
  return parts.join(PAIR);
}

/**
 * URL の値を展示のコンストラクタ引数へ。
 *
 * **未知のキーは無視し、壊れた値はそのペアだけ捨てる。**投げない。
 */
export function decodeState(id: ExhibitId, raw: string | null): ExhibitOverrides {
  const out: ExhibitOverrides = {};
  if (raw === null || raw === '') return out;
  const fields = new Map(EXHIBIT_CODECS[id].map((field) => [field.short, field]));
  for (const pair of raw.split(PAIR)) {
    const cut = pair.indexOf(KV);
    if (cut <= 0) continue;
    const field = fields.get(pair.slice(0, cut));
    if (field === undefined) continue; // 未知のキー = 将来の Phase のもの
    field.write(pair.slice(cut + 1), out);
  }
  return out;
}

/** 出荷時の既定に、URL から復号した差分を重ねた最終的な生成引数 */
export function resolveOverrides(id: ExhibitId, raw: string | null): ExhibitOverrides {
  return { ...EXHIBIT_DEFAULTS[id], ...decodeState(id, raw) };
}
