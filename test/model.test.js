// -----------------------------------------------------------------------------
// The pure parts: the answers of the device, the capabilities, the index
// guard, the devices and their states.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { parseAddress, normalizeConfig } from '../src/config.js';
import { FEATURE, buildDevice, indexStates, liveStates, ids } from '../src/devices.js';
import { IndexGuard, indexOfTariffs } from '../src/guard.js';
import { createFileStore } from '../src/store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bringsNew,
  capabilitiesOf,
  mergeCapabilities,
  normalizeMac,
  num,
  parseEnelogic,
  parseGeneric,
  parseInfo,
  parsePhases,
  stampTime,
  supportsPhases,
} from '../src/youless/model.js';
import { ENELOGIC, GENERIC, INFO, NOW, PHASES } from './fixtures/youless.js';

const MINUTE = 60_000;

test('numbers: comma decimals and padding of /a, nothing else', () => {
  assert.equal(num(' 12345,678'), 12345.678);
  assert.equal(num('141950,625'), 141950.625);
  assert.equal(num(750), 750);
  assert.equal(num('-12'), -12);
  for (const bad of ['', 'abc', '1,2,3', null, undefined, NaN, Infinity, {}, '0x10']) {
    assert.equal(num(bad), undefined, String(bad));
  }
});

test('the address: IP, host name, port, pasted URL; never credentials', () => {
  assert.deepEqual(parseAddress(' 192.168.1.50 '), { address: '192.168.1.50' });
  assert.deepEqual(parseAddress('http://192.168.1.50/a?f=j'), { address: '192.168.1.50' });
  assert.deepEqual(parseAddress('youless.lan:8080'), { address: 'youless.lan:8080' });
  assert.deepEqual(parseAddress('192.168.1.50:80'), { address: '192.168.1.50' });
  assert.deepEqual(parseAddress('fe80::1'), { address: '[fe80::1]' });
  assert.deepEqual(parseAddress('[fe80::1]:81'), { address: '[fe80::1]:81' });
  assert.deepEqual(parseAddress(''), { address: '' });
  for (const bad of ['http://admin:pw@192.168.1.50', 'bad host', 'host:70000', 'a..b']) {
    assert.deepEqual(parseAddress(bad), { error: 'invalid' }, bad);
  }
  assert.deepEqual(normalizeConfig({ address: 'x y', password: ' p ' }), {
    address: '',
    invalidAddress: true,
    password: ' p ',
  });
});

test('/d: MAC and firmware; the phases page from firmware 1.5', () => {
  assert.deepEqual(parseInfo(INFO), { mac: '72b8ad14162e', firmware: '1.6.0-EL', model: 'LS120' });
  // A /d without a usable MAC is still a /d (the device is then known by its address).
  assert.deepEqual(parseInfo({ mac: '293:23fd:23' }), {
    mac: undefined,
    firmware: undefined,
    model: undefined,
  });
  assert.equal(parseInfo('<html>'), undefined);
  assert.equal(parseInfo([INFO]), undefined);
  assert.equal(parseInfo({}), undefined);
  assert.equal(normalizeMac('00:00:00:00:00:00'), undefined);
  assert.equal(supportsPhases('1.6.0-EL'), true);
  assert.equal(supportsPhases('1.5'), true);
  assert.equal(supportsPhases('1.4.9'), false);
  assert.equal(supportsPhases('2.0'), true);
  assert.equal(supportsPhases(undefined), false);
});

test('/e with a P1 meter: consumption p1 + p2, injection n1 + n2, never net', () => {
  const s = parseEnelogic(ENELOGIC, NOW);
  assert.equal(s.power, 2382);
  assert.deepEqual(s.consumption, { total: 4703.562 + 4490.631, t1: 4703.562, t2: 4490.631 });
  assert.deepEqual(s.injection, { total: 0.029, t1: 0.029, t2: 0 });
  assert.deepEqual(s.s0, { index: 15, power: 10 });
  assert.equal(s.gas, 1624.264);
  assert.equal(s.water, 1234.564);
  assert.notEqual(s.consumption.total, ENELOGIC[0].net);
  assert.equal(s.p1Meter, true, 'the P1 path: both tariffs checked');
});

