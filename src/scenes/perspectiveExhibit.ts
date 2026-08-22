import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

import { clamp, clamp01, expSmooth } from '../math/ease';
import {
  makeNOrthoplex,
  makePolytope,
  type Polytope,
  type PolytopeFamily,
} from '../math/polytopes';
import { rotateBatch, type PlaneRotation } from '../math/rotation';
import { projectPerspective } from '../math/projection';
import {
  faceCountOfDim,
  makeFlatSliceGeometry,
  sliceFlat,
  type FlatSliceGeometry,
} from '../math/flatSlice';
import { sphereSliceRadius } from '../math/slice';

import { LineBatch } from '../render/lineBatch';
import { PointBatch } from '../render/pointBatch';
import { CYAN, GOLD, MAGENTA, VIOLET } from '../render/palette';
import { perspectiveCaption, perspectiveTagline } from '../ui/content';
import { createPanel } from '../ui/panel';
import { SHEET_LAYOUT_QUERY } from '../ui/components/component';

import type { EngineCtx, Exhibit } from './exhibit';

/**
 * 視点次元セレクタ「PERSPECTIVE」展示(プラン7節)。
 *
 * 「次元 m の観測者が次元 n の対象をどう知覚するか」を体験させる。
 *
 *   m < n(低い次元から高い次元を見る)
 *     slice  … 対象が観測者の超平面を通過する。見えるのは断面だけ(フラットランドの瞬間)
 *     shadow … n → m の透視投影。影として構造だけが残る
 *   m > n(高い次元から低い次元を見下ろす)
 *     xray   … 閉じた領域の内側がすべて同時に見える「X線俯瞰」。
 *              一般の数学ではなく**演出された場面**(家・部屋・住人・宝物)で見せる
 *
 * slice / shadow では画面右下に「神視点インセット」を重ね、対象と観測者超平面の
 * 位置関係を外から見せる。メインビュー(知覚)との対比がこの展示の教育的な核。
 */

export type PerspectiveMode = 'slice' | 'shadow' | 'xray';
/** 対象の族。ポリトープ 3 種 + 解析的に断面が求まる n-球 */
export type PerspectiveFamily = PolytopeFamily | 'sphere';

export interface PerspectiveParams {
  /** 観測者の次元 m。m=1(線の住人)は Phase 7/8 のストレッチなので 2..4 に丸める */
  observer: 1 | 2 | 3 | 4;
  /** 対象の次元 n(2..6)。m ≠ n */
  target: 2 | 3 | 4 | 5 | 6;
  family: PerspectiveFamily;
  /** m<n → slice|shadow、m>n → xray に自動で丸められる */
  mode: PerspectiveMode;
  /** 対象を nD でタンブルさせるか。false なら固定の見栄えのする姿勢で止める */
  rotate: boolean;
}

/** カメラ誘導のヒント(standalone ブートが expSmooth で適用する) */
export interface CameraHint {
  pos: THREE.Vector3;
  look: THREE.Vector3;
}

// --- 定数 ------------------------------------------------------------------

const OBSERVER_MIN = 2;
const OBSERVER_MAX = 4;
const TARGET_MIN = 2;
const TARGET_MAX = 6;

/** 線幅(CSS px)。gl.lineWidth は使えないので Line2 のファットライン */
const LINE_WIDTH = 2.6;

/**
 * 断面ワイヤの基礎輝度。線が数十本しかないので密度補正は不要(既知の罠 #6 は
 * 5000 本級の polytope explorer の話)。
 *
 * Phase 11: この展示だけはフォグを入れない(断面は数十本の疎な線で、遠近の
 * 積み上がりが起きないため)。その代わりブルーム減量ぶんの取り返しが無く、
 * 実測でも 4 展示中いちばん暗かった(行ごとのピーク 55/255 に対し他は 165〜207)。
 * よって 3 モードとも基礎輝度を +10% する ── 他の展示と同じ扱いに揃える。
 */
const SLICE_BRIGHTNESS = 0.66;
/** 影モードの基礎輝度。6-cube で 192 本まで増えるので軽い密度補正を入れる */
const SHADOW_BRIGHTNESS = 0.68;
const SHADOW_DENSITY_REFERENCE = 96;
const XRAY_BRIGHTNESS = 0.68;

/** 断面の頂点グロー */
const SLICE_POINT_SIZE = 0.75;
const SLICE_POINT_BRIGHT = 0.5;
/** X線俯瞰で閉領域の内部に置く「中が見えている」ことを示す大きく淡いスプライト */
const XRAY_GLOW_SIZE = 7;
const XRAY_GLOW_BRIGHT = 0.16;

/**
 * 超平面スイープ。
 *
 * 振幅は**その瞬間の姿勢でのスライス軸方向の厚み**の 1.04 倍にする。
 * 外接半径(=1)を基準に固定振幅を取ると、対象が薄く構えている間は超平面が
 * 完全に外れてしまう ── 実測で全体の 45% の時間、画面から断面が消えた
 * (テッセラクトの座標は ±1/2 しかなく、外接半径 1 に届くのは対角が揃った
 * 瞬間だけだから)。厚みに追従させれば、どの姿勢でも断面は必ず
 * 「生まれ → 最大 → 消える」を往復し、なお 1.04 倍ぶんの「無」も残る。
 */
const SWEEP_MARGIN = 1.04;
const SWEEP_OMEGA = 0.25;
/** 頂点との厳密一致による交差判定の不安定さを避ける(既知の罠 #9) */
const SWEEP_EPS = 1e-9;

/**
 * 掃引しない中間軸(m..n−2)を固定する位置。m < n−1 のときだけ使う。
 *
 * **0 ちょうどに置いてはいけない。** 正軸体の頂点 ±e_i はほとんどの座標が 0 で、
 * 平坦面がそれをまとめて通ると交点が重複して断面が壊れる(既知の罠 #9 の、
 * 余次元が 2 以上になったときの姿)。中心の近くで、互いに異なる半端な値にする ──
 * 中心付近を通すのは、断面が最も大きく育つ場所を見せるため。
 */
const FIXED_AXIS_OFFSETS: readonly number[] = [0.031, -0.047, 0.023, -0.017];

/** 透視カスケードの視点距離(プラン既定)。形状は外接半径 1 なので分母は安全 */
const PROJECT_DIST = 2.4;

/**
 * 自動タンブルの角速度。比を無理数にして周期が一致しないようにする
 * (合成回転が決して同じ姿勢へ戻らない = 常に新しい断面が現れる)。
 */
const OMEGA_0 = 0.31;
const OMEGA_1 = 0.23 * Math.SQRT2;
const OMEGA_2 = 0.17 * Math.sqrt(5);
/** rotate=false のときに凍結する姿勢(軸に平行でない = 断面が正方形にならない時刻) */
const FROZEN_POSE_T = 1.7;

/**
 * 自動フィットの目標半径。カメラ z≈7.2 / fov 50 の可視半高は ≈3.4 だが、断面は
 * 原点対称ではない(オフセット s の位置で切るので偏る)ため、その偏りぶんの
 * 余白を残して 2.2 にする。
 */
const TARGET_RADIUS = 2.2;
const FIT_SAMPLES = 48;
const FIT_SPAN = 41.3;
/** 演出シーン(X線俯瞰)は寸法を決め打ちで作ってあるので固定倍率 */
const XRAY_SCALE = 2.4;

const REVEAL_RATE = 9;

/** n-球ワイヤ: 緯線 8 本 + 経線 8 本 × 24 分割 */
const SPHERE_RINGS = 8;
const SPHERE_MERIDIANS = 8;
const SPHERE_RING_SEGMENTS = 24;
const SPHERE_WIRE_SEGMENTS = (SPHERE_RINGS + SPHERE_MERIDIANS) * SPHERE_RING_SEGMENTS;
/** 2 次元世界ビューでの円(断面 = 円周)の分割数 */
const CIRCLE_SEGMENTS = 64;

/** 演出シーンの線分数の上限(実測: 2D 世界 36 / 3D 家 53) */
const XRAY_MAX_SEGMENTS = 96;
const XRAY_MAX_GLOWS = 8;

/** インセットの寸法(CSS px)。3 : 2.2 の横長 */
const INSET_MARGIN = 16;
const INSET_ASPECT = 2.2 / 3;
const INSET_MIN_WIDTH = 150;
const INSET_MAX_WIDTH = 280;
const INSET_WIDTH_RATIO = 0.3;
/**
 * モバイル(ボトムシート版レイアウト)での縮小率(Phase 11)。
 * インセットは右下からタブ棚の直下へ引っ越す ── 右下はシートが覆う場所で、
 * 神視点が「開いた操作卓の裏に隠れる」のがこの展示で最も惜しい欠陥だった。
 * 引っ越し先は見出しと同じ帯なので、一回り小さくして文字と釣り合わせる。
 */
const INSET_MOBILE_SCALE = 0.82;
/** インセットのグリッド/超平面クアッドの一辺 */
const INSET_PLANE_SIZE = 2.4;

/** カメラヒントを出し続ける時間(秒)。切り替えの瞬間だけ誘導し、あとは操作に譲る */
const HINT_DURATION = 2.6;

const TWO_PI = Math.PI * 2;

// --- 容量(すべての (族 × n) を走査して導出。ハードコードしない) ----------------

