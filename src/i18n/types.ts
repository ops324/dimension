/**
 * 多言語の辞書の型(Phase 45)。
 *
 * ここは**型だけ**。実体は `ja.ts` / `en.ts` が持ち、`ui/content.ts` が
 * `LANG` で 1 つを選んで束ねる。型をこの 1 本に切り出しておくと、
 * 訳を足し忘れたときに**コンパイラが落ちる** ── 「英語版に codex の
 * quests が無い」は実行してから気づくことではない。
 *
 * 章と展示の型はもともと `ui/content.ts` にあり、そこから再エクスポートを
 * 続けている(`import type { Chapter } from './content'` の呼び出し側を
 * 1 行も書き換えないため)。
 */

export type ChapterRole = 'prologue' | 'chapter' | 'epilogue';

export interface Chapter {
  /** DOM の id・data 属性に使う安定キー。**言語を跨いで同一**であること */
  readonly id: string;
  /** 巨大ディスプレイ英字(Unbounded 800)。原則どの言語でも同じ語 */
  readonly en: string;
  /**
   * 読者の言語で読む見出しと本文。
   *
   * もとは `jp` という名だった。英語版が入った時点で「jp に英文が入っている」
   * ことになるので改名した ── Phase 38 の「数えているものを名前にする」と同じ理由で、
   * **中身と食い違う名前は次に読む人を必ず騙す**。
   */
  readonly text: {
    readonly title: string;
    readonly body: string;
  };
  /**
   * この章の**終端**で到達する dimLevel。
   * scrollDirector は章 i の前半で d[i-1] → d[i] を補間する。
   */
  readonly dim: number;
  /** 章番号ラベル(Space Mono・欧文)。数なので言語に依らない */
  readonly index: string;
  /** 章の次元ラベル。プロローグ/エピローグは持たない */
  readonly unit?: string;
  /** 縦組みの飾り(writing-mode: vertical-rl) */
  readonly caption: string;
  /**
   * 章番号の下に添える計器の読み(Space Mono・装飾)。
   * 記号と数だけなので言語に依らない。
   */
  readonly coord?: string;
  /** セクション高さと文字組みの出し分け */
  readonly role: ChapterRole;
  /** プロローグのみ: スクロール誘導 */
  readonly hint?: string;
  /** エピローグのみ: ギャラリーへの CTA ラベル */
  readonly cta?: string;
}

/** クエスト = パネル操作への誘い。title は命令形、body は「何が見られるか」の予告 */
export interface CodexQuest {
  readonly title: string;
  readonly body: string;
}

/** 図鑑データの 1 行。label は欧文モノ(言語に依らない)、value は短い訳文 */
export interface CodexStat {
  readonly label: string;
  readonly value: string;
}

/** やさしい層の全体。Drawer.ts がこの構造からコーデックス DOM を組む */
export interface ExhibitCodex {
  /** 一行のフック(ドロワー冒頭の大きな文字) */
  readonly hook: string;
  /** 導入 2〜3 文。専門用語ゼロ */
  readonly intro: string;
  /** たとえ話カードの見出しと本文 */
  readonly metaphorTitle: string;
  readonly metaphor: string;
  /** 「いま見えているもの」── 画面の観察ポイント */
  readonly observe: readonly string[];
  /** TRY THIS ── パネル操作のクエスト */
  readonly quests: readonly CodexQuest[];
  /** 図鑑データ(2 列グリッド) */
  readonly stats: readonly CodexStat[];
}

export interface ExhibitInfo {
  readonly id: string;
  /** タブとヘッダの英字ディスプレイ。**言語を跨いで同一** */
  readonly en: string;
  /**
   * 英字に添える副題(小さく暗い一行。タブにも出る)。
   *
   * もとは `jp` という名だった(`Chapter.text` と同じ理由で改名)。
   * **どの言語でも空にしない** ── ExhibitHeader は `[subEl, taglineEl]` を
   * まとめて行分割するので、空文字を渡すと分割器に空の要素が流れる。
   * 英語では対象そのものを名指しする短い一行を置いてある。
   */
  readonly sub: string;
  /**
   * 一行の惹句(ヘッダに出る)。
   * 展示が `tagline()` を実装していれば、そちらが優先される(Phase 40 の PERSPECTIVE)。
   */
  readonly tagline: string;
  /** やさしい層(Phase 15) */
  readonly codex: ExhibitCodex;
  /** 深い層 ── 「解説」ドロワーの DEEP DIVE 本文(装飾 HTML) */
  readonly explanation: string;
}

/* --------------------------------------------------------------- POLYTOPE の語 */

