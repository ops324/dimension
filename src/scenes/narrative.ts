import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

import { clamp01, expSmooth, smoothstep } from '../math/ease';
import { makeNCube, type Polytope } from '../math/polytopes';
import { rotateBatch, type PlaneRotation } from '../math/rotation';
import { projectPerspective } from '../math/projection';

import { LineBatch } from '../render/lineBatch';
import { PointBatch } from '../render/pointBatch';
import { CYAN, GOLD, cosinePalette } from '../render/palette';

import type { ScrollDirector } from '../core/scrollDirector';
import type { EngineCtx, Exhibit } from './exhibit';

/**
 * 物語シーン「次元の階段」— extents モーフ(プラン1節)。
 *
 * 全 9 章は **同一の 6-cube**(64 頂点 / 192 辺)を共有する。章ごとにジオメトリを
 * 作り直すのではなく、軸ごとの伸長率だけを動かす:
 *
 *   extent[k] = clamp01(dimLevel − k)          k = 0..5
 *   work[p*6+k] = base[p*6+k] * extent[k]      回転・投影の前段でスケール
 *
 * dimLevel=0 で点、1 で線、3.5 で立方体がテッセラクトへ半分押し出し中…と、
 * 連続的・可逆・スクラブ可能な押し出しモーフになる。スクロールを戻せば次元も
 * 巻き戻る ─ これが「次元の階段」の核心トリック。
 */

const N = 6;
/** 辺の細分割数(プラン5節「投影の真の曲率」。n ≤ 6 は 16 分割) */
const SUBDIV = 16;
/** 192 × 17 = 3264 細分点 */
const SUB_POINTS = 192 * (SUBDIV + 1);
/** 192 × 16 = 3072 線分 */
const SUB_SEGMENTS = 192 * SUBDIV;

/**
 * 透視カスケードの視点距離。Phase 2 の実測で 6-cube の投影半径は dist=2.4 のとき
 * 最大 1.44(退化の閾値 3 の半分以下)。よって polytopeExhibit のような
 * 自動フィット/自動 dist 伸長は不要で、固定のワールドスケールで構図が決まる。
 */
const DIST = 2.4;
/** 投影半径 1.44(6D 時)× 1.6 ≒ 2.3 ワールド単位。カメラリグの画角に合わせた値 */
const WORLD_SCALE = 1.6;

const LINE_WIDTH = 2.6;
/**
 * 加算合成の基礎輝度(既知の罠 #6)。実効値は overlapCompensation() を掛けたもの。
 */
const LINE_BASE_BRIGHTNESS = 0.6;
const POINT_BASE_BRIGHTNESS = 0.72;

/**
 * 「生まれかけの次元」のゴールドフラッシュの増幅。
 * 4·e·(1−e) は e=0.5 で 1、e=0 と e=1 で 0 になる山なので、軸が伸びている
 * 最中だけ配色がゴールドへ寄り、伸びきると通常のパレットへ戻る。
 */
const GOLD_GAIN = 1.35;

/**
 * 幾何としての最小 extent。
 *
 * extent=0 の軸に沿う辺は長さ 0 の線分になるが、LineMaterial の頂点シェーダは
 * `dir = normalize(ndcEnd - ndcStart)` を計算するため零ベクトルで NaN が出る
 * (three r185 LineMaterial.js:177)。輝度は真の extent(=0)で潰すので見えないが、
 * ジオメトリ側だけは常に非退化にしておく。1e-3 は 800px 高の画面で 0.4px 未満。
 */
const MIN_GEOM_EXTENT = 1e-3;

/**
 * 重なり補正のための「軸が分離したとみなす」しきい値。
 *
 * extent[k]=0 の軸は 6-cube の頂点を 2 枚重ねに畳む。よって dimLevel=d では
 * 図形が 2^(6−d) 枚**完全に重なって**描かれる(d=1 なら 32 重ね)。加算合成では
 * これがそのまま輝度の 32 倍になり、低次元ほど白飛びする。畳まれている軸の数を
 * 数えて割り戻すことで、画面上の見かけの明るさを全次元で一定に保つ。
 */
const SEPARATION_T = 0.3;

