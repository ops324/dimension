/**
 * 物語「次元の階段」の全コピー。
 *
 * プラン8節「コピーライティングは作品品質の中核」に従い、テキストはここに
 * 一元管理する。DOM は overlays.ts の buildNarrativeDOM() がこの配列から
 * 生成するので、章の追加・並べ替え・推敲はこのファイルだけで完結する。
 *
 * 日本語本文の方針:
 *   - 詩的でありながら数学的に正確であること(頂点数・辺数・胞数は実数値)
 *   - 2〜4 文。line-height 2 の読み心地に合う短い呼吸で切る
 *   - 「押し出し(extrusion)」という一本の比喩で 0D から 6D までを貫く
 */

export type ChapterRole = 'prologue' | 'chapter' | 'epilogue';

export interface Chapter {
  /** DOM の id・data 属性に使う安定キー */
  readonly id: string;
  /** 巨大ディスプレイ英字(Unbounded 800) */
  readonly en: string;
  readonly jp: {
    readonly title: string;
    readonly body: string;
  };
  /**
   * この章の**終端**で到達する dimLevel。
   * scrollDirector は章 i の前半で d[i-1] → d[i] を補間する。
   */
  readonly dim: number;
  /** 章番号ラベル(Space Mono・欧文) */
  readonly index: string;
  /** 章の次元ラベル。プロローグ/エピローグは持たない */
  readonly unit?: string;
  /** 縦組みの飾り(writing-mode: vertical-rl) */
  readonly caption: string;
  /** セクション高さと文字組みの出し分け */
  readonly role: ChapterRole;
  /** プロローグのみ: スクロール誘導 */
  readonly hint?: string;
  /** エピローグのみ: ギャラリーへの CTA ラベル */
  readonly cta?: string;
}

export const CHAPTERS: readonly Chapter[] = [
  {
    id: 'prologue',
    en: 'DIMENSION',
    dim: 0,
    index: 'PROLOGUE',
    caption: '序章',
    role: 'prologue',
    hint: 'SCROLL',
    jp: {
      title: '見えない次元へ',
      body:
        '人間の目は、三つの方向しか受けとれない。縦と、横と、奥ゆき。' +
        'それでも数学は、その先へ進むことができる ── 見えないまま、正確に。' +
        'スクロールするたび、世界に方向がひとつずつ加わっていく。',
    },
  },
  {
    id: 'd0',
    en: 'POINT',
    dim: 0,
    index: 'CH.00',
    unit: '0D',
    caption: '第〇章',
    role: 'chapter',
    jp: {
      title: '大きさを持たない場所',
      body:
        '点には、広がりがない。あるのは「ここ」という一点の事実だけだ。' +
        '長さも、面積も、体積も、まだ生まれていない。' +
        'すべての次元は、この沈黙から始まる。',
    },
  },
  {
    id: 'd1',
    en: 'LINE',
    dim: 1,
    index: 'CH.01',
    unit: '1D',
    caption: '第一章',
    role: 'chapter',
    jp: {
      title: '点が、動く',
      body:
        '点をひとつの方向へ動かす。その軌跡が線になり、世界にはじめて長さが宿る。' +
        '線の中に住むものにとって、世界は前と後ろがすべてだ。' +
        '振り返ることはできても、すれちがうことはできない。',
    },
  },
  {
    id: 'd2',
    en: 'PLANE',
    dim: 2,
    index: 'CH.02',
    unit: '2D',
    caption: '第二章',
    role: 'chapter',
    jp: {
      title: '線が、横切る',
      body:
        '線を、それ自身と直角な向きへ押し出す。掃かれた跡が平面になり、面積が生まれる。' +
        'ここでは道が交わり、円が閉じ、はじめて回り込むことができる。' +
        'それでも、上という方向はまだない。',
    },
  },
  {
    id: 'd3',
    en: 'SOLID',
    dim: 3,
    index: 'CH.03',
    unit: '3D',
    caption: '第三章',
    role: 'chapter',
    jp: {
      title: 'わたしたちの部屋',
      body:
        '平面を、紙から浮かせるように持ち上げる。六つの面が閉じて、立方体ができあがる。' +
        'ここがわたしたちの住む世界であり、目に映るものの果てでもある。' +
        'この先は、見ることをあきらめて、数えることになる。',
    },
  },
  {
    id: 'd4',
    en: 'TESSERACT',
    dim: 4,
    index: 'CH.04',
    unit: '4D',
    caption: '第四章',
    role: 'chapter',
    jp: {
      title: '四つ目の方向',
      body:
        '立方体を、どの辺とも直角な「四つ目の方向」へ押し出す。それがテッセラクト。' +
        '八つの立方体が、たがいの面を共有したまま閉じている。' +
        'あなたが見ているのは、その影にすぎない ── ' +
        '内側にある小さな立方体は、縮んでいるのではなく、四つ目の方向へ遠ざかっているだけだ。',
    },
  },
  {
    id: 'd5',
    en: 'PENTERACT',
    dim: 5,
    index: 'CH.05',
    unit: '5D',
    caption: '第五章',
    role: 'chapter',
    jp: {
      title: '規則だけが、先へ行く',
      body:
        '直角な方向を、もう一本。それだけでペンテラクト ── 五次元の超立方体になる。' +
        '三十二の頂点、八十本の辺、十個のテッセラクト。' +
        '頭の中にはもう像が結ばないのに、数はどこまでも正確に続いていく。',
    },
  },
  {
    id: 'd6',
    en: 'HEXERACT',
    dim: 6,
    index: 'CH.06',
    unit: '6D',
    caption: '第六章',
    role: 'chapter',
    jp: {
      title: 'ふたつの回転が、同時に',
      body:
        'ヘクセラクト、六次元の超立方体。六十四の頂点と百九十二本の辺が、いま同時に回っている。' +
        '三次元では、回転はいつも一本の軸のまわりで起きる。' +
        'けれど四次元より先では、物体は互いに独立なふたつの平面で同時に回れる ── ' +
        '影がほどけ、裏返り、それでも一度も壊れないのはそのためだ。',
    },
  },
  {
    id: 'epilogue',
    en: 'BEYOND',
    dim: 6,
    index: 'EPILOGUE',
    caption: '終章',
    role: 'epilogue',
    cta: 'ギャラリーを探索する',
    jp: {
      title: 'ここから先は、あなたの番',
      body:
        '次元は六で終わらない。七も、十も、その先も、同じ規則のままそこにある ── ' +
        'ただ、名前がまだ足りないだけだ。' +
        'ここから先は、あなたが自由に探索する番だ。',
    },
  },
];

