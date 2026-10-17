// -----------------------------------------------------------------------------
// Plausibility of the electricity index, the only value Gladys bills. Pure.
//
// The core turns the deltas of an `energy-sensor` / `index` feature into
// consumption and cost: it skips a delta below zero (a counter reset) but
// counts every rise IN FULL. So 9,194 → 0 → 9,194 kWh is billed as 9,194 kWh
// in one half hour. The rules:
// - a value of 0 (or below) is never published;
// - a value plausible after the last one published (not lower, not more than
//   INDEX_MAX_KW on average since then) goes through;
// - a drop (a meter replaced, a counter set again in the YouLess) goes
//   through only once the lower values, never 0 and never decreasing, have
//   been read for INDEX_DROP_CONFIRM (the core then skips the negative delta);
// - a jump up is NEVER confirmed by repetition nor by time: it is held (any
//   value at or above it stays held, the margin growing while nothing is
//   published must never cover it), shown in the status, kept in /data across
//   restarts, and taken only on an explicit gesture of the user
//   (`acceptJump`, a save of the configuration), the difference counted once.
// -----------------------------------------------------------------------------

import { INDEX_DROP_CONFIRM, INDEX_MAX_KW, INDEX_SLACK_KWH } from './constants.js';

const HOUR = 3_600_000;

/** Whether `value` may follow `previous` (both `{ value, at }`). */
function follows(previous, value, at) {
  const hours = Math.max(0, at - previous.at) / HOUR;
  return (
    value >= previous.value && value - previous.value <= INDEX_MAX_KW * hours + INDEX_SLACK_KWH
  );
}

const validLast = (last) =>
  last && Number.isFinite(last.value) && last.value > 0 && Number.isFinite(last.at)
    ? { value: last.value, at: last.at }
    : undefined;

const validJump = (jump) =>
  jump && [jump.from, jump.to, jump.threshold].every(Number.isFinite)
    ? { from: jump.from, to: jump.to, threshold: jump.threshold }
    : undefined;

export class IndexGuard {
  /**
   * `last`: the value Gladys already holds (`{ value, at }`), when known.
   * `saved`: the state kept in /data (`state()`), so that a jump held back
   * stays held across a restart.
   */
  constructor(last, saved) {
    const kept = validLast(saved?.last);
    const known = validLast(last);
    // The most recent reference wins.
    this.last = kept && (!known || kept.at >= known.at) ? kept : known;
    /** The lower values read since a drop: `{ value, at, since }`. */
    this.drop = undefined;
    /**
     * A jump held back until the user accepts it: `{ from, to, threshold }`.
     * Every value at or above `threshold` stays held whatever the time
     * passed: the margin of INDEX_MAX_KW grows while nothing is published,
     * it must never end up covering the jump.
     */
    this.jump = this.last ? validJump(saved?.jump) : undefined;
    this.jumpAccepted = false;
  }

  /** What /data keeps: the reference and the jump held. */
  state() {
    return { last: this.last ?? null, jump: this.jump ?? null };
  }

  /** The user accepts the current index (a save of the configuration). */
  acceptJump() {
    if (this.jump) {
      this.jumpAccepted = true;
    }
  }

  /** Whether `value`, read at `at`, may be published. A published value becomes the reference. */
  accept(value, at) {
    if (!Number.isFinite(value) || value <= 0) {
      // Never 0, and a 0 breaks a drop being confirmed.
      this.drop = undefined;
      return false;
    }
    if (this.jump && value >= this.jump.threshold) {
      this.drop = undefined;
      if (this.jumpAccepted) {
        return this.take(value, at);
      }
      // Held, however long ago the last value was published.
      this.jump = { ...this.jump, to: value };
      return false;
    }
    if (!this.last || follows(this.last, value, at)) {
      return this.take(value, at);
    }
    if (value > this.last.value) {
      this.drop = undefined;
      if (this.jumpAccepted) {
        return this.take(value, at);
      }
      this.jump = {
        from: this.last.value,
        to: value,
        threshold: Math.min(value, this.jump?.threshold ?? Infinity),
      };
      return false;
    }
    // Lower than the reference: a drop, confirmed by lower values never
    // decreasing, read over INDEX_DROP_CONFIRM.
    this.jump = undefined;
    this.jumpAccepted = false;
    if (this.drop && follows(this.drop, value, at)) {
      this.drop = { value, at, since: this.drop.since };
    } else {
      this.drop = { value, at, since: at };
    }
    if (at - this.drop.since >= INDEX_DROP_CONFIRM) {
      return this.take(value, at);
    }
    return false;
  }

  take(value, at) {
    this.last = { value, at };
    this.drop = undefined;
    this.jump = undefined;
    this.jumpAccepted = false;
    return true;
  }
}