test('/e without P1 (optical sensor): net is the meter count, no tariff, no injection', () => {
  const s = parseEnelogic(
    [{ net: 1234.5, pwr: 300, p1: 0, p2: 0, n1: 0, n2: 0, gas: 0, gts: 0 }],
    NOW,
  );
  assert.deepEqual(s.consumption, { total: 1234.5 });
  assert.equal(s.p1Meter, undefined, 'net never goes through the tariff check');
  assert.equal(parseGeneric(GENERIC).p1Meter, undefined, 'nor cnt');
  assert.deepEqual(s.injection, {});
  const caps = capabilitiesOf(s);
  assert.equal(caps.tariffs, false);
  assert.equal(caps.injection, false);
  assert.equal(caps.gas, false, 'gas: 0 without a stamp is no gas meter');
  assert.equal(caps.water, false);
});

test('/e: stale gas and water readings are dropped (youless-api)', () => {
  const old = 2610150900; // two days before NOW
  const s = parseEnelogic([{ ...ENELOGIC[0], gts: old, wts: old }], NOW);
  assert.equal(s.gas, undefined);
  assert.equal(s.water, undefined);
  assert.equal(stampTime(2610171100), Date.UTC(2026, 9, 17, 11, 0));
  assert.equal(stampTime(2613171100), undefined);
  assert.equal(parseEnelogic([], NOW), undefined);
  assert.equal(parseEnelogic({ pwr: 1 }, NOW), undefined);
  assert.equal(parseEnelogic([{ foo: 1 }], NOW), undefined);
});

test('/a?f=j: comma index, S0 input', () => {
  const s = parseGeneric({ ...GENERIC, cs0: ' 12,500', ps0: 40 });
  assert.equal(s.power, 750);
  assert.deepEqual(s.consumption, { total: 141950.625 });
  assert.deepEqual(s.s0, { index: 12.5, power: 40 });
  assert.equal(parseGeneric({ foo: 'bar' }), undefined);
  assert.equal(parseGeneric([GENERIC]), undefined);
});

test('/f: three phases and the tariff', () => {
  const p = parsePhases(PHASES);
  assert.equal(p.tariff, 1);
  assert.deepEqual(p.phases[0], { current: 0.123, voltage: 240, power: 462 });
  assert.equal(p.phases.length, 3);
  assert.deepEqual(parsePhases({ tr: 2, i1: 1, v1: 230, l1: 100 }).phases.length, 1);
  assert.equal(parsePhases({ tr: 7 }).tariff, undefined);
  // youless-api says 0 or 1, Home Assistant 1 or 2: kept as given.
  assert.equal(parsePhases({ tr: 0 }).tariff, 0);
});

test('/e: once P1 was seen, a read without P1 gives no index at all (never net, never 0)', () => {
  const outage = [{ ...ENELOGIC[0], p1: 0, p2: 0, n1: 0, n2: 0, net: 5000 }];
  const known = parseEnelogic(outage, NOW, { p1Known: true });
  assert.equal(known.consumption.total, undefined);
  assert.equal(known.injection.total, undefined);
  assert.equal(known.p1Outage, true);
  const missing = parseEnelogic([{ pwr: 0 }], NOW, { p1Known: true });
  assert.equal(missing.consumption.total, undefined);
  // Never seen: a meter without P1, read through net.
  assert.equal(parseEnelogic(outage, NOW).consumption.total, 5000);
});

test('capabilities only grow', () => {
  const a = capabilitiesOf(parseGeneric(GENERIC));
  const b = capabilitiesOf({ ...parseEnelogic(ENELOGIC, NOW), ...parsePhases(PHASES) });
  assert.equal(bringsNew(a, a), false);
  assert.equal(bringsNew(a, b), true);
  const merged = mergeCapabilities(a, b);
  assert.equal(merged.phases, 3);
  assert.equal(bringsNew(merged, a), false);
  assert.equal(bringsNew(undefined, a), true);
});

test('index guard: never 0, a normal rise goes through', () => {
  const guard = new IndexGuard();
  assert.equal(guard.accept(0, 0), false, 'never 0, even as the first reference');
  assert.equal(guard.accept(1000, 0), true);
  assert.equal(guard.accept(1000.2, MINUTE), true);
  // A glitch to 0, for as long as it lasts: never published.
  for (let i = 2; i < 200; i += 1) {
    assert.equal(guard.accept(0, i * MINUTE), false);
  }
  assert.equal(guard.accept(1000.3, 200 * MINUTE), true);
  assert.equal(new IndexGuard().accept(-1, 0), false);
  assert.equal(new IndexGuard().accept(NaN, 0), false);
  // After a long stop, a big but plausible rise goes through.
  assert.equal(new IndexGuard({ value: 100, at: 0 }).accept(400, 24 * 60 * MINUTE), true);
});

