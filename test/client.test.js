// -----------------------------------------------------------------------------
// The HTTP client against a fake YouLess: detection, login, errors.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BODY_BYTES, MODEL } from '../src/constants.js';
import { YoulessClient, YoulessError } from '../src/youless/client.js';
import { createFetch, refusedError, timeoutError } from './helpers/fakeFetch.js';
import {
  ADDRESS,
  ENELOGIC,
  NOW,
  html,
  json,
  ls110Routes,
  ls120Routes,
} from './fixtures/youless.js';

const client = (routes, extra = {}) => {
  const fake = createFetch(routes);
  return {
    fake,
    client: new YoulessClient({
      address: ADDRESS,
      fetchImpl: fake.fetch,
      now: () => NOW,
      ...extra,
    }),
  };
};

test('LS120 Enelogic: /d then /e, phases from firmware 1.6', async () => {
  const { client: c, fake } = client(ls120Routes());
  const device = await c.detect();
  assert.deepEqual(device, {
    model: MODEL.LS120,
    mac: '72b8ad14162e',
    firmware: '1.6.0-EL',
    endpoint: 'enelogic',
    phases: true,
  });
  const snapshot = await c.read(device);
  assert.equal(snapshot.power, 2382);
  assert.equal(snapshot.phases.length, 3);
  assert.equal(snapshot.tariff, 1);
  assert.deepEqual(
    fake.calls.map((call) => call.path),
    ['/d', '/e', '/e', '/f'],
  );
  assert.equal(fake.calls[0].url, `http://${ADDRESS}/d`);
  assert.equal(fake.calls[0].init.redirect, 'manual');
});

test('LS120 PVOutput firmware: /e is not Enelogic, /a?f=j is read', async () => {
  const { client: c } = client(ls120Routes({ '/e': () => html() }));
  const device = await c.detect();
  assert.equal(device.model, MODEL.LS120_PVOUTPUT);
  assert.equal(device.endpoint, 'generic');
  const snapshot = await c.read(device);
  assert.equal(snapshot.consumption.total, 141950.625);
});

test('LS110: no /d page, read through /a?f=j, known by its address', async () => {
  const { client: c, fake } = client(ls110Routes());
  const device = await c.detect();
  assert.deepEqual(device, { model: MODEL.LS110, endpoint: 'generic', phases: false });
  await c.read(device);
  assert.ok(!fake.calls.some((call) => call.path === '/f'));
});

test('a network failure during detection is never taken for an LS110', async () => {
  const { client: c } = client({
    '/d': () => {
      throw timeoutError();
    },
  });
  await assert.rejects(c.detect(), (err) => err.code === 'timeout');
  const { client: refused } = client({
    '/d': () => {
      throw refusedError();
    },
  });
  await assert.rejects(
    refused.detect(),
    (err) => err.code === 'unreachable' && err.message === 'unreachable (ECONNREFUSED)',
  );
});

test('the phases page failing never holds back the main values', async () => {
  const { client: c } = client(ls120Routes({ '/f': () => new Response('x', { status: 500 }) }));
  const device = await c.detect();
  const snapshot = await c.read(device);
  assert.equal(snapshot.power, 2382);
  assert.equal(snapshot.phasesError.code, 'http');
  assert.deepEqual(snapshot.phases, []);
});

test('password: login first, cookies sent back, a refused one is reported', async () => {
  let unlocked = false;
  const routes = ls120Routes({
    '/L': (call) => {
      unlocked = new URL(call.url).searchParams.get('w') === 'p@ss w';
      return new Response('ok', { status: 200, headers: { 'set-cookie': 'sid=abc; Path=/' } });
    },
    '/d': () => (unlocked ? json({ mac: '72:b8:ad:14:16:2e', fw: '1.6.0' }) : html()),
    '/e': () => (unlocked ? json(ENELOGIC) : html()),
  });
  const { client: c, fake } = client(routes, { password: 'p@ss w' });
  const device = await c.detect();
  assert.equal(device.model, MODEL.LS120);
  assert.equal(fake.calls[0].path, '/L');
  assert.equal(fake.calls[1].headers.Cookie, 'sid=abc');
  // A refused password: one new login, one new try, then the error.
  const { client: c2 } = client(
    {
      ...routes,
      '/L': () => new Response('ok', { status: 200 }),
      '/e': () => html(),
    },
    { password: 'wrong' },
  );
  await assert.rejects(c2.read({ endpoint: 'enelogic' }), (err) => err.code === 'auth');
});

test('a protected device without password says so; errors never quote the device', async () => {
  const secret = '<html>secret-page-text</html>';
  const { client: c } = client(ls110Routes({ '/a?f=j': () => html(secret) }));
  await assert.rejects(c.detect(), (err) => {
    assert.equal(err.code, 'protected');
    assert.ok(!err.message.includes('secret-page-text'));
    return true;
  });
  const { client: c2 } = client(
    ls110Routes({ '/a?f=j': () => new Response('boom', { status: 500 }) }),
  );
  await assert.rejects(c2.read({ endpoint: 'generic' }), (err) => {
    assert.equal(err.code, 'http');
    assert.equal(err.message, 'HTTP 500');
    return true;
  });
  const { client: c3 } = client(ls110Routes({ '/a?f=j': () => json({ hello: 'world' }) }));
  await assert.rejects(c3.read({ endpoint: 'generic' }), (err) => err.code === 'unknown_answer');
  const { client: c4 } = client(
    ls110Routes({ '/a?f=j': () => new Response('plain', { status: 200 }) }),
  );
  await assert.rejects(c4.read({ endpoint: 'generic' }), (err) => err.code === 'not_data');
});

test('an answer larger than a YouLess sends is cut', async () => {
  const big = 'x'.repeat(MAX_BODY_BYTES + 10);
  const { client: c } = client(ls110Routes({ '/a?f=j': () => new Response(big) }));
  await assert.rejects(c.read({ endpoint: 'generic' }), (err) => {
    assert.ok(err instanceof YoulessError);
    return err.code === 'too_large';
  });
});
