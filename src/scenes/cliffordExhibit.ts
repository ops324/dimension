import * as THREE from 'three';

import { expSmooth } from '../math/ease';
import type { PlaneRotation } from '../math/rotation';
import { Line4DBatch } from '../render/line4d';
import { cosinePalette } from '../render/palette';
import { createPanel } from '../ui/panel';
import type { EngineCtx, Exhibit } from './exhibit';

export interface CliffordParams {
  /** u 方向の分割数 = v 円(u 固定)の本数 */
  gridU: number;
  /** v 方向の分割数 = u 円(v 固定)の本数 */
  gridV: number;
  /** 等傾二重回転(ω2 = ω1)。トーラスは変形せず自身に沿って流れるだけになる */
  isoclinic: boolean;
  /** 平面 (0,1) の角速度 */
  omega1: number;
  /** 平面 (2,3) の角速度(isoclinic 時は無視され ω1 が使われる) */
  omega2: number;
  /** 平面 (0,3) の歳差角速度。裏返りを起こす唯一の回転(下記 PRECESSION の注を参照) */
  precession: number;
}

/** 円 1 本あたりの線分数(= 円周の径数化点数) */
const SEGMENTS = 160;
/** 片族あたりの円の本数上限 */
const MAX_GRID = 64;
/** 2 族 × MAX_GRID 本 × SEGMENTS 線分 */
const MAX_SEGMENTS = 2 * MAX_GRID * SEGMENTS;

/**
 * 彩色: 2 つの族が一目で区別できることが最優先。コサインパレットを
 * 前半(深い青→シアン)と後半(バイオレット→マゼンタ)に割り当て、
 * 族内では固定角(v₀ / u₀)でパレットを走らせて格子の位相を読ませる。
 */
const PAL_U_START = 0.05;
const PAL_U_END = 0.45;
const PAL_V_START = 0.55;
const PAL_V_END = 0.95;

/**
 * 白飛びしない基礎輝度(既知の罠 #6)。トーラス面上の格子は Hopf 束ほど
 * 視線方向に積み上がらない(1 本の視線が横切るのは概ね数本)ので、Hopf の
 * 0.21 より強めに取れる。
 */
const BASE_BRIGHTNESS = 0.3;
/** この本数を基準に、増やしたぶんだけ族ごとに減光する */
const DENSITY_REFERENCE = 48;
const DENSITY_EXPONENT = 0.7;

/**
 * 投影極(w→1)を跨ぐ線分の巨大化を縮退させる閾値(ワールド単位)。
 * 通常時の線分長は 0.1 未満なので、実質「極の直上だけ」に効く。
 */
const MAX_SEGMENT_LENGTH = 6;

const REVEAL_RATE = 7;

const TWO_PI = Math.PI * 2;
/** クリフォードトーラスの半径 1/√2(両平面に等しく配分すると ‖p‖ = 1) */
const INV_SQRT2 = Math.SQRT1_2;

/**
 * クリフォードトーラス展示。
 *
 * クリフォードトーラス {(cos u, sin u, cos v, sin v)/√2} は S³ 上の**平坦な**
 * トーラスであり、S³ を合同な 2 つの中身の詰まったトーラスに二等分する境界面。
 * ここではその 2 つの径数円族(v 固定の u 円 / u 固定の v 円)を S³ 上の円の
 * まま GPU へ置き(Line4DBatch)、SO(4) 回転とステレオ投影を頂点シェーダーで行う。
 *
 * 静止時の投影像は R = √2 / r = 1 の輪環面(半径 ~2.41 に収まる)。
 * 歳差平面がトーラスを投影極へ近づけると像は無限へ膨張し、極を通過した瞬間に
 * 内と外が入れ替わる ── これがこの展示の見せ場(プランの Phase 5 検証項目
 * 「トーラスが自身を通り抜けて裏返る二重回転」)。
 */
export class CliffordExhibit implements Exhibit {
  readonly id = 'clifford';
  readonly scene: THREE.Scene;
  readonly params: CliffordParams;

