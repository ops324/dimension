import { clamp } from '../math/ease';
import { ARROW_STEP } from './scrollGlide';

/**
 * 階段(Phase 34e)── スクロールの**死んだ区間を、入力 1 段ぶんに畳む**。
 *
 * ## なぜ磁力ではないのか
 *
 * 最初の案は soft snap(近くの段へ引く磁力)だった。独立監査が 3 つの理由で潰した。
 *
 * 1. **ビューポート依存**。段を localT で定義すると、そこから文字の退場点までの
 *    距離が画面高に比例する。「1 ノッチで図だけになる」は h ≤ 757.6px でしか
 *    成り立たない。段は localT ではなく **px** で置かなければならない。
 * 2. **磁力は微調整を打ち消す**。効いていると感じられるだけ強い磁力は、
 *    微調整を取り消すだけ強い。取り消さないほど弱い磁力は、効いていると感じられない。
 * 3. **作品が二度拒否した「時計」を持ち込む**。SPEC §5.5 は波面について
 *    「時間軸を持たせない」、昇華について「駆動は終章の localT ただ 1 つで、
 *    時計を持たない」と書いている。磁力は scrollY を「入力が止まってからの
 *    経過時間」の関数にする ── localT に時計を与えることになる。
 *
 * ## 代わりにすること
 *
 * **力を加えない。変えるのは「入力が目標をどこへ運ぶか」だけ。**
 * 入力が無ければ 1 バイトも書かないので、`settled` 契約(SPEC §6.2)が無傷のまま
 * 残る ── 初回ロード・ギャラリー復元・タッチのネイティブ慣性・履歴復元・
 * `prefers-reduced-motion` は、すべて今日のままである。
 *
 * ## 段の置き方
 *
 * ```
 * ┌── 章(踏み面・連続)──────────────┬── 踊り場(蹴上げ)──┬── 次の章 ──
 * │ localT 0 ── 0.4 ── 0.5 ──── 0.86  │                   │
 * │ 次元が伸びる  カメラ  文字が退く    │  ● 図だけ         │
 * │ ← 自由にスクラブ →  ● 読む位置    │                   │
 * └───────────────────────────────────┴───────────────────┴────────────
 * ```
 *
 * - **踏み面**は章の頭から「読む位置」まで。波面のピーク(localT 0.20)も
 *   めまいも自由に止められる ── README の「第四章で立ち止まれば」は無傷。
 * - **読む位置**は文字の退場点から `ARROW_STEP` 手前。ここに立てば
 *   **↓ 1 打鍵でもホイール 1 ノッチでも、必ず文字が退く** = 「微調整で図のみ」。
 *   同時に、退場点の手前で必ず駐まるので**振り付け(1.29 秒)が完成する**
 *   ── いまは 768px を 1.29 秒以内に通過すると `cancelAll` が
 *   組み上がりかけの文字を殺していた。
 * - **踊り場**は文字が退いてから次章の文字が立つまでの約 124svh。そこでは
 *   スクロールが図に対して何もしない(SPEC §5.5: 章の 27% しか生きていない)。
 *   着地点を 1 つだけ置くことで、**死んだ 124svh が 1 段になる**。
 */

/**
 * 1 段抜けるのに要する入力量(px)。`ARROW_STEP` と同じにしてあるので、
 * **↓ 1 打鍵がちょうど 1 段**になる(ホイール 1 ノッチ 100px なら余りは持ち越す)。
 */
export const DETENT_RELEASE = ARROW_STEP;

/**
 * 終章の段。`dissolveAmount` の `smoothstep` が 1 に達する点で、
 * **導関数がちょうど 0 になる**位置でもある ── 最後の接近が画面上で何も変えない。
 * 変化率が最大の点(localT 0.45)に置くと「止まったのに絵が滑る」が起きる。
 */
export const EPILOGUE_STOP_T = 0.75;

/**
 * タッチの寄せを「もう着いている」と見なす幅(px)。
 * `scrollTo` の着地は端末画素へ丸められるので、これが無いと
 * **自分の寄せが生んだ `scrollend` に反応して寄せ直す無限ループ**になる。
 * `RESYNC_EPSILON` と同じ 2px。
 */
export const DETENT_SNAP_EPSILON = 2;