function vertexCountOf(family: PolytopeFamily, n: number): number {
  switch (family) {
    case 'cube':
      return 1 << n;
    case 'simplex':
      return n + 1;
    case 'orthoplex':
      return 2 * n;
  }
}

function edgeCountOf(family: PolytopeFamily, n: number): number {
  switch (family) {
    case 'cube':
      return n * (1 << (n - 1));
    case 'simplex':
      return ((n + 1) * n) / 2;
    case 'orthoplex':
      return 2 * n * (n - 1);
  }
}

/**
 * 断面線分数の上限。
 *
 * 断面の辺を生むのは **(k+1)-面**(k = n − m)で、1 面につき高々 1 線分。
 * m は 2..n−1 を動くので k+1 は 2..n−1 を動く ── どの次元の面が最大に
 * なるかは族と n で変わるので、全次元の最大を取る(Phase 39)。
 */
function faceCountOf(family: PolytopeFamily, n: number): number {
  if (n < 2) return 0;
  let max = 0;
  for (let j = 0; j <= n; j++) max = Math.max(max, faceCountOfDim(family, n, j));
  return max;
}

/**
 * 最悪ケースは常に n=6 の cube: 64 頂点 / 192 辺 / 240 個の 2-面。
 * 線分バッファは n-球ワイヤ(384)が最大になる。
 */
const CAPACITY = (() => {
  const families: readonly PolytopeFamily[] = ['cube', 'simplex', 'orthoplex'];
  let vertices = 0;
  let edges = 0;
  let faces = 0;
  for (const family of families) {
    for (let n = TARGET_MIN; n <= TARGET_MAX; n++) {
      vertices = Math.max(vertices, vertexCountOf(family, n));
      edges = Math.max(edges, edgeCountOf(family, n));
      faces = Math.max(faces, faceCountOf(family, n));
    }
  }
  const segments = Math.max(faces, edges, SPHERE_WIRE_SEGMENTS, XRAY_MAX_SEGMENTS);
  return {
    vertices,
    edges,
    faces,
    segments,
    /** 断面の端点(線分ごとに 2 点)+ 演出シーンのグロー */
    points: Math.max(faces * 2, XRAY_MAX_GLOWS),
  };
})();

// --- 演出シーン(X線俯瞰)の設計図 -------------------------------------------
// 平面図は (u, v) で書き、ワールドへは (u, 0, −v) で置く(+v が奥 = 画面の上)。

/** 家の外壁。玄関の切り欠きぶんだけ開いた折れ線 */
const HOUSE2D_WALL: readonly number[] = [
  0.15, -0.6, 0.8, -0.6, 0.8, 0.35, 0, 0.85, -0.8, 0.35, -0.8, -0.6, -0.15, -0.6,
];
/** 玄関の左右の柱(内側へ 0.18) */
const HOUSE2D_DOOR: readonly number[] = [-0.15, -0.6, -0.15, -0.42, 0.15, -0.6, 0.15, -0.42];
/** 左の部屋 / 右の部屋(閉じた矩形) */
const HOUSE2D_ROOM_A: readonly number[] = [-0.68, -0.46, -0.06, -0.46, -0.06, 0.2, -0.68, 0.2];
const HOUSE2D_ROOM_B: readonly number[] = [0.06, -0.46, 0.68, -0.46, 0.68, 0.2, 0.06, 0.2];
/** 住人(左の部屋)と宝物(右の部屋) */
const HOUSE2D_INHABITANT = { u: -0.37, v: -0.12, r: 0.16 };
const HOUSE2D_TREASURE: readonly number[] = [0.28, -0.21, 0.46, -0.21, 0.46, -0.03, 0.28, -0.03];
/** 内部が「見えている」ことを示す淡いスプライトの位置(閉領域の重心) */
const HOUSE2D_GLOWS: readonly number[] = [-0.37, -0.13, 0.37, -0.13, 0, 0.42];

/** 3D の家: 母屋の箱と寄棟屋根の棟 */
const HOUSE3D_BODY = { cx: 0, cy: -0.05, cz: 0, hx: 0.8, hy: 0.6, hz: 0.6 };
const HOUSE3D_RIDGE_X = 0.55;
const HOUSE3D_RIDGE_Y = 1.0;
/** 内側の部屋・住人・宝物(すべて母屋の内部に収まる) */
const HOUSE3D_ROOM = { cx: 0.06, cy: -0.32, cz: -0.02, hx: 0.38, hy: 0.33, hz: 0.33 };
const HOUSE3D_INHABITANT = { cx: 0.14, cy: -0.36, cz: 0.06, r: 0.22 };
const HOUSE3D_TREASURE = { cx: -0.14, cy: -0.5, cz: -0.14, h: 0.075 };

function setPlane(rot: PlaneRotation, i: number, j: number): void {
  rot.i = i;
  rot.j = j;
}

/** 観測者 m と対象 n からモードを確定する(UI の要求は尊重しつつ矛盾を潰す) */
function resolveMode(m: number, n: number, requested: PerspectiveMode): PerspectiveMode {
  if (m > n) return 'xray'; // 高 → 低 は X 線俯瞰しかない
  return requested === 'xray' ? 'slice' : requested;
}

/**
 * 代表的な視点(PRESETS)。**表として持つ**のが Phase 19 の要点である ──
 * 以前はボタン 3 つのベタ書きで、押した先の (m, n, mode, family) が
 * その場のクロージャの中にしか無かった。表にすると「今の状態がどれかと一致するか」
 * を後から問い合わせられるようになり、OBSERVER を直接動かしたときにも
 * 現在地が点灯する(= プリセットが状態の**表示**でもある)。
 *
 * mode は「希望」の形で書いてよい ── 一致判定は resolveMode を通してから比べる。
 */
interface PerspectivePreset {
  readonly key: string;
  readonly label: string;
  readonly observer: number;
  readonly target: number;
  readonly mode: PerspectiveMode;
  readonly family: PerspectiveFamily;
}

const PRESETS: readonly PerspectivePreset[] = [
  { key: 'preset-flatland', label: '2 次元人が立方体を見る', observer: 2, target: 3, mode: 'slice', family: 'cube' },
  { key: 'preset-tesseract', label: '私たちがテッセラクトを見る', observer: 3, target: 4, mode: 'slice', family: 'cube' },
  { key: 'preset-fromabove', label: '4 次元の目で見る', observer: 4, target: 3, mode: 'xray', family: 'cube' },
];

/** 画面幅からインセットの CSS 幅を決める(DOM 枠と scissor 矩形の唯一の情報源) */
function insetWidthFor(viewportWidth: number): number {
  return clamp(viewportWidth * INSET_WIDTH_RATIO, INSET_MIN_WIDTH, INSET_MAX_WIDTH);
}

export class PerspectiveExhibit implements Exhibit {
  readonly id = 'perspective';
  readonly scene: THREE.Scene;
  readonly params: PerspectiveParams;

  private readonly group = new THREE.Group();

  private material!: LineMaterial;
  private lineBatch!: LineBatch;
  private pointBatch!: PointBatch;

  // --- nD の作業バッファ(すべて init で最大容量を確保・以後アロケーションなし) ---
  /** 対象の元頂点(インターリーブ・ストライド n) */
  private vertBase!: Float64Array;
  /** 回転後の頂点 */
  private vertRot!: Float64Array;
  /** sliceFlat の出力。線分ごとに端点 2 × **m 座標**(m ≤ n−1 なので確保量は据え置き) */
  private sliceOut!: Float64Array;
  /** 断面端点 / 影の頂点を 3D へ落とした結果 */
  private packed3!: Float32Array;
  /** 単位半径の n-球ワイヤ(緯線+経線)と単位円。毎フレームは半径倍するだけ */
  private sphereWire!: Float32Array;
  private unitCircle!: Float32Array;
  /** X線俯瞰の呼吸(輝度脈動)用に、生成時の色・グロー輝度を退避しておく */
  private xrayBaseColors!: Float32Array;
  private readonly xrayGlowBase = new Float32Array(XRAY_MAX_GLOWS);

  /** タンブルの 3 平面。オブジェクトは使い回して i/j/angle だけ書き換える */
  private readonly rots: PlaneRotation[] = [
    { i: 0, j: 1, angle: 0 },
    { i: 0, j: 2, angle: 0 },
    { i: 1, j: 2, angle: 0 },
  ];
  private readonly scratchColor = new THREE.Color();
  private readonly scratchColorB = new THREE.Color();

  private polytope: Polytope | null = null;
  /** 断面の組合せ構造。**観測者 m を変えたら組み直す**(余次元が変わるため) */
  private sliceGeom: FlatSliceGeometry | null = null;
  /** 平坦面の固定位置。offsets[j] が軸 m+j に対応する */
  private readonly sliceOffsets = new Float64Array(TARGET_MAX);
  /** 解決済みモード(params.mode と同期する)と、ユーザーが最後に選んだ希望モード */
  private mode: PerspectiveMode = 'slice';
  private requestedMode: PerspectiveMode = 'slice';
  private segCount = 0;
  private pointCount = 0;
  private sweep = 0;
  private lineBrightness = SLICE_BRIGHTNESS;
  /**
   * 影モードの深度キューの正規化係数。回転後の最終軸座標が取り得る幅は形状で
   * 大きく違う(n-cube の座標は ±1/√n しかない)ため、refit の走査中に実測して
   * 配色のレンジを使い切る。
   */
  private depthScale = 1;
  /** X線俯瞰で脈動させる線分の範囲(内部の物体だけ) */
  private xrayPulseStart = 0;
  private xrayPulseCount = 0;
  private xrayGlowCount = 0;