/**
 * 0D の「誕生の星」の増幅。
 *
 * dimLevel=0 では 64 頂点すべてが原点へ畳まれ、加算グローが 1 点に集中する。
 * 重なり補正(1/64)だけを掛けると単なる 1 個の点と同じ明るさになってしまい、
 * 「すべての次元がここから始まる」という劇的な読みが失われる。そこで補正後に
 * 低 dimLevel でのみ効くブーストを乗せ、実効輝度を通常頂点の ~3.2 倍に置く
 * (ブルーム閾値 0.1 を大きく超えるが、ACES のロールオフ内に収まる範囲)。
 */
const BIRTH_GAIN = 2.2;

/** カメラキーフレームを章の前半何割で混ぜるか */
const CAMERA_BLEND_FRACTION = 0.5;

/** 深度 → 色のルックアップ表の解像度 */
const LUT_SIZE = 256;
const LUT_MAX = LUT_SIZE - 1;

const TAU = Math.PI * 2;

interface PlaneSpec {
  readonly i: number;
  readonly j: number;
  /** ゲートが閉じている(低 dimLevel)ときの角速度 rad/s */
  readonly low: number;
  /** ゲートが開ききったときの角速度 rad/s */
  readonly high: number;
  /** ゲートが開き始める dimLevel。負なら常に開いている(= high 固定) */
  readonly gate: number;
}

/**
 * 回転スケジュール(プラン1節「章ごとの回転スケジュール」)。
 *
 * 重要: 角度は **積分位相** で持つ。`angle = ω·t·weight` にすると weight が
 * 変わった瞬間に角度が飛ぶ(スクロールでスクラブすると形が跳ねる)。
 * `phase += ω(dimLevel) · dt` なら dimLevel は角速度にしか効かず、位相は常に連続。
 * スカラーの積分なので rotation.ts が避けている「回転行列の増分積算による
 * ノルムドリフト」は起きない。
 *
 * 3 番目の (1,2) low=0.055 について:
 * 低次元では図形が平坦(1D は線、2D は正方形)なので、その姿勢を変えられる
 * 回転が 1 枚しかないと **周期的に完全な真横向き(edge-on)になり、正方形が
 * ただの線に潰れる**(実測で確認)。正方形の傾きを変えられるのは (0,2) と (1,2)
 * だけなので、(1,2) に低次元専用の弱いタンブルを 1 枚足して 2 自由度にする。
 * この枠は 4D ゲートが開くと角速度 0 になり、位相も 0 へ巻き戻る(下記)ので、
 * 等傾ペア((0,3) と (1,2))は完全に同一のダイナミクスで phase 0 から立ち上がり、
 * **プラトーでは角度まで厳密に一致した等傾二重回転になる**。
 */
const SCHEDULE: readonly PlaneSpec[] = [
  // 3D のゆるやかなタンブル。常時回る = 低次元でも図形が死なない
  { i: 0, j: 1, low: 0.12, high: 0.12, gate: -1 },
  { i: 0, j: 2, low: 0.09, high: 0.09, gate: -1 },
  // 低次元専用の第 3 タンブル(4D ゲートが開くと消える)
  { i: 1, j: 2, low: 0.055, high: 0, gate: 3 },
  // 等傾二重回転(THE 4D moment)。(0,3) と (1,2) は 4 次元部分空間の
  // 直交する補平面同士なので、同角・同速で回すと 4D の等傾回転になる
  { i: 0, j: 3, low: 0, high: 0.35, gate: 3 },
  { i: 1, j: 2, low: 0, high: 0.35, gate: 3 },
  // 5 軸目・6 軸目が生まれるたびに平面を足す
  { i: 2, j: 4, low: 0, high: 0.21, gate: 4 },
  { i: 0, j: 5, low: 0, high: 0.16, gate: 5 },
];
/** ゲートの立ち上がり幅(dimLevel) */
const GATE_WIDTH = 0.8;