test('index guard: a jump up is never confirmed by repetition, only by the user', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  for (let i = 1; i <= 500; i += 1) {
    assert.equal(guard.accept(6000 + i * 0.01, i * MINUTE), false);
  }
  assert.deepEqual(guard.held, {
    direction: 'up',
    from: 1000,
    to: 6005,
    threshold: 6000.01,
    at: 500 * MINUTE,
  });
  assert.deepEqual(guard.acceptHeld(), { direction: 'up', from: 1000, to: 6005 });
  assert.equal(guard.accept(6005.01, 501 * MINUTE), true);
  assert.equal(guard.held, undefined);
  // Back to normal values: the jump is forgotten, nothing to accept.
  const back = new IndexGuard({ value: 1000, at: 0 });
  back.accept(9000, MINUTE);
  assert.equal(back.accept(1000.1, 2 * MINUTE), true);
  assert.equal(back.held, undefined);
  assert.equal(back.acceptHeld(), undefined);
  assert.equal(back.accept(9000, 3 * MINUTE), false, 'an old acceptance never covers a new jump');
});

test('index guard: a drop is never confirmed by time; back up, nothing fictive is billed', () => {
  const guard = new IndexGuard({ value: 50_000, at: 0 });
  // A drop to 10 kWh, for a week: held all along (0.1.1 took it after 60 minutes).
  for (let i = 1; i <= 7 * 24 * 60; i += 60) {
    assert.equal(guard.accept(10 + i * 0.0001, i * MINUTE), false, `minute ${i}`);
  }
  assert.equal(guard.held.direction, 'down');
  assert.deepEqual(guard.last, { value: 50_000, at: 0 });
  // Back to the real value: it goes through, the hold ends; the reference
  // never went down, so no rise of 50,000 kWh is ever billed.
  assert.equal(guard.accept(50_001, 7 * 24 * 60 * MINUTE + MINUTE), true);
  assert.equal(guard.held, undefined);
});

test('index guard: a drop accepted by the user, then the values rise normally', () => {
  const guard = new IndexGuard({ value: 50_000, at: 0 });
  assert.equal(guard.accept(10, MINUTE), false);
  assert.deepEqual(guard.acceptHeld(), { direction: 'down', from: 50_000, to: 10 });
  // The core skips the negative delta: nothing billed.
  assert.equal(guard.accept(10.01, 2 * MINUTE), true);
  assert.deepEqual(guard.last, { value: 10.01, at: 2 * MINUTE });
  assert.equal(guard.accept(10.5, 3 * MINUTE), true);
  // Back to the old value after the acceptance: a jump, held.
  assert.equal(guard.accept(50_000, 4 * MINUTE), false);
  assert.equal(guard.held.direction, 'up');
});

test('index guard: an acceptance of a drop never takes a jump', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  guard.accept(10, MINUTE);
  guard.acceptHeld();
  assert.equal(guard.accept(90_000, 2 * MINUTE), false);
  assert.equal(guard.held.direction, 'up');
  assert.equal(guard.accept(90_000, 3 * MINUTE), false);
});

test('index guard: a frozen reading never shrinks the margin of the next rise', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  // 3 hours of the same value, read every minute.
  for (let i = 1; i <= 180; i += 1) {
    assert.equal(guard.accept(1000, i * MINUTE), true);
  }
  assert.deepEqual(guard.last, { value: 1000, at: 0 }, 'the date of the value is kept');
  // +4 kWh after 3 hours: 1.3 kW on average, plausible.
  assert.equal(guard.accept(1004, 181 * MINUTE), true);
  assert.equal(guard.held, undefined);
});

