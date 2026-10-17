// -----------------------------------------------------------------------------
// The local HTTP API of a YouLess (plain HTTP on the home network, no cloud),
// after youless-api (gjong/youless-python-bridge, MIT, see
// THIRD_PARTY_NOTICES.md):
//
//   detection   /d answers (MAC, firmware)?  no -> LS110, read /a?f=j
//                                            yes -> /e answers Enelogic JSON?
//                                                   yes -> LS120, read /e (+ /f from firmware 1.5)
//                                                   no  -> LS120 PVOutput firmware, read /a?f=j
//
// A device protected by a password is opened with GET /L?w=<password> (the
// login of its web page); the cookies it sets, if any, are sent back. The
// password goes to the configured address only, and no URL is ever logged
// (the login one holds it).
//
// Errors carry our own words and codes, never a text of the device.
// -----------------------------------------------------------------------------

import { HTTP_TIMEOUT, MAX_BODY_BYTES, MAX_COOKIES, MODEL, PATHS } from '../constants.js';
import { parseEnelogic, parseGeneric, parseInfo, parsePhases, supportsPhases } from './model.js';

export class YoulessError extends Error {
  /**
   * @param {'timeout'|'unreachable'|'http'|'too_large'|'not_data'|'auth'|'protected'|'unknown_answer'} code
   */
  constructor(code, message, status) {
    super(message);
    this.name = 'YoulessError';
    this.code = code;
    this.status = status;
  }
}

/** A system error code (ECONNREFUSED...) is ours to show; anything else is not. */
const systemCode = (err) => {
  const code = err?.cause?.code ?? err?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,30}$/.test(code) ? code : undefined;
};

/** The body, read up to `limit` bytes: a longer one is not a YouLess. */
async function readBounded(response, limit) {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new YoulessError('too_large', 'the device answered more than a YouLess sends');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

const looksLikePage = (answer) =>
  /html/i.test(answer.contentType) || /^\s*</.test(answer.text.slice(0, 64));

export class YoulessClient {
  constructor({
    address,
    password = '',
    now = Date.now,
    fetchImpl = (...args) => globalThis.fetch(...args),
    timeout = HTTP_TIMEOUT,
  }) {
    this.address = address;
    this.password = password;
    this.now = now;
    this.fetch = fetchImpl;
    this.timeout = timeout;
    /** name -> value, from the login answer */
    this.cookies = new Map();
    this.loggedIn = false;
  }

  /** One GET: `{ status, contentType, text, json }`, `json` undefined when it is not JSON. */
  async raw(path) {
    const headers = { Accept: 'application/json, text/plain, */*' };
    if (this.cookies.size > 0) {
      headers.Cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    let response;
    try {
      response = await this.fetch(`http://${this.address}${path}`, {
        method: 'GET',
        headers,
        // A redirect is never followed: the password stays on this address.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (err) {
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      const code = systemCode(err);
      throw new YoulessError(
        timeout ? 'timeout' : 'unreachable',
        timeout ? 'no answer' : `unreachable${code ? ` (${code})` : ''}`,
      );
    }
    const text = await readBounded(response, MAX_BODY_BYTES);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      text,
      json,
      setCookies:
        typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [],
    };
  }

  /** The login of a protected device; its cookies are kept for the next requests. */
  async login() {
    const answer = await this.raw(`${PATHS.LOGIN}${encodeURIComponent(this.password)}`);
    for (const line of answer.setCookies.slice(0, MAX_COOKIES)) {
      const match = /^\s*([^=;\s]{1,64})=([^;]{0,512})/.exec(line);
      if (match) {
        this.cookies.set(match[1], match[2].trim());
      }
    }
    while (this.cookies.size > MAX_COOKIES) {
      this.cookies.delete(this.cookies.keys().next().value);
    }
    this.loggedIn = true;
  }

  /**
   * A data page (JSON). A refusal or a web page instead of data means the
   * device wants its password: with one configured, one new login and one
   * new try.
   */
  async data(path) {
    if (this.password && !this.loggedIn) {
      await this.login();
    }
    let answer = await this.raw(path);
    const locked = (a) =>
      a.status === 401 || a.status === 403 || (a.json === undefined && looksLikePage(a));
    if (this.password && locked(answer)) {
      await this.login();
      answer = await this.raw(path);
      if (locked(answer)) {
        this.loggedIn = false;
        throw new YoulessError('auth', 'password refused', answer.status);
      }
    }
    if (answer.status === 401 || answer.status === 403) {
      throw new YoulessError('protected', 'the device asks for a password', answer.status);
    }
    if (answer.status < 200 || answer.status >= 300) {
      throw new YoulessError('http', `HTTP ${answer.status}`, answer.status);
    }
    if (answer.json === undefined) {
      throw looksLikePage(answer)
        ? new YoulessError('protected', 'the device answered a web page instead of data')
        : new YoulessError('not_data', 'the device answered something that is not data');
    }
    return answer.json;
  }

  /** Model, MAC, firmware and the page to read. Network errors go up (never taken for an LS110). */
  async detect() {
    if (this.password) {
      await this.login();
    }
    const infoAnswer = await this.raw(PATHS.INFO);
    const info = infoAnswer.status === 200 ? parseInfo(infoAnswer.json) : undefined;
    if (!info) {
      const snapshot = parseGeneric(await this.data(PATHS.GENERIC));
      if (!snapshot) {
        throw new YoulessError('unknown_answer', 'the device answer is not a YouLess one');
      }
      return { model: MODEL.LS110, endpoint: 'generic', phases: false };
    }
    const enelogic = await this.raw(PATHS.ENELOGIC);
    if (enelogic.status === 200 && parseEnelogic(enelogic.json, this.now())) {
      return {
        model: MODEL.LS120,
        mac: info.mac,
        firmware: info.firmware,
        endpoint: 'enelogic',
        phases: supportsPhases(info.firmware),
      };
    }
    if (!parseGeneric(await this.data(PATHS.GENERIC))) {
      throw new YoulessError('unknown_answer', 'the device answer is not a YouLess one');
    }
    return {
      model: MODEL.LS120_PVOUTPUT,
      mac: info.mac,
      firmware: info.firmware,
      endpoint: 'generic',
      phases: false,
    };
  }

  /**
   * One read: the main page, then the phases page when the firmware has one.
   * The phases are secondary: their failure is returned (`phasesError`),
   * never thrown, so the power and the indexes always go through.
   */
  async read(device) {
    const snapshot =
      device.endpoint === 'enelogic'
        ? parseEnelogic(await this.data(PATHS.ENELOGIC), this.now())
        : parseGeneric(await this.data(PATHS.GENERIC));
    if (!snapshot) {
      throw new YoulessError('unknown_answer', 'the device answer is not a YouLess one');
    }
    if (device.phases) {
      try {
        const phases = parsePhases(await this.data(PATHS.PHASES));
        if (!phases) {
          throw new YoulessError('not_data', 'unexpected phases page');
        }
        snapshot.phases = phases.phases;
        snapshot.tariff = phases.tariff;
      } catch (err) {
        snapshot.phasesError = err;
      }
    }
    return snapshot;
  }
}
