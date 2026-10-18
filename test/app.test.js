// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake YouLess.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { YoulessApp } from '../src/app.js';
import { ACTIONS, AUTH_RETRY, POWER_INTERVAL, RETRY_MIN } from '../src/constants.js';
import { buildDevice } from '../src/devices.js';
import { createMemoryStore } from '../src/store.js';
import { YoulessClient } from '../src/youless/client.js';
import { capabilitiesOf, mergeCapabilities, parseEnelogic } from '../src/youless/model.js';
import { createFetch, timeoutError } from './helpers/fakeFetch.js';
import { createFakeTimers } from './helpers/fakeTimers.js';
import {
  ADDRESS,
  ENELOGIC,
  NOW,
  html,
  json,
  ls110Routes,
  ls120Routes,
} from './fixtures/youless.js';

const SELECTOR = 'youless';
const DEVICE = `ext:${SELECTOR}:youless:72b8ad14162e`;
const F = (key) => `${DEVICE}:${key}`;
const CONFIG = { address: ADDRESS };

function createLogger() {
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  return { lines, info: log, warn: log, error: log, debug: log };
}

/** The LS120 device as the user created it from the discovered one. */
function createdLs120() {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const caps = mergeCapabilities(capabilitiesOf(parseEnelogic(ENELOGIC, NOW)), {
    phases: 3,
    tariff: true,
  });
  return buildDevice(
    gladys,
    { model: 'LS120', mac: '72b8ad14162e', firmware: '1.6.0-EL' },
    caps,
    ADDRESS,
  );
}

async function setup({
  config = CONFIG,
  routes = ls120Routes(),
  devices = [],
  store = createMemoryStore(),
  now = NOW,
} = {}) {
  const fake = createFetch(routes);
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  await gladys.connect();
  const timers = createFakeTimers();
  const clock = { now };
  const logger = createLogger();
  const app = new YoulessApp({
    gladys,
    logger,
    now: () => clock.now,
    timers,
    store,
    clientFactory: (options) => new YoulessClient({ ...options, fetchImpl: fake.fetch }),
  });
  gladys.onDeviceCreated((device) => app.onDeviceCreated(device));
  gladys.onDeviceUpdated((device) => app.onDeviceUpdated(device));
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  gladys.onAction(ACTIONS.ACCEPT_HELD, () => app.acceptHeldIndex());
  /** The next 10-second tick. */
  const tick = async (ms = POWER_INTERVAL) => {
    clock.now += ms;
    await timers.runIntervals();
  };
  return { app, gladys, timers, clock, logger, fake, tick };
}

const status = (gladys) => gladys.fake.connectionStatus;
const published = (gladys, key) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === F(key));

test('no address, a wrong one: the status says so, nothing is called', async () => {
  for (const [config, pattern] of [
    [{}, /Saisissez l’adresse/],
    [{ address: 'http://admin:pw@1.2.3.4' }, /pas valide/],
  ]) {
    const { app, gladys, timers, fake } = await setup({ config });
    await app.start(config);
    await app.idle();
    assert.equal(status(gladys).connected, false);
    assert.match(status(gladys).message.fr, pattern);
    assert.equal(fake.calls.length, 0);
    assert.equal(timers.pending.size, 0);
    assert.match(String((await gladys.fake.action(ACTIONS.TEST)).data.message.fr), pattern);
  }
});

test('LS120: the device is discovered with what it gives; no value before it is created', async () => {
  const { app, gladys } = await setup();
  await app.start(CONFIG);
  await app.idle();
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.name, 'YouLess LS120');
  const keys = device.features.map((f) => f.external_id.split(':').at(-1));
  for (const key of [
    'power',
    'consumption_index',
    'injection_index',
    'gas',
    'water',
    'power_l3',
    'tariff',
  ]) {
    assert.ok(keys.includes(key), key);
  }
  assert.equal(gladys.fake.states.length, 0);
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.fr, /Découverte/);
});