test('index guard: an acceptance is bounded to the value shown and the margin since', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  assert.equal(guard.accept(1005, MINUTE), false);
  assert.deepEqual(guard.acceptHeld(), { direction: 'up', from: 1000, to: 1005 });
  // 5000 is not what the user saw: held again, nothing taken, acceptance dropped.
  assert.equal(guard.accept(5000, 2 * MINUTE), false);
  assert.deepEqual(guard.last, { value: 1000, at: 0 });
  assert.equal(guard.held.to, 5000);
  assert.equal(guard.accepted, undefined);
  assert.equal(guard.accept(5000.1, 3 * MINUTE), false, 'still held');
  // The value shown, plus what the home may draw meanwhile: taken.
  const fair = new IndexGuard({ value: 1000, at: 0 });
  fair.accept(1005, MINUTE);
  fair.acceptHeld();
  assert.equal(fair.accept(1005.5, 2 * MINUTE), true);
  // Below the value shown: not the jump accepted either.
  const below = new IndexGuard({ value: 1000, at: 0 });
  below.accept(1005, MINUTE);
  below.acceptHeld();
  assert.equal(below.accept(1004, 2 * MINUTE), false);
  // A drop: at most the value shown plus the margin.
  const drop = new IndexGuard({ value: 1000, at: 0 });
  drop.accept(10, MINUTE);
  drop.acceptHeld();
  assert.equal(drop.accept(900, 2 * MINUTE), false, 'not the drop shown');
  drop.accept(10, 3 * MINUTE);
  drop.acceptHeld();
  assert.equal(drop.accept(10.2, 4 * MINUTE), true);
  assert.equal(new IndexGuard({ value: 1, at: 0 }).acceptHeld(), undefined, 'nothing held');
});

test('index guard: a value held read back from /data is dated at its loading', () => {
  const DAY = 24 * 60 * MINUTE;
  const saved = {
    last: { value: 1000, at: 0 },
    held: { direction: 'up', from: 1000, to: 1005, threshold: 1005, at: 0 },
  };
  // Loaded 5 days later: an acceptance covers 1005 plus the margin since the load only.
  const guard = new IndexGuard(undefined, saved, 5 * DAY);
  assert.equal(guard.held.at, 5 * DAY);
  guard.acceptHeld();
  assert.equal(guard.accept(5000, 5 * DAY + MINUTE), false, 'the old date never widens it');
  assert.equal(guard.held.to, 5000);
  const fair = new IndexGuard(undefined, saved, 5 * DAY);
  fair.acceptHeld();
  assert.equal(fair.accept(1005.5, 5 * DAY + MINUTE), true);
});

test('index guard: the /data state of 0.1.1 ({ last, jump }) is migrated, still held', () => {
  const DAY = 24 * 60 * MINUTE;
  // Written by 0.1.1: the reference several days old, a jump without a date.
  const old = {
    last: { value: 1000, at: 0 },
    jump: { from: 1000, to: 1005, threshold: 1005 },
  };
  const loadedAt = 6 * DAY;
  const guard = new IndexGuard(undefined, old, loadedAt);
  assert.deepEqual(guard.held, {
    direction: 'up',
    from: 1000,
    to: 1005,
    threshold: 1005,
    at: loadedAt,
  });
  // The threshold alone holds the jump, however much margin 6 days would give.
  assert.equal(guard.accept(1005.2, loadedAt + MINUTE), false);
  assert.equal(guard.accept(1500, loadedAt + 2 * MINUTE), false);
  assert.deepEqual(guard.last, { value: 1000, at: 0 });
  // An acceptance, then a value far above the jump shown: held again (the
  // date of last, 6 days old, never widens the range).
  guard.acceptHeld();
  assert.equal(guard.accept(9000, loadedAt + 3 * MINUTE), false);
  assert.equal(guard.held.to, 9000);
  assert.equal(guard.accepted, undefined);
  // Written back in the new shape.
  assert.deepEqual(Object.keys(guard.state()), ['last', 'held']);
  assert.equal(guard.state().held.direction, 'up');
  // The value shown, accepted: taken.
  const fair = new IndexGuard(undefined, old, loadedAt);
  assert.deepEqual(fair.acceptHeld(), { direction: 'up', from: 1000, to: 1005 });
  assert.equal(fair.accept(1005.1, loadedAt + MINUTE), true);
  // A broken old jump is ignored; without a reference nothing is held.
  assert.equal(new IndexGuard(undefined, { ...old, jump: { from: 1 } }, loadedAt).held, undefined);
  assert.equal(new IndexGuard(undefined, { last: null, jump: old.jump }, loadedAt).held, undefined);
});

