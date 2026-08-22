import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

import { clamp, expSmooth } from '../math/ease';
import { makePolytope, type Polytope, type PolytopeFamily } from '../math/polytopes';
import { rotateBatch, type PlaneRotation } from '../math/rotation';
import { projectOrtho, projectPerspective } from '../math/projection';
import { MAX_TUMBLE_PLANES, planTumble } from '../math/tumble';

import { LineBatch } from '../render/lineBatch';
import { PointBatch } from '../render/pointBatch';
import { CYAN, cosinePalette } from '../render/palette';
import { createPanel } from '../ui/panel';
import { polytopeTagline } from '../ui/content';

import type { EngineCtx, Exhibit } from './exhibit';

export type ProjectionMode = 'perspective' | 'ortho';

export interface PolytopeParams {
  family: PolytopeFamily;
  /** 3..10 */
  n: number;
  projection: ProjectionMode;
  /**
   * 透視カスケードの**基準**視点距離(プラン既定 2.4)。実効値はこれを下限として
   * 形状ごとに自動的に伸びる ─ MAX_PROJECTED_RADIUS のコメント参照。
   */
  dist: number;
}

const N_MIN = 3;
const N_MAX = 10;

/** 線幅(CSS px)。gl.lineWidth は使えないので Line2 のファットライン */
const LINE_WIDTH = 2.5;
/**
 * 加算合成 + ACES で白飛びさせないための基礎輝度(既知の罠 #6)。
 * Phase 11: 0.80 → 0.90(ブルーム減量ぶんのピークを線そのもので取り戻す)。
 */
const LINE_BASE_BRIGHTNESS = 0.9;
const POINT_BRIGHTNESS = 0.85;

/**
 * 黒への指数フォグ(Phase 11 で新設)。
 *
 * 高 n の入れ子構造は奥側の辺が大量に重なる。フォグはそれをブルームへ入る**前**に
 * 減衰させるので、にじみ(veil)の原料そのものが減る ── フォグを足すと画面は
 * 濁るのではなく、逆に澄む(監査の実測)。像の半径は自動フィットで常に ~2.3、
 * カメラ距離は 2.2〜20 なので、密度 0.05 は手前 0.99 / 奥 0.85 程度の穏やかな傾斜。
 * 星は fog:false の生 ShaderMaterial なので影響を受けない(背景は消えない)。
 */
const FOG_DENSITY = 0.05;

/**
 * 密度補正(既知の罠 #6 の本丸)。
 *
 * 10-cube は辺が 5120 本あり、投影すると中心付近で猛烈に重なる。加算合成では
 * 重なりがそのまま加算されるので、n によらず一定の基礎輝度にすると高 n で
 * 画面全体が白飛びする(実測: 未補正の 10-cube はブラウザ上で完全な白面になった)。
 *
 * 自動フィットで見かけの大きさは形状によらず揃うため、画面上の総インク量は
 * ほぼ辺の本数に比例する。よって重なりのピークを一定に保つ補正は **線形**
 * (1/edgeCount)。基準本数以下ではフル輝度のままにする。細分割は辺を端点で
 * 継ぐだけで総インク量を増やさないので、基準は segCount ではなく edgeCount。
 *
 * 実測での落とし所: 10-cube → 0.8·128/5120 = 0.020(入れ子キューブ構造が
 * 白飛びせずに読める) / 4-cube → 0.8(素の明るいワイヤ)。
 */
const DENSITY_REFERENCE_EDGES = 128;
const DENSITY_REFERENCE_VERTICES = 48;

