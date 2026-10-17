// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// -----------------------------------------------------------------------------

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * An address typed by the user: an IP address or a host name, with an
 * optional port. A pasted URL ("http://192.168.1.30/a?f=j") is reduced to its
 * host and port.
 * @returns {{ address: string } | { error: 'invalid' }} `address` is '' when empty.
 */
export function parseAddress(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return { address: '' };
  }
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '');
  // user:password@ never belongs in the address: refused rather than sent around.
  if (text.includes('@')) {
    return { error: 'invalid' };
  }
  const bracketed = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(text);
  if (bracketed) {
    return withPort(`[${bracketed[1].toLowerCase()}]`, bracketed[2]);
  }
  if (/^[0-9a-f:.]+$/i.test(text) && (text.match(/:/g) ?? []).length >= 2) {
    return { address: `[${text.toLowerCase()}]` };
  }
  const match = /^(.*?)(?::(\d{1,5}))?$/.exec(text);
  const host = match[1];
  if (host.length > 253 || !host.split('.').every((label) => LABEL.test(label))) {
    return { error: 'invalid' };
  }
  return withPort(host.toLowerCase(), match[2]);
}

function withPort(host, port) {
  if (port === undefined) {
    return { address: host };
  }
  const number = Number(port);
  if (number < 1 || number > 65535) {
    return { error: 'invalid' };
  }
  return { address: number === 80 ? host : `${host}:${number}` };
}

export function normalizeConfig(raw = {}) {
  const parsed = parseAddress(raw?.address);
  return {
    address: parsed.error ? '' : parsed.address,
    invalidAddress: Boolean(parsed.error),
    // A password is taken as typed: spaces may belong to it.
    password: typeof raw?.password === 'string' ? raw.password : '',
  };
}