/** 停留所 1 つ。`from` 以上 `to` 未満へ入ろうとした目標は `at` に着地する */
export interface Detent {
  readonly at: number;
  readonly from: number;
  readonly to: number;
}

/** 段の表を組むのに要る、章 1 つぶんの実測としきい値 */
export interface ChapterSpan {
  /** 章の開始位置(ドキュメント px) */
  readonly start: number;
  /** スクラブ可能長(px)= セクション高 − ビューポート高 */
  readonly lens: number;
  readonly inT: number;
  readonly outT: number;
  readonly backOutT: number;
  /**
   * 「読む位置」の段を持つか。
   * **序章は持たない** ── スクラブ長 30svh に段を置く粒度が無く(1 ノッチが
   * localT 0.42)、かつ y = 0 が既にブラウザの硬い止まりになっている。
   */
  readonly hasRead: boolean;
}

/**
 * 段の表を組む。**純関数** ── DOM も window も見ない。
 * `remeasure()` のたびに組み直す(章の実測が動くので)。
 */
export function buildDetents(chapters: readonly ChapterSpan[], scrollMax: number): Detent[] {
  const out: Detent[] = [];
  const n = chapters.length;

  for (let i = 0; i < n; i++) {
    const c = chapters[i];

    if (i === n - 1) {
      // 終章。後ろに踊り場は無い ── ページの末尾がブラウザの硬い止まりになる
      const at = c.start + EPILOGUE_STOP_T * c.lens;
      if (at > c.start && at < scrollMax) out.push({ at, from: at, to: scrollMax });
      continue;
    }

    const outY = c.start + c.outT * c.lens;
    const next = chapters[i + 1];
    const inYNext = next.start + next.inT * next.lens;

    if (c.hasRead) {
      /*
        読む位置。**2 つの保証を同時に満たす**ので、小さいほうを採る。
          ARROW_STEP 以上手前 → ↓ 1 打鍵で文字が退く(画面高に依らない)
          backOutT 以前       → 踊り場から戻ったとき、文字が必ず出直す
                                (出側のヒステリシス / Phase 34a)
        後者は背の高い画面で効く ── h ≥ 約 1440px では 0.04 × lens が 64px を超える。
      */
      const backOutY = c.start + c.backOutT * c.lens;
      const at = Math.min(outY - ARROW_STEP, backOutY);
      if (at > c.start && at < outY) out.push({ at, from: at, to: outY });
    }

    // 踊り場(図だけ)。**ここが唯一の着地点**なので、死んだ区間が 1 段になる
    const figAt = outY + ARROW_STEP;
    if (outY < inYNext && figAt < inYNext) out.push({ at: figAt, from: outY, to: inYNext });
  }

  return out;
}

/**
 * 段つきの目標。`ScrollGlide` の**外側**に置く ── 中に入れると
 * `外部スクロールの再同期は現在値と目標を同時に置く` が落ちる。あの 1 行が
 * 層の分離を守っている(独立監査の指摘)。
 *
 * DOM を見ないので、体感を決めるこのロジックを単体で固定できる
 * (`src/tests/detents.test.ts`)。
 */
export class DetentTrack {
  private detents: readonly Detent[] = [];
  private tgt = 0;
  private maxY = 0;
  /** いま捕まっている段。null なら自由 */
  private heldAt: Detent | null = null;
  /** 捕まっているあいだに積んだ入力(px)。`DETENT_RELEASE` を超えたら抜ける */
  private overflow = 0;

  /** いまの目標(px)。`ScrollGlide.to()` へ渡す値 */
  get target(): number {
    return this.tgt;
  }

  /** 段に捕まっているか(検証・デバッグ用) */
  get holding(): boolean {
    return this.heldAt !== null;
  }

  get max(): number {
    return this.maxY;
  }

  /**
   * 段の表とスクロール上限の差し替え(`remeasure()` のあと)。
   * **読者は動かさない** ── 目標はそのままで、捕まり状態だけ解く。
   * 走行中に段が動いても位置が飛ばないことが要件。
   */
  setDetents(detents: readonly Detent[], scrollMax: number): void {
    this.detents = detents;
    this.maxY = scrollMax > 0 ? scrollMax : 0;
    this.tgt = clamp(this.tgt, 0, this.maxY);
    this.heldAt = null;
    this.overflow = 0;
  }