test('created device: power every 10 s, indexes once a minute, gas and water as volumes', async () => {
  const routes = ls120Routes();
  const { app, gladys, tick } = await setup({ routes, devices: [createdLs120()] });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(gladys.fake.lastState(F('power')), 2382);
  assert.equal(gladys.fake.lastState(F('consumption_index')), 9194.193);
  assert.equal(gladys.fake.lastState(F('injection_index')), 0.029);
  assert.equal(gladys.fake.lastState(F('gas')), 1624.264);
  assert.equal(gladys.fake.lastState(F('water')), 1234.564);
  assert.equal(gladys.fake.lastState(F('voltage_l1')), 240);
  assert.equal(gladys.fake.lastState(F('tariff')), 1);
  assert.match(status(gladys).message.en, /Connected to the YouLess LS120/);

  // 10 s later: a new power is sent, the new index waits for the minute.
  routes['/e'] = () => json([{ ...ENELOGIC[0], pwr: 500, p1: 4703.6 }]);
  await tick();
  assert.equal(gladys.fake.lastState(F('power')), 500);
  assert.equal(gladys.fake.lastState(F('consumption_index')), 9194.193);
  for (let i = 0; i < 5; i += 1) {
    await tick();
  }
  assert.equal(gladys.fake.lastState(F('consumption_index')), 9194.231);
});

test('an index glitch never reaches Gladys', async () => {
  const routes = ls120Routes();
  const { app, gladys, tick, logger } = await setup({ routes, devices: [createdLs120()] });
  await app.start(CONFIG);
  await app.idle();
  routes['/e'] = () => json([{ ...ENELOGIC[0], p1: 0.001, p2: 0 }]);
  await tick(60_000);
  assert.deepEqual(
    published(gladys, 'consumption_index').map((s) => s.state),
    [9194.193],
  );
  assert.ok(logger.lines.some((l) => /held back/.test(l)));
});

test('unreachable device: status, growing delays, no request in between, then back', async () => {
  const routes = ls120Routes();
  const { app, gladys, tick, fake, logger } = await setup({ routes, devices: [createdLs120()] });
  await app.start(CONFIG);
  await app.idle();
  routes['/e'] = () => {
    throw timeoutError();
  };
  await tick();
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /pas de réponse.*10 s/);
  const calls = fake.calls.length;
  await tick(RETRY_MIN - 1000);
  assert.equal(fake.calls.length, calls, 'no request before the delay');
  await tick(1000);
  assert.match(status(gladys).message.fr, /20 s/);
  routes['/e'] = () => json(ENELOGIC);
  await tick(20_000);
  assert.equal(status(gladys).connected, true);
  assert.ok(!logger.lines.join('\n').includes(ADDRESS + '/'), 'no URL in the logs');
});

test('the phases page failing: logged once, the main values go on', async () => {
  const routes = ls120Routes({ '/f': () => new Response('x', { status: 500 }) });
  const { app, gladys, tick, logger } = await setup({ routes, devices: [createdLs120()] });
  await app.start(CONFIG);
  await app.idle();
  await tick();
  assert.equal(gladys.fake.lastState(F('power')), 2382);
  assert.equal(gladys.fake.lastState(F('consumption_index')), 9194.193);
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.en, /phases page does not answer/);
  assert.equal(logger.lines.filter((l) => /phases page unavailable/.test(l)).length, 1);
});

test('each reconnection publishes the device and every value again; the retry delay stays', async () => {
  const routes = ls120Routes();
  const { app, gladys, tick } = await setup({ routes, devices: [createdLs120()] });
  await app.start(CONFIG);
  await app.idle();
  const before = published(gladys, 'consumption_index').length;
  const discoveries = gladys.fake.bodies('POST', '/discovered_device').length;
  await app.start(CONFIG);
  await app.idle();
  assert.equal(published(gladys, 'consumption_index').length, before + 1);
  assert.ok(gladys.fake.bodies('POST', '/discovered_device').length > discoveries);
  // Unreachable, then a reconnection: the delay is kept; a save of the form ends it.
  routes['/e'] = () => {
    throw timeoutError();
  };
  await tick();
  await tick();
  const message = status(gladys).message.fr;
  assert.match(message, /20 s/);
  routes['/e'] = () => json(ENELOGIC);
  await app.start(CONFIG);
  await app.idle();
  assert.equal(status(gladys).connected, false);
  await app.start(CONFIG, { fresh: true });
  await app.idle();
  assert.equal(status(gladys).connected, true);
});

test('a refused password: slow retries and its own message, never the password in logs', async () => {
  const routes = ls120Routes({
    '/L': () => new Response('ok'),
    '/d': () => html(),
    '/e': () => html(),
    '/a?f=j': () => html(),
  });
  const config = { address: ADDRESS, password: 'hunter2' };
  const { app, gladys, logger, fake, tick } = await setup({ config, routes });
  await app.start(config);
  await app.idle();
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /refusé le mot de passe/);
  const calls = fake.calls.length;
  await tick(AUTH_RETRY - POWER_INTERVAL);
  assert.equal(fake.calls.length, calls);
  assert.ok(!logger.lines.join('\n').includes('hunter2'));
});