/**
 * POLYTOPE EXPLORER の名前づけ。
 *
 * **数え方(算術)は共有、呼び方(言語)だけがここに来る。** 頂点数・辺数の
 * 3 桁区切りや「固有名を引いてから族の総称へ落ちる」という手順は
 * `ui/content.ts` が 1 本だけ持つ ── 言語ごとに手順を書くと、片方だけ
 * 直したときに食い違う。
 */
export interface PolytopeCopy {
  /** 族 × n の固有名。**表に無い n は「数で呼ぶ」へ落ちる**(それが作品上の狙い) */
  readonly names: Readonly<Record<string, Readonly<Record<number, string>>>>;
  /** 族の総称。固有名を持たない次元はこちらで呼ぶ */
  readonly kinds: Readonly<Record<string, string>>;
  /** 未知の族の総称(保険) */
  readonly fallbackKind: string;
  /**
   * 次元を**その言語の数詞で**読む。ja は漢数字(`七`)、en は綴った数(`seven`)。
   *
   * `byNumber` の中に埋め込まずに独立させてあるのは、**終章の CTA と着地の
   * 副題が同じ数を名乗っている**ことを試験が確かめられるようにするため
   * (Phase 41 の受け渡し)。文字列をテスト側へ手で写すと、訳を直した瞬間に
   * 嘘になる ── 数詞の綴りも辞書が唯一の情報源であること。
   *
   * 表の外の n は算用数字へ落とす(それも「名前が足りない」の一形態)。
   */
  readonly numeral: (n: number) => string;
  /**
   * 固有名が尽きたときの呼び名。
   *
   * ja は `七次元の超立方体`、en は `seven-dimensional hypercube`。
   * どちらも**名前は言語、数は算術**という対比を保つための綴りで、
   * 下の `tagline` が算用数字を使うのと対になっている。崩さないこと。
   */
  readonly byNumber: (n: number, kind: string) => string;
  /** 見出しの副題。`name` は上で組んだ呼び名、`vertices`/`edges` は 3 桁区切り済み */
  readonly tagline: (name: string, vertices: string, edges: string) => string;
}

/* ------------------------------------------------------------ PERSPECTIVE の語 */

export interface PerspectiveCopy {
  /** キーは `モード:観測者m:対象n`。完全一致が無ければ `モード` だけへ落ちる */
  readonly captions: Readonly<Record<string, string>>;
  /** キーは `m:n` */
  readonly taglines: Readonly<Record<string, string>>;
  /** 表に無い組。次元差から組み立てる(必ず何かを返す) */
  readonly taglineFallback: (m: number, n: number) => string;
}

/* ---------------------------------------------------------------------- UI の語 */

/**
 * 二言語ならぶ場所の対。
 *
 * この作品の意匠は**「読者の言語 + 欧文の飾り」の二段組み**で出来ている
 * (ナビの `物語 / STORY`、ドロワーの `ANALOGY / たとえるなら`)。英語で読む回は
 * 二段が同じ語になってしまうので、**片方を空文字にする** ── 空の側は
 * style.css の `:empty` 規則が畳む。どちらが主でどちらが飾りかは場所ごとに
 * 違うので(ナビは訳文が大きく、ドロワーは欧文が主)、対のまま渡して
 * 差し込み先はコンポーネントに任せる。
 */
export interface LabelPair {
  /** 訳文の側 */
  readonly text: string;
  /** 欧文の側 */
  readonly latin: string;
}

