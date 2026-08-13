import * as THREE from 'three';

import { expSmooth } from '../math/ease';
import type { PlaneRotation } from '../math/rotation';
import {
  baseFibonacci,
  baseGreatCircle,
  baseLatitudeRingsWeighted,
  hopfFiber,
} from '../math/hopf';
import { Line4DBatch } from '../render/line4d';
import { cosinePalette } from '../render/palette';
import { createPanel } from '../ui/panel';
import type { EngineCtx, Exhibit } from './exhibit';

export type HopfDistribution = 'rings' | 'great' | 'fibonacci';

export interface HopfParams {
  /** ファイバー本数(rings 分布では リング数×リング内本数 に丸められる) */
  fiberCount: number;
  distribution: HopfDistribution;
  /** 等傾二重回転(ω2 = ω1)。S³ が剛体のように流れる古典の絵になる */
  isoclinic: boolean;
  /** 平面 (0,1) の角速度 */
  omega1: number;
  /** 平面 (2,3) の角速度(isoclinic 時は無視され ω1 が使われる) */
  omega2: number;
  /** 基底球の歳差(平面 (0,2))の角速度。0 で純粋な等傾回転 */
  precession: number;
  /** great 分布の大円の傾き */
  tilt: number;
}

/** ファイバー1本あたりの線分数(= 円の径数化点数)。ULTRA 既定 */
const SEGMENTS = 192;
const MAX_FIBERS = 1200;
const MAX_SEGMENTS = MAX_FIBERS * SEGMENTS;

/** rings 分布のリング内本数(リング数は fiberCount から導出) */
const PER_RING = 24;

/**
 * 加算合成の密度補正。ファイバーはトーラス面上に分布するため重なりは
 * 多胞体の中心集中より穏やかで、辺数線形(polytope の 1/edgeCount)ほど
 * 強い補正は不要。実測ベースで 1/√(count/REF) に緩める。
 */
const DENSITY_REFERENCE_FIBERS = 240;
/**
 * 白飛びしない基礎輝度(既知の罠 #6)。
 * トーラス束の中心軸方向は視線が数十本のファイバーを掠めるため加算が
 * 積み上がる(≈2×リング数の交差)。1 本あたり ~0.1 前後に抑えると
 * 中心は「熱いコア」として残りつつ純白飽和しない — 実測で決めた値。
 * Phase 11: 0.21 → 0.25。ブルーム強度を 0.95 → 0.40 へ落としたぶん、
 * 芯のピーク輝度を線そのもので取り戻す(にじみで稼がない)。
 */
const BASE_BRIGHTNESS = 0.25;
/** 本数増加時の減光指数(1/√ では 600 本時にまだ飽和した — 実測) */
const DENSITY_EXPONENT = 0.7;

/** 極付近を通るファイバーの巨大線分を縮退させる距離閾値(ワールド単位) */
const MAX_SEGMENT_LENGTH = 6;

const REVEAL_RATE = 7;

/**
 * ホップ・ファイブレーション展示 — 本サイトの芸術的中核。
 *
 * S³ を満たすファイバー円の族をステレオ投影した「入れ子のトーラスを巡る光の輪」。
 * ジオメトリは S³ 上の 4D 座標のまま GPU に置かれ(Line4DBatch)、毎フレームの
 * 回転は SO(4) 行列 uniform の合成だけで完結する。CPU は毎フレーム
 * 4×4 行列ひとつを作るのみ — 1200 本 × 192 線分でも回転は GPU が担う。
 */
export class HopfExhibit implements Exhibit {
  readonly id = 'hopf';
  readonly scene: THREE.Scene;
  readonly params: HopfParams;

  private batch!: Line4DBatch;
  private readonly group = new THREE.Group();

  /** 分布の基点 (θ,φ) の作業領域 */
  private readonly basePoints = new Float64Array(MAX_FIBERS * 2);
  /** ファイバー1本分の 4D 点列の作業領域 */
  private readonly fiberScratch = new Float64Array(SEGMENTS * 4);
  private readonly scratchColor = new THREE.Color();

  /** 回転平面: (0,1) / (2,3) の二重回転 + (0,2) の歳差 */
  private readonly rots: PlaneRotation[] = [
    { i: 0, j: 1, angle: 0 },
    { i: 2, j: 3, angle: 0 },
    { i: 0, j: 2, angle: 0 },
  ];

  private fiberTotal = 0;
  private reveal = 0;
  private revealTarget = 1;
  private initialized = false;

  constructor(params?: Partial<HopfParams>) {
    this.scene = new THREE.Scene();
    this.scene.name = 'hopfScene';
    // 黒への指数フォグ = 加算合成における距離減衰。束の裏側の積み上げを抑え、
    // 手前のファイバーが立ち上がる奥行きを作る(中心飽和対策の本命 — 実測)。
    // Phase 11: 0.09 → 0.11。**フォグは veil を減らす**(直感に反するが実測)──
    // 遠方のジオメトリをブルームへ入る前に減衰させるので、にじみの原料が減る。
    this.scene.fog = new THREE.FogExp2(0x000000, 0.11);
    this.group.name = 'hopf';
    this.scene.add(this.group);

    this.params = {
      fiberCount: params?.fiberCount ?? 600,
      distribution: params?.distribution ?? 'rings',
      isoclinic: params?.isoclinic ?? true,
      omega1: params?.omega1 ?? 0.25,
      omega2: params?.omega2 ?? 0.16,
      precession: params?.precession ?? 0.07,
      tilt: params?.tilt ?? 0.6,
    };
  }

