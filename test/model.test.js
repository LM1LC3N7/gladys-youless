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
import { INDEX_DROP_CONFIRM } from '../src/constants.js';
import { FEATURE, buildDevice, indexStates, liveStates, ids } from '../src/devices.js';
import { IndexGuard } from '../src/guard.js';
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
});

test('/e without P1 (optical sensor): net is the meter count, no tariff, no injection', () => {
  const s = parseEnelogic(
    [{ net: 1234.5, pwr: 300, p1: 0, p2: 0, n1: 0, n2: 0, gas: 0, gts: 0 }],
    NOW,
  );
  assert.deepEqual(s.consumption, { total: 1234.5 });
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
  assert.deepEqual(guard.jump, { from: 1000, to: 6005 });
  guard.acceptJump();
  assert.equal(guard.accept(6005.01, 501 * MINUTE), true);
  assert.equal(guard.jump, undefined);
  // Back to normal values: the jump is forgotten, nothing to accept.
  const back = new IndexGuard({ value: 1000, at: 0 });
  back.accept(9000, MINUTE);
  assert.equal(back.accept(1000.1, 2 * MINUTE), true);
  assert.equal(back.jump, undefined);
  back.acceptJump();
  assert.equal(back.accept(9000, 3 * MINUTE), false, 'an old acceptance never covers a new jump');
});

test('index guard: a drop needs non-zero, non-decreasing values over the confirmation time', () => {
  const replaced = new IndexGuard({ value: 50_000, at: 0 });
  const minutes = INDEX_DROP_CONFIRM / MINUTE;
  for (let i = 1; i <= minutes; i += 1) {
    assert.equal(replaced.accept(10 + i * 0.01, i * MINUTE), false, `minute ${i}`);
  }
  assert.equal(replaced.accept(10 + (minutes + 1) * 0.01, (minutes + 1) * MINUTE), true);
  // A 0 or a lower value restarts the confirmation.
  const glitchy = new IndexGuard({ value: 50_000, at: 0 });
  let t = 0;
  for (let i = 0; i < minutes; i += 1) {
    t += MINUTE;
    glitchy.accept(10, t);
  }
  glitchy.accept(0, (t += MINUTE));
  assert.equal(glitchy.accept(10, (t += MINUTE)), false);
  glitchy.accept(9, (t += MINUTE));
  assert.equal(glitchy.accept(9, t + minutes * MINUTE - MINUTE), false);
  assert.equal(glitchy.accept(9, t + minutes * MINUTE), true);
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
