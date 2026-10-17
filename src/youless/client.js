// -----------------------------------------------------------------------------
// The local HTTP API of a YouLess (plain HTTP on the home network, no cloud),
// after youless-api (gjong/youless-python-bridge, MIT, see
// THIRD_PARTY_NOTICES.md):
//
//   detection   /d answers 404                -> LS110, read /a?f=j
//               /d answers a device page (200) -> /e answers Enelogic JSON?
//                    yes          -> LS120, read /e (+ /f from firmware 1.5)
//                    404, or 200 without Enelogic data
//                                 -> LS120 PVOutput firmware, read /a?f=j
//               anything else (another status, a network error) is a passing
//               error, never a guess: a wrong guess would change the
//               external id or the billed index.
//
// Password: youless-api sends HTTP Basic credentials; this integration does
// NOT port that. It ASSUMES the login of the device's web page,
// GET /L?w=<password> (not checked on a protected device), and sends back
// the cookies it sets, if any. The password goes to the configured address
// only, and no URL is ever logged (the login one holds it).
//
// Errors carry our own words and codes, never a text of the device.
// -----------------------------------------------------------------------------

import {
  AUTH_RETRY,
  HTTP_TIMEOUT,
  MAX_BODY_BYTES,
  MAX_COOKIES,
  MODEL,
  PATHS,
} from '../constants.js';
import { parseEnelogic, parseGeneric, parseInfo, parsePhases, supportsPhases } from './model.js';

export class YoulessError extends Error {
  /**
   * @param {'timeout'|'unreachable'|'http'|'too_large'|'not_data'|'auth'|'protected'|'unknown_answer'|'downgrade'} code
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

/** A network failure (while connecting or while reading the body), in our words. */
function networkError(err) {
  if (err instanceof YoulessError) {
    return err;
  }
  const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  const code = systemCode(err);
  return new YoulessError(
    timeout ? 'timeout' : 'unreachable',
    timeout ? 'no answer' : `unreachable${code ? ` (${code})` : ''}`,
  );
}

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

const notYouless = () =>
  new YoulessError('unknown_answer', 'the device answer is not a YouLess one');

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
    /** The phases page refused the password: left alone until then (the main session is kept). */
    this.phasesPausedUntil = 0;
  }

  /** One GET: `{ status, contentType, text, json }`, `json` undefined when it is not JSON. */
  async raw(path) {
    const headers = { Accept: 'application/json, text/plain, */*' };
    if (this.cookies.size > 0) {
      headers.Cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    let response;
    let text;
    try {
      response = await this.fetch(`http://${this.address}${path}`, {
        method: 'GET',
        headers,
        // A redirect is never followed: the password stays on this address.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeout),
      });
      // The body can fail too (timeout, connection cut): same errors.
      text = await readBounded(response, MAX_BODY_BYTES);
    } catch (err) {
      throw networkError(err);
    }
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

  /** An answer refused, or a web page instead of data, without a password configured. */
  passwordError(answer) {
    return this.password
      ? new YoulessError('auth', 'password refused', answer.status)
      : new YoulessError('protected', 'the device asks for a password', answer.status);
  }

  /**
   * A data page (JSON). A refusal or a web page instead of data means the
   * device wants its password: with one configured, one new login and one
   * new try (`relogin: false` for a secondary page: no login for it).
   */
  async data(path, { relogin = true } = {}) {
    if (this.password && !this.loggedIn) {
      await this.login();
    }
    let answer = await this.raw(path);
    const locked = (a) =>
      a.status === 401 || a.status === 403 || (a.json === undefined && looksLikePage(a));
    if (locked(answer)) {
      if (!this.password || !relogin) {
        throw this.passwordError(answer);
      }
      await this.login();
      answer = await this.raw(path);
      if (locked(answer)) {
        this.loggedIn = false;
        throw this.passwordError(answer);
      }
    }
    if (answer.status < 200 || answer.status >= 300) {
      throw new YoulessError('http', `HTTP ${answer.status}`, answer.status);
    }
    if (answer.json === undefined) {
      throw new YoulessError('not_data', 'the device answered something that is not data');
    }
    return answer.json;
  }

  /**
   * Model, MAC, firmware and the page to read. Only a 404 of /d means LS110,
   * only a 404 or a non-Enelogic 200 of /e means the PVOutput firmware; any
   * other answer, and every network error, goes up as a passing error.
   */
  async detect() {
    if (this.password) {
      await this.login();
    }
    const infoAnswer = await this.raw(PATHS.INFO);
    if (infoAnswer.status === 404) {
      if (!parseGeneric(await this.data(PATHS.GENERIC))) {
        throw notYouless();
      }
      return { model: MODEL.LS110, endpoint: 'generic', phases: false };
    }
    if (infoAnswer.status === 401 || infoAnswer.status === 403) {
      throw this.passwordError(infoAnswer);
    }
    if (infoAnswer.status !== 200) {
      throw new YoulessError('http', `HTTP ${infoAnswer.status}`, infoAnswer.status);
    }
    const info = parseInfo(infoAnswer.json);
    if (!info) {
      throw infoAnswer.json === undefined && looksLikePage(infoAnswer)
        ? this.passwordError(infoAnswer)
        : notYouless();
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
    if (enelogic.status !== 200 && enelogic.status !== 404) {
      throw new YoulessError('http', `HTTP ${enelogic.status}`, enelogic.status);
    }
    if (!parseGeneric(await this.data(PATHS.GENERIC))) {
      throw notYouless();
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
   * never thrown, so the power and the indexes always go through. A phases
   * page refusing the password is left alone for AUTH_RETRY, without a new
   * login (the main page keeps its session).
   * `p1Known`: the device showed P1 values before (src/youless/model.js).
   */
  async read(device, { p1Known = false } = {}) {
    const snapshot =
      device.endpoint === 'enelogic'
        ? parseEnelogic(await this.data(PATHS.ENELOGIC), this.now(), { p1Known })
        : parseGeneric(await this.data(PATHS.GENERIC));
    if (!snapshot) {
      throw notYouless();
    }
    if (device.phases) {
      if (this.now() < this.phasesPausedUntil) {
        snapshot.phasesError = new YoulessError('auth', 'phases page paused');
        return snapshot;
      }
      try {
        const phases = parsePhases(await this.data(PATHS.PHASES, { relogin: false }));
        if (!phases) {
          throw new YoulessError('not_data', 'unexpected phases page');
        }
        snapshot.phases = phases.phases;
        snapshot.tariff = phases.tariff;
      } catch (err) {
        if (err.code === 'auth' || err.code === 'protected') {
          this.phasesPausedUntil = this.now() + AUTH_RETRY;
        }
        snapshot.phasesError = err;
      }
    }
    return snapshot;
  }
}