/**
 * 透視カスケードの退化回避(既知の罠 #2 の実測による補強)。
 *
 * プランは「外接半径 1 への正規化 + dist=2.4 で特異点は構造的に排除」としているが、
 * これが保証するのは**カスケードの第 1 段だけ**である。各段は下位の全座標を
 * f = dist/(dist − p[d]) 倍するので倍率が累積し、段数の多い高次元では下位段の
 * |p[d]| が dist を超えて分母の符号が反転する。
 *
 * 実測(dist=2.4・回転を 400 サンプル走査したときの投影半径の最大値):
 *   6-cube 1.44 / 7-cube 1.80 / 8-cube 2.65 / **9-cube 37.5 / 10-cube 178**
 * (9・10 では projection.ts の F_CLAMP=50 が発動している = 完全な退化)
 *
 * そこで基準 dist から測定 → 上限超なら dist を 1.2 倍、を繰り返して安全な
 * 視点距離を選ぶ。simplex / orthoplex は n=10 でも 1.15 / 1.10 なので 2.4 のまま。
 */
const MAX_PROJECTED_RADIUS = 3;
const DIST_STEP = 1.2;
const DIST_MAX_STEPS = 8;

/**
 * 自動フィット。投影後の見かけ半径は形状で桁違いに変わる(10-cube の座標は
 * ±1/√10 しかない一方、カスケードで数倍に伸びる)ため、測定した半径から
 * ワールドスケールを決めて構図を揃える。投影の数学には一切手を入れず、
 * カメラのフレーミングに相当する操作だけを行う。
 * カメラ z=6 / fov 50 の可視半高が ≈2.8 なので、最大時に画面高の ~82% を占める
 * 2.3 を目標半径とする。
 */
const TARGET_RADIUS = 2.3;
/** 見かけ半径の測定条件。SPAN は ω と共鳴しないよう半端な値にする */
const FIT_SAMPLES = 64;
const FIT_SPAN = 53.7;

/** reveal(draw-on)の収束速度。expSmooth で ~350ms */
const REVEAL_RATE = 9;

/** 深度 → 色のルックアップ表の解像度 */
const LUT_SIZE = 256;
const LUT_MAX = LUT_SIZE - 1;

/**
 * 辺の細分割数(プラン5節「投影の真の曲率」)。
 * 透視カスケードでは高次元の直線辺が 3D では曲線に映る。頂点だけを投影して
 * 直線で結ぶとこの曲がりが消えてしまうため、辺上に中間点を打って投影する。
 */
function subdivisionsFor(n: number): number {
  return n <= 6 ? 16 : n <= 8 ? 8 : 4;
}

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
 * 全 (族 × n) の組み合わせを走査してバッファ容量を決める。
 * 最悪ケースは常に n=10 の cube: 1024 頂点 / 5120 辺 / 細分割 4 で
 *   細分点 5120×5 = 25,600 / 線分 5120×4 = 20,480。
 * ハードコードせず導出することで、族や n の範囲を広げても破綻しない。
 */
const CAPACITY = (() => {
  const families: readonly PolytopeFamily[] = ['cube', 'simplex', 'orthoplex'];
  let vertices = 0;
  let segments = 0;
  let subPoints = 0;
  for (const family of families) {
    for (let n = N_MIN; n <= N_MAX; n++) {
      const s = subdivisionsFor(n);
      const e = edgeCountOf(family, n);
      vertices = Math.max(vertices, vertexCountOf(family, n));
      segments = Math.max(segments, e * s);
      subPoints = Math.max(subPoints, e * (s + 1));
    }
  }
  return { vertices, segments, subPoints };
})();

/** 深度(正規化済み ∈[-1,1])→ LUT の行インデックス */
function lutIndexOf(depth: number, scale: number): number {
  const t = (depth * scale + 1) * 0.5 * LUT_MAX;
  if (!(t > 0)) return 0;
  return t > LUT_MAX ? LUT_MAX : t | 0;
}

/**
 * n 次元多胞体エクスプローラ。
 *
 * 毎フレームのデータフロー(プラン6節・アロケーションゼロ):
 *   角度更新(絶対時刻) → rotateBatch → projectPerspective/Ortho
 *   → 辺インデックスで線分バッファへ scatter(色も同時に)
 *   → commitPositions / commitColors / commit
 */
export class PolytopeExhibit implements Exhibit {
  readonly id = 'polytope';
  readonly scene: THREE.Scene;
  readonly params: PolytopeParams;

  private readonly group = new THREE.Group();

  private material!: LineMaterial;
  private lineBatch!: LineBatch;
  private pointBatch!: PointBatch;

