// -----------------------------------------------------------------------------
// A fake `fetch` for the YouLess client: routes by path (and query), records
// every call, fails loudly on an unexpected one. No test touches the network.
// -----------------------------------------------------------------------------

/**
 * `routes` maps a path ("/e", "/a?f=j", or "/L" for the login whatever its
 * password) to handler({ url, path, init }) -> Response, or throws.
 */
export function createFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    const path = pathname === '/L' ? '/L' : `${pathname}${search}`;
    const call = { url, path, init, headers: init.headers ?? {} };
    calls.push(call);
    const handler = routes[path];
    if (!handler) {
      throw new Error(`Unexpected YouLess call in a test: ${path}`);
    }
    return handler(call);
  };
  return { fetch: fetchImpl, calls, routes };
}

/** What fetch throws when the device does not answer in time. */
export const timeoutError = () => {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'TimeoutError';
  return err;
};

/** What fetch throws when nothing listens at the address. */
export const refusedError = () => {
  const err = new TypeError('fetch failed');
  err.cause = { code: 'ECONNREFUSED' };
  return err;
};