test('LS110: generic page, device by address, test button', async () => {
  const { app, gladys } = await setup({ routes: ls110Routes() });
  await app.start(CONFIG);
  await app.idle();
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, `ext:${SELECTOR}:youless:host-${ADDRESS}`);
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').at(-1)),
    ['power', 'consumption_index'],
  );
  const answer = await gladys.fake.action(ACTIONS.TEST);
  assert.match(answer.data.message.en, /LS110 read: power 750 W, consumption index 141950.625 kWh/);
});

test('the device created later: its values are read at once', async () => {
  const { app, gladys } = await setup();
  await app.start(CONFIG);
  await app.idle();
  assert.equal(gladys.fake.states.length, 0);
  await gladys.fake.deviceCreated(createdLs120());
  assert.equal(gladys.fake.lastState(F('consumption_index')), 9194.193);
  assert.match(status(gladys).message.en, /Connected/);
});

// --- Review fixes ----------------------------------------------------------------

const MINUTE = 60_000;
const indexes = (gladys) => published(gladys, 'consumption_index').map((s) => s.state);
const distinct = (values) => [...new Set(values)];

test('+50 kWh at once is held for 60 minutes and more (the margin never covers it)', async () => {
  const routes = ls120Routes();
  const { app, gladys, tick } = await setup({ routes, devices: [createdLs120()] });
  await app.start(CONFIG);
  await app.idle();
  routes['/e'] = () => json([{ ...ENELOGIC[0], p1: 4753.562 }]);
  for (let i = 0; i < 90; i += 1) {
    await tick(MINUTE);
  }
  assert.deepEqual(distinct(indexes(gladys)), [9194.193]);
  assert.match(status(gladys).message.fr, /sauté/);
});

test('an LS110 set from 2.5 to 12,345 kWh is held for 200 hours', async () => {
  const gladys0 = createFakeGladys({ selector: SELECTOR });
  const ls110 = buildDevice(
    gladys0,
    { model: 'LS110' },
    { power: true, consumption: true },
    ADDRESS,
  );
  const routes = ls110Routes({ '/a?f=j': () => json({ cnt: '2,5', pwr: 100 }) });
  const { app, gladys, tick } = await setup({ routes, devices: [ls110] });
  await app.start(CONFIG);
  await app.idle();
  routes['/a?f=j'] = () => json({ cnt: '12345,0', pwr: 100 });
  for (let i = 0; i < 200; i += 1) {
    await tick(60 * MINUTE);
  }
  const id = `${ls110.external_id}:consumption_index`;
  const values = gladys.fake.states
    .filter((s) => s.device_feature_external_id === id)
    .map((s) => s.state);
  assert.deepEqual(distinct(values), [2.5]);
});

test('a jump held stays held across a restart, until the user accepts it', async () => {
  const store = createMemoryStore();
  const routes = ls120Routes();
  const first = await setup({ routes, devices: [createdLs120()], store });
  await first.app.start(CONFIG);
  await first.app.idle();
  routes['/e'] = () => json([{ ...ENELOGIC[0], p1: 9703.562 }]);
  await first.tick(MINUTE);
  await first.app.stop();
  // A new container, hours later; Gladys still holds an old value.
  const created = createdLs120();
  const index = created.features.find((f) => f.external_id.endsWith(':consumption_index'));
  index.last_value = 9194.193;
  index.last_value_changed = new Date(NOW - 200 * 3_600_000).toISOString();
  const second = await setup({ routes, devices: [created], store, now: NOW + 5 * 3_600_000 });
  await second.app.start(CONFIG);
  await second.app.idle();
  for (let i = 0; i < 5; i += 1) {
    await second.tick(MINUTE);
  }
  assert.ok(!indexes(second.gladys).includes(14194.193));
  assert.match(status(second.gladys).message.fr, /sauté/);
  // A save of the form accepts nothing.
  await second.app.start(CONFIG, { fresh: true });
  await second.app.idle();
  assert.ok(!indexes(second.gladys).includes(14194.193));
  await second.gladys.fake.action(ACTIONS.ACCEPT_HELD);
  await second.app.idle();
  assert.equal(indexes(second.gladys).at(-1), 14194.193);
});