  private batch!: Line4DBatch;
  private readonly group = new THREE.Group();

  /** 円 1 本分の 4D 点列の作業領域(init 以降アロケーションしない) */
  private readonly circleScratch = new Float64Array(SEGMENTS * 4);
  private readonly scratchColor = new THREE.Color();

  /**
   * 回転平面: (0,1)/(2,3) の二重回転 + (0,3) の歳差。
   *
   * **平面 (0,3) を選んだ理由(重要)**: 二重回転 (0,1)+(2,3) 単体では、
   * u 円は u 円へ・v 円は v 円へ写るだけで**像の集合は不変**(トーラスは自身に
   * 沿って流れるが形は変わらない)。形を変えるには u 側の座標と v 側の座標を
   * 混ぜる歳差が要る。ここで歳差平面の選び方が決定的になる:
   *
   *   composeRot4 の適用順は v ← G₂G₁G₀v なので、最後に掛かる歳差の平面が
   *   w(= 座標 3)成分を作れるかどうかで結果が変わる。
   *   ・平面 (0,2) … 座標 3 に触れないため w = sin(v+β)/√2 のままで |w| ≤ 0.707。
   *     投影極には**決して到達せず**、像は常に半径 2.41 以内の埋め込みトーラス
   *     (メビウス変換されたデュパンのサイクライド)。傾くだけで裏返らない。
   *   ・平面 (0,3) … w = (sinγ·cos(u+α) + cosγ·sin(v+β))/√2 となり、
   *     最大値は cos(γ − π/4)。γ = π/4 で **w = 1**(投影極)に接する。
   *     その前後で像は無限へ膨れ上がり、通過後に内外が反転する。
   *
   * 既定 precession = 0.05 では γ = π/4 が t ≈ 15.7 秒。t ≈ 9〜22 秒が
   * 膨張〜反転の見せ場になる(w > 0.95 で像の最大半径 > 6)。
   */
  private readonly rots: PlaneRotation[] = [
    { i: 0, j: 1, angle: 0 },
    { i: 2, j: 3, angle: 0 },
    { i: 0, j: 3, angle: 0 },
  ];

  private circleTotal = 0;
  private segmentTotal = 0;
  private reveal = 0;
  private revealTarget = 1;
  private initialized = false;

  constructor(params?: Partial<CliffordParams>) {
    this.scene = new THREE.Scene();
    this.scene.name = 'cliffordScene';
    // 黒への指数フォグ = 加算合成における距離減衰。極へ近づいて遠方へ伸びた
    // 部分を自然に減衰させ、手前の格子が読めるようにする
    this.scene.fog = new THREE.FogExp2(0x000000, 0.08);
    this.group.name = 'clifford';
    this.scene.add(this.group);

    this.params = {
      gridU: params?.gridU ?? 36,
      gridV: params?.gridV ?? 36,
      // 非等傾が既定: ω1 ≠ ω2 だと 2 族の流れる速さが食い違い、面が自身の
      // 上を滑っていることが色の位相差として見える
      isoclinic: params?.isoclinic ?? false,
      omega1: params?.omega1 ?? 0.22,
      omega2: params?.omega2 ?? 0.13,
      precession: params?.precession ?? 0.05,
    };
  }

  init(ctx: EngineCtx): void {
    if (this.initialized) return;

    this.batch = new Line4DBatch(MAX_SEGMENTS, {
      linewidth: 1.8,
      maxSegmentLength: MAX_SEGMENT_LENGTH,
      fog: true,
    });
    ctx.engine.registerLineMaterial(this.batch.material);
    this.group.add(this.batch.object);

    this.initialized = true;
    this.rebuild();

    console.info(
      `[clifford] gpuPath=${this.batch.gpuPath} circles=${this.circleTotal} ` +
        `(u:${this.params.gridV} + v:${this.params.gridU}) ` +
        `segments=${this.segmentTotal} (${SEGMENTS}/circle)`,
    );
  }

  enter(): void {
    this.reveal = 0;
    this.revealTarget = 1;
  }

