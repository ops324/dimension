/**
 * SoundToggle — 音の在/不在を選ぶチップ(Phase 10)。
 *
 * 品質チップと**同じ寸法・同じヘアライン・同じ書体**で、その真下に座る
 * (品質のメニューは上へ開くので、下に置けば決して重ならない)。
 *
 * 見せているのは 2 つだけ:
 *   ◌ SOUND … 消えている
 *   ● SOUND … 鳴っている(既定)+ 3 本のバーがゆっくり上下する
 * バーは CSS アニメーションで、**ON のときだけ**動く ── OFF のあいだ、
 * この部品は 1 フレームも仕事をしない。
 *
 * 初回訪問だけ、プリローダが退いたあとに 2 回だけ小さく脈打つ。
 * Phase 19 で既定が ON になり、この脈の意味は「音を入れませんか」から
 * **「音はここで切れる」**へ変わった ── 誘いではなく出口の提示なので、
 * 既定を反転させたあとのほうがむしろ要る。一度でも自分で選んだ人には出ない。
 *
 * Phase 12b: **はじめて音を入れたときだけ**、チップの隣に一行だけ言葉を置く。
 * この空間の環境音には左右の耳でわずかに高さの違う正弦が含まれていて、
 * その拍はスピーカーでは(左右の音が空気の中で混ざってしまうので)現れない ──
 * それを伝えるためだけの一行で、6 秒で自分から消える。トグルは増やさない。
 */

import { audio, type SoundDetail } from '../../audio/engine';
import { toggleOff, toggleOn } from '../../audio/sfx';
import { DUR, EASE, h, play, prefersReducedMotion, type Component } from './component';
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

/**
 * ヘッドフォンの一行。
 *
 * **効能は書かない**。書いてよいのは「何が鳴っているか」だけである ──
 * 左右の耳にわずかに違う高さの正弦があり、その差が拍として聞こえる。
 * それがどう作用するかは書かないし、この作品は何も約束しない。
 */
const HINT_KEY = 'dimension.sound.hint';
const HINT_TEXT = 'ヘッドフォンを ── うなりは空気ではなく、耳の中で生まれる。';
/** 出したまま置く時間(ms)。読み切って、まだ少し残る長さ */
const HINT_HOLD_MS = 6000;
/** 引きの尺(ms)。急がずに消える */
const HINT_FADE_MS = 900;

/** localStorage は投げうる(プライベートモード等)。読み書きとも黙って諦める */
function hintShown(): boolean {
  try {
    return window.localStorage.getItem(HINT_KEY) !== null;
  } catch {
    // 読めない環境では「まだ出していない」として扱う(出しすぎるほうがまだ良い)
    return false;
  }
}

function markHintShown(): void {
  try {
    window.localStorage.setItem(HINT_KEY, 'shown');
  } catch {
    // 書けない環境では、このセッションのあいだだけの一度きりになる
  }
}

export class SoundToggle implements Component {
  readonly el: HTMLElement;

  private readonly chip: HTMLButtonElement;
  private readonly glyph: HTMLElement;
  private readonly magnet: Magnet;

  private observer: MutationObserver | null = null;
  private pulseTimer = 0;
  private pulse: Animation | null = null;
  private invited = false;

  /** ヘッドフォンの一行。出ているあいだだけ非 null */
  private hint: HTMLElement | null = null;
  private hintTimer = 0;
  private hintAnim: Animation | null = null;
  /** localStorage が読めない環境でも、少なくとも 1 セッションに 1 回に抑える */
  private hinted = false;

  constructor() {
    this.el = h('div', 'sound', { id: 'sound' });

    this.chip = h('button', 's-chip', {
      id: 'sound-chip',
      type: 'button',
      'data-cursor': '',
      // 混在した文字列に lang は付けられない ── 言い換えでしか直らない。
      // 可視ラベルの「SOUND」は装飾なので、名前は日本語だけで足りる
      'aria-label': '環境音',
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
    this.dropHint();
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
    // 一行を出すのは **音が実際に立ち上がった**ときだけ(enabled ではなく audible)。
    // 既定 ON になった以上、設定を見ていると初回訪問の「まだ鳴っていない」時間に
    // ヘッドフォンの話を始めてしまう ── 6 秒で消える一行なので、鳴る前に出せば
    // 鳴るころには消えている。
    if (detail?.audible === true) this.showHint();
  };

  private paint(on: boolean): void {
    this.chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    this.el.dataset.on = on ? 'true' : 'false';
    const glyph = on ? GLYPH_ON : GLYPH_OFF;
    if (this.glyph.textContent !== glyph) this.glyph.textContent = glyph;
  }

  // --- ヘッドフォンの一行 ----------------------------------------------------

  /**
   * 一生に一度だけ出る一行。**新しいトグルは作らない** ── 音を入れるという
   * 一度きりの選択に、説明をひとつ添えるだけである。
   *
   * 中身を空のまま挿してから次のフレームで文字を入れる: aria-live は
   * 「すでに在る領域の中身が変わった」ときに読まれるので、要素と文字を同時に
   * 差し込むと読み上げが落ちる支援技術がある。
   */
  private showHint(): void {
    if (this.hinted || this.hint !== null) return;
    if (hintShown()) return;
    this.hinted = true;
    markHintShown();

    const hint = h('p', 's-hint', { role: 'status', 'aria-live': 'polite' });
    this.hint = hint;
    this.el.append(hint);
    requestAnimationFrame(() => {
      hint.textContent = HINT_TEXT;
    });

    play(hint, [{ opacity: 0 }, { opacity: 1 }], {
      duration: DUR.med,
      easing: EASE.outQuint,
    });

    this.hintTimer = window.setTimeout(() => {
      this.hintTimer = 0;
      this.fadeHint();
    }, HINT_HOLD_MS);
  }

  /** 引いて、消す。消えたあとに DOM から抜くので、残骸を置いていかない */
  private fadeHint(): void {
    const hint = this.hint;
    if (hint === null) return;

    const anim = play(hint, [{ opacity: 1 }, { opacity: 0 }], {
      duration: HINT_FADE_MS,
      easing: EASE.inoutSoft,
      fill: 'forwards',
    });
    this.hintAnim = anim;
    anim.onfinish = (): void => {
      this.hintAnim = null;
      this.hint = null;
      hint.remove();
    };
  }

  /** 畳む(destroy から)。待ちも animation も残さない */
  private dropHint(): void {
    if (this.hintTimer !== 0) {
      window.clearTimeout(this.hintTimer);
      this.hintTimer = 0;
    }
    if (this.hintAnim !== null) {
      this.hintAnim.onfinish = null;
      this.hintAnim.cancel();
      this.hintAnim = null;
    }
    this.hint?.remove();
    this.hint = null;
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