test('a P1 outage of 10 minutes never bills the index (neither 0 nor net)', async () => {
  const routes = ls120Routes();
  const { app, gladys, tick } = await setup({ routes, devices: [createdLs120()] });
  await app.start(CONFIG);
  await app.idle();
  routes['/e'] = () => json([{ ...ENELOGIC[0], p1: 0, p2: 0, n1: 0, n2: 0, net: 5000 }]);
  for (let i = 0; i < 10; i += 1) {
    await tick(MINUTE);
  }
  assert.match(status(gladys).message.fr, /compteur P1 ne donne pas d’index/);
  routes['/e'] = () => json([{ ...ENELOGIC[0], p1: 4703.6 }]);
  await tick(MINUTE);
  assert.deepEqual(indexes(gladys), [9194.193, 9194.231]);
  assert.doesNotMatch(status(gladys).message.fr, /P1/);
});

test('a jump up is held until the user accepts it by its action, then counted once', async () => {
  const routes = ls120Routes();
  const { app, gladys, tick } = await setup({ routes, devices: [createdLs120()] });
  await app.start(CONFIG);
  await app.idle();
  routes['/e'] = () => json([{ ...ENELOGIC[0], p1: 9703.562 }]);
  for (let i = 0; i < 90; i += 1) {
    await tick(MINUTE);
  }
  // The last accepted value may be sent again (heartbeat), never the jump.
  assert.deepEqual(distinct(indexes(gladys)), [9194.193]);
  assert.match(status(gladys).message.fr, /sauté de 9194.193 à 14194.193 kWh/);
  assert.match(status(gladys).message.fr, /5000 kWh seront comptés d’un coup comme consommation/);
  assert.match(status(gladys).message.en, /accept only if this energy was really consumed/);
  assert.match(status(gladys).message.en, /Saving the configuration accepts nothing/);
  // A simple reconnection never accepts it.
  await app.start(CONFIG);
  await app.idle();
  assert.deepEqual(distinct(indexes(gladys)), [9194.193]);
  // Nor a save of the form.
  await app.start(CONFIG, { fresh: true });
  await app.idle();
  assert.deepEqual(distinct(indexes(gladys)), [9194.193]);
  const answer = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(answer.data.message.fr, /5000 kWh .*seront comptés d’un coup/);
  await app.idle();
  assert.deepEqual(distinct(indexes(gladys)), [9194.193, 14194.193]);
  assert.equal(
    (await gladys.fake.action(ACTIONS.ACCEPT_HELD)).data.message.en,
    'No consumption index is held back: nothing to accept.',
  );
  assert.doesNotMatch(status(gladys).message.fr, /sauté/);
});

test('after "Update" in Discovery, the new features get their values', async () => {
  const gladys0 = createFakeGladys({ selector: SELECTOR });
  const small = buildDevice(
    gladys0,
    { model: 'LS120', mac: '72b8ad14162e', firmware: '1.6.0-EL' },
    { power: true, consumption: true },
    ADDRESS,
  );
  const { app, gladys } = await setup({ devices: [small] });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(gladys.fake.lastState(F('gas')), undefined);
  await gladys.fake.deviceUpdated(createdLs120());
  assert.equal(gladys.fake.lastState(F('gas')), 1624.264);
  assert.equal(gladys.fake.lastState(F('voltage_l2')), 240);
});

test('after a restart, the device published again never loses a feature', async () => {
  const created = createdLs120();
  const routes = ls120Routes({
    '/e': () => json([{ ...ENELOGIC[0], gts: 2601010000, wts: 2601010000 }]),
    '/f': () => new Response('x', { status: 500 }),
  });
  const { app, gladys } = await setup({ routes, devices: [created] });
  await app.start(CONFIG);
  await app.idle();
  const keys = (d) => d.features.map((f) => f.external_id).sort();
  assert.deepEqual(keys(gladys.fake.discoveredDevices[0]), keys(created));
});

test('detection: only a 404 of /d means LS110, only a 404 or non-Enelogic /e means PVOutput', async () => {
  for (const [routes, pattern] of [
    [ls120Routes({ '/d': () => new Response('busy', { status: 503 }) }), /erreur HTTP 503/],
    [ls120Routes({ '/e': () => new Response('busy', { status: 500 }) }), /erreur HTTP 500/],
  ]) {
    const { app, gladys } = await setup({ routes });
    await app.start(CONFIG);
    await app.idle();
    assert.equal(status(gladys).connected, false);
    assert.match(status(gladys).message.fr, pattern);
    assert.equal(gladys.fake.discoveredDevices.length, 0);
  }
});