  exit(): void {
    this.revealTarget = 0;
  }

  /**
   * 制御パネル(Phase 7)。u/v の格子密度は族ごとに独立で調整できる ──
   * 片方だけを密にすると、二つの円族が別のものであることが一目で分かる。
   */
  buildPanel(root: HTMLElement): void {
    const p = this.params;
    const panel = createPanel(root, 'CLIFFORD TORUS');

    panel.slider({
      label: 'GRID U / u 円の本数',
      min: 12,
      max: MAX_GRID,
      step: 4,
      value: p.gridU,
      onInput: (v) => this.setGrid(v, p.gridV),
    });

    panel.slider({
      label: 'GRID V / v 円の本数',
      min: 12,
      max: MAX_GRID,
      step: 4,
      value: p.gridV,
      onInput: (v) => this.setGrid(p.gridU, v),
    });

    panel.divider();

    panel.toggle({
      label: 'ISOCLINIC / 等傾回転',
      value: p.isoclinic,
      onChange: (v) => {
        p.isoclinic = v;
        panel.setDisabled('omega2', v);
      },
    });

    panel.slider({
      label: 'ω₁ / 平面 (0,1)',
      min: 0,
      max: 0.6,
      step: 0.01,
      value: p.omega1,
      format: (v) => v.toFixed(2),
      onInput: (v) => {
        p.omega1 = v;
      },
    });

    panel.slider({
      key: 'omega2',
      label: 'ω₂ / 平面 (2,3)',
      min: 0,
      max: 0.6,
      step: 0.01,
      value: p.omega2,
      format: (v) => v.toFixed(2),
      disabled: p.isoclinic,
      onInput: (v) => {
        p.omega2 = v;
      },
    });

    panel.slider({
      label: 'PRECESSION / 歳差 (0,3)',
      min: 0,
      max: 0.15,
      step: 0.005,
      value: p.precession,
      format: (v) => v.toFixed(3),
      onInput: (v) => {
        p.precession = v;
      },
    });

    panel.note(
      '歳差角 γ = π/4 の付近でトーラスは投影の極を跨ぐ ── ' +
        '像は無限へ膨れ上がり、通過した瞬間に内と外が入れ替わって裏返る。',
    );
  }

  /** 格子密度の変更。ジオメトリを作り直して一括アップロードする */
  setGrid(gridU: number, gridV?: number): void {
    this.params.gridU = gridU;
    this.params.gridV = gridV ?? gridU;
    if (this.initialized) this.rebuild();
  }

  update(dt: number, t: number): void {
    if (!this.initialized) return;

    if (this.reveal !== this.revealTarget) {
      this.reveal = expSmooth(this.reveal, this.revealTarget, REVEAL_RATE, dt);
      if (Math.abs(this.revealTarget - this.reveal) < 0.002) this.reveal = this.revealTarget;
      this.batch.setReveal(this.reveal);
    }

    const p = this.params;
    // 角度は絶対時刻から(ドリフトなし)
    this.rots[0].angle = p.omega1 * t;
    this.rots[1].angle = (p.isoclinic ? p.omega1 : p.omega2) * t;
    this.rots[2].angle = p.precession * t;
    this.batch.setRotation(this.rots);
  }

  dispose(): void {
    this.batch?.dispose();
  }

  // --- 内部 ------------------------------------------------------------------

