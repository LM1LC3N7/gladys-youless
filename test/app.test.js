// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake YouLess.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { YoulessApp } from '../src/app.js';
import { ACTIONS, AUTH_RETRY, POWER_INTERVAL, RETRY_MIN } from '../src/constants.js';
import { buildDevice } from '../src/devices.js';
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

async function setup({ config = CONFIG, routes = ls120Routes(), devices = [] } = {}) {
  const fake = createFetch(routes);
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  await gladys.connect();
  const timers = createFakeTimers();
  const clock = { now: NOW };
  const logger = createLogger();
  const app = new YoulessApp({
    gladys,
    logger,
    now: () => clock.now,
    timers,
    clientFactory: (options) => new YoulessClient({ ...options, fetchImpl: fake.fetch }),
  });
  gladys.onDeviceCreated((device) => app.onDeviceCreated(device));
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
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