test('a created LS120 is never downgraded to an LS110 (another device) by a detection', async () => {
  const { app, gladys, fake, tick } = await setup({
    routes: ls110Routes(),
    devices: [createdLs120()],
  });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /autre modèle/);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  assert.equal(gladys.fake.states.length, 0);
  // Back to its LS120 answers: found again under its MAC.
  Object.assign(fake.routes, ls120Routes());
  await tick(RETRY_MIN);
  assert.equal(status(gladys).connected, true);
  assert.equal(gladys.fake.discoveredDevices[0].external_id, DEVICE);
});

test('answers that are not a YouLess one, repeated: the model is detected again', async () => {
  const routes = ls120Routes();
  const { app, fake, tick } = await setup({ routes, devices: [createdLs120()] });
  await app.start(CONFIG);
  await app.idle();
  routes['/e'] = () => json({ hello: 'world' });
  const detections = () => fake.calls.filter((c) => c.path === '/d').length;
  assert.equal(detections(), 1);
  let wait = RETRY_MIN;
  for (let i = 0; i < 3; i += 1) {
    await tick(wait);
    wait *= 2;
  }
  routes['/e'] = () => json(ENELOGIC);
  await tick(wait);
  assert.equal(detections(), 2);
});

// --- Held index (drops and jumps held until accepted by their action) ---------------

/** The consumption the core would derive from the published index: the sum of its rises. */
const billed = (gladys) =>
  indexes(gladys).reduce(
    (acc, value) => ({ sum: acc.sum + Math.max(0, value - acc.prev), prev: value }),
    { sum: 0, prev: indexes(gladys)[0] },
  ).sum;

/** The /e answer with these fields. */
const enelogic = (routes, fields) => {
  routes['/e'] = () => json([{ ...ENELOGIC[0], ...fields }]);
};

test('a drop held for a week, never confirmed by time; back up, no fictive kWh', async () => {
  const routes = ls120Routes();
  const { app, gladys, tick } = await setup({ routes, devices: [createdLs120()] });
  await app.start(CONFIG);
  await app.idle();
  // Both P1 tariffs far lower (another meter, a reset): a drop, held.
  enelogic(routes, { p1: 3, p2: 2 });
  for (let i = 0; i < 7 * 24; i += 1) {
    await tick(60 * MINUTE);
  }
  assert.deepEqual(distinct(indexes(gladys)), [9194.193]);
  assert.match(status(gladys).message.fr, /a baissé de 9194.193 à 5 kWh/);
  assert.match(status(gladys).message.en, /Saving the configuration accepts nothing/);
  // The real values come back: they go on from the reference, nothing billed in between.
  enelogic(routes, { p1: 4703.6 });
  await tick(MINUTE);
  assert.equal(indexes(gladys).at(-1), 9194.231);
  assert.ok(billed(gladys) < 0.1, `billed ${billed(gladys)}`);
  assert.doesNotMatch(status(gladys).message.fr, /baissé/);
});

test('a drop accepted by its action: nothing billed, then the index rises normally', async () => {
  const routes = ls120Routes();
  const { app, gladys, tick } = await setup({ routes, devices: [createdLs120()] });
  await app.start(CONFIG);
  await app.idle();
  enelogic(routes, { p1: 3, p2: 2 });
  await tick(MINUTE);
  // A save of the form accepts nothing.
  await app.start(CONFIG, { fresh: true });
  await app.idle();
  assert.deepEqual(distinct(indexes(gladys)), [9194.193]);
  const answer = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(answer.data.message.fr, /de 9194.193 à 5 kWh.*0 kWh est compté/);
  await app.idle();
  assert.equal(indexes(gladys).at(-1), 5);
  enelogic(routes, { p1: 3.5, p2: 2 });
  await tick(MINUTE);
  assert.equal(indexes(gladys).at(-1), 5.5);
  assert.ok(Math.abs(billed(gladys) - 0.5) < 1e-6, `billed ${billed(gladys)}`);
});