  init(ctx: EngineCtx): void {
    if (this.initialized) return;

    this.batch = new Line4DBatch(MAX_SEGMENTS, {
      linewidth: 1.7,
      maxSegmentLength: MAX_SEGMENT_LENGTH,
      fog: true,
    });
    ctx.engine.registerLineMaterial(this.batch.material);
    this.group.add(this.batch.object);

    this.initialized = true;
    this.rebuild();

    console.info(
      `[hopf] gpuPath=${this.batch.gpuPath} fibers=${this.fiberTotal} ` +
        `segments=${this.fiberTotal * SEGMENTS} (${SEGMENTS}/fiber)`,
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
   * 制御パネル(Phase 7)。ω₂ は等傾回転のとき ω₁ に置き換わるので、
   * トグルに連動して**無効状態を視覚的にも見せる**(値は残す = 解除で戻る)。
   */
  buildPanel(root: HTMLElement): void {
    const p = this.params;
    const panel = createPanel(root, 'HOPF FIBRATION');

    panel.slider({
      label: 'FIBERS / ファイバー数',
      min: 24,
      max: MAX_FIBERS,
      step: 12,
      value: p.fiberCount,
      onInput: (v) => this.setDistribution(p.distribution, v),
    });

    panel.segmented({
      label: 'DISTRIBUTION / 分布',
      options: [
        ['rings', '緯線'],
        ['great', '大円'],
        ['fibonacci', 'フィボナッチ'],
      ],
      value: p.distribution,
      onSelect: (v) => this.setDistribution(v as HopfDistribution, p.fiberCount),
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
      label: 'PRECESSION / 歳差',
      min: 0,
      max: 0.2,
      step: 0.005,
      value: p.precession,
      format: (v) => v.toFixed(3),
      onInput: (v) => {
        p.precession = v;
      },
    });

    panel.note(
      '画面を横切る巨大な線になりかけた輪だけ、そっと消している。' +
        '極のそばの「途切れ」はその跡 ── 地図の端では、いつも何かがはみ出す。',
    );
  }

  /** 分布・本数の変更。ジオメトリを作り直して一括アップロードする */
  setDistribution(distribution: HopfDistribution, fiberCount?: number): void {
    this.params.distribution = distribution;
    if (fiberCount !== undefined) this.params.fiberCount = fiberCount;
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
    // 角度は絶対時刻から(ドリフトなし)。等傾時は両平面の角が厳密に一致する
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
   * 基点分布 → ファイバー生成 → 線分展開 → 彩色 → 一括アップロード。
   * 分布・本数の変更時のみ走る(毎フレームではない)。
   */
  private rebuild(): void {
    const p = this.params;
    const requested = Math.max(1, Math.min(MAX_FIBERS, Math.round(p.fiberCount)));

    let count: number;
    switch (p.distribution) {
      case 'rings': {
        // 面積重み付き(perRing ∝ sinθ)。小 θ リングの同一円重なりによる
        // 白飛びを構造的に防ぐ(等本数リングは加算合成で飽和した — 実測)。
        // θ 範囲は既定より狭める: 極寄りの巨大ファイバー(半径 ~11)が構図を
        // 支配し、肝心の入れ子トーラス(半径 1〜4)が潰れるため(実測)
        const rings = Math.max(2, Math.round(requested / PER_RING));
        count = baseLatitudeRingsWeighted(rings, requested, this.basePoints, 0.3, 2.45);
        break;
      }
      case 'great':
        count = baseGreatCircle(requested, p.tilt, this.basePoints);
        break;
      case 'fibonacci':
        count = baseFibonacci(requested, this.basePoints);
        break;
    }
    count = Math.min(count, MAX_FIBERS);
    this.fiberTotal = count;

    const data4 = this.batch.data4;
    const colors = this.batch.colors;
    const scratch = this.fiberScratch;
    const color = this.scratchColor;
    const density = Math.min(1, (DENSITY_REFERENCE_FIBERS / count) ** DENSITY_EXPONENT);
    const brightness = BASE_BRIGHTNESS * density;
    const TWO_PI = Math.PI * 2;

    for (let f = 0; f < count; f++) {
      const theta = this.basePoints[f * 2];
      const phi = this.basePoints[f * 2 + 1];
      hopfFiber(theta, phi, SEGMENTS, scratch);

      // 彩色: 経度 φ でパレットを回し、緯度 θ で輝度を変える(赤道が最も明るい)。
      // ファイバー内では一定 — ファイバーが「1 本の光の輪」として読めることが優先。
      // sinθ の寄与を大きめに取り、コア円(θ小)への集中発光を抑える
      const tPal = ((phi / TWO_PI) % 1 + 1) % 1;
      cosinePalette(tPal, color);
      const lum = brightness * (0.2 + 0.8 * Math.sin(theta));

      const segBase = f * SEGMENTS;
      for (let k = 0; k < SEGMENTS; k++) {
        const sIdx = k * 4;
        const eIdx = ((k + 1) % SEGMENTS) * 4;
        const o = (segBase + k) * 8;
        data4[o] = scratch[sIdx];
        data4[o + 1] = scratch[sIdx + 1];
        data4[o + 2] = scratch[sIdx + 2];
        data4[o + 3] = scratch[sIdx + 3];
        data4[o + 4] = scratch[eIdx];
        data4[o + 5] = scratch[eIdx + 1];
        data4[o + 6] = scratch[eIdx + 2];
        data4[o + 7] = scratch[eIdx + 3];

        const co = (segBase + k) * 6;
        colors[co] = color.r * lum;
        colors[co + 1] = color.g * lum;
        colors[co + 2] = color.b * lum;
        colors[co + 3] = color.r * lum;
        colors[co + 4] = color.g * lum;
        colors[co + 5] = color.b * lum;
      }
    }

    this.batch.commitData(count * SEGMENTS);
    this.batch.setReveal(this.reveal);
  }
}
