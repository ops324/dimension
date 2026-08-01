/**
 * グラスパネルの入口(Phase 9b 以降は再エクスポートのみ)。
 *
 * 実装は `src/ui/components/controls/` の部品群へ移した(Slider / Segmented /
 * Toggle / Readout / PanelButton / Panel)。ここを 1 行の facade として残すのは、
 * **4 つの展示の import を 1 行も書き換えないため** ── Phase 9b は
 * ギャラリーの見た目と操作感の刷新であって、展示の数式・描画には触れない。
 * `createPanel(root, title)` のビルダ API は Phase 7 と完全に同一。
 */

export type {
  SliderSpec,
  SegmentedSpec,
  ToggleSpec,
  ButtonSpec,
  ReadoutSpec,
  ReadoutUpdate,
  PanelBuilder,
} from './components/controls/Panel';

export { createPanel } from './components/controls/Panel';