/**
 * 停止中の平面の位相を 0 へ巻き戻す速さ。
 *
 * これが無いと **スクロールを戻したときに壊れる**(実測で発見):
 * 角速度だけをゲートすると、いったん開いた平面の角度が閉じたあとも凍結して残る。
 * たとえば平面 (0,3) が 2.0 rad で凍ると、3D へ戻ったときに立方体の軸 0 が
 * 「伸びていないはずの軸 3」へ 2.0 rad 傾いたままになり、可視 3 軸の広がりが
 * 潰れて立方体が薄い板に見える(実測 bbox が [0.30, 1.24, 0.42] になった)。
 * 角速度が 0 に近い平面ほど強く位相を 0 へ緩和することで、次元を降りると
 * 回転もほどけていく ─ 物語としても正しい振る舞いになる。
 */
const RELAX_RATE = 3;

interface CameraKey {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly fov: number;
}

/**
 * 章ごとのカメラキーフレーム(常に原点を見る)。
 *
 * 弧の設計: 0D は狭い画角で点に寄り、次元が増えるごとに引きながら画角も開いて
 * いく。4D で 3/4 ビューへ回り込み(テッセラクトの入れ子構造が最も読める角度)、
 * 6D でさらに引いて 192 辺の全体像を収める。エピローグはもう一段引いて余白を作る。
 */
const CAMERA_KEYS: readonly CameraKey[] = [
  { x: 0.0, y: 0.0, z: 4.2, fov: 40 }, // 0 prologue — 点へ寄る
  { x: 0.0, y: 0.0, z: 4.2, fov: 40 }, // 1 POINT
  { x: 0.55, y: 0.3, z: 4.35, fov: 43 }, // 2 LINE
  { x: 1.1, y: 0.7, z: 4.5, fov: 46 }, // 3 PLANE
  { x: 1.8, y: 1.2, z: 4.6, fov: 48 }, // 4 SOLID
  { x: 2.6, y: 1.8, z: 4.6, fov: 50 }, // 5 TESSERACT — 3/4 ビュー
  { x: 2.9, y: 2.0, z: 5.1, fov: 51 }, // 6 PENTERACT
  { x: 3.2, y: 2.2, z: 5.6, fov: 52 }, // 7 HEXERACT
  { x: 2.8, y: 2.3, z: 6.4, fov: 54 }, // 8 epilogue — 引いて余白
];

/** アイドルドリフト(呼吸)。カメラが完全静止しないことで映像が生きる */
const DRIFT_X = 0.08;
const DRIFT_Y = 0.06;
const DRIFT_Z = 0.05;

/**
 * 縦長画面でのドリー(引き)量の上限。
 *
 * PerspectiveCamera の fov は **垂直** 画角なので、aspect < 1 の画面では水平方向の
 * 視野が狭くなり、キーフレームどおりの距離だと図形が左右にはみ出す
 * (実測: 375×812 で 6-cube が両端を突き抜けた)。カメラ位置ベクトルを
 * 1/aspect 倍(上限あり)してドリーバックすることで、構図の向きは変えずに
 * 横方向へ収める。lookAt は原点のままなので純粋なドリー。
 */
const PORTRAIT_DOLLY_MAX = 1.6;
/** これ以上狭いアスペクトでも上限で頭打ちにする */
const PORTRAIT_ASPECT_FLOOR = 0.5;

/** 深度(投影後 z、正規化済み ∈[-1,1])→ LUT の行インデックス */
function lutIndexOf(depth: number, scale: number): number {
  const t = (depth * scale + 1) * 0.5 * LUT_MAX;
  if (!(t > 0)) return 0;
  return t > LUT_MAX ? LUT_MAX : t | 0;
}

export class NarrativeScene implements Exhibit {
  readonly id = 'narrative';
  readonly scene: THREE.Scene;

  private readonly director: ScrollDirector;
  private readonly group = new THREE.Group();

  private material!: LineMaterial;
  private lineBatch!: LineBatch;
  private pointBatch!: PointBatch;

  /** 細分点の元座標(6D インターリーブ) */
  private subBase!: Float64Array;
  /** extent スケール後 → 回転後(rotateBatch は in-place 可) */
  private subWork!: Float64Array;
  /** 3D 投影結果 */
  private subProj!: Float32Array;
  /** 素の 64 頂点 */
  private vertBase!: Float64Array;
  private vertWork!: Float64Array;

  /** 深度 → RGB(通常パレット / ゴールド)の事前計算表 */
  private depthLut!: Float32Array;
  private goldLut!: Float32Array;

  private polytope: Polytope | null = null;