  private reveal = 0;
  private revealTarget = 1;
  private initialized = false;
  private active = false;
  private logAt = 0;

  // --- 神視点インセット ---
  private readonly insetScene = new THREE.Scene();
  private insetCamera!: THREE.PerspectiveCamera;
  private insetEdges!: THREE.LineSegments;
  private insetEdgePos!: Float32Array;
  private insetEdgeAttr!: THREE.BufferAttribute;
  private insetTrace!: THREE.LineSegments;
  private insetTracePos!: Float32Array;
  private insetTraceAttr!: THREE.BufferAttribute;
  private readonly insetPlane = new THREE.Group();
  /** インセットの辺数が固定の族(n-球)では毎フレーム書き換えない */
  private insetEdgeStatic = false;
  private insetVisible = false;
  /** 没入モード(body.ui-hidden)。CSS では消せない第2パスをここで止める */
  private chromeHidden = false;
  /**
   * scissor 矩形(CSS px・原点は左上)。**DOM 枠の実測**がただ一つの情報源で、
   * 配置を決めているのは CSS ── 枠と絵が 1px もずれないための唯一の道。
   */
  private readonly insetRect = { x: 0, top: 0, w: 0, h: 0 };
  private insetMeasured = false;
  private readonly sheetLayout: MediaQueryList | null =
    window.matchMedia?.(SHEET_LAYOUT_QUERY) ?? null;
  private insetFrame: HTMLElement | null = null;
  private insetReadout: HTMLElement | null = null;
  private insetReadoutText = '';
  private captionEl: HTMLElement | null = null;
  private captionText = '';
  private captionTimer = 0;

  /** renderInset のスコープ保存用(毎フレームのアロケーション禁止) */
  private readonly savedViewport = new THREE.Vector4();
  private readonly savedScissor = new THREE.Vector4();
  private readonly tmpSize = new THREE.Vector2();

  /** カメラ誘導 */
  private hintTimer = 0;
  private hintFlat = false;
  private hintPlan = false;

  constructor(params?: Partial<PerspectiveParams>) {
    this.scene = new THREE.Scene();
    this.scene.name = 'perspectiveScene';
    this.group.name = 'perspective';
    this.scene.add(this.group);

    // 既定プリセット: 観測者 3 / 対象 4 / cube / slice =「我々がテッセラクトの断面を見る」
    this.params = {
      observer: params?.observer ?? 3,
      target: params?.target ?? 4,
      family: params?.family ?? 'cube',
      mode: params?.mode ?? 'slice',
      rotate: params?.rotate ?? true,
    };
    this.requestedMode = this.params.mode;
  }

