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
// - a jump up is NEVER confirmed by repetition: it is held, shown in the
//   status, and taken only on an explicit gesture of the user (`acceptJump`,
//   a save of the configuration), the difference being counted once.
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

export class IndexGuard {
  /** `last`: the value Gladys already holds (`{ value, at }`), when known. */
  constructor(last) {
    this.last =
      last && Number.isFinite(last.value) && last.value > 0 && Number.isFinite(last.at)
        ? last
        : undefined;
    /** The lower values read since a drop: `{ value, at, since }`. */
    this.drop = undefined;
    /** The value of a jump held back, until the user accepts it: `{ from, to }`. */
    this.jump = undefined;
    this.jumpAccepted = false;
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
    if (!this.last || follows(this.last, value, at)) {
      return this.take(value, at);
    }
    if (value > this.last.value) {
      this.drop = undefined;
      if (this.jumpAccepted) {
        return this.take(value, at);
      }
      this.jump = { from: this.last.value, to: value };
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
