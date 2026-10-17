// -----------------------------------------------------------------------------
// The answers of a YouLess, read into one snapshot. Pure.
//
// Ported from youless-api (gjong/youless-python-bridge, MIT, see
// THIRD_PARTY_NOTICES.md): the meaning of the fields of /d, /a, /e and /f,
// the comma decimals of /a, the stale gas and water readings of /e, the
// firmware that brings /f.
//
//   /d      { model, mac, fw }
//   /a?f=j  { cnt: " 12345,678" (kWh), pwr (W), cs0: " 0,000" (kWh), ps0 (W), ... }
//   /e      [{ net, pwr, p1, p2, n1, n2 (kWh), gas, gts, wtr, wts, cs0, ps0, ... }]
//   /f      { tr, i1..i3 (A), v1..v3 (V), l1..l3 (W), pp, pts, pa }
//
// A snapshot holds only what the device gave (a missing value is undefined):
//   { power, consumption: { total, t1, t2 }, injection: { total, t1, t2 },
//     s0: { power, index }, gas, water, phases: [{ power, voltage, current }], tariff }
// -----------------------------------------------------------------------------

import { METER_STALE_AFTER, PHASES_FIRMWARE } from '../constants.js';

/** A number of a YouLess answer: a number, or a string with a comma decimal (" 12345,678"). */
export function num(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const text = value.trim().replace(',', '.');
    if (/^-?\d+(\.\d+)?$/.test(text)) {
      return Number(text);
    }
  }
  return undefined;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sum = (a, b) => (a === undefined || b === undefined ? undefined : a + b);

/** A MAC as the external id keeps it: 12 lower-case hex digits, or undefined. */
export function normalizeMac(raw) {
  const mac = String(raw ?? '')
    .replace(/[^0-9a-f]/gi, '')
    .toLowerCase();
  return /^[0-9a-f]{12}$/.test(mac) && mac !== '000000000000' ? mac : undefined;
}

/**
 * The /d answer: `{ mac, firmware, model }` (`mac` undefined when it is not a
 * usable MAC), or undefined when it is not a device page.
 */
export function parseInfo(json) {
  if (!isObject(json) || (typeof json.mac !== 'string' && typeof json.fw !== 'string')) {
    return undefined;
  }
  const text = (value) => (typeof value === 'string' ? value.trim().slice(0, 40) : undefined);
  return { mac: normalizeMac(json.mac), firmware: text(json.fw), model: text(json.model) };
}

/** Whether a firmware ("1.6.0-EL") serves the phases page /f. */
export function supportsPhases(firmware) {
  const match = /^(\d+)\.(\d+)/.exec(String(firmware ?? ''));
  if (!match) {
    return false;
  }
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return (
    major > PHASES_FIRMWARE.major ||
    (major === PHASES_FIRMWARE.major && minor >= PHASES_FIRMWARE.minor)
  );
}

/**
 * The instant of a `gts` / `wts` stamp (yymmddhhmm, the clock of the device),
 * read as UTC: the device has no time zone, the caller keeps a margin.
 */
export function stampTime(stamp) {
  const text = String(num(stamp) ?? '');
  const match = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(text);
  if (!match) {
    return undefined;
  }
  const [yy, mm, dd, hh, mi] = match.slice(1).map(Number);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59) {
    return undefined;
  }
  return Date.UTC(2000 + yy, mm - 1, dd, hh, mi);
}

/**
 * A gas or water value of /e, unless its stamp says it is stale: youless-api
 * drops a reading older than the current day; here, older than
 * METER_STALE_AFTER (the device clock has no time zone).
 */
function fresh(value, stamp, now) {
  const reading = num(value);
  const stamped = num(stamp);
  if (reading === undefined || stamped === undefined || stamped === 0) {
    return reading;
  }
  const time = stampTime(stamped);
  return time !== undefined && now - time > METER_STALE_AFTER ? undefined : reading;
}

/** The /a?f=j answer (LS110, LS120 PVOutput firmware). */
export function parseGeneric(json) {
  if (!isObject(json)) {
    return undefined;
  }
  const power = num(json.pwr);
  const total = num(json.cnt);
  if (power === undefined && total === undefined) {
    return undefined;
  }
  return {
    power,
    consumption: { total },
    injection: {},
    s0: { index: num(json.cs0), power: num(json.ps0) },
    phases: [],
  };
}