test('index of the P1 tariffs: both there; a register at 0 or dropping alone is no index', () => {
  assert.equal(indexOfTariffs(5000, 3000), 8000);
  assert.equal(indexOfTariffs(5000, 0), 5000, 'a single-tariff meter, no reference yet');
  for (const [p1, p2] of [
    [undefined, 3000],
    [5000, null],
    [NaN, 3000],
    [Infinity, 1],
    [-1, 3000],
    [0, 0],
  ]) {
    assert.equal(indexOfTariffs(p1, p2), undefined, `${p1} ${p2}`);
  }
  const ref = { p1: 5000, p2: 3000 };
  assert.equal(indexOfTariffs(5000.1, 3000, ref), 8000.1);
  assert.equal(indexOfTariffs(0, 3000.1, ref), undefined, 'a tariff above 0 falls to 0');
  assert.equal(indexOfTariffs(4000, 3000.1, ref), undefined, 'one tariff drops alone');
  assert.equal(indexOfTariffs(5000, 2999, ref), undefined, 'one tariff drops alone');
  assert.equal(indexOfTariffs(10, 5, ref), 15, 'both drop: a real drop, for the guard');
  assert.equal(indexOfTariffs(10, 0, ref), 10, 'both lower, one at 0: still a real drop');
  assert.equal(indexOfTariffs(5000.1, 0, { p1: 5000, p2: 0 }), 5000.1, 'single tariff');
});

test('the device: one index in the energy monitoring, everything else plain or volume', () => {
  const gladys = createFakeGladys({ selector: 'youless' });
  const device = { model: 'LS120', mac: '72b8ad14162e', firmware: '1.6.0-EL' };
  const caps = mergeCapabilities(capabilitiesOf(parseEnelogic(ENELOGIC, NOW)), {
    phases: 3,
    tariff: true,
  });
  const built = buildDevice(gladys, device, caps, '192.168.1.50');
  assert.equal(built.external_id, 'ext:youless:youless:72b8ad14162e');
  const byKey = Object.fromEntries(built.features.map((f) => [f.external_id.split(':').at(-1), f]));
  // The only energy index: the consumption (p1 + p2).
  const indexes = built.features.filter(
    (f) =>
      f.category === C.ENERGY_SENSOR &&
      [T.ENERGY_SENSOR.INDEX, T.ENERGY_SENSOR.ENERGY].includes(f.type),
  );
  assert.deepEqual(
    indexes.map((f) => f.external_id.split(':').at(-1)),
    [FEATURE.CONSUMPTION_INDEX],
  );
  assert.equal(byKey.consumption_index.unit, U.KILOWATT_HOUR);
  // Never a daily consumption, never gas or water in the energy categories.
  for (const f of built.features) {
    assert.notEqual(f.type, T.ENERGY_SENSOR.DAILY_CONSUMPTION);
    assert.notEqual(f.type, T.ENERGY_SENSOR.THIRTY_MINUTES_CONSUMPTION);
  }
  for (const key of ['gas', 'water']) {
    assert.equal(byKey[key].category, C.VOLUME_SENSOR);
    assert.equal(byKey[key].unit, U.CUBIC_METER);
  }
  for (const key of ['injection_index', 'injection_tariff1', 'consumption_tariff1', 's0_index']) {
    assert.equal(byKey[key].category, C.UNKNOWN, key);
    assert.equal(byKey[key].unit, undefined, key);
  }
  // The meter power is the only energy-sensor power: the phases' are plain.
  assert.deepEqual(
    built.features
      .filter((f) => f.category === C.ENERGY_SENSOR && f.type === T.ENERGY_SENSOR.POWER)
      .map((f) => f.external_id.split(':').at(-1)),
    ['power'],
  );
  assert.equal(byKey.power_l1.category, C.UNKNOWN);
  assert.equal(byKey.voltage_l3.unit, U.VOLT);
  assert.equal(byKey.current_l2.unit, U.AMPERE);
});

test('an LS110 is known by its address', () => {
  const gladys = createFakeGladys({ selector: 'youless' });
  const external = ids(gladys, { model: 'LS110' }, '192.168.1.50:8080');
  assert.equal(external.device, 'ext:youless:youless:host-192.168.1.50-8080');
});

test('states: live values and indexes apart, rounded, the index only when let through', () => {
  const gladys = createFakeGladys({ selector: 'youless' });
  const external = ids(gladys, { mac: '72b8ad14162e' }, 'x');
  const snapshot = { ...parseEnelogic(ENELOGIC, NOW), ...parsePhases(PHASES) };
  const live = liveStates(external, snapshot);
  assert.deepEqual(
    live.map((s) => s.device_feature_external_id.split(':').at(-1)),
    [
      'power',
      'power_l1',
      'voltage_l1',
      'current_l1',
      'power_l2',
      'voltage_l2',
      'current_l2',
      'power_l3',
      'voltage_l3',
      'current_l3',
      's0_power',
    ],
  );
  const held = indexStates(external, snapshot, undefined);
  assert.ok(!held.some((s) => s.device_feature_external_id.endsWith(':consumption_index')));
  const index = indexStates(external, snapshot, snapshot.consumption.total);
  assert.equal(index[0].state, 9194.193);
  assert.ok(
    index.some((s) => s.device_feature_external_id.endsWith(':gas') && s.state === 1624.264),
  );
});