  /** 細分点の元座標(nD インターリーブ・ストライド n) */
  private subBase!: Float64Array;
  /** 細分点の回転後座標 */
  private subRot!: Float64Array;
  /** 細分点の 3D 投影結果 */
  private subProj!: Float32Array;
  /** 素の頂点(グロー点用)の元座標 / 回転後座標 */
  private vertBase!: Float64Array;
  private vertRot!: Float64Array;
  /** 深度 → RGB の事前計算表(毎フレーム 25,600 回 cos を呼ばないため) */
  private depthLut!: Float32Array;

  /**
   * 自動タンブルの回転平面。**枚数は投影モードと n で変わる**(tumble.ts)ので
   * 長さは可変で、実体は pool から使い回す ── 毎フレーム書き換えるのは angle だけ。
   */
  private readonly rotPool: readonly PlaneRotation[] = Array.from(
    { length: MAX_TUMBLE_PLANES },
    () => ({ i: 0, j: 1, angle: 0 }),
  );
  private readonly rots: PlaneRotation[] = [];
  /** rots[r] の角速度(rad/s)と初期位相(rad) */
  private readonly omegas = new Float64Array(MAX_TUMBLE_PLANES);
  private readonly phases = new Float64Array(MAX_TUMBLE_PLANES);
  /** computeDepthScale の作業用ビット列 */
  private readonly axisFlags = new Uint8Array(N_MAX);
  private readonly scratchColor = new THREE.Color();

  private polytope: Polytope | null = null;
  private subdivisions = 0;
  private subPointCount = 0;
  private segCount = 0;
  /** 最終軸座標を [-1,1] へ正規化する係数(色のダイナミックレンジを使い切るため) */
  private depthScale = 1;
  /** 密度補正後の線/点の基礎輝度 */
  private lineBrightness = LINE_BASE_BRIGHTNESS;
  private pointBrightness = POINT_BRIGHTNESS;
  /** 実効視点距離(params.dist を下限とし、退化する形状では自動的に伸ばす) */
  private dist = 2.4;

  private reveal = 0;
  private revealTarget = 1;
  private initialized = false;

  constructor(params?: Partial<PolytopeParams>) {
    this.scene = new THREE.Scene();
    this.scene.name = 'polytopeScene';
    this.scene.fog = new THREE.FogExp2(0x000000, FOG_DENSITY);

    // Phase 2 の既定は性能ストレスケースの 10-cube。
    // 出荷時の既定(おそらく n=4 のテッセラクト)は Phase 7 で決める。
    this.params = {
      family: params?.family ?? 'cube',
      n: params?.n ?? 10,
      projection: params?.projection ?? 'perspective',
      dist: params?.dist ?? 2.4,
    };

    this.group.name = 'polytope';
    this.scene.add(this.group);
  }

