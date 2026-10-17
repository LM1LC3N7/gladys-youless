// -----------------------------------------------------------------------------
// YouLess answers, shaped after the tests of youless-api (gjong/youless-python-bridge)
// and the fields its code reads. Synthetic: never captured on a real device.
// -----------------------------------------------------------------------------

export const ADDRESS = '192.168.1.50';
export const MAC = '72b8ad14162e';
/** 2026-10-17 12:00 UTC */
export const NOW = Date.UTC(2026, 9, 17, 12, 0);
/** A gts / wts stamp of 11:00 on the same day (yymmddhhmm). */
export const STAMP = 2610171100;

export const INFO = { model: 'LS120', mac: '72:b8:ad:14:16:2e', fw: '1.6.0-EL' };

export const ENELOGIC = [
  {
    tm: 1611929119,
    net: 9194.164,
    pwr: 2382,
    ts0: 1608654000,
    cs0: 15.0,
    ps0: 10,
    p1: 4703.562,
    p2: 4490.631,
    n1: 0.029,
    n2: 0.0,
    gas: 1624.264,
    gts: STAMP,
    wtr: 1234.564,
    wts: STAMP,
  },
];

export const PHASES = {
  tr: 1,
  i1: 0.123,
  v1: 240,
  l1: 462,
  v2: 240,
  l2: 230,
  i2: 0.123,
  v3: 240,
  l3: 230,
  i3: 0.123,
  pp: 1200,
  pts: STAMP,
  pa: 400,
};

export const GENERIC = {
  cnt: '141950,625',
  pwr: 750,
  lvl: 90,
  dev: '(&plusmn;3%)',
  det: '',
  con: 'OK',
  sts: '(33)',
  raw: 743,
};

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const html = (body = '<html><body>Login</body></html>', status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } });

export const notFound = () => new Response('Not found', { status: 404 });

/** The routes of an LS120 with the Enelogic firmware (1.6, phases page). */
export const ls120Routes = (overrides = {}) => ({
  '/d': () => json(INFO),
  '/e': () => json(ENELOGIC),
  '/f': () => json(PHASES),
  '/a?f=j': () => json(GENERIC),
  ...overrides,
});

/** The routes of an LS110: no /d, no /e. */
export const ls110Routes = (overrides = {}) => ({
  '/d': () => notFound(),
  '/e': () => notFound(),
  '/a?f=j': () => json({ ...GENERIC, cs0: ' 0,000', ps0: 0 }),
  ...overrides,
});