test('an accepted jump never takes another value: held again, nothing billed', async () => {
  const routes = ls120Routes();
  const { app, gladys, tick } = await setup({ routes, devices: [createdLs120()] });
  await app.start(CONFIG);
  await app.idle();
  enelogic(routes, { p1: 4708.562 });
  await tick(MINUTE);
  assert.match(status(gladys).message.fr, /sauté de 9194.193 à 9199.193 kWh/);
  // Meanwhile the meter says 5000 kWh more: the user accepts what was shown.
  enelogic(routes, { p1: 9708.562 });
  await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  await app.idle();
  await tick(MINUTE);
  assert.deepEqual(distinct(indexes(gladys)), [9194.193]);
  assert.match(status(gladys).message.fr, /sauté de 9194.193 à 14199.193 kWh/);
});

test('a frozen index for 3 hours, then +4 kWh: accepted, nothing held', async () => {
  const routes = ls120Routes();
  const { app, gladys, tick } = await setup({ routes, devices: [createdLs120()] });
  await app.start(CONFIG);
  await app.idle();
  for (let i = 0; i < 180; i += 1) {
    await tick(MINUTE);
  }
  enelogic(routes, { p1: 4707.562 });
  await tick(MINUTE);
  assert.equal(indexes(gladys).at(-1), 9198.193);
  assert.doesNotMatch(status(gladys).message.fr, /sauté/);
});

test('one P1 tariff at 0 for 90 minutes, then back: no fictive kWh', async () => {
  const routes = ls120Routes();
  const { app, gladys, tick } = await setup({ routes, devices: [createdLs120()] });
  await app.start(CONFIG);
  await app.idle();
  enelogic(routes, { p2: 0 });
  for (let i = 0; i < 90; i += 1) {
    await tick(MINUTE);
  }
  assert.deepEqual(distinct(indexes(gladys)), [9194.193]);
  assert.match(status(gladys).message.fr, /tarifs P1 du compteur ne donnent pas d’index/);
  enelogic(routes, { p1: 4703.662 });
  await tick(MINUTE);
  assert.equal(indexes(gladys).at(-1), 9194.293);
  assert.ok(Math.abs(billed(gladys) - 0.1) < 1e-6, `billed ${billed(gladys)}`);
  assert.doesNotMatch(status(gladys).message.fr, /tarifs P1/);
});

test('one P1 tariff dropping alone gives no index; both lower is a drop, held', async () => {
  const routes = ls120Routes();
  const { app, gladys, tick } = await setup({ routes, devices: [createdLs120()] });
  await app.start(CONFIG);
  await app.idle();
  enelogic(routes, { p1: 4000 });
  await tick(MINUTE);
  assert.match(status(gladys).message.fr, /tarifs P1 du compteur ne donnent pas d’index/);
  assert.doesNotMatch(status(gladys).message.fr, /baissé/);
  enelogic(routes, { p1: 4000, p2: 4000 });
  await tick(MINUTE);
  assert.match(status(gladys).message.fr, /a baissé de 9194.193 à 8000 kWh/);
  assert.deepEqual(distinct(indexes(gladys)), [9194.193]);
});

test('the held index stays in every status while the YouLess cannot be read', async () => {
  const routes = ls120Routes();
  const { app, gladys, tick } = await setup({ routes, devices: [createdLs120()] });
  await app.start(CONFIG);
  await app.idle();
  enelogic(routes, { p1: 9703.562 });
  await tick(MINUTE);
  routes['/e'] = () => {
    throw timeoutError();
  };
  await tick(MINUTE);
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /pas de réponse.*sauté de 9194.193 à 14194.193 kWh/);
  // A password asked (the login page answered).
  routes['/e'] = () => html();
  await tick(5 * MINUTE);
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /mot de passe.*sauté de 9194.193 à 14194.193 kWh/);
});

test('a held index read back from /data shows in a password refused at the start', async () => {
  const store = createMemoryStore();
  await store.save({
    [F('consumption_index')]: {
      last: { value: 9194.193, at: NOW - MINUTE },
      held: { direction: 'down', from: 9194.193, to: 5, threshold: 5, at: NOW - MINUTE },
      tariffs: null,
    },
  });
  const routes = ls120Routes({
    '/L': () => new Response('ok'),
    '/d': () => html(),
    '/e': () => html(),
    '/a?f=j': () => html(),
  });
  const config = { address: ADDRESS, password: 'hunter2' };
  const { app, gladys } = await setup({ config, routes, devices: [createdLs120()], store });
  await app.start(config);
  await app.idle();
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /refusé le mot de passe.*a baissé de 9194.193 à 5 kWh/);
});