  init(ctx: EngineCtx): void {
    if (this.initialized) return;

    this.subBase = new Float64Array(CAPACITY.subPoints * N_MAX);
    this.subRot = new Float64Array(CAPACITY.subPoints * N_MAX);
    this.subProj = new Float32Array(CAPACITY.subPoints * 3);
    this.vertBase = new Float64Array(CAPACITY.vertices * N_MAX);
    this.vertRot = new Float64Array(CAPACITY.vertices * N_MAX);
    this.depthLut = new Float32Array(LUT_SIZE * 3);

    this.material = new LineMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      linewidth: LINE_WIDTH,
    });
    // ShaderMaterial の fog 既定は false。**生成時に**立てること ── 実行中に
    // 切り替えると USE_FOG の定義が変わるためプログラムの再ビルドが要る。
    this.material.fog = true;
    // resize 時の resolution 更新は engine が一元管理する(既知の罠 #3)
    ctx.engine.registerLineMaterial(this.material);

    this.lineBatch = new LineBatch(CAPACITY.segments, this.material);
    this.pointBatch = new PointBatch(CAPACITY.vertices, {
      color: CYAN,
      brightness: POINT_BRIGHTNESS,
    });
    ctx.engine.onResize((_width, _height, pixelRatio) => {
      this.pointBatch.setPixelRatio(pixelRatio);
    });

    this.group.add(this.lineBatch.object, this.pointBatch.object);

    this.initialized = true;
    this.applyShape();
  }

  enter(): void {
    this.reveal = 0;
    this.revealTarget = 1;
  }

  exit(): void {
    this.revealTarget = 0;
  }

  /**
   * 見出しの副題。**いま何を見ているか**を、名前と数で名乗る(Phase 41)。
   * 数はパネルの VERTICES / EDGES と同じ実物の値を渡す ── 二重に数えない。
   * init() が applyShape() を通るので、gallery が引く時点で polytope は必ずある。
   */
  tagline(): string {
    const poly = this.polytope;
    const n = poly?.n ?? this.params.n;
    return polytopeTagline(
      this.params.family,
      n,
      poly?.vertexCount ?? 0,
      poly?.edgeCount ?? 0,
    );
  }

  /**
   * 制御パネル(Phase 7)。族と n はどちらも形状の作り直しを伴うが、
   * バッファは n=10 cube の最悪ケースで確保済みなので再確保は起きない。
   */
  buildPanel(root: HTMLElement): void {
    const p = this.params;
    const panel = createPanel(root, 'POLYTOPE EXPLORER');

    const counts = panel.readout({ label: 'VERTICES / EDGES' });
    const refresh = (): void => {
      const poly = this.polytope;
      if (poly !== null) counts(`${poly.vertexCount} / ${poly.edgeCount}`);
    };
    refresh();

    panel.segmented({
      label: 'FAMILY / 族',
      options: [
        ['cube', '超立方体'],
        ['simplex', '単体'],
        ['orthoplex', '正軸体'],
      ],
      value: p.family,
      onSelect: (v) => {
        this.setShape(v as PolytopeFamily, p.n);
        refresh();
      },
    });

    panel.slider({
      label: 'N / 次元',
      min: N_MIN,
      max: N_MAX,
      step: 1,
      value: p.n,
      onInput: (v) => {
        this.setShape(p.family, v);
        refresh();
      },
    });

    panel.segmented({
      label: 'PROJECTION / 投影',
      options: [
        ['perspective', '透視'],
        ['ortho', '直交'],
      ],
      value: p.projection,
      onSelect: (v) => this.setProjection(v as ProjectionMode),
    });

    panel.note(
      '辺が曲がって見えるのは誤差ではない ── 高次元のまっすぐな辺は、' +
        '影になるとき本当に曲がる。色は、見えなくなった軸の深さ。',
    );
  }

  /** 形状の切り替え。事前確保済みバッファを再利用し、前計算だけをやり直す */
  setShape(family: PolytopeFamily, n: number): void {
    this.params.family = family;
    this.params.n = n;
    if (this.initialized) this.applyShape();
  }

  setProjection(mode: ProjectionMode): void {
    this.params.projection = mode;
    if (this.polytope !== null) this.applyProjection(this.polytope);
  }

  update(dt: number, t: number): void {
    const poly = this.polytope;
    if (!this.initialized || poly === null) return;

    // draw-on: instanceCount を伸ばすだけのアロケーションフリーな入退場
    if (this.reveal !== this.revealTarget) {
      this.reveal = expSmooth(this.reveal, this.revealTarget, REVEAL_RATE, dt);
      if (Math.abs(this.revealTarget - this.reveal) < 0.002) this.reveal = this.revealTarget;
    }

    const n = poly.n;
    // 角度は毎フレーム絶対時刻から再計算する(増分積算しないので誤差が溜まらない)
    this.setAngles(t);

    const rots = this.rots;
    const perspective = this.params.projection === 'perspective';
    const dist = this.dist;

    // 1) 細分点: nD 回転 → 3D 投影
    rotateBatch(this.subBase, this.subRot, n, this.subPointCount, rots);
    if (perspective) {
      projectPerspective(this.subRot, n, this.subPointCount, dist, this.subProj);
    } else {
      projectOrtho(this.subRot, n, this.subPointCount, this.subProj);
    }
    // 2) 点列(チェーン)→ 線分ペアへ展開。subProj をそのまま線バッファに
    //    できないのはこの展開があるため(1 点は 2 線分に共有される)
    this.scatterSegments(n);

    // 3) 素の頂点は別途回転・投影して Points のバッファへ直接書く
    //    (投影関数の out がそのまま BufferAttribute の配列)
    const vertexCount = poly.vertexCount;
    rotateBatch(this.vertBase, this.vertRot, n, vertexCount, rots);
    if (perspective) {
      projectPerspective(this.vertRot, n, vertexCount, dist, this.pointBatch.positions);
    } else {
      projectOrtho(this.vertRot, n, vertexCount, this.pointBatch.positions);
    }
    this.shadeVertices(n, vertexCount);

    this.lineBatch.commitPositions(this.segCount);
    this.lineBatch.commitColors(this.segCount);
    this.lineBatch.setReveal(this.reveal);
    this.pointBatch.commit(vertexCount);
    this.pointBatch.commitBrightness();
    this.pointBatch.setBrightness(this.pointBrightness * this.reveal);
  }

  dispose(): void {
    this.lineBatch?.dispose();
    this.pointBatch?.dispose();
    this.material?.dispose();
  }

  // --- 内部 ------------------------------------------------------------------

  /**
   * 細分点チェーンを線分ペアへ展開しつつ、色も同時に書き込む。
   *
   * 色は「回転後の最終軸座標」= 3D へ潰される直前の隠れた次元での深さ。
   * 手前(+)ほど明るくマゼンタ寄り、奥(−)ほど暗く青寄りになり、4 次元以上の
   * 奥行きが色として読める(科学的にも正しい深度キュー)。
   */
  private scatterSegments(n: number): void {
    const poly = this.polytope;
    if (poly === null) return;

    const S = this.subdivisions;
    const edgeCount = poly.edgeCount;
    const proj = this.subProj;
    const rot = this.subRot;
    const lut = this.depthLut;
    const pos = this.lineBatch.positions;
    const col = this.lineBatch.colors;
    const depthAxis = n - 1;
    const scale = this.depthScale;

    let p = 0; // 細分点インデックス(辺ごとに S+1 点が連続配置されている)
    let seg = 0;

    for (let e = 0; e < edgeCount; e++) {
      let i0 = lutIndexOf(rot[p * n + depthAxis], scale);
      for (let s = 0; s < S; s++) {
        const p1 = p + 1;
        const i1 = lutIndexOf(rot[p1 * n + depthAxis], scale);

        const so = seg * 6;
        const a = p * 3;
        const b = p1 * 3;
        pos[so] = proj[a];
        pos[so + 1] = proj[a + 1];
        pos[so + 2] = proj[a + 2];
        pos[so + 3] = proj[b];
        pos[so + 4] = proj[b + 1];
        pos[so + 5] = proj[b + 2];

        const c0 = i0 * 3;
        const c1 = i1 * 3;
        col[so] = lut[c0];
        col[so + 1] = lut[c0 + 1];
        col[so + 2] = lut[c0 + 2];
        col[so + 3] = lut[c1];
        col[so + 4] = lut[c1 + 1];
        col[so + 5] = lut[c1 + 2];

        i0 = i1;
        p = p1;
        seg++;
      }
      p++; // 辺の終端点を消費して次の辺の先頭へ
    }
  }

  /** 頂点グローの輝度にも同じ深度キューを載せる */
  private shadeVertices(n: number, count: number): void {
    const rot = this.vertRot;
    const bright = this.pointBatch.brights;
    const depthAxis = n - 1;
    const scale = this.depthScale;
    for (let v = 0; v < count; v++) {
      const raw = (rot[v * n + depthAxis] * scale + 1) * 0.5;
      const t01 = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      bright[v] = 0.35 + 0.85 * t01;
    }
  }

  /** 形状依存の前計算をまとめて実行する(init と setShape からのみ) */
  private applyShape(): void {
    const n = clamp(Math.round(this.params.n), N_MIN, N_MAX);
    this.params.n = n;

    const poly = makePolytope(this.params.family, n);
    this.polytope = poly;
    this.subdivisions = subdivisionsFor(n);

    this.buildSubdivided(poly);
    this.vertBase.set(poly.vertices);

    this.lineBrightness =
      LINE_BASE_BRIGHTNESS * Math.min(1, DENSITY_REFERENCE_EDGES / poly.edgeCount);
    this.pointBrightness =
      POINT_BRIGHTNESS * Math.min(1, DENSITY_REFERENCE_VERTICES / poly.vertexCount);
    this.buildDepthLut();

    this.applyProjection(poly);

    // 見出しの副題を設定に追従させる(Phase 41)。入場時は gallery が tagline() を
    // **引く**ので、ここで押すのは表示中に族 / N を変えたときのためだけ
    window.dispatchEvent(
      new CustomEvent<string>('dimension:tagline', {
        detail: polytopeTagline(this.params.family, n, poly.vertexCount, poly.edgeCount),
      }),
    );

    console.info(
      `[polytope] family=${this.params.family} n=${n} verts=${poly.vertexCount} ` +
        `edges=${poly.edgeCount} subSegs=${this.segCount} proj=${this.params.projection} ` +
        `planes=${this.rots.length} dist=${this.dist.toFixed(2)} ` +
        `fit=${this.group.scale.x.toFixed(3)}`,
    );
  }

  /**
   * 回転平面・深度スケール・実効視点距離・ワールドスケールを決める。
   * 形状変更と投影モード変更でのみ実行。
   * 測定には毎フレームと同じ回転・投影経路を使う(数式を二重実装しない)。
   */
  private applyProjection(poly: Polytope): void {
    const perspective = this.params.projection === 'perspective';

    // 平面は投影モードに従属し、深度スケールは平面に従属する。だから
    // **投影を切り替えたときも**この順で張り直す必要がある(形状変更だけではない)。
    this.pickPlanes(poly.n, perspective);
    this.depthScale = this.computeDepthScale(poly);

    let dist = this.params.dist;
    let radius = this.measureRadius(poly, dist, perspective);

    if (perspective) {
      for (let i = 0; i < DIST_MAX_STEPS && radius > MAX_PROJECTED_RADIUS; i++) {
        dist *= DIST_STEP;
        radius = this.measureRadius(poly, dist, perspective);
      }
    }

    this.dist = dist;
    this.group.scale.setScalar(radius > 1e-6 ? TARGET_RADIUS / radius : TARGET_RADIUS);
  }

  /** 自動タンブルを時間方向に走査したときの投影半径の最大値 */
  private measureRadius(poly: Polytope, dist: number, perspective: boolean): number {
    const n = poly.n;
    const count = poly.vertexCount;
    const rots = this.rots;
    const out = this.subProj; // 形状変更時のみ走るので細分点用バッファを流用できる

    let maxSq = 0;
    for (let s = 0; s < FIT_SAMPLES; s++) {
      this.setAngles((s / FIT_SAMPLES) * FIT_SPAN);
      rotateBatch(this.vertBase, this.vertRot, n, count, rots);
      if (perspective) {
        projectPerspective(this.vertRot, n, count, dist, out);
      } else {
        projectOrtho(this.vertRot, n, count, out);
      }
      for (let v = 0; v < count; v++) {
        const x = out[v * 3];
        const y = out[v * 3 + 1];
        const z = out[v * 3 + 2];
        const r2 = x * x + y * y + z * z;
        if (r2 > maxSq) maxSq = r2;
      }
    }
    return Math.sqrt(maxSq);
  }

  /** 辺ごとに S+1 点を線形補間して連続配置する(nD のまま補間するのが要点) */
  private buildSubdivided(poly: Polytope): void {
    const n = poly.n;
    const S = this.subdivisions;
    const invS = 1 / S;
    const edges = poly.edges;
    const vertices = poly.vertices;
    const base = this.subBase;

    let p = 0;
    for (let e = 0; e < poly.edgeCount; e++) {
      const a = edges[e * 2] * n;
      const b = edges[e * 2 + 1] * n;
      for (let s = 0; s <= S; s++) {
        const t = s * invS;
        const o = p * n;
        for (let k = 0; k < n; k++) {
          const va = vertices[a + k];
          base[o + k] = va + (vertices[b + k] - va) * t;
        }
        p++;
      }
    }

    this.subPointCount = p;
    this.segCount = poly.edgeCount * S;
  }

  /**
   * 回転平面を張り直す(tumble.ts が条件を持っている)。
   *
   * **投影モードが変わったら必ず呼ぶこと。** 直交は「すべての軸が可視 3 軸へ
   * 到達する」ことを要求し、透視は要求しない ── 条件が違うので平面の組も違う。
   */
  private pickPlanes(n: number, perspective: boolean): void {
    const plan = planTumble(n, perspective);
    const rots = this.rots;
    rots.length = 0;
    for (let k = 0; k < plan.planes.length; k++) {
      const rot = this.rotPool[k];
      rot.i = plan.planes[k][0];
      rot.j = plan.planes[k][1];
      this.omegas[k] = plan.omegas[k];
      this.phases[k] = plan.phases[k];
      rots.push(rot);
    }
  }

  /** 全平面の角度を絶対時刻から張り直す(update と measureRadius で共有) */
  private setAngles(t: number): void {
    const rots = this.rots;
    const omegas = this.omegas;
    const phases = this.phases;
    for (let r = 0; r < rots.length; r++) rots[r].angle = omegas[r] * t + phases[r];
  }

  /**
   * 「回転後の最終軸座標」が取り得る最大値の逆数を返す。
   *
   * 深度の生の値域は形状と回転平面に強く依存する(例: 10-cube の座標は ±1/√10 しか
   * ないので、そのまま [-1,1] とみなすとパレットの中央 3 割しか使われない)。
   * 最終軸へ寄与し得る入力軸を回転列から逆向きに辿って集め、その部分ノルムの
   * 最大値でスケールすることで、どの形状でも配色のレンジを使い切る。
   */
  private computeDepthScale(poly: Polytope): number {
    const n = poly.n;
    const flags = this.axisFlags;
    flags.fill(0);
    flags[n - 1] = 1;
    // rots は順に適用されるので、依存関係は後ろから辿る
    for (let r = this.rots.length - 1; r >= 0; r--) {
      const rot = this.rots[r];
      if (flags[rot.i] === 1 || flags[rot.j] === 1) {
        flags[rot.i] = 1;
        flags[rot.j] = 1;
      }
    }

    const vertices = poly.vertices;
    let maxSq = 0;
    for (let v = 0; v < poly.vertexCount; v++) {
      const o = v * n;
      let sum = 0;
      for (let k = 0; k < n; k++) {
        if (flags[k] === 1) {
          const x = vertices[o + k];
          sum += x * x;
        }
      }
      if (sum > maxSq) maxSq = sum;
    }

    const max = Math.sqrt(maxSq);
    return max > 1e-6 ? 1 / max : 1;
  }

  /**
   * 深度 → 色の表を作る。パレット評価は 256 段で足り、毎フレーム数万回
   * Math.cos を呼ぶ必要がなくなる。
   *
   * t = 0.15 + 0.70·t01(パレットの実用域)、輝度 = (0.55 + 0.35·t01)·基礎輝度。
   * 隠れた次元で手前にあるものほど明るい = 4 次元以上でも成立する深度キュー。
   */
  private buildDepthLut(): void {
    const color = this.scratchColor;
    const lut = this.depthLut;
    for (let i = 0; i < LUT_SIZE; i++) {
      const t01 = i / LUT_MAX;
      cosinePalette(0.15 + 0.7 * t01, color);
      const brightness = (0.55 + 0.35 * t01) * this.lineBrightness;
      const o = i * 3;
      lut[o] = color.r * brightness;
      lut[o + 1] = color.g * brightness;
      lut[o + 2] = color.b * brightness;
    }
  }
}