  init(ctx: EngineCtx): void {
    if (this.initialized) return;

    this.vertBase = new Float64Array(CAPACITY.vertices * TARGET_MAX);
    this.vertRot = new Float64Array(CAPACITY.vertices * TARGET_MAX);
    this.sliceOut = new Float64Array(CAPACITY.faces * 2 * (TARGET_MAX - 1));
    this.packed3 = new Float32Array(Math.max(CAPACITY.faces * 2, CAPACITY.vertices) * 3);
    this.xrayBaseColors = new Float32Array(XRAY_MAX_SEGMENTS * 6);

    this.material = new LineMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      linewidth: LINE_WIDTH,
    });
    // resize 時の resolution 更新は engine が一元管理する(既知の罠 #3)
    ctx.engine.registerLineMaterial(this.material);

    this.lineBatch = new LineBatch(CAPACITY.segments, this.material);
    // 断面の角(小さく硬い光)と X線俯瞰の内部グロー(大きく淡い霞)を 1 つの
    // マテリアルで兼ねる。強さと大きさは点ごとの属性で出し分ける。
    this.pointBatch = new PointBatch(CAPACITY.points, {
      color: CYAN,
      brightness: 1,
      falloff: 10,
      maxSize: 200,
    });
    this.group.add(this.lineBatch.object, this.pointBatch.object);

    this.buildUnitWires();
    this.buildInset();
    this.buildDOM();

    ctx.engine.onResize((width, _height, pixelRatio) => {
      this.pointBatch.setPixelRatio(pixelRatio);
      this.layoutInset(width);
    });
    // インセットは composer の**後**に scissor で直描きする(プラン7節)
    ctx.engine.onAfterRender(this.renderInset);

    this.initialized = true;
    this.rebuild();
    this.layoutInset(window.innerWidth);
  }

  enter(): void {
    this.reveal = 0;
    this.revealTarget = 1;
    this.active = true;
    this.hintTimer = HINT_DURATION;
    this.applyVisibility();
  }

  exit(): void {
    this.revealTarget = 0;
    this.active = false;
    this.applyVisibility();
  }

  /**
   * 制御パネル(Phase 7)。
   *
   * この展示だけは選択肢どうしに制約がある(m ≠ n / 高→低は X線俯瞰のみ)。
   * 制約の判定は rebuild() が持つ唯一の実装(resolveMode と m≠n の強制)に任せ、
   * パネルは **適用後の params を読み直して自分を合わせる**(sync)。
   * UI 側で二重に規則を実装しないための設計 ── 禁じ手は無効状態として見せる。
   */
  buildPanel(root: HTMLElement): void {
    const p = this.params;
    const panel = createPanel(root, 'PERSPECTIVE');

    const sync = (): void => {
      panel.setValue('observer', String(p.observer));
      panel.setValue('target', String(p.target));
      panel.setValue('mode', p.mode);
      for (let n = TARGET_MIN; n <= TARGET_MAX; n++) {
        panel.setOptionDisabled('target', String(n), n === p.observer);
      }
      // 高 → 低(m > n)は X線俯瞰しかない。逆向きでは X線俯瞰が選べない
      const looksDown = p.observer > p.target;
      panel.setOptionDisabled('mode', 'slice', looksDown);
      panel.setOptionDisabled('mode', 'shadow', looksDown);
      panel.setOptionDisabled('mode', 'xray', !looksDown);

      /*
        プリセットの現在地(Phase 19)。**プリセットを押したときだけでなく、
        OBSERVER / TARGET / MODE を直接動かしたときにも**ここを通る ──
        sync() は「適用後の params を読み直して自分を合わせる」唯一の場所なので、
        現在地の判定もここに置けば経路によらず一致する(UI 側に規則を二重実装しない、
        というこのパネルの設計をそのまま延長したもの)。

        比べるのは**解決後**のモードである。表は希望の形で書いてよい代わりに、
        m > n で xray へ丸められた結果と突き合わせないと、
        「4 次元の目で見る」は自分自身と一致しなくなる。
      */
      for (const item of PRESETS) {
        const resolved = resolveMode(item.observer, item.target, item.mode);
        panel.setActive(
          item.key,
          p.observer === item.observer &&
            p.target === item.target &&
            p.mode === resolved &&
            p.family === item.family,
        );
      }
    };

    const preset = (item: PerspectivePreset): void => {
      this.params.family = item.family;
      this.requestedMode = item.mode;
      this.setPerspective(item.observer, item.target);
      sync();
    };

    panel.note('PRESETS / 代表的な視点');
    for (const item of PRESETS) {
      panel.button({ key: item.key, label: item.label, onClick: () => preset(item) });
    }

    panel.divider();

    panel.segmented({
      key: 'observer',
      label: 'OBSERVER / 観測者 m',
      options: [
        ['2', '2 次元'],
        ['3', '3 次元'],
        ['4', '4 次元'],
      ],
      value: String(p.observer),
      onSelect: (v) => {
        this.setPerspective(Number(v), p.target);
        sync();
      },
    });

    panel.segmented({
      key: 'target',
      label: 'TARGET / 対象 n',
      options: [
        ['2', '2'],
        ['3', '3'],
        ['4', '4'],
        ['5', '5'],
        ['6', '6'],
      ],
      value: String(p.target),
      onSelect: (v) => {
        this.setPerspective(p.observer, Number(v));
        sync();
      },
    });

    panel.segmented({
      key: 'mode',
      label: 'MODE / 見えかた',
      options: [
        ['slice', '断面'],
        ['shadow', '影'],
        ['xray', 'X線俯瞰'],
      ],
      value: p.mode,
      onSelect: (v) => {
        this.setMode(v as PerspectiveMode);
        sync();
      },
    });

    panel.toggle({
      label: 'ROTATE / 回転',
      value: p.rotate,
      onChange: (v) => this.setRotate(v),
    });

    panel.note(
      '観測者と対象は同じ次元にできない(m ≠ n)。' +
        '低い側から覗くなら断面と影、高い側から見下ろすなら X線俯瞰 ── ' +
        '選べない組み合わせは灰色になる。' +
        'いま見ている設定が上の代表的な視点と重なると、その行に印が点く。',
    );

    sync();
  }

  // --- 公開 API --------------------------------------------------------------

  /** 観測者 m / 対象 n の変更。m=n は矛盾なので n をずらして解消する */
  setPerspective(observer: number, target: number): void {
    this.params.observer = clamp(
      Math.round(observer),
      OBSERVER_MIN,
      OBSERVER_MAX,
    ) as PerspectiveParams['observer'];
    this.params.target = clamp(
      Math.round(target),
      TARGET_MIN,
      TARGET_MAX,
    ) as PerspectiveParams['target'];
    if (this.initialized) this.rebuild();
  }

  /** 見出しの副題。いま誰の目を借りていて、それで足りるのか(Phase 40) */
  tagline(): string {
    return perspectiveTagline(this.params.observer, this.params.target);
  }

  setFamily(family: PerspectiveFamily): void {
    this.params.family = family;
    if (this.initialized) this.rebuild();
  }

  /** ユーザーの希望モード。m>n では xray に丸められるが希望は覚えておく */
  setMode(mode: PerspectiveMode): void {
    this.requestedMode = mode;
    if (this.initialized) this.rebuild();
  }

  /**
   * タンブルの停止/再開。自動フィットは全姿勢の最大で決めてあるので、
   * 姿勢を凍結しても像がフレームから溢れることはない(再フィットは不要)。
   */
  setRotate(rotate: boolean): void {
    this.params.rotate = rotate;
  }

  /**
   * カメラの誘導ヒント。切り替え直後の数秒だけ true を返し、そのあとは
   * ユーザーの OrbitControls に完全に譲る(勝手に構図を戻し続けない)。
   */
  getCameraHint(out: CameraHint): boolean {
    if (!this.active || this.hintTimer <= 0) return false;
    if (this.hintFlat) {
      // 2 次元世界ビュー: 断面(z=0 平面)を正面から
      out.pos.set(0, 0.4, 8.2);
    } else if (this.hintPlan) {
      // 平面世界の X線俯瞰: 斜め上から見下ろす
      out.pos.set(0, 5.4, 5.8);
    } else {
      out.pos.set(0, 1.6, 7.2);
    }
    out.look.set(0, 0, 0);
    return true;
  }

  update(dt: number, t: number): void {
    if (!this.initialized) return;

    if (this.reveal !== this.revealTarget) {
      this.reveal = expSmooth(this.reveal, this.revealTarget, REVEAL_RATE, dt);
      if (Math.abs(this.revealTarget - this.reveal) < 0.002) this.reveal = this.revealTarget;
    }
    if (this.hintTimer > 0) this.hintTimer -= dt;

    if (this.mode === 'xray') {
      this.updateXray(t);
    } else {
      this.segCount = this.buildFrame(t);
      this.shadeFrame();
      this.lineBatch.commitPositions(this.segCount);
      this.lineBatch.commitColors(this.segCount);
      this.pointBatch.commit(this.pointCount);
      this.pointBatch.commitSizes();
      this.pointBatch.commitBrightness();
      this.updateInset();
      this.updateReadout();
    }

    this.lineBatch.setReveal(this.reveal);
    this.pointBatch.setBrightness(this.reveal);

    if (import.meta.env.DEV && t - this.logAt > 1) {
      this.logAt = t;
      console.info(
        `[perspective] m=${this.params.observer} n=${this.params.target} ` +
          `${this.params.family}/${this.mode} s=${this.sweep.toFixed(3)} ` +
          `segments=${this.segCount}`,
      );
    }
  }

  dispose(): void {
    // engine には onAfterRender の解除口がないので、フラグで直描画を止める
    this.insetVisible = false;
    this.active = false;
    this.lineBatch?.dispose();
    this.pointBatch?.dispose();
    this.material?.dispose();
    this.insetEdges?.geometry.dispose();
    (this.insetEdges?.material as THREE.Material | undefined)?.dispose();
    this.insetTrace?.geometry.dispose();
    (this.insetTrace?.material as THREE.Material | undefined)?.dispose();
    this.insetFrame?.remove();
    this.captionEl?.remove();
    if (this.captionTimer !== 0) window.clearTimeout(this.captionTimer);
  }

  // --- 形状の切り替え --------------------------------------------------------

  /**
   * パラメータを正規化して前計算をやり直す。
   * 事前確保済みのバッファはすべて再利用する(ここでも毎フレーム経路は触らない)。
   */
  private rebuild(): void {
    const p = this.params;
    // m=1(線の住人)の HUD 表現は Phase 7/8 のストレッチ。中途半端に出さない
    const m = clamp(Math.round(p.observer), OBSERVER_MIN, OBSERVER_MAX);
    let n = clamp(Math.round(p.target), TARGET_MIN, TARGET_MAX);
    if (n === m) n = m < TARGET_MAX ? m + 1 : m - 1; // m ≠ n を強制
    p.observer = m as PerspectiveParams['observer'];
    p.target = n as PerspectiveParams['target'];

    this.mode = resolveMode(m, n, this.requestedMode);
    p.mode = this.mode;

    this.pickPlanes(n);
    this.polytope = null;
    this.sliceGeom = null;
    this.pointCount = 0;
    this.xrayPulseCount = 0;
    this.xrayGlowCount = 0;

    if (this.mode === 'xray') {
      this.group.scale.setScalar(XRAY_SCALE);
      this.buildXrayScene(n);
    } else {
      this.group.rotation.set(0, 0, 0);
      if (p.family !== 'sphere') {
        const poly = makePolytope(p.family, n);
        this.polytope = poly;
        // 断面は観測者の m 次元平坦面で切る = 余次元 k は m にも従属する。
        // だから **m を変えたときも**ここを通す必要がある(rebuild が唯一の入口)
        if (this.mode === 'slice') this.sliceGeom = makeFlatSliceGeometry(p.family, n, n - m);
        this.vertBase.set(poly.vertices);
        this.lineBrightness =
          this.mode === 'shadow'
            ? SHADOW_BRIGHTNESS * Math.min(1, SHADOW_DENSITY_REFERENCE / poly.edgeCount)
            : SLICE_BRIGHTNESS;
      } else {
        this.lineBrightness = this.mode === 'shadow' ? SHADOW_BRIGHTNESS : SLICE_BRIGHTNESS;
      }
      this.refit();
      this.rebuildInsetEdges();
    }

    // 断面/影が z=0 平面に収まる構図か(= 2 次元世界ビュー)。
    // 断面はいま **m 次元**で出るので、族によらず m===2 が平面ビュー(Phase 39)
    this.hintFlat = this.mode === 'slice' ? m === 2 : this.mode === 'shadow' && m === 2;
    this.hintPlan = this.mode === 'xray' && n === 2;
    this.hintTimer = HINT_DURATION;

    // 断面の角は硬い光、X線俯瞰の内部グローは霞。点の色もモードで替える
    this.pointBatch.setColor(this.mode === 'xray' ? VIOLET : CYAN);

    this.applyVisibility();
    this.setCaption(perspectiveCaption(this.mode, m, n));
    // 見出しの副題も設定に追従させる(Phase 40)。入場時は gallery が tagline() を
    // 引くので、ここで押すのは**表示中に設定を変えたとき**のためだけ
    window.dispatchEvent(
      new CustomEvent<string>('dimension:tagline', { detail: perspectiveTagline(m, n) }),
    );

    console.info(
      `[perspective] m=${m} n=${n} family=${p.family} mode=${this.mode} ` +
        `verts=${this.polytope?.vertexCount ?? 0} ` +
        `slice=${this.sliceGeom === null ? '-' : `${this.sliceGeom.codim}co/${this.sliceGeom.nodeCount}v/${this.sliceGeom.linkCount}e`} ` +
        `fit=${this.group.scale.x.toFixed(3)}`,
    );
  }

  /**
   * 回転平面の選択(polytope explorer と同じ考え方)。
   * スライス軸は常に最終軸 n−1 なので、**最終軸を含む平面を必ず 1 枚**入れる。
   * さもないと対象が超平面に対して姿勢を変えず、断面が単に相似縮小するだけになる。
   */
  private pickPlanes(n: number): void {
    const r = this.rots;
    if (n <= 3) {
      setPlane(r[0], 0, 1);
      setPlane(r[1], 0, 2);
      setPlane(r[2], 1, 2);
      return;
    }
    setPlane(r[0], 0, 2);
    setPlane(r[1], 1, n - 1);
    // n=4 では (2, n−2) が退化する。(0,3) にすると 4 軸すべてが回る
    setPlane(r[2], n - 2 > 2 ? 2 : 0, n - 2 > 2 ? n - 2 : 3);
  }

  private updateRots(t: number): void {
    const tt = this.params.rotate ? t : FROZEN_POSE_T;
    this.rots[0].angle = OMEGA_0 * tt;
    this.rots[1].angle = OMEGA_1 * tt;
    this.rots[2].angle = OMEGA_2 * tt;
  }

  /**
   * 投影後の見かけ半径を測ってワールド倍率を決める。形状変更時のみ実行。
   * 測定には毎フレームとまったく同じ経路(buildFrame)を使う ── 数式を二重実装しない。
   */
  private refit(): void {
    const pos = this.lineBatch.positions;
    const poly = this.polytope;
    let maxSq = 0;
    let maxDepth = 0;
    for (let i = 0; i < FIT_SAMPLES; i++) {
      // buildFrame が姿勢とスイープ位相を同時に進めるので、走査は時刻だけでよい
      const t = (i / FIT_SAMPLES) * FIT_SPAN;
      const segments = this.buildFrame(t);
      for (let k = 0; k < segments * 6; k += 3) {
        const x = pos[k];
        const y = pos[k + 1];
        const z = pos[k + 2];
        const r2 = x * x + y * y + z * z;
        if (r2 > maxSq) maxSq = r2;
      }
      // 影の深度キュー用に、回転後の最終軸座標の振れ幅も同じ走査で測る
      if (poly !== null) {
        const n = poly.n;
        for (let v = 0; v < poly.vertexCount; v++) {
          const d = Math.abs(this.vertRot[v * n + n - 1]);
          if (d > maxDepth) maxDepth = d;
        }
      }
    }
    const radius = Math.sqrt(maxSq);
    this.group.scale.setScalar(radius > 1e-6 ? TARGET_RADIUS / radius : TARGET_RADIUS);
    this.depthScale = maxDepth > 1e-6 ? 1 / maxDepth : 1;
  }

  // --- 毎フレームのジオメトリ生成 --------------------------------------------

  /**
   * 時刻 t・超平面オフセット s のフレームを線分バッファへ書き、線分数を返す。
   * 色は書かない(refit が何度も回すため)。GPU への commit も呼び出し側の責務。
   */
  private buildFrame(t: number): number {
    this.updateRots(t);
    const n = this.params.target;
    const phase = this.mode === 'slice' ? Math.sin(SWEEP_OMEGA * t) : 0;

    if (this.params.family === 'sphere') {
      // 単位球は姿勢によらず厚み 1
      this.sweep = SWEEP_MARGIN * phase;
      return this.buildSphereFrame(this.sweep);
    }
    const poly = this.polytope;
    if (poly === null) {
      this.sweep = 0;
      return 0;
    }

    rotateBatch(this.vertBase, this.vertRot, n, poly.vertexCount, this.rots);
    if (this.mode === 'shadow') {
      this.sweep = 0;
      return this.buildShadow(poly, n);
    }
    this.sweep = SWEEP_MARGIN * this.measureExtent(poly, n) * phase;
    return this.buildSlice(n, this.sweep);
  }

  /** いまの姿勢での「スライス軸方向の厚み」= max |x[n−1]|(回転後) */
  private measureExtent(poly: Polytope, n: number): number {
    const rot = this.vertRot;
    let max = 0;
    for (let v = 0; v < poly.vertexCount; v++) {
      const d = Math.abs(rot[v * n + n - 1]);
      if (d > max) max = d;
    }
    return max;
  }

  /**
   * 断面モード: 観測者の **m 次元平坦面** A = { x_m = …, x_{n−1} = s } で切る。
   *
   * 断面は m 次元 ── つまり画面に出るのは「その次元の住人が本当に見ている
   * 切り口」である(Phase 39 でここを直した。それまでは常に n−1 次元を出して
   * いたので、m < n−1 では OBSERVER を動かしても絵が変わらなかった)。
   * m が 4 以上のときだけ、透視カスケードで 3D へ落とす。
   */
  private buildSlice(n: number, s: number): number {
    const geom = this.sliceGeom;
    if (geom === null) return 0;

    const dim = this.params.observer;
    const k = n - dim;
    const offsets = this.sliceOffsets;
    // 掃引するのは最終軸(= 神視点インセットの高さ s)。中間軸は中心近くに固定する
    for (let j = 0; j < k - 1; j++) offsets[j] = FIXED_AXIS_OFFSETS[j % FIXED_AXIS_OFFSETS.length];
    offsets[k - 1] = s + SWEEP_EPS;

    const segments = sliceFlat(this.vertRot, n, dim, offsets, geom, this.sliceOut);
    const pos = this.lineBatch.positions;
    const pts = this.pointBatch.positions;
    const sizes = this.pointBatch.sizes;
    const brights = this.pointBatch.brights;
    const out = this.sliceOut;

    // dim > 3: sliceOut は端点が (2·segments) 個・ストライド dim で並んでいるので、
    // そのまま透視カスケードの入力にできる(詰め直し不要)
    const cascade = dim > 3;
    if (cascade) {
      projectPerspective(out, dim, segments * 2, PROJECT_DIST, this.packed3);
    }

    const src = cascade ? this.packed3 : out;
    for (let i = 0; i < segments; i++) {
      const o = i * 6;
      let ax: number;
      let ay: number;
      let az: number;
      let bx: number;
      let by: number;
      let bz: number;
      if (cascade) {
        const a = i * 6;
        ax = src[a];
        ay = src[a + 1];
        az = src[a + 2];
        bx = src[a + 3];
        by = src[a + 4];
        bz = src[a + 5];
      } else {
        const a = i * dim * 2;
        ax = src[a];
        ay = src[a + 1];
        az = dim > 2 ? src[a + 2] : 0; // dim=2 は z=0 の「2 次元世界ビュー」
        bx = src[a + dim];
        by = src[a + dim + 1];
        bz = dim > 2 ? src[a + dim + 2] : 0;
      }
      pos[o] = ax;
      pos[o + 1] = ay;
      pos[o + 2] = az;
      pos[o + 3] = bx;
      pos[o + 4] = by;
      pos[o + 5] = bz;

      // 断面の角のグロー。重複除去はしない(重なった点はそのまま少し強く光る)
      const p0 = i * 6;
      pts[p0] = ax;
      pts[p0 + 1] = ay;
      pts[p0 + 2] = az;
      pts[p0 + 3] = bx;
      pts[p0 + 4] = by;
      pts[p0 + 5] = bz;
      sizes[i * 2] = SLICE_POINT_SIZE;
      sizes[i * 2 + 1] = SLICE_POINT_SIZE;
      brights[i * 2] = SLICE_POINT_BRIGHT;
      brights[i * 2 + 1] = SLICE_POINT_BRIGHT;
    }

    this.pointCount = segments * 2;
    return segments;
  }

  /**
   * 影モード: n → m の透視投影。辺は細分割しない ── 投影の真の曲率は
   * polytope explorer の担当で、ここで見せたいのは「次元が落ちる」ことそのもの。
   */
  private buildShadow(poly: Polytope, n: number): number {
    const count = poly.vertexCount;
    const proj = this.packed3;
    projectPerspective(this.vertRot, n, count, PROJECT_DIST, proj);
    if (this.params.observer === 2) {
      // m=2: カスケードをもう一段だけ回して 2 次元へ(3D → 2D の透視除算)
      flattenTo2D(proj, count, PROJECT_DIST);
    }

    const edges = poly.edges;
    const pos = this.lineBatch.positions;
    for (let e = 0; e < poly.edgeCount; e++) {
      const a = edges[e * 2] * 3;
      const b = edges[e * 2 + 1] * 3;
      const o = e * 6;
      pos[o] = proj[a];
      pos[o + 1] = proj[a + 1];
      pos[o + 2] = proj[a + 2];
      pos[o + 3] = proj[b];
      pos[o + 4] = proj[b + 1];
      pos[o + 5] = proj[b + 2];
    }
    this.pointCount = 0;
    return poly.edgeCount;
  }

  /**
   * n-球は解析的に切れる ── (n−1)-球の半径は √(1−s²)。
   * 見えるかたちは m で決まる: m=2 なら円、m≥3 ならワイヤ球。
   * 影モードでは常に半径 1(シルエット)で静止する。
   */
  private buildSphereFrame(s: number): number {
    const r = this.mode === 'shadow' ? 1 : sphereSliceRadius(1, s);
    const pos = this.lineBatch.positions;
    this.pointCount = 0;
    if (r <= 1e-6) return 0;

    const flat = this.params.observer === 2;
    const src = flat ? this.unitCircle : this.sphereWire;
    const segments = flat ? CIRCLE_SEGMENTS : SPHERE_WIRE_SEGMENTS;
    const total = segments * 6;
    for (let i = 0; i < total; i++) pos[i] = src[i] * r;
    return segments;
  }

  /**
   * 線の色。断面は |s| で cyan ↔ gold を混ぜる ── 中心を通過して断面が最大に
   * なる瞬間に金色が閃く。影は最終軸の深さで cyan ↔ magenta の深度キュー。
   */
  private shadeFrame(): void {
    const col = this.lineBatch.colors;
    const segments = this.segCount;

    if (this.mode === 'slice') {
      const g = clamp01(1 - Math.abs(this.sweep) / 0.55);
      const c = this.scratchColor.copy(CYAN).lerp(GOLD, g * g);
      const lum = this.lineBrightness;
      const r = c.r * lum;
      const gg = c.g * lum;
      const b = c.b * lum;
      for (let i = 0; i < segments; i++) {
        const o = i * 6;
        col[o] = r;
        col[o + 1] = gg;
        col[o + 2] = b;
        col[o + 3] = r;
        col[o + 4] = gg;
        col[o + 5] = b;
      }
      this.pointBatch.setColor(c);
      return;
    }

    // 影モード: 頂点ごとに「投影で失われた最終軸」の深さで彩色する
    const poly = this.polytope;
    const lum = this.lineBrightness;
    if (poly === null || this.params.family === 'sphere') {
      const c = this.scratchColor.copy(CYAN);
      for (let i = 0; i < segments; i++) {
        const o = i * 6;
        col[o] = col[o + 3] = c.r * lum;
        col[o + 1] = col[o + 4] = c.g * lum;
        col[o + 2] = col[o + 5] = c.b * lum;
      }
      return;
    }

    const n = poly.n;
    const rot = this.vertRot;
    const edges = poly.edges;
    const near = this.scratchColor;
    const far = this.scratchColorB;
    const ds = this.depthScale;
    for (let e = 0; e < poly.edgeCount; e++) {
      const a = edges[e * 2];
      const b = edges[e * 2 + 1];
      const o = e * 6;
      depthColor(rot[a * n + n - 1] * ds, near);
      depthColor(rot[b * n + n - 1] * ds, far);
      col[o] = near.r * lum;
      col[o + 1] = near.g * lum;
      col[o + 2] = near.b * lum;
      col[o + 3] = far.r * lum;
      col[o + 4] = far.g * lum;
      col[o + 5] = far.b * lum;
    }
  }

  // --- X線俯瞰(演出シーン) --------------------------------------------------

  /**
   * 「上の次元からは、内側がすべて見える」。
   * 一般の数学ではなく設計された場面で見せる ── 家があり、部屋が仕切られ、
   * 住人がいて、宝物が隠されている。それが全部同時に見えてしまう、という一枚。
   * 加算合成 + depthWrite:false なので、手前の壁が奥を隠すことは構造的に起きない。
   */
  private buildXrayScene(n: number): void {
    const segments = n <= 2 ? this.buildFlatlandScene() : this.buildHouse3DScene();
    this.segCount = segments;
    // 生成した色を退避し、毎フレームは内部だけを脈動させる
    this.xrayBaseColors.set(this.lineBatch.colors.subarray(0, segments * 6));
    this.lineBatch.commitPositions(segments);
    this.lineBatch.commitColors(segments);
    this.pointBatch.commit(this.pointCount);
    this.pointBatch.commitSizes();
    this.pointBatch.commitBrightness();
  }

  /** m>n・n=2: 平面世界(家の間取り)を斜め上から見下ろす */
  private buildFlatlandScene(): number {
    let seg = 0;
    seg = this.emitPlanPolyline(seg, HOUSE2D_WALL, false, CYAN, XRAY_BRIGHTNESS);
    seg = this.emitPlanSegments(seg, HOUSE2D_DOOR, CYAN, XRAY_BRIGHTNESS);
    // ここから先が「内部」── 毎フレーム呼吸させる範囲
    this.xrayPulseStart = seg;
    seg = this.emitPlanPolyline(seg, HOUSE2D_ROOM_A, true, CYAN, XRAY_BRIGHTNESS * 0.75);
    seg = this.emitPlanPolyline(seg, HOUSE2D_ROOM_B, true, CYAN, XRAY_BRIGHTNESS * 0.75);
    seg = this.emitPlanCircle(
      seg,
      HOUSE2D_INHABITANT.u,
      HOUSE2D_INHABITANT.v,
      HOUSE2D_INHABITANT.r,
      16,
      MAGENTA,
      XRAY_BRIGHTNESS,
    );
    seg = this.emitPlanPolyline(seg, HOUSE2D_TREASURE, true, GOLD, XRAY_BRIGHTNESS);
    this.xrayPulseCount = seg - this.xrayPulseStart;

    // 閉領域の内部にごく淡い大きなスプライトを置く =「中まで光が届いている」
    const pts = this.pointBatch.positions;
    const sizes = this.pointBatch.sizes;
    const brights = this.pointBatch.brights;
    const glows = HOUSE2D_GLOWS.length / 2;
    for (let i = 0; i < glows; i++) {
      pts[i * 3] = HOUSE2D_GLOWS[i * 2];
      pts[i * 3 + 1] = 0;
      pts[i * 3 + 2] = -HOUSE2D_GLOWS[i * 2 + 1];
      sizes[i] = XRAY_GLOW_SIZE;
      brights[i] = XRAY_GLOW_BRIGHT;
      this.xrayGlowBase[i] = XRAY_GLOW_BRIGHT;
    }
    this.pointCount = glows;
    this.xrayGlowCount = glows;
    return seg;
  }

  /** m>n・n=3: 3D の家。壁・内室・住人・宝物がすべて同時に透けて見える */
  private buildHouse3DScene(): number {
    let seg = 0;
    const body = HOUSE3D_BODY;
    seg = this.emitBox(seg, body.cx, body.cy, body.cz, body.hx, body.hy, body.hz, CYAN, XRAY_BRIGHTNESS);

    // 寄棟屋根: 棟 1 本 + 母屋の上面 4 隅への隅棟 4 本
    const ry = HOUSE3D_RIDGE_Y;
    const rx = HOUSE3D_RIDGE_X;
    const ty = body.cy + body.hy;
    seg = this.emitSegment(seg, -rx, ry, 0, rx, ry, 0, CYAN, XRAY_BRIGHTNESS);
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        seg = this.emitSegment(
          seg,
          sx * rx,
          ry,
          0,
          body.cx + sx * body.hx,
          ty,
          body.cz + sz * body.hz,
          CYAN,
          XRAY_BRIGHTNESS,
        );
      }
    }

    // ここから先が「内部」── 呼吸させる範囲
    this.xrayPulseStart = seg;
    const room = HOUSE3D_ROOM;
    seg = this.emitBox(
      seg,
      room.cx,
      room.cy,
      room.cz,
      room.hx,
      room.hy,
      room.hz,
      VIOLET,
      XRAY_BRIGHTNESS * 0.9,
    );

    // 住人は正軸体(= 正八面体)を小さくしたもの。makeNOrthoplex(3) をそのまま使う
    const octa = makeNOrthoplex(3);
    const inh = HOUSE3D_INHABITANT;
    for (let e = 0; e < octa.edgeCount; e++) {
      const a = octa.edges[e * 2] * 3;
      const b = octa.edges[e * 2 + 1] * 3;
      seg = this.emitSegment(
        seg,
        inh.cx + octa.vertices[a] * inh.r,
        inh.cy + octa.vertices[a + 1] * inh.r,
        inh.cz + octa.vertices[a + 2] * inh.r,
        inh.cx + octa.vertices[b] * inh.r,
        inh.cy + octa.vertices[b + 1] * inh.r,
        inh.cz + octa.vertices[b + 2] * inh.r,
        MAGENTA,
        XRAY_BRIGHTNESS,
      );
    }

    const tr = HOUSE3D_TREASURE;
    seg = this.emitBox(seg, tr.cx, tr.cy, tr.cz, tr.h, tr.h, tr.h, GOLD, XRAY_BRIGHTNESS);
    this.xrayPulseCount = seg - this.xrayPulseStart;

    // 内部の霞は 2 つ(部屋の中と屋根裏)
    const pts = this.pointBatch.positions;
    pts[0] = room.cx;
    pts[1] = room.cy;
    pts[2] = room.cz;
    pts[3] = 0;
    pts[4] = ty + 0.18;
    pts[5] = 0;
    this.pointBatch.sizes[0] = XRAY_GLOW_SIZE;
    this.pointBatch.sizes[1] = XRAY_GLOW_SIZE * 0.7;
    this.pointBatch.brights[0] = this.xrayGlowBase[0] = XRAY_GLOW_BRIGHT;
    this.pointBatch.brights[1] = this.xrayGlowBase[1] = XRAY_GLOW_BRIGHT * 0.8;
    this.pointCount = 2;
    this.xrayGlowCount = 2;
    return seg;
  }

  /** 群全体のゆっくりした回転 + 内部の物体だけの呼吸(輝度脈動) */
  private updateXray(t: number): void {
    const n = this.params.target;
    if (n <= 2) {
      // 平面世界は面の法線(Y)まわりだけで回す ── 平面のままであることが要点
      this.group.rotation.set(0, 0.06 * t, 0);
    } else {
      this.group.rotation.set(0.1 * Math.sin(0.23 * t), 0.19 * t, 0);
    }

    const pulse = 0.72 + 0.28 * Math.sin(1.5 * t);
    const col = this.lineBatch.colors;
    const base = this.xrayBaseColors;
    const from = this.xrayPulseStart * 6;
    const to = (this.xrayPulseStart + this.xrayPulseCount) * 6;
    for (let i = from; i < to; i++) col[i] = base[i] * pulse;
    this.lineBatch.commitColors(this.segCount);

    const brights = this.pointBatch.brights;
    for (let i = 0; i < this.xrayGlowCount; i++) {
      brights[i] = this.xrayGlowBase[i] * pulse;
    }
    this.pointBatch.commitBrightness();
  }

  // --- 神視点インセット ------------------------------------------------------

  /**
   * インセットのシーンを組む。
   *
   * 座標の対応(この展示の肝): インセットの (X, Y, Z) = 対象の (x0, x_axis, x1)。
   * スライス軸 x_axis をインセットの**鉛直軸**に取るので、観測者の超平面
   * {x_axis = s} は文字どおり水平面 Y = s になる。断面をこの高さに再プロットすれば、
   * メインビュー(知覚)とインセット(実体)の対応が一目で読める。
   */
  private buildInset(): void {
    // 固定の 3/4 ビュー。超平面は最大 ±1 強まで上下するので、対象(半径 1)と
    // グリッド(一辺 2.4)がその振れ幅ごと収まる距離 ~5.7 から見る
    this.insetCamera = new THREE.PerspectiveCamera(40, 1 / INSET_ASPECT, 0.1, 100);
    this.insetCamera.position.set(3.5, 2.8, 3.5);
    this.insetCamera.lookAt(0, 0, 0);

    // インセットはポストFXを通らないので、素の LineBasicMaterial で十分
    this.insetEdgePos = new Float32Array(CAPACITY.segments * 6);
    this.insetEdges = makeInsetLines(this.insetEdgePos, 0x9fc4ff, 0.5);
    this.insetEdgeAttr = this.insetEdges.geometry.getAttribute('position') as THREE.BufferAttribute;

    this.insetTracePos = new Float32Array(CAPACITY.faces * 6);
    this.insetTrace = makeInsetLines(this.insetTracePos, 0xffd24f, 1);
    this.insetTraceAttr = this.insetTrace.geometry.getAttribute('position') as THREE.BufferAttribute;

    // 観測者超平面: 半透明グリッド + ごく薄いクアッド。GridHelper は既定で XZ 平面
    // (= 水平)にあるので回転は不要
    const grid = new THREE.GridHelper(INSET_PLANE_SIZE, 12, 0x4fd8ff, 0x2b6f8c);
    const gridMaterial = grid.material as THREE.Material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.28;
    gridMaterial.depthWrite = false;

    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(INSET_PLANE_SIZE, INSET_PLANE_SIZE),
      new THREE.MeshBasicMaterial({
        color: CYAN,
        transparent: true,
        opacity: 0.06,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    quad.rotation.x = -Math.PI / 2;

    this.insetPlane.add(grid, quad);
    this.insetScene.add(this.insetEdges, this.insetTrace, this.insetPlane);
  }

  /**
   * 族が n-球のときは対象そのものが回転で変わらないので、インセットの線は
   * 単位球のワイヤを一度焼き込むだけでよい(毎フレームの書き換えを止める)。
   */
  private rebuildInsetEdges(): void {
    const poly = this.polytope;
    if (poly === null) {
      this.insetEdgePos.set(this.sphereWire.subarray(0, SPHERE_WIRE_SEGMENTS * 6));
      this.insetEdges.geometry.setDrawRange(0, SPHERE_WIRE_SEGMENTS * 2);
      this.insetEdgeAttr.needsUpdate = true;
      this.insetEdgeStatic = true;
      return;
    }
    this.insetEdgeStatic = false;
    this.insetEdges.geometry.setDrawRange(0, poly.edgeCount * 2);
  }

  /** 対象の辺・超平面・断面トレースをインセット空間へ毎フレーム写す */
  private updateInset(): void {
    const s = this.sweep;
    this.insetPlane.position.y = s;

    const poly = this.polytope;
    if (!this.insetEdgeStatic && poly !== null) {
      const n = poly.n;
      const axis = n - 1;
      const rot = this.vertRot;
      const edges = poly.edges;
      const dst = this.insetEdgePos;
      for (let e = 0; e < poly.edgeCount; e++) {
        const a = edges[e * 2] * n;
        const b = edges[e * 2 + 1] * n;
        const o = e * 6;
        dst[o] = rot[a];
        dst[o + 1] = rot[a + axis];
        dst[o + 2] = rot[a + 1];
        dst[o + 3] = rot[b];
        dst[o + 4] = rot[b + axis];
        dst[o + 5] = rot[b + 1];
      }
      this.insetEdgeAttr.needsUpdate = true;
    }

    // 断面トレース: 端点の先頭 2 座標を高さ s に置く。sliceOut は axis を除いた
    // 座標が元の軸順で並んでいるので、先頭 2 つがそのまま (x0, x1)
    let traceSegments = 0;
    const dst = this.insetTracePos;
    if (this.mode === 'slice' && poly !== null) {
      const dim = this.params.observer; // 断面は m 次元(Phase 39)
      const src = this.sliceOut;
      traceSegments = this.segCount;
      for (let i = 0; i < traceSegments; i++) {
        const a = i * dim * 2;
        const o = i * 6;
        dst[o] = src[a];
        dst[o + 1] = s;
        dst[o + 2] = dim > 1 ? src[a + 1] : 0;
        dst[o + 3] = src[a + dim];
        dst[o + 4] = s;
        dst[o + 5] = dim > 1 ? src[a + dim + 1] : 0;
      }
      this.insetTraceAttr.needsUpdate = true;
    } else if (this.mode === 'slice') {
      // n-球の断面は解析的な円。単位円を半径倍して高さ s に置く
      const r = sphereSliceRadius(1, s);
      if (r > 1e-6) {
        const src = this.unitCircle;
        traceSegments = CIRCLE_SEGMENTS;
        for (let i = 0; i < traceSegments; i++) {
          const a = i * 6;
          const o = i * 6;
          dst[o] = src[a] * r;
          dst[o + 1] = s;
          dst[o + 2] = src[a + 1] * r;
          dst[o + 3] = src[a + 3] * r;
          dst[o + 4] = s;
          dst[o + 5] = src[a + 4] * r;
        }
        this.insetTraceAttr.needsUpdate = true;
      }
    }
    this.insetTrace.geometry.setDrawRange(0, traceSegments * 2);
  }

  /**
   * composer の後に scissor + viewport で直描きする第2パス。
   * **状態を必ず復帰すること** ── しないと次フレームの composer が
   * インセット矩形に閉じ込められて壊れる(既知の罠 #10)。
   *
   * 通常は engine.onAfterRender 経由で呼ばれる。公開しているのは、rAF が止まる
   * ヘッドレス検証(main.ts の renderOnce)から同じ順序で叩けるようにするため。
   */
  readonly renderInset = (renderer: THREE.WebGLRenderer): void => {
    if (!this.initialized || !this.insetVisible) return;

    // setViewport/setScissor は内部で pixelRatio 倍されるので CSS px を渡す。
    // 位置は DOM 枠の実測(= CSS が決めた場所)。測れていないときだけ右下の既定へ。
    const size = renderer.getSize(this.tmpSize);
    const measured = this.insetMeasured;
    const w = measured ? this.insetRect.w : insetWidthFor(size.x);
    const h = measured ? this.insetRect.h : w * INSET_ASPECT;
    const x = measured ? this.insetRect.x : size.x - INSET_MARGIN - w;
    // GL のビューポート原点は左下。CSS の top から反転する
    const y = measured ? size.y - this.insetRect.top - h : INSET_MARGIN;

    renderer.getViewport(this.savedViewport);
    renderer.getScissor(this.savedScissor);
    const savedScissorTest = renderer.getScissorTest();
    const savedAutoClear = renderer.autoClear;

    renderer.setScissorTest(true);
    renderer.setScissor(x, y, w, h);
    renderer.setViewport(x, y, w, h);
    // 色は消さない(composer の出力がそのまま背景になる)。深度だけは毎フレーム
    // 捨てないと前フレームの深度が残って線が欠ける
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.insetScene, this.insetCamera);

    renderer.autoClear = savedAutoClear;
    renderer.setScissorTest(savedScissorTest);
    renderer.setScissor(this.savedScissor);
    renderer.setViewport(this.savedViewport);
  };

  // --- DOM(インセット枠・キャプション) --------------------------------------

  private buildDOM(): void {
    const frame = document.createElement('div');
    frame.id = 'perspective-inset';
    frame.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'pv-inset-label';
    label.textContent = '神の視点 / GOD VIEW';

    const readout = document.createElement('span');
    readout.className = 'pv-inset-readout';
    readout.textContent = 's = 0.00';

    frame.append(label, readout);
    document.body.append(frame);

    const caption = document.createElement('p');
    caption.id = 'perspective-caption';
    caption.setAttribute('role', 'status');

    document.body.append(caption);

    this.insetFrame = frame;
    this.insetReadout = readout;
    this.captionEl = caption;
  }

  /**
   * インセットの DOM 枠の寸法を scissor 矩形と一致させる。
   * 幅の式は insetWidthFor() ひとつだけが持ち、CSS へは custom property で渡す
   * (2 箇所で計算するとズレるため)。**位置**は CSS が決め、こちらは実測する。
   */
  private layoutInset(viewportWidth: number): void {
    const scale = this.sheetLayout?.matches === true ? INSET_MOBILE_SCALE : 1;
    const w = insetWidthFor(viewportWidth) * scale;
    const root = document.documentElement.style;
    root.setProperty('--pv-inset-w', `${w.toFixed(1)}px`);
    root.setProperty('--pv-inset-h', `${(w * INSET_ASPECT).toFixed(1)}px`);
    root.setProperty('--pv-inset-margin', `${INSET_MARGIN}px`);
    this.measureInsetRect();
  }

  /**
   * DOM 枠の実際の矩形を読んで scissor の位置を決める。
   *
   * モバイルでは枠が右下からタブ棚の直下へ引っ越すが、その引っ越しを書いているのは
   * CSS のメディアクエリだけ ── ここで同じ条件を二重に実装すると必ずズレるので、
   * **結果を測る**。枠が畳まれている(display:none)ときは測れないので、
   * renderInset 側の既定(右下)へ落とす。
   */
  private measureInsetRect(): void {
    const frame = this.insetFrame;
    if (frame === null) {
      this.insetMeasured = false;
      return;
    }
    const rect = frame.getBoundingClientRect();
    if (!(rect.width > 1 && rect.height > 1)) {
      this.insetMeasured = false;
      return;
    }
    this.insetRect.x = rect.left;
    this.insetRect.top = rect.top;
    this.insetRect.w = rect.width;
    this.insetRect.h = rect.height;
    this.insetMeasured = true;
  }

  /**
   * 没入モードの通知(gallery が唯一の呼び手)。
   * インセットは composer の後の第2パスなので CSS では止まらない ── ここで止める。
   */
  setChromeHidden(hidden: boolean): void {
    if (hidden === this.chromeHidden) return;
    this.chromeHidden = hidden;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    this.insetVisible = this.active && this.mode !== 'xray' && !this.chromeHidden;
    this.insetFrame?.classList.toggle('is-visible', this.insetVisible);
    this.captionEl?.classList.toggle('is-visible', this.active && !this.chromeHidden);
    // 枠が現れた直後にだけ測る(display:none のあいだは矩形が取れない)
    if (this.insetVisible) this.measureInsetRect();
  }

  /** s の読み出しは 2 桁表示が変わったときだけ DOM を触る */
  private updateReadout(): void {
    const el = this.insetReadout;
    if (el === null) return;
    const text = `s = ${this.sweep >= 0 ? '+' : '-'}${Math.abs(this.sweep).toFixed(2)}`;
    if (text === this.insetReadoutText) return;
    this.insetReadoutText = text;
    el.textContent = text;
  }

  /** キャプションの差し替え(フェードアウト → 文字替え → フェードイン) */
  private setCaption(text: string): void {
    const el = this.captionEl;
    if (el === null || text === this.captionText) return;
    const first = this.captionText === '';
    this.captionText = text;
    if (this.captionTimer !== 0) window.clearTimeout(this.captionTimer);
    if (first) {
      // 初回はフェード待ちを挟まない(入場時に空欄が見えるのを避ける)
      el.textContent = text;
      return;
    }
    el.classList.add('is-swapping');
    this.captionTimer = window.setTimeout(() => {
      this.captionTimer = 0;
      el.textContent = text;
      el.classList.remove('is-swapping');
    }, 220);
  }

  // --- 低レベルのジオメトリ出力 ----------------------------------------------

  /** 単位半径の n-球ワイヤと単位円を一度だけ作る(毎フレームは半径倍するだけ) */
  private buildUnitWires(): void {
    this.sphereWire = new Float32Array(SPHERE_WIRE_SEGMENTS * 6);
    this.unitCircle = new Float32Array(CIRCLE_SEGMENTS * 6);

    let o = 0;
    // 緯線: 極を避けて θ を等分し、XZ 平面に平行な円を積む
    for (let i = 0; i < SPHERE_RINGS; i++) {
      const theta = (Math.PI * (i + 1)) / (SPHERE_RINGS + 1);
      const y = Math.cos(theta);
      const rr = Math.sin(theta);
      for (let k = 0; k < SPHERE_RING_SEGMENTS; k++) {
        const a = (TWO_PI * k) / SPHERE_RING_SEGMENTS;
        const b = (TWO_PI * (k + 1)) / SPHERE_RING_SEGMENTS;
        this.sphereWire[o++] = rr * Math.cos(a);
        this.sphereWire[o++] = y;
        this.sphereWire[o++] = rr * Math.sin(a);
        this.sphereWire[o++] = rr * Math.cos(b);
        this.sphereWire[o++] = y;
        this.sphereWire[o++] = rr * Math.sin(b);
      }
    }
    // 経線: 極を通る大円
    for (let j = 0; j < SPHERE_MERIDIANS; j++) {
      const phi = (Math.PI * j) / SPHERE_MERIDIANS;
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      for (let k = 0; k < SPHERE_RING_SEGMENTS; k++) {
        const a = (TWO_PI * k) / SPHERE_RING_SEGMENTS;
        const b = (TWO_PI * (k + 1)) / SPHERE_RING_SEGMENTS;
        this.sphereWire[o++] = Math.sin(a) * cp;
        this.sphereWire[o++] = Math.cos(a);
        this.sphereWire[o++] = Math.sin(a) * sp;
        this.sphereWire[o++] = Math.sin(b) * cp;
        this.sphereWire[o++] = Math.cos(b);
        this.sphereWire[o++] = Math.sin(b) * sp;
      }
    }

    let c = 0;
    for (let k = 0; k < CIRCLE_SEGMENTS; k++) {
      const a = (TWO_PI * k) / CIRCLE_SEGMENTS;
      const b = (TWO_PI * (k + 1)) / CIRCLE_SEGMENTS;
      this.unitCircle[c++] = Math.cos(a);
      this.unitCircle[c++] = Math.sin(a);
      this.unitCircle[c++] = 0;
      this.unitCircle[c++] = Math.cos(b);
      this.unitCircle[c++] = Math.sin(b);
      this.unitCircle[c++] = 0;
    }
  }

  private emitSegment(
    seg: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    color: THREE.Color,
    lum: number,
  ): number {
    const pos = this.lineBatch.positions;
    const col = this.lineBatch.colors;
    const o = seg * 6;
    pos[o] = ax;
    pos[o + 1] = ay;
    pos[o + 2] = az;
    pos[o + 3] = bx;
    pos[o + 4] = by;
    pos[o + 5] = bz;
    col[o] = col[o + 3] = color.r * lum;
    col[o + 1] = col[o + 4] = color.g * lum;
    col[o + 2] = col[o + 5] = color.b * lum;
    return seg + 1;
  }

  private emitBox(
    seg: number,
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
    color: THREE.Color,
    lum: number,
  ): number {
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        seg = this.emitSegment(
          seg, cx - hx, cy + sy * hy, cz + sz * hz, cx + hx, cy + sy * hy, cz + sz * hz, color, lum,
        );
      }
    }
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        seg = this.emitSegment(
          seg, cx + sx * hx, cy - hy, cz + sz * hz, cx + sx * hx, cy + hy, cz + sz * hz, color, lum,
        );
      }
    }
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) {
        seg = this.emitSegment(
          seg, cx + sx * hx, cy + sy * hy, cz - hz, cx + sx * hx, cy + sy * hy, cz + hz, color, lum,
        );
      }
    }
    return seg;
  }

  /** 平面図の折れ線。(u,v) → (u, 0, −v) */
  private emitPlanPolyline(
    seg: number,
    pts: readonly number[],
    closed: boolean,
    color: THREE.Color,
    lum: number,
  ): number {
    const count = pts.length / 2;
    const last = closed ? count : count - 1;
    for (let i = 0; i < last; i++) {
      const j = (i + 1) % count;
      seg = this.emitSegment(
        seg, pts[i * 2], 0, -pts[i * 2 + 1], pts[j * 2], 0, -pts[j * 2 + 1], color, lum,
      );
    }
    return seg;
  }

  /** 平面図の独立した線分列(点の対で 1 本ずつ) */
  private emitPlanSegments(
    seg: number,
    pts: readonly number[],
    color: THREE.Color,
    lum: number,
  ): number {
    for (let i = 0; i < pts.length / 4; i++) {
      const o = i * 4;
      seg = this.emitSegment(
        seg, pts[o], 0, -pts[o + 1], pts[o + 2], 0, -pts[o + 3], color, lum,
      );
    }
    return seg;
  }

  /** 平面図の円(住人) */
  private emitPlanCircle(
    seg: number,
    cu: number,
    cv: number,
    radius: number,
    steps: number,
    color: THREE.Color,
    lum: number,
  ): number {
    for (let k = 0; k < steps; k++) {
      const a = (TWO_PI * k) / steps;
      const b = (TWO_PI * (k + 1)) / steps;
      seg = this.emitSegment(
        seg,
        cu + Math.cos(a) * radius,
        0,
        -(cv + Math.sin(a) * radius),
        cu + Math.cos(b) * radius,
        0,
        -(cv + Math.sin(b) * radius),
        color,
        lum,
      );
    }
    return seg;
  }
}