  /**
   * 2 つの円族を生成 → 線分展開 → 彩色 → 一括アップロード。
   * 格子密度の変更時のみ走る(毎フレームではない)。
   */
  private rebuild(): void {
    const p = this.params;
    const gridU = clampGrid(p.gridU);
    const gridV = clampGrid(p.gridV);
    p.gridU = gridU;
    p.gridV = gridV;

    const color = this.scratchColor;
    // 密度補正は族ごと(片方だけ密にしても輝度バランスが崩れないように)
    const lumU = BASE_BRIGHTNESS * densityFactor(gridV);
    const lumV = BASE_BRIGHTNESS * densityFactor(gridU);

    let seg = 0;

    // u 円(v = v₀ 固定): (cos u, sin u, cos v₀, sin v₀)/√2 を gridV 本
    for (let iv = 0; iv < gridV; iv++) {
      const v0 = (TWO_PI * iv) / gridV;
      this.fillCircle(v0, false);
      cosinePalette(PAL_U_START + (PAL_U_END - PAL_U_START) * (iv / gridV), color);
      seg = this.emitLoop(seg, color, lumU);
    }

    // v 円(u = u₀ 固定): (cos u₀, sin u₀, cos v, sin v)/√2 を gridU 本
    for (let iu = 0; iu < gridU; iu++) {
      const u0 = (TWO_PI * iu) / gridU;
      this.fillCircle(u0, true);
      cosinePalette(PAL_V_START + (PAL_V_END - PAL_V_START) * (iu / gridU), color);
      seg = this.emitLoop(seg, color, lumV);
    }

    this.circleTotal = gridU + gridV;
    this.segmentTotal = seg;
    this.batch.commitData(seg);
    this.batch.setReveal(this.reveal);
  }

  /**
   * 円 1 本を作業領域へ書く。
   * `fixedFirst = false`: v₀ を固定した u 円(動くのは座標 0,1)
   * `fixedFirst = true` : u₀ を固定した v 円(動くのは座標 2,3)
   * どちらも ‖p‖² = 1/2 + 1/2 = 1 ── S³ 上の大円ではない「平坦な」円。
   */
  private fillCircle(fixed: number, fixedFirst: boolean): void {
    const s = this.circleScratch;
    const a = Math.cos(fixed) * INV_SQRT2;
    const b = Math.sin(fixed) * INV_SQRT2;
    const step = TWO_PI / SEGMENTS;

    for (let k = 0; k < SEGMENTS; k++) {
      const angle = k * step;
      const c = Math.cos(angle) * INV_SQRT2;
      const d = Math.sin(angle) * INV_SQRT2;
      const o = k * 4;
      if (fixedFirst) {
        s[o] = a;
        s[o + 1] = b;
        s[o + 2] = c;
        s[o + 3] = d;
      } else {
        s[o] = c;
        s[o + 1] = d;
        s[o + 2] = a;
        s[o + 3] = b;
      }
    }
  }

  /**
   * 作業領域の点列を閉ループの線分列として data4/colors へ展開する。
   * 戻り値は次の書き込み開始位置(線分インデックス)。
   */
  private emitLoop(segBase: number, color: THREE.Color, lum: number): number {
    const data4 = this.batch.data4;
    const colors = this.batch.colors;
    const s = this.circleScratch;
    const r = color.r * lum;
    const g = color.g * lum;
    const b = color.b * lum;

    for (let k = 0; k < SEGMENTS; k++) {
      const sIdx = k * 4;
      const eIdx = ((k + 1) % SEGMENTS) * 4; // 閉ループ
      const o = (segBase + k) * 8;
      data4[o] = s[sIdx];
      data4[o + 1] = s[sIdx + 1];
      data4[o + 2] = s[sIdx + 2];
      data4[o + 3] = s[sIdx + 3];
      data4[o + 4] = s[eIdx];
      data4[o + 5] = s[eIdx + 1];
      data4[o + 6] = s[eIdx + 2];
      data4[o + 7] = s[eIdx + 3];

      const co = (segBase + k) * 6;
      colors[co] = r;
      colors[co + 1] = g;
      colors[co + 2] = b;
      colors[co + 3] = r;
      colors[co + 4] = g;
      colors[co + 5] = b;
    }

    return segBase + SEGMENTS;
  }
}

function clampGrid(value: number): number {
  const n = Math.round(value);
  if (!(n > 1)) return 2;
  return n > MAX_GRID ? MAX_GRID : n;
}

/** 本数を増やしたときの減光。基準本数以下では 1(暗くしない) */
function densityFactor(count: number): number {
  return Math.min(1, (DENSITY_REFERENCE / count) ** DENSITY_EXPONENT);
}