export interface UiCopy {
  /** `<title>` と meta / OGP。index.html の静的タグを起動時に書き換える */
  readonly doc: {
    readonly title: string;
    readonly description: string;
    readonly ogDescription: string;
    readonly ogImageAlt: string;
  };
  /** 器の文言(index.html に静的に置いてあるもの) */
  readonly chrome: {
    readonly skipToGallery: string;
    readonly canvasLabel: string;
    readonly navLabel: string;
    readonly navNarrative: LabelPair;
    readonly navGallery: LabelPair;
    readonly tabsLabel: string;
    readonly about: LabelPair;
    readonly drawerClose: string;
    readonly qualityLabel: string;
  };
  readonly preloader: {
    readonly caption: string;
    readonly label: string;
  };
  readonly sound: {
    readonly label: string;
    readonly hint: string;
  };
  readonly immersive: { readonly label: string };
  readonly engine: {
    readonly error: string;
    readonly reload: string;
  };
  readonly panel: {
    readonly hint: string;
    readonly toggle: string;
  };
  /** ドロワーの節見出し。すべて `欧文 / 訳文` の対 */
  readonly drawer: {
    readonly analogy: LabelPair;
    readonly observe: LabelPair;
    readonly tryThis: LabelPair;
    readonly data: LabelPair;
    readonly deepDive: LabelPair;
  };
  /**
   * 支援技術への読み上げ(Announcer)。DOM には出ない。
   *
   * `exhibit` が `ExhibitInfo` を丸ごと受け取るのは、**どのフィールドを
   * 読み上げるかが言語ごとに違う**ため。日本語は `sub`(日本語名)で告げる ──
   * 日本語の TTS に欧文の `en` を渡すと綴りを読み上げてしまう。英語は逆に
   * `en` が正しい名前で、`sub` は説明の一行なので読み上げには長い。
   * 呼び出し側(`core/gallery.ts`)に言語の分岐を置かないための形である。
   */
  readonly announce: {
    readonly backToNarrative: string;
    readonly exhibit: (index: number, total: number, info: ExhibitInfo) => string;
  };
  /** 回転平面グリッドの升の読み上げ名 */
  readonly planeCell: (i: number, j: number) => string;
  /**
   * 言語スイッチ自身。
   *
   * `names` は**各言語をその言語自身の名前で**書いた表(自言語表記)。
   * どの言語の辞書でも同じ中身になる ── 英語版でも「日本語」は「日本語」で、
   * 探している人が読める字で書いてあることが要件である。
   *
   * `switchTo` は読み上げ名。チップの可視ラベルは**行き先の言語名**なので、
   * それだけでは「いまその言語なのか、押すとその言語になるのか」が
   * 支援技術に伝わらない ── 動詞はここで足す。
   */
  readonly langToggle: {
    readonly names: Readonly<Record<string, string>>;
    readonly switchTo: (name: string) => string;
  };
  /** 4 展示の操作パネル */
  readonly panels: {
    readonly polytope: PolytopePanelCopy;
    readonly perspective: PerspectivePanelCopy;
    readonly clifford: CliffordPanelCopy;
    readonly hopf: HopfPanelCopy;
  };
}

/**
 * パネルのラベルは日本語版では `FAMILY / 族` のように**欧文と訳文を
 * スラッシュで繋いだ 1 本の文字列**になっている(Slider / Segmented は
 * 文字列 1 つしか受け取らない)。英語版はスラッシュの右が消えて `FAMILY` になる ──
 * つまりこれは対ではなく、**言語ごとに丸ごと違う 1 本の文字列**である。
 */
export interface PolytopePanelCopy {
  readonly family: string;
  readonly families: {
    readonly cube: string;
    readonly simplex: string;
    readonly orthoplex: string;
  };
  readonly n: string;
  readonly projection: string;
  readonly projections: {
    readonly perspective: string;
    readonly ortho: string;
  };
  readonly noteProjection: string;
  readonly rotationPlanes: string;
  readonly planes: string;
  readonly notePlanes: string;
  readonly spin: {
    readonly default: string;
    readonly depth: string;
    readonly pose: string;
    readonly all: string;
  };
  /** SPINNING / PLANES の読み。保留枚数があるときだけ括弧が付く */
  readonly spinSummary: (spinning: number, total: number, dropped: number) => string;
}

export interface PerspectivePanelCopy {
  readonly presetsNote: string;
  readonly presets: {
    readonly flatland: string;
    readonly tesseract: string;
    readonly fromAbove: string;
  };
  readonly observer: string;
  readonly target: string;
  readonly mode: string;
  readonly modes: {
    readonly slice: string;
    readonly shadow: string;
    readonly xray: string;
  };
  readonly rotate: string;
  readonly note: string;
  /** 神視点の窓のラベル。ここも二段組み */
  readonly godView: string;
}

export interface CliffordPanelCopy {
  readonly gridU: string;
  readonly gridV: string;
  readonly isoclinic: string;
  readonly omega1: string;
  readonly omega2: string;
  readonly precession: string;
  readonly note: string;
}

export interface HopfPanelCopy {
  readonly fibers: string;
  readonly distribution: string;
  readonly distributions: {
    readonly latitude: string;
    readonly greatCircle: string;
    readonly fibonacci: string;
  };
  readonly isoclinic: string;
  readonly omega1: string;
  readonly omega2: string;
  readonly precession: string;
  readonly note: string;
}

/* ------------------------------------------------------------------------ 辞書 */

/**
 * 1 言語ぶんの全文。**`ja.ts` と `en.ts` はこの型を実装する** ──
 * 訳の抜けはコンパイル時に落ちる。
 */
export interface Copy {
  /** 物語の流れる帯(装飾の欧文)。言語ごとに変えてよい */
  readonly marquee: {
    readonly prologue: string;
    readonly epilogue: string;
  };
  readonly chapters: readonly Chapter[];
  readonly exhibits: readonly ExhibitInfo[];
  readonly polytope: PolytopeCopy;
  readonly perspective: PerspectiveCopy;
  readonly ui: UiCopy;
}
