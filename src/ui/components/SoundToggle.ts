/**
 * SoundToggle — 音の在/不在を選ぶチップ(Phase 10)。
 *
 * 品質チップと**同じ寸法・同じヘアライン・同じ書体**で、その真下に座る
 * (品質のメニューは上へ開くので、下に置けば決して重ならない)。
 *
 * 見せているのは 2 つだけ:
 *   ◌ SOUND … 消えている(既定)
 *   ● SOUND … 鳴っている + 3 本のバーがゆっくり上下する
 * バーは CSS アニメーションで、**ON のときだけ**動く ── OFF のあいだ、
 * この部品は 1 フレームも仕事をしない。
 *
 * 初回訪問だけ、プリローダが退いたあとに 2 回だけ小さく脈打つ。
 * 誘いであって催促ではないので、一度でも設定を選んだ人には二度と出ない。
 */

import { audio, type SoundDetail } from '../../audio/engine';
import { toggleOff, toggleOn } from '../../audio/sfx';
import { EASE, h, prefersReducedMotion, type Component } from './component';
import { magnetize, type Magnet } from './MagneticButton';

/** 消えている / 鳴っている の記号 */
const GLYPH_OFF = '◌';
const GLYPH_ON = '●';

/** 誘いの脈。1 拍 700ms を 2 回 */
const PULSE_MS = 700;
const PULSE_COUNT = 2;
const PULSE_SCALE = 1.06;
/** プリローダが退かなかった場合の保険(ms) */
const PULSE_FALLBACK_MS = 3500;
/** プリローダが消えてから脈打つまでの間(ms)。星空が見えてから誘う */
const PULSE_DELAY_MS = 900;

export class SoundToggle implements Component {
  readonly el: HTMLElement;

  private readonly chip: HTMLButtonElement;
  private readonly glyph: HTMLElement;
  private readonly magnet: Magnet;

  private observer: MutationObserver | null = null;
  private pulseTimer = 0;
  private pulse: Animation | null = null;
  private invited = false;

  constructor() {
    this.el = h('div', 'sound', { id: 'sound' });

    this.chip = h('button', 's-chip', {
      id: 'sound-chip',
      type: 'button',
      'data-cursor': '',
      'aria-label': '環境音 SOUND',
      'aria-pressed': 'false',
    });

    this.glyph = h('span', 's-chip-glyph', { 'aria-hidden': 'true', text: GLYPH_OFF });
    const bars = h('span', 's-bars', { 'aria-hidden': 'true' });
    bars.append(h('span', 's-bar'), h('span', 's-bar'), h('span', 's-bar'));

    this.chip.append(this.glyph, h('span', 's-chip-label', { text: 'SOUND' }), bars);
    this.el.append(this.chip);

    this.chip.addEventListener('click', this.onClick);
    window.addEventListener('dimension:sound', this.onSoundEvent);

    // 品質チップの位置(1 段上)は、このチップが在るときだけ変わる
    this.magnet = magnetize(this.chip, { radius: 60, max: 5, labelMax: 7 });
  }

  mount(parent: HTMLElement): void {
    parent.append(this.el);
    document.body.classList.add('has-sound');
    this.paint(audio.enabled);
    if (!audio.hasPreference) this.armInvitation();
  }

  destroy(): void {
    this.cancelInvitation();
    this.magnet.destroy();
    this.chip.removeEventListener('click', this.onClick);
    window.removeEventListener('dimension:sound', this.onSoundEvent);
    document.body.classList.remove('has-sound');
    this.el.remove();
  }

  // --- 操作 ------------------------------------------------------------------

  /**
   * ON にするときは **有効化してから**確認音を鳴らす(押した手が音で返ってくる)。
   * OFF にするときは **フェードが始まる前に**鳴らす ── 順が逆だと、
   * 引きはじめた master の底で確認音が消えてしまう。
   */
  private readonly onClick = (): void => {
    this.cancelInvitation();
    const next = !audio.enabled;
    if (next) {
      audio.setEnabled(true);
      toggleOn();
    } else {
      toggleOff();
      audio.setEnabled(false);
    }
  };

  private readonly onSoundEvent = (event: Event): void => {
    const detail = (event as CustomEvent<SoundDetail>).detail;
    this.paint(detail?.enabled === true);
  };

  private paint(on: boolean): void {
    this.chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    this.el.dataset.on = on ? 'true' : 'false';
    const glyph = on ? GLYPH_ON : GLYPH_OFF;
    if (this.glyph.textContent !== glyph) this.glyph.textContent = glyph;
  }

  // --- 初回訪問の誘い --------------------------------------------------------

  /** プリローダが DOM から消えたら(= 作品が見えたら)脈を打つ */
  private armInvitation(): void {
    if (this.invited || prefersReducedMotion()) return;

    if (document.querySelector('.pl') === null) {
      this.scheduleInvitation();
      return;
    }

    this.observer = new MutationObserver(() => {
      if (document.querySelector('.pl') !== null) return;
      this.observer?.disconnect();
      this.observer = null;
      this.scheduleInvitation();
    });
    this.observer.observe(document.body, { childList: true });

    // プリローダが退かない事故でも、誘いが永久に来ないことはない
    this.pulseTimer = window.setTimeout(() => this.scheduleInvitation(), PULSE_FALLBACK_MS);
  }

  private scheduleInvitation(): void {
    if (this.invited) return;
    if (this.pulseTimer !== 0) window.clearTimeout(this.pulseTimer);
    this.pulseTimer = window.setTimeout(() => {
      this.pulseTimer = 0;
      this.invite();
    }, PULSE_DELAY_MS);
  }

  private invite(): void {
    // 待っているあいだに自分で選んだ人には、もう誘わない
    if (this.invited || audio.hasPreference || prefersReducedMotion()) return;
    this.invited = true;
    this.pulse = this.chip.animate([{ scale: 1 }, { scale: PULSE_SCALE }, { scale: 1 }], {
      duration: PULSE_MS,
      iterations: PULSE_COUNT,
      easing: EASE.inoutSoft,
    });
  }

  private cancelInvitation(): void {
    this.invited = true;
    if (this.pulseTimer !== 0) {
      window.clearTimeout(this.pulseTimer);
      this.pulseTimer = 0;
    }
    this.observer?.disconnect();
    this.observer = null;
    this.pulse?.cancel();
    this.pulse = null;
  }
}

/** 器を作って body へ載せる。音を出せない環境ではチップも出さない */
export function createSoundToggle(parent: HTMLElement): SoundToggle | null {
  if (!audio.available) return null;
  const toggle = new SoundToggle();
  toggle.mount(parent);
  return toggle;
}
