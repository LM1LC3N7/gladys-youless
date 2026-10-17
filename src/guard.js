// -----------------------------------------------------------------------------
// Plausibility of the electricity index, the only value Gladys bills. Pure.
//
// The core turns the deltas of an `energy-sensor` / `index` feature into
// consumption and cost, and skips a delta below zero (a counter reset). A
// glitch would cost dearly: 12,345 → 0 → 12,346 kWh is a reset, then 12,346
// kWh consumed in half an hour. So a value is published only when it is
// plausible after the last one published: not lower, and not more than
// INDEX_MAX_KW on average since then. A drop or a jump is taken once read
// INDEX_CONFIRMATIONS times in a row, each read plausible after the previous
// one (a meter replaced, a counter set again by hand in the YouLess).
// -----------------------------------------------------------------------------

import { INDEX_CONFIRMATIONS, INDEX_MAX_KW, INDEX_SLACK_KWH } from './constants.js';

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
    this.last = last && Number.isFinite(last.value) && Number.isFinite(last.at) ? last : undefined;
    this.candidate = undefined;
  }

  /** Whether `value`, read at `at`, may be published. A published value becomes the reference. */
  accept(value, at) {
    if (!Number.isFinite(value) || value < 0) {
      return false;
    }
    if (!this.last || follows(this.last, value, at)) {
      this.last = { value, at };
      this.candidate = undefined;
      return true;
    }
    if (this.candidate && follows(this.candidate, value, at)) {
      this.candidate = { value, at, count: this.candidate.count + 1 };
    } else {
      this.candidate = { value, at, count: 1 };
    }
    if (this.candidate.count >= INDEX_CONFIRMATIONS) {
      this.last = { value, at };
      this.candidate = undefined;
      return true;
    }
    return false;
  }
}
