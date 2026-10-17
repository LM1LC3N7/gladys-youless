// -----------------------------------------------------------------------------
// Constants shared by the integration. Every key stored by Gladys (actions,
// manifest keys, feature keys in src/devices.js) is forever: never rename one.
// -----------------------------------------------------------------------------

export const ACTIONS = { TEST: 'test_connection' };

/** The type part of the external ids: `youless:<MAC>` (or `youless:<address>` for an LS110). */
export const EXTERNAL_ID_TYPE = 'youless';

// --- The local HTTP API of the YouLess (as youless-api reads it) ------------------
export const PATHS = {
  /** Model, MAC and firmware (LS120 only: an LS110 has no such page). */
  INFO: '/d',
  /** Enelogic answer of the LS120: a JSON array with one object. */
  ENELOGIC: '/e',
  /** Generic answer of the LS110 and of the LS120 PVOutput firmware. */
  GENERIC: '/a?f=j',
  /** Phases, tariff and peaks (LS120 firmware 1.5 and later). */
  PHASES: '/f',
  /** Login of a device protected by a password (password in the query, as the device wants it). */
  LOGIN: '/L?w=',
};

export const MODEL = {
  LS110: 'LS110',
  LS120: 'LS120',
  LS120_PVOUTPUT: 'LS120-PVOutput',
};

/** The phases page appeared with this firmware (youless-api: `fw[0:3] >= 1.5`). */
export const PHASES_FIRMWARE = { major: 1, minor: 5 };

export const HTTP_TIMEOUT = 5_000;
/** A YouLess page is a few hundred bytes: more is not a YouLess. */
export const MAX_BODY_BYTES = 64 * 1024;
/** At most this many cookies kept from a login answer. */
export const MAX_COOKIES = 10;

// --- Schedule ------------------------------------------------------------------------
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** The live values (power, phases): one read every 10 s, as Home Assistant does. */
export const POWER_INTERVAL = 10 * SECOND;
/** The indexes (electricity, gas, water): published once a minute. */
export const INDEX_INTERVAL = 60 * SECOND;
/** An unreachable device: tries after 10 s, then doubled up to 5 minutes. */
export const RETRY_MIN = 10 * SECOND;
export const RETRY_MAX = 5 * MINUTE;
/** A refused password: one try every 5 minutes (no hammering of the login page). */
export const AUTH_RETRY = 5 * MINUTE;
/** Unchanged values are sent again after this delay (publishChangedStates heartbeat). */
export const STATE_HEARTBEAT = 10 * MINUTE;
/** The test button answers within this delay. */
export const TEST_ANSWER_WITHIN = 25 * SECOND;

// --- Plausibility of the electricity index (the one Gladys bills) --------------------
/** A home never draws more than this on average between two reads. */
export const INDEX_MAX_KW = 100;
/** kWh always accepted on top of INDEX_MAX_KW × hours (rounding, a late read). */
export const INDEX_SLACK_KWH = 0.5;
/**
 * A drop is taken only once lower values (never 0, never decreasing) have
 * been read for this long. A jump up is never taken without the user.
 */
export const INDEX_DROP_CONFIRM = 60 * MINUTE;
/** After this many answers that are not a YouLess one in a row, the model is detected again. */
export const REDETECT_AFTER = 3;

/** A gas or water reading older than this is stale (the device keeps its last one). */
export const METER_STALE_AFTER = 26 * HOUR;