/** 章ごとの目標 dimLevel(scrollDirector へ渡す。毎フレーム再構築しないよう定数化) */
export const CHAPTER_DIMS: readonly number[] = CHAPTERS.map((c) => c.dim);

/* ------------------------------------------------------------------ PERSPECTIVE */

/**
 * 視点次元セレクタ展示のキャプション(プラン7節)。
 *
 * キーは `モード:観測者m:対象n`。完全一致がなければ `モード` だけのフォールバックを引く。
 * 一文で「いま画面に起きていること」を言い切る ── 章テキストと同じ語り口(平易な語彙・
 * 断定・比喩は一本)で、けれど数学的には嘘をつかないこと。
 */
export const PERSPECTIVE_CAPTIONS: Readonly<Record<string, string>> = {
  // --- 断面(低い次元から高い次元を見る) ---
  slice:
    '高い次元の物体が世界を通り抜けるとき、低い次元の住人に見えるのは、たった一枚の切り口だけだ。',
  'slice:2:3':
    '平面の住人にとって、立方体はどこからともなく現れる多角形だ。三角が四角に、六角に変わり、そして消える。',
  'slice:3:4':
    '三次元のわたしたちに見えるのは、テッセラクトの断面だけだ ── 現れ、ふくらみ、かたちを変えて、消えていく。',
  'slice:3:5':
    '五次元の立体が通り過ぎる。断面はもう四次元で、それをさらに影にして、ようやくわたしたちの目に届く。',
  'slice:2:4':
    '四次元の物体の断面は立体だ。その立体すら、平面の住人には一本の線としてしか届かない。',
  // --- 影(次元を落とす投影) ---
  shadow:
    '影は、失われた次元の記録だ。長さは歪み、直角はほどけ、それでも構造そのものは残っている。',
  'shadow:3:4':
    'テッセラクトの影。内側の小さな立方体は縮んでいるのではない ── 四つ目の方向へ遠ざかっているだけだ。',
  'shadow:2:3':
    '平面に落ちた立方体の影。六つの正方形は、もう正方形には見えない。',
  // --- X線俯瞰(高い次元から低い次元を見下ろす) ---
  xray: 'ひとつ上の次元から見下ろせば、閉じているはずのものが、すべて開いて見える。',
  'xray:3:2':
    '上から見れば、家の中も、部屋の間取りも、住人の内側さえ、すべてが同時に見えてしまう。',
  'xray:4:3':
    '四次元の目には、わたしたちの世界がこう映る。壁も、皮膚も、金庫の扉も、何ひとつ隔てにならない。',
};

/**
 * (モード, 観測者 m, 対象 n) に対応するキャプションを引く。
 * 個別の組が未定義ならモード共通の一文へ落とす(必ず何かを返す)。
 */
export function perspectiveCaption(mode: string, m: number, n: number): string {
  return PERSPECTIVE_CAPTIONS[`${mode}:${m}:${n}`] ?? PERSPECTIVE_CAPTIONS[mode] ?? '';
}