test('a held index shows in the downgrade status too', async () => {
  const store = createMemoryStore();
  await store.save({
    [F('consumption_index')]: {
      last: { value: 9194.193, at: NOW - MINUTE },
      held: { direction: 'up', from: 9194.193, to: 14194.193, threshold: 14194.193, at: 0 },
    },
  });
  const { app, gladys } = await setup({ routes: ls110Routes(), devices: [createdLs120()], store });
  await app.start(CONFIG);
  await app.idle();
  assert.match(status(gladys).message.fr, /autre modèle.*sauté de 9194.193 à 14194.193 kWh/);
});

test('the /data state of 0.1.1 ({ last, jump }, days old) is migrated: held until accepted', async () => {
  const DAY = 24 * 60 * MINUTE;
  const old = () => ({
    [F('consumption_index')]: {
      last: { value: 9194.193, at: NOW - 6 * DAY },
      jump: { from: 9194.193, to: 14194.193, threshold: 14194.193 },
    },
  });
  // Gladys holds the same old value: the oldest date is kept.
  const created = () => {
    const device = createdLs120();
    const index = device.features.find((f) => f.external_id.endsWith(':consumption_index'));
    index.last_value = 9194.193;
    index.last_value_changed = new Date(NOW - 6 * DAY).toISOString();
    return device;
  };
  const store = createMemoryStore();
  await store.save(old());
  const routes = ls120Routes();
  enelogic(routes, { p1: 9703.562 });
  const { app, gladys, tick } = await setup({ routes, devices: [created()], store });
  await app.start(CONFIG);
  await app.idle();
  for (let i = 0; i < 5; i += 1) {
    await tick(MINUTE);
  }
  // Six days of margin (14,400 kWh) never let the migrated jump through.
  assert.ok(!indexes(gladys).includes(14194.193));
  assert.match(status(gladys).message.fr, /sauté de 9194.193 à 14194.193 kWh/);
  // Written back in the new shape.
  const saved = store.load()[F('consumption_index')];
  assert.equal(saved.held.direction, 'up');
  assert.equal(saved.jump, undefined);
  // Meanwhile the meter says 1000 kWh more (less than the 6 days of margin
  // since the old reference); the user accepts what was shown: held again.
  enelogic(routes, { p1: 10703.562 });
  await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  await app.idle();
  await tick(MINUTE);
  assert.deepEqual(distinct(indexes(gladys)), [9194.193]);
  assert.match(status(gladys).message.fr, /sauté de 9194.193 à 15194.193 kWh/);

  // The same old state, the value shown accepted: counted once.
  const store2 = createMemoryStore();
  await store2.save(old());
  const routes2 = ls120Routes();
  enelogic(routes2, { p1: 9703.562 });
  const second = await setup({ routes: routes2, devices: [created()], store: store2 });
  await second.app.start(CONFIG);
  await second.app.idle();
  assert.deepEqual(distinct(indexes(second.gladys)), [9194.193]);
  await second.gladys.fake.action(ACTIONS.ACCEPT_HELD);
  await second.app.idle();
  assert.equal(indexes(second.gladys).at(-1), 14194.193);
});

test('a register stuck in a state that gives no index: deleting and creating the device ends it', async () => {
  const routes = ls120Routes();
  const store = createMemoryStore();
  const { app, gladys, tick } = await setup({ routes, devices: [createdLs120()], store });
  await app.start(CONFIG);
  await app.idle();
  // A new meter whose second register stays at 0, higher on the first one.
  enelogic(routes, { p1: 9000, p2: 0 });
  for (let i = 0; i < 30; i += 1) {
    await tick(MINUTE);
  }
  assert.deepEqual(distinct(indexes(gladys)), [9194.193]);
  assert.match(status(gladys).message.fr, /tarifs P1 du compteur ne donnent pas d’index/);
  await gladys.fake.deviceCreated(createdLs120());
  await app.idle();
  assert.equal(indexes(gladys).at(-1), 9000);
});

test('another address or password: the P1 tariff reference starts again', async () => {
  const routes = ls120Routes();
  const { app } = await setup({ routes, devices: [createdLs120()] });
  await app.start(CONFIG);
  await app.idle();
  assert.deepEqual(app.tariffRef, { p1: 4703.562, p2: 4490.631 });
  await app.start({ address: '192.168.1.51' });
  assert.equal(app.tariffRef, undefined);
  assert.equal(app.guard, undefined);
});