  /** 軸ごとの伸長率(輝度用の真値) */
  private readonly extents = new Float64Array(N);
  /** 同(ジオメトリ用。0 を MIN_GEOM_EXTENT で床上げしたもの) */
  private readonly geomExtents = new Float64Array(N);

  /** 平面回転。オブジェクトは使い回して angle だけ書き換える */
  private readonly rots: PlaneRotation[] = SCHEDULE.map((s) => ({ i: s.i, j: s.j, angle: 0 }));
  /** 積分位相(平面ごと) */
  private readonly phases = new Float64Array(SCHEDULE.length);

  /** engine のカメラ。物語モードでは OrbitControls を使わずここから直接駆動する */
  private camera: THREE.PerspectiveCamera | null = null;

  private lineBrightness = LINE_BASE_BRIGHTNESS;
  private reduceMotion = false;
  private initialized = false;

  constructor(director: ScrollDirector) {
    this.director = director;

    this.scene = new THREE.Scene();
    this.scene.name = 'narrativeScene';

    this.group.name = 'narrative';
    this.group.scale.setScalar(WORLD_SCALE);
    this.scene.add(this.group);
  }

  init(ctx: EngineCtx): void {
    if (this.initialized) return;

    // 6-cube は一度だけ生成する(全章で共有 — これが extents モーフの前提)
    const poly = makeNCube(N);
    this.polytope = poly;

    this.subBase = new Float64Array(SUB_POINTS * N);
    this.subWork = new Float64Array(SUB_POINTS * N);
    this.subProj = new Float32Array(SUB_POINTS * 3);
    this.vertBase = new Float64Array(poly.vertexCount * N);
    this.vertWork = new Float64Array(poly.vertexCount * N);
    this.depthLut = new Float32Array(LUT_SIZE * 3);
    this.goldLut = new Float32Array(LUT_SIZE * 3);

    this.buildSubdivided(poly);
    this.vertBase.set(poly.vertices);
    this.buildLuts();

    this.material = new LineMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      linewidth: LINE_WIDTH,
    });
    // resize 時の resolution 更新は engine が一元管理する(既知の罠 #3)
    ctx.engine.registerLineMaterial(this.material);

    this.lineBatch = new LineBatch(SUB_SEGMENTS, this.material);
    this.pointBatch = new PointBatch(poly.vertexCount, {
      color: CYAN,
      brightness: POINT_BASE_BRIGHTNESS,
      // 頂点は 64 個しかないので polytope 展示より一回り大きく、芯を締める
      scale: 105,
      falloff: 15,
    });
    ctx.engine.onResize((_width, _height, pixelRatio) => {
      this.pointBatch.setPixelRatio(pixelRatio);
    });

    this.group.add(this.lineBatch.object, this.pointBatch.object);

    this.camera = ctx.engine.camera;

    // reduced-motion ではカメラのアイドルドリフトを止める(スクロール駆動の
    // モーフ自体は物語の本体なので残す — 止めると内容が読めなくなるため)
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (query) {
      this.reduceMotion = query.matches;
      query.addEventListener('change', (event) => {
        this.reduceMotion = event.matches;
      });
    }

    this.initialized = true;

    console.info(
      `[narrative] 6-cube verts=${poly.vertexCount} edges=${poly.edgeCount} ` +
        `subPoints=${SUB_POINTS} segments=${SUB_SEGMENTS} dist=${DIST} scale=${WORLD_SCALE}`,
    );
  }

  enter(): void {
    this.lineBatch?.setReveal(1);
  }

  /** 物語→ギャラリー遷移は Phase 7。シーンは破棄せず保持する */
  exit(): void {
    // no-op
  }

  /** 物語シーンに制御パネルはない(Exhibit インターフェースの充足) */
  buildPanel(_root: HTMLElement): void {
    // no-op
  }

  /** 現在の次元レベル(デバッグ/検証用) */
  get dimLevel(): number {
    return this.director.dimLevel;
  }

  update(dt: number, t: number): void {
    const poly = this.polytope;
    if (!this.initialized || poly === null) return;

    const dimLevel = this.director.dimLevel;

    // 1) 軸ごとの伸長率を決め、base → work へスケール
    this.applyExtents(dimLevel);

    // 2) 回転スケジュール(積分位相)
    this.advancePhases(dimLevel, dt);

    // 3) 6D 回転 → 透視カスケードで 3D へ
    rotateBatch(this.subWork, this.subWork, N, SUB_POINTS, this.rots);
    projectPerspective(this.subWork, N, SUB_POINTS, DIST, this.subProj);

    rotateBatch(this.vertWork, this.vertWork, N, poly.vertexCount, this.rots);
    projectPerspective(this.vertWork, N, poly.vertexCount, DIST, this.pointBatch.positions);

    // 4) 重なり補正 — 畳まれた軸の枚数ぶん輝度を割り戻す
    const overlap = this.overlapCompensation();
    this.lineBrightness = LINE_BASE_BRIGHTNESS * overlap;

    // 5) 線分への展開と彩色 / 頂点グローの深度キュー
    const depthScale = this.depthScaleFor(dimLevel);
    this.scatterSegments(depthScale);
    this.shadeVertices(poly.vertexCount, depthScale);

    this.lineBatch.commitPositions(SUB_SEGMENTS);
    this.lineBatch.commitColors(SUB_SEGMENTS);
    this.pointBatch.commit(poly.vertexCount);
    this.pointBatch.commitBrightness();

    // 0D の「誕生の星」: 補正後に低次元だけ効くブーストを乗せる
    const birth = 1 + BIRTH_GAIN * (1 - smoothstep(dimLevel));
    this.pointBatch.setBrightness(POINT_BASE_BRIGHTNESS * overlap * birth);

    // 6) カメラリグ
    this.updateCamera(t);
  }

  dispose(): void {
    this.lineBatch?.dispose();
    this.pointBatch?.dispose();
    this.material?.dispose();
  }

  // --- 内部 ------------------------------------------------------------------

  /** 辺ごとに SUBDIV+1 点を 6D のまま線形補間して連続配置する */
  private buildSubdivided(poly: Polytope): void {
    const invS = 1 / SUBDIV;
    const edges = poly.edges;
    const vertices = poly.vertices;
    const base = this.subBase;

    let p = 0;
    for (let e = 0; e < poly.edgeCount; e++) {
      const a = edges[e * 2] * N;
      const b = edges[e * 2 + 1] * N;
      for (let s = 0; s <= SUBDIV; s++) {
        const f = s * invS;
        const o = p * N;
        for (let k = 0; k < N; k++) {
          const va = vertices[a + k];
          base[o + k] = va + (vertices[b + k] - va) * f;
        }
        p++;
      }
    }
  }

  /** extents モーフ本体。base を軸ごとにスケールして work へ書く */
  private applyExtents(dimLevel: number): void {
    const ext = this.extents;
    const geo = this.geomExtents;
    for (let k = 0; k < N; k++) {
      const e = clamp01(dimLevel - k);
      ext[k] = e;
      geo[k] = e > MIN_GEOM_EXTENT ? e : MIN_GEOM_EXTENT;
    }

    const e0 = geo[0];
    const e1 = geo[1];
    const e2 = geo[2];
    const e3 = geo[3];
    const e4 = geo[4];
    const e5 = geo[5];

    const base = this.subBase;
    const work = this.subWork;
    for (let o = 0; o < SUB_POINTS * N; o += N) {
      work[o] = base[o] * e0;
      work[o + 1] = base[o + 1] * e1;
      work[o + 2] = base[o + 2] * e2;
      work[o + 3] = base[o + 3] * e3;
      work[o + 4] = base[o + 4] * e4;
      work[o + 5] = base[o + 5] * e5;
    }

    const vb = this.vertBase;
    const vw = this.vertWork;
    for (let o = 0; o < vb.length; o += N) {
      vw[o] = vb[o] * e0;
      vw[o + 1] = vb[o + 1] * e1;
      vw[o + 2] = vb[o + 2] * e2;
      vw[o + 3] = vb[o + 3] * e3;
      vw[o + 4] = vb[o + 4] * e4;
      vw[o + 5] = vb[o + 5] * e5;
    }
  }

  /**
   * 各平面の位相を dt ぶん進める。dimLevel は角速度側にだけ効くので、
   * dimLevel がどれだけ急に動いても角度は連続(= 形が跳ねない)。
   */
  private advancePhases(dimLevel: number, dt: number): void {
    const phases = this.phases;
    const rots = this.rots;
    for (let r = 0; r < SCHEDULE.length; r++) {
      const spec = SCHEDULE[r];
      const open =
        spec.gate < 0 ? 1 : smoothstep((dimLevel - spec.gate) / GATE_WIDTH);
      const omega = spec.low + (spec.high - spec.low) * open;

      let phase = phases[r] + omega * dt;

      // 角速度がその平面の最高速からどれだけ落ちているかに比例して 0 へ緩和する。
      // 常時回る平面(low = high)では緩和は常に 0 になるので分岐は要らない。
      const peak = spec.low > spec.high ? spec.low : spec.high;
      if (peak > 0 && omega < peak) {
        phase = expSmooth(phase, 0, RELAX_RATE * (1 - omega / peak), dt);
      }

      // 位相は常に (-π, π] へ畳む。回転は 2π 周期なので幾何は不変で、
      // 長時間セッションでの倍精度の目減りも、巻き戻しが遠回りすることも防げる。
      if (phase > Math.PI) phase -= TAU;
      else if (phase <= -Math.PI) phase += TAU;

      phases[r] = phase;
      rots[r].angle = phase;
    }
  }

  /**
   * 畳まれた軸による重なり枚数の逆数。
   *
   * extent[k]=0 の軸ごとに図形は 2 枚重ねになる(頂点が完全に一致する)。
   * 加算合成ではそれがそのまま輝度の 2 倍になるので、掛かっている倍率
   * Π_k (1 or 2) を割り戻して見かけの明るさを全次元で揃える。
   * 軸が伸び始めたら滑らかに 2 → 1 へ落とす(コピーが視覚的に分離するため)。
   */
  private overlapCompensation(): number {
    const ext = this.extents;
    let collapse = 1;
    for (let k = 0; k < N; k++) {
      collapse *= 2 - smoothstep(ext[k] / SEPARATION_T);
    }
    return 1 / collapse;
  }

  /**
   * 深度の正規化係数。
   *
   * 深度キューには **投影後の z** を使う。回転後の第 6 軸ではなく z を選ぶ理由は、
   * 平面 (0,5) が dimLevel>5 でしか回らないため第 6 軸座標は低次元では恒等的に 0 で、
   * 配色が凍りついてしまうから。投影後 z ならどの次元でも変化し、しかもカスケードの
   * 拡大率(= 隠れた次元での近さ)が乗った値になっている。
   *
   * 見かけの投影半径は dimLevel とともに 0.41(1D)→ 1.44(6D)と伸びるので、
   * 係数もそれに追従させてパレットのレンジを全次元で使い切る。
   */
  private depthScaleFor(dimLevel: number): number {
    return 1 / (0.3 + 0.19 * dimLevel);
  }

  /**
   * 細分点チェーンを線分ペアへ展開しつつ彩色する。
   *
   * 色 = 深度キューのパレット
   *      × extent[edgeAxis[e]](まだ伸びていない軸の辺はフェードイン途中)
   *      × ゴールドの一瞬の混色(その次元が「生まれている」最中だけ)
   */
  private scatterSegments(depthScale: number): void {
    const poly = this.polytope;
    if (poly === null || poly.edgeAxis === undefined) return;

    const edgeCount = poly.edgeCount;
    const edgeAxis = poly.edgeAxis;
    const proj = this.subProj;
    const lut = this.depthLut;
    const gold = this.goldLut;
    const pos = this.lineBatch.positions;
    const col = this.lineBatch.colors;
    const extents = this.extents;
    const bright = this.lineBrightness;

    let p = 0;
    let seg = 0;

    for (let e = 0; e < edgeCount; e++) {
      const ext = extents[edgeAxis[e]];
      // 4·e·(1−e): e=0.5 で 1、伸びきる(e=1)と 0 に戻る「誕生の閃光」
      const flash = 4 * ext * (1 - ext);
      const gain = ext * bright;

      let i0 = lutIndexOf(proj[p * 3 + 2], depthScale);
      for (let s = 0; s < SUBDIV; s++) {
        const p1 = p + 1;
        const i1 = lutIndexOf(proj[p1 * 3 + 2], depthScale);

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
        col[so] = (lut[c0] + (gold[c0] - lut[c0]) * flash) * gain;
        col[so + 1] = (lut[c0 + 1] + (gold[c0 + 1] - lut[c0 + 1]) * flash) * gain;
        col[so + 2] = (lut[c0 + 2] + (gold[c0 + 2] - lut[c0 + 2]) * flash) * gain;
        col[so + 3] = (lut[c1] + (gold[c1] - lut[c1]) * flash) * gain;
        col[so + 4] = (lut[c1 + 1] + (gold[c1 + 1] - lut[c1 + 1]) * flash) * gain;
        col[so + 5] = (lut[c1 + 2] + (gold[c1 + 2] - lut[c1 + 2]) * flash) * gain;

        i0 = i1;
        p = p1;
        seg++;
      }
      p++; // 辺の終端点を消費して次の辺の先頭へ
    }
  }

  /** 頂点グローの輝度にも同じ深度キューを載せる */
  private shadeVertices(count: number, depthScale: number): void {
    const proj = this.pointBatch.positions;
    const brights = this.pointBatch.brights;
    for (let v = 0; v < count; v++) {
      const raw = (proj[v * 3 + 2] * depthScale + 1) * 0.5;
      const t01 = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      brights[v] = 0.35 + 0.85 * t01;
    }
  }

  /**
   * カメラリグ。章 i のキーフレームへ、章の前半 50% で滑らかに寄せる。
   * 常に原点を見る + わずかなアイドルドリフト。
   * Vector3 の新規生成はしない(camera.position.set / lookAt(x,y,z) は
   * three 内部の静的テンポラリを使うのでアロケーションゼロ)。
   */
  private updateCamera(t: number): void {
    const camera = this.camera;
    if (camera === null) return;

    const index = this.director.chapterIndex;
    const to = CAMERA_KEYS[index < CAMERA_KEYS.length ? index : CAMERA_KEYS.length - 1];
    const from = index === 0 ? CAMERA_KEYS[0] : CAMERA_KEYS[index - 1];
    const b = smoothstep(this.director.localT / CAMERA_BLEND_FRACTION);

    // 縦長画面では水平方向に収まるようドリーバックする(構図の向きは変えない)
    const aspect = camera.aspect;
    const dolly =
      aspect < 1 ? Math.min(PORTRAIT_DOLLY_MAX, 1 / Math.max(aspect, PORTRAIT_ASPECT_FLOOR)) : 1;

    let x = (from.x + (to.x - from.x) * b) * dolly;
    let y = (from.y + (to.y - from.y) * b) * dolly;
    let z = (from.z + (to.z - from.z) * b) * dolly;

    if (!this.reduceMotion) {
      x += Math.sin(t * 0.3) * DRIFT_X;
      y += Math.cos(t * 0.23) * DRIFT_Y;
      z += Math.sin(t * 0.17) * DRIFT_Z;
    }

    camera.position.set(x, y, z);
    camera.lookAt(0, 0, 0);

    const fov = from.fov + (to.fov - from.fov) * b;
    if (Math.abs(camera.fov - fov) > 1e-3) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  /**
   * 深度 → 色の表(通常パレットとゴールド)。
   * polytopeExhibit と同じ調律: t = 0.15 + 0.70·t01、輝度 = 0.55 + 0.35·t01。
   * 実効輝度(密度補正)は毎フレーム変わるので LUT には焼き込まない。
   */
  private buildLuts(): void {
    const color = new THREE.Color();
    const lut = this.depthLut;
    const gold = this.goldLut;
    for (let i = 0; i < LUT_SIZE; i++) {
      const t01 = i / LUT_MAX;
      cosinePalette(0.15 + 0.7 * t01, color);
      const shade = 0.55 + 0.35 * t01;
      const o = i * 3;
      lut[o] = color.r * shade;
      lut[o + 1] = color.g * shade;
      lut[o + 2] = color.b * shade;
      gold[o] = GOLD.r * shade * GOLD_GAIN;
      gold[o + 1] = GOLD.g * shade * GOLD_GAIN;
      gold[o + 2] = GOLD.b * shade * GOLD_GAIN;
    }
  }
}