test('index guard: a held jump is never covered by the margin growing over time', () => {
  const guard = new IndexGuard({ value: 2.5, at: 0 });
  assert.equal(guard.accept(12345, MINUTE), false);
  // 200 hours later, 100 kW × 200 h would cover the jump: still held.
  assert.equal(guard.accept(12345.5, 200 * 60 * MINUTE), false);
  assert.deepEqual(guard.held, {
    direction: 'up',
    from: 2.5,
    to: 12345.5,
    threshold: 12345,
    at: 200 * 60 * MINUTE,
  });
  // A value below the jump goes through the usual rule again.
  assert.equal(guard.accept(2.6, 200 * 60 * MINUTE + MINUTE), true);
  assert.equal(guard.held, undefined);
});

test('index guard: its state survives a restart; same value, the oldest date', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  guard.accept(1050, MINUTE);
  const saved = JSON.parse(JSON.stringify(guard.state()));
  const again = new IndexGuard({ value: 900, at: -1000 * MINUTE }, saved);
  assert.deepEqual(again.last, { value: 1000, at: 0 });
  assert.equal(again.accept(1050.1, 60 * MINUTE), false, 'still held after the restart');
  again.acceptHeld();
  assert.equal(again.accept(1050.2, 61 * MINUTE), true);
  // A newer value in Gladys than in /data wins; the same value keeps its oldest date.
  assert.deepEqual(new IndexGuard({ value: 1100, at: 5 }, saved).last, { value: 1100, at: 5 });
  assert.deepEqual(new IndexGuard({ value: 1000, at: 50 }, saved).last, { value: 1000, at: 0 });
  assert.deepEqual(
    new IndexGuard({ value: 1000, at: -50 }, { last: { value: 1000, at: 10 } }).last,
    { value: 1000, at: -50 },
  );
  assert.deepEqual(new IndexGuard(undefined, { last: null, held: null }).state(), {
    last: null,
    held: null,
  });
});

test('the /data store: written through a temporary file, read back, empty when absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'youless-'));
  try {
    const store = createFileStore(join(dir, 'state.json'));
    assert.deepEqual(store.load(), {});
    const state = { last: { value: 1, at: 2 }, held: null, tariffs: { p1: 1, p2: 0 } };
    await store.save({ a: state });
    assert.deepEqual(store.load(), { a: state });
    assert.deepEqual(createFileStore(join(dir, 'missing', 'x.json')).load(), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('index guard: while held, an old reference never lets a large rise through', () => {
  const DAY = 24 * 60 * MINUTE;
  // Migrated from 0.1.1: the reference 5 days old, a jump to 15000 held.
  const old = {
    last: { value: 9000, at: 0 },
    jump: { from: 9000, to: 15000, threshold: 15000 },
  };
  const loadedAt = 5 * DAY;
  const guard = new IndexGuard(undefined, old, loadedAt);
  // 14000: below the threshold, within 5 days of margin from last.at, but
  // not within the short margin since held.at: held in its turn.
  assert.equal(guard.accept(14000, loadedAt + MINUTE), false);
  assert.deepEqual(guard.last, { value: 9000, at: 0 }, '0 kWh billed');
  assert.deepEqual(guard.held, {
    direction: 'up',
    from: 9000,
    to: 14000,
    threshold: 14000,
    at: loadedAt + MINUTE,
  });
  // The real consumption stays acceptable by the button.
  assert.deepEqual(guard.acceptHeld(), { direction: 'up', from: 9000, to: 14000 });
  assert.equal(guard.accept(14000.1, loadedAt + 2 * MINUTE), true);
  // A small rise right after the held value still ends the hold (a glitch).
  const glitch = new IndexGuard(undefined, old, loadedAt);
  assert.equal(glitch.accept(9000.5, loadedAt + MINUTE), true);
  assert.equal(glitch.held, undefined);
});