test('the LS110 index (cnt) never goes through the P1 tariff check', async () => {
  const gladys0 = createFakeGladys({ selector: SELECTOR });
  const ls110 = buildDevice(
    gladys0,
    { model: 'LS110' },
    { power: true, consumption: true },
    ADDRESS,
  );
  const routes = ls110Routes({ '/a?f=j': () => json({ cnt: '1000,0', pwr: 100 }) });
  const { app, gladys, tick } = await setup({ routes, devices: [ls110] });
  await app.start(CONFIG);
  await app.idle();
  routes['/a?f=j'] = () => json({ cnt: '1000,1', pwr: 100 });
  await tick(MINUTE);
  const id = `${ls110.external_id}:consumption_index`;
  const values = gladys.fake.states
    .filter((s) => s.device_feature_external_id === id)
    .map((s) => s.state);
  assert.deepEqual(values, [1000, 1000.1]);
  assert.equal(app.tariffRef, undefined);
  assert.doesNotMatch(status(gladys).message.fr, /tarifs P1/);
});

test('while a value is held, a migrated old reference never bills a large rise', async () => {
  const DAY = 24 * 60 * MINUTE;
  const store = createMemoryStore();
  await store.save({
    [F('consumption_index')]: {
      last: { value: 9194.193, at: NOW - 5 * DAY },
      jump: { from: 9194.193, to: 15000, threshold: 15000 },
    },
  });
  const routes = ls120Routes();
  // 14000 kWh: below the threshold, within 5 days of margin from the old reference.
  enelogic(routes, { p1: 9509.369 });
  const { app, gladys, tick } = await setup({ routes, devices: [createdLs120()], store });
  await app.start(CONFIG);
  await app.idle();
  await tick(MINUTE);
  assert.ok(!indexes(gladys).includes(14000));
  assert.equal(billed(gladys), 0);
  assert.match(status(gladys).message.fr, /sauté de 9194.193 à 14000 kWh/);
  assert.match(status(gladys).message.fr, /4805.807 kWh seront comptés/);
});

test('P1 tariff counters: not sent without an index, never 0 after a value above 0', async () => {
  const routes = ls120Routes();
  const { app, gladys, tick } = await setup({ routes, devices: [createdLs120()] });
  await app.start(CONFIG);
  await app.idle();
  const t2 = () => published(gladys, 'consumption_tariff2').map((s) => s.state);
  assert.deepEqual(t2(), [4490.631]);
  // One register at 0: no index, so no tariff counter either.
  enelogic(routes, { p2: 0 });
  for (let i = 0; i < 15; i += 1) {
    await tick(MINUTE);
  }
  assert.deepEqual(distinct(t2()), [4490.631]);
  // Both lower, one at 0: a drop for the guard (an index exists, held), yet
  // the counter at 0 is never sent after a value above 0.
  enelogic(routes, { p1: 3, p2: 0 });
  await tick(MINUTE);
  assert.match(status(gladys).message.fr, /a baissé/);
  assert.ok(!t2().includes(0), 'never 0 after a value above 0');
  assert.ok(published(gladys, 'consumption_tariff1').every((s) => s.state > 0));
  // A single-tariff meter (p2 always 0) still gets its counters.
  const single = await setup({
    routes: ls120Routes({ '/e': () => json([{ ...ENELOGIC[0], p2: 0 }]) }),
    devices: [createdLs120()],
  });
  await single.app.start(CONFIG);
  await single.app.idle();
  assert.deepEqual(
    single.gladys.fake.states
      .filter((s) => s.device_feature_external_id === F('consumption_tariff2'))
      .map((s) => s.state),
    [0],
  );
});

test('the held index shows in the "no address" and "invalid address" statuses', async () => {
  for (const [config, pattern] of [
    [{}, /Saisissez l’adresse.*sauté de 9194.193 à 14194.193 kWh/],
    [{ address: 'bad host' }, /pas valide.*sauté de 9194.193 à 14194.193 kWh/],
  ]) {
    const store = createMemoryStore();
    await store.save({
      [F('consumption_index')]: {
        last: { value: 9194.193, at: NOW - MINUTE },
        held: { direction: 'up', from: 9194.193, to: 14194.193, threshold: 14194.193, at: 0 },
      },
    });
    const { app, gladys } = await setup({ config, devices: [createdLs120()], store });
    await app.start(config);
    await app.idle();
    assert.equal(status(gladys).connected, false);
    assert.match(status(gladys).message.fr, pattern);
  }
});
