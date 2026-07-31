import type * as THREE from 'three';
import type { Engine } from '../core/engine';

/** 展示が init 時に受け取る共有リソース(プラン3節: renderer/composer/camera は 1 つだけ) */
export interface EngineCtx {
  engine: Engine;
}

/**
 * ギャラリー展示の共通インターフェース。
 *
 * ライフサイクル:
 *   init(ctx) … 遅延・一度だけ。バッファ確保とシーン構築はここで完結させる
 *   enter()   … 表示へ切り替わる直前。reveal のリセット等
 *   update()  … 毎フレーム。アロケーション禁止
 *   exit()    … 非表示へ。シーンは破棄せず保持する(再入場を即時にするため)
 *   buildPanel(root) … 制御パネルの DOM を root へ構築(Phase 7 の gallery が呼ぶ)
 */
export interface Exhibit {
  readonly id: string;
  /** この展示専用のシーン。engine.setScene() で差し替えて使う */
  readonly scene: THREE.Scene;
  init(ctx: EngineCtx): void;
  enter(): void;
  update(dt: number, t: number): void;
  exit(): void;
  buildPanel(root: HTMLElement): void;
}