// --- モジュール内ヘルパー ----------------------------------------------------

/** 透視除算のもう一段(3D → 2D)。z は 0 に潰す。projection.ts と同じ f クランプ */
function flattenTo2D(proj: Float32Array, count: number, dist: number): void {
  for (let v = 0; v < count; v++) {
    const o = v * 3;
    let f = dist / (dist - proj[o + 2]);
    if (f > 50) f = 50;
    else if (f < -50) f = -50;
    proj[o] *= f;
    proj[o + 1] *= f;
    proj[o + 2] = 0;
  }
}

/** 影モードの深度キュー: 手前(+)ほどマゼンタ、奥(−)ほど青 */
function depthColor(depth: number, target: THREE.Color): THREE.Color {
  const t = clamp01((depth + 1) * 0.5);
  target.copy(CYAN).lerp(MAGENTA, t);
  target.multiplyScalar(0.55 + 0.55 * t);
  return target;
}

/** インセット用の素の LineSegments(ブルームを通さないので Line2 は不要) */
function makeInsetLines(positions: Float32Array, color: number, opacity: number): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(positions, 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', attr);
  geometry.setDrawRange(0, 0);
  // 未使用領域を含む境界計算が走る経路を塞ぐ(frustumCulled=false と対で)
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);

  const material = new THREE.LineBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  return lines;
}