/**
 * The /e answer (LS120 Enelogic firmware). With a P1 smart meter, the
 * consumption index is p1 + p2 (the two tariffs) and the injection n1 + n2,
 * kept apart; `net` (p1 + p2 - n1 - n2) is never the consumption index then.
 * Without P1 (an optical sensor on the meter), the tariff fields stay at 0 and
 * `net` is the meter count.
 *
 * `p1Known`: this device has shown P1 values before. A read without them is
 * then a P1 outage, never a meter without P1: no consumption index at all
 * (falling back on `net`, or on 0, would bill the whole index once P1 is back).
 */
export function parseEnelogic(json, now, { p1Known = false } = {}) {
  const entry = Array.isArray(json) ? json[0] : undefined;
  if (!isObject(entry)) {
    return undefined;
  }
  const [p1, p2, n1, n2] = ['p1', 'p2', 'n1', 'n2'].map((key) => num(entry[key]));
  const p1Meter = [p1, p2, n1, n2].some((value) => value !== undefined && value > 0);
  const snapshot = {
    power: num(entry.pwr),
    consumption: {},
    injection: {},
    s0: { index: num(entry.cs0), power: num(entry.ps0) },
    gas: fresh(entry.gas, entry.gts, now),
    water: fresh(entry.wtr, entry.wts, now),
    // A stamp says a meter is wired, even while its value is still 0.
    stamps: { gas: num(entry.gts), water: num(entry.wts) },
    phases: [],
  };
  if (p1Meter) {
    snapshot.consumption = { total: sum(p1, p2), t1: p1, t2: p2 };
    snapshot.injection = { total: sum(n1, n2), t1: n1, t2: n2 };
  } else if (p1Known) {
    snapshot.p1Outage = true;
    return snapshot;
  } else {
    snapshot.consumption = { total: num(entry.net) };
  }
  if (snapshot.power === undefined && snapshot.consumption.total === undefined) {
    return undefined;
  }
  return snapshot;
}

/** The /f answer: up to three phases and the current tariff (1 or 2). */
export function parsePhases(json) {
  if (!isObject(json)) {
    return undefined;
  }
  const phases = [];
  for (const n of [1, 2, 3]) {
    // youless-api keys a phase on its current: no `i<n>`, no phase.
    if (!(`i${n}` in json)) {
      break;
    }
    phases.push({
      current: num(json[`i${n}`]),
      voltage: num(json[`v${n}`]),
      power: num(json[`l${n}`]),
    });
  }
  const tariff = num(json.tr);
  // youless-api says 0 or 1, Home Assistant shows 1 or 2: kept as the device gives it.
  return { phases, tariff: [0, 1, 2].includes(tariff) ? tariff : undefined };
}

const has = (value) => value !== undefined;
const positive = (value) => value !== undefined && value > 0;

/**
 * What a snapshot shows the device can give: the features of its Gladys
 * device. Gas, water and S0 count only once they hold something (an LS120
 * without gas meter answers `gas: 0`).
 */
export function capabilitiesOf(snapshot) {
  return {
    power: has(snapshot.power),
    consumption: has(snapshot.consumption.total),
    tariffs: has(snapshot.consumption.t1) || has(snapshot.consumption.t2),
    injection: has(snapshot.injection.total),
    s0: positive(snapshot.s0?.index) || positive(snapshot.s0?.power),
    gas: has(snapshot.gas) && (positive(snapshot.gas) || positive(snapshot.stamps?.gas)),
    water: has(snapshot.water) && (positive(snapshot.water) || positive(snapshot.stamps?.water)),
    phases: snapshot.phases.length,
    tariff: has(snapshot.tariff),
  };
}

/** The union of two capability sets: a device never loses a feature it showed once. */
export function mergeCapabilities(a, b) {
  if (!a) return { ...b };
  if (!b) return { ...a };
  const merged = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    merged[key] =
      typeof a[key] === 'number' || typeof b[key] === 'number'
        ? Math.max(a[key] ?? 0, b[key] ?? 0)
        : Boolean(a[key] || b[key]);
  }
  return merged;
}

/** Whether `seen` brings a feature `known` does not have (the device must be published again). */
export const bringsNew = (known, seen) =>
  JSON.stringify(mergeCapabilities(known, seen)) !== JSON.stringify(mergeCapabilities(known, {}));