  /**
   * 外部要因(タッチ・スクロールバー・`scrollTo`・履歴復元)への再同期。
   * **段には吸わせない** ── 読者が指で置いた位置を動かさないのが「力を加えない」の中身。
   */
  reset(y: number): void {
    const at = y > 0 ? y : 0;
    if (at > this.maxY) this.maxY = at;
    this.tgt = at;
    this.heldAt = null;
    this.overflow = 0;
  }

  /** 絶対指定(Home / End)。**段を素通りする** ── 端へ行けなくなってはいけない */
  to(y: number): void {
    this.tgt = clamp(y, 0, this.maxY);
    this.heldAt = null;
    this.overflow = 0;
  }

  /** ホイール / 矢印キーの相対入力 */
  push(delta: number): void {
    if (delta === 0) return;

    const held = this.heldAt;
    if (held === null) {
      this.land(this.tgt + delta);
      return;
    }

    this.overflow += delta;
    if (this.overflow >= DETENT_RELEASE) {
      // 余りは持ち越す ── 入力を捨てない
      this.land(held.to + (this.overflow - DETENT_RELEASE));
    } else if (this.overflow <= -DETENT_RELEASE) {
      this.land(held.from - 1 + (this.overflow + DETENT_RELEASE));
    }
    // 閾値に届かないあいだは目標を動かさない = これが「段」の手ごたえ
  }

  /**
   * 次(`dir = 1`)/ 前(`dir = -1`)の段へ 1 つ。Space / PageUp / PageDown 用。
   * 段が無ければ端へ ── **キーボードだけが取り残されない**ことが要件。
   */
  stepDetent(dir: 1 | -1): void {
    const list = this.detents;
    const from = this.tgt;
    let best: number | null = null;
    for (let i = 0; i < list.length; i++) {
      const at = list[i].at;
      const ahead = dir > 0 ? at > from + 1 : at < from - 1;
      if (!ahead) continue;
      if (best === null || (dir > 0 ? at < best : at > best)) best = at;
    }
    this.land(best ?? (dir > 0 ? this.maxY : 0));
  }

  /**
   * **タッチ用**(Phase 34g)。指が離れて慣性も終わった位置 `y` から、
   * 落ち着かせるべき位置を返す。落ち着かせる必要が無ければ null。
   *
   * ホイールと違い、タッチは「1 回の入力」の粒度が無い ── 1 スワイプが
   * 1〜2 画面ぶん飛ぶ。そこで**止まった場所が段の受け持ち範囲に入っていたときだけ**、
   * その範囲の両端(着地点 `at` と出口 `to`)の**近いほう**へ寄せる。
   *
   * - **踏み面(章の中)では何もしない。** 読者が図を見て止まった場所は動かさない ──
   *   波面のピークで止まる自由は、タッチでも奪わない
   * - 前半なら `at`(= 図だけの位置)、後半なら `to`(= 次章の文字が立つ位置)。
   *   文字が消えた直後で止まった読者は前半に入るので「図のみ」に落ち着き、
   *   勢いで越えた読者は先へ送られる
   * - 寄せ先がまた別の段の受け持ちに入る場合(読む位置 → 踊り場)は解き直す。
   *   境界は半開区間なので、この反復は数回で必ず止まる
   */
  snapTarget(y: number): number | null {
    let t = clamp(y, 0, this.maxY);
    for (let i = 0; i < 4; i++) {
      const d = this.findDetent(t);
      if (d === null) break;
      const next = t < (d.at + d.to) / 2 ? d.at : d.to;
      if (next === t) break;
      t = clamp(next, 0, this.maxY);
    }
    return Math.abs(t - y) < DETENT_SNAP_EPSILON ? null : t;
  }

  /** 目標を y へ置く。段の受け持ち範囲に入るなら、そこへ着地して捕まる */
  private land(y: number): void {
    const at = clamp(y, 0, this.maxY);
    const d = this.findDetent(at);
    this.overflow = 0;
    if (d === null) {
      this.heldAt = null;
      this.tgt = at;
      return;
    }
    this.heldAt = d;
    this.tgt = clamp(d.at, 0, this.maxY);
  }

  private findDetent(y: number): Detent | null {
    const list = this.detents;
    for (let i = 0; i < list.length; i++) {
      if (y >= list[i].from && y < list[i].to) return list[i];
    }
    return null;
  }
}
