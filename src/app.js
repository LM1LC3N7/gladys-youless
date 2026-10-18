// -----------------------------------------------------------------------------
// The integration itself: detection of the YouLess, its device, the reads
// (every 10 s, the indexes published once a minute), the plausibility of the
// billed index, the retries of an unreachable device and the test button.
// index.js only wires the SDK handlers to it.
//
// The created devices are read from `gladys.devices`, which the SDK keeps up
// to date (connection, creation, update, deletion): never a copy of our own.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import {
  AUTH_RETRY,
  EXTERNAL_ID_TYPE,
  INDEX_INTERVAL,
  MODEL,
  POWER_INTERVAL,
  REDETECT_AFTER,
  RETRY_MAX,
  RETRY_MIN,
  STATE_HEARTBEAT,
  TEST_ANSWER_WITHIN,
} from './constants.js';
import {
  FEATURE,
  buildDevice,
  capabilitiesOfDevice,
  ids,
  indexStates,
  liveStates,
  paramOf,
  round,
} from './devices.js';
import { IndexGuard, indexOfTariffs } from './guard.js';
import { createFileStore } from './store.js';
import { T, withNotes } from './i18n.js';
import { YoulessClient, YoulessError } from './youless/client.js';
import { bringsNew, capabilitiesOf, mergeCapabilities } from './youless/model.js';

const defaultTimers = { setTimeout, clearTimeout, setInterval, clearInterval };
/** Errors only the user can solve (a password): slow retries, their own message. */
const PASSWORD_ERRORS = new Set(['auth', 'protected']);

/** The index Gladys already holds for a feature of a created device, when it says so. */
function lastValueOf(device, featureId) {
  const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
  const value = Number(feature?.last_value);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return feature?.last_value !== null &&
    feature?.last_value !== undefined &&
    Number.isFinite(value) &&
    Number.isFinite(at)
    ? { value, at }
    : undefined;
}

/** The P1 tariffs kept in /data with the guard: `{ p1, p2 }` of the last index accepted. */
const validTariffs = (tariffs) =>
  tariffs && Number.isFinite(tariffs.p1) && Number.isFinite(tariffs.p2)
    ? { p1: tariffs.p1, p2: tariffs.p2 }
    : undefined;

export class YoulessApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'youless' }),
    now = Date.now,
    timers = defaultTimers,
    clientFactory = (options) => new YoulessClient(options),
    store = createFileStore(),
  }) {
    this.gladys = gladys;
    /** /data: the index reference, the value held and the P1 tariffs, across restarts. */
    this.store = store;
    this.savedGuard = undefined;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.clientFactory = clientFactory;
    this.config = normalizeConfig();
    this.client = undefined;
    /** The detected device: { model, mac?, firmware?, endpoint, phases }. */
    this.device = undefined;
    /** What the device showed it gives, and what its created device carries: only grows. */
    this.capabilities = undefined;
    this.guard = undefined;
    /** The index feature the guard belongs to. */
    this.guardIndexId = undefined;
    /** The P1 tariffs of the last index accepted (src/guard.js indexOfTariffs). */
    this.tariffRef = undefined;
    /** The last check of the P1 tariffs gave no index (a register glitching). */
    this.indexUndefined = false;
    /** The P1 tariff counters last sent, by feature id (never 0 after a value above 0). */
    this.publishedTariffs = new Map();
    this.lastIndexAt = 0;
    /** Retries: kept across reconnections to Gladys, reset by a save of the form. */
    this.failures = 0;
    this.nextTryAt = 0;
    this.unknownAnswers = 0;
    this.phasesFailing = false;
    this.p1Outage = false;
    this.timer = undefined;
    this.busy = undefined;
    this.firstRun = Promise.resolve();
    this.lastStatus = undefined;
    this.generation = 0;
    this.lifecycle = Promise.resolve();
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * `fresh`: the user saved the form (not a reconnection): the retry delay
   * ends. It accepts nothing: a value held back is only taken by its own
   * action (`acceptHeldIndex`).
   */
  start(raw = {}, { fresh = false } = {}) {
    return this.serialize(() => this.doStart(raw, { fresh }));
  }

  stop() {
    return this.serialize(() => this.doStop());
  }

  /** Resolves once every queued start/stop and the first read after it are done (tests). */
  async idle() {
    await this.lifecycle;
    await this.firstRun;
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  async doStart(raw, { fresh = false } = {}) {
    await this.doStop();
    const generation = ++this.generation;
    const config = normalizeConfig(raw);
    const changed =
      config.address !== this.config.address || config.password !== this.config.password;
    this.config = config;
    if (changed || !this.client) {
      // Another device (or another password): nothing of the previous one is kept.
      this.client = config.address
        ? this.clientFactory({ address: config.address, password: config.password, now: this.now })
        : undefined;
      this.device = undefined;
      this.capabilities = undefined;
      this.guard = undefined;
      this.guardIndexId = undefined;
      this.savedGuard = undefined;
      this.tariffRef = undefined;
      this.indexUndefined = false;
      this.publishedTariffs.clear();
      this.failures = 0;
      this.nextTryAt = 0;
      this.unknownAnswers = 0;
    }
    if (fresh) {
      this.failures = 0;
      this.nextTryAt = 0;
    }
    if (!config.address) {
      // The index held back stays shown here too.
      const message = config.invalidAddress ? T.badAddress : T.noAddress;
      await this.setStatus(false, withNotes(message, this.heldNotes()));
      return;
    }
    // Every start (a reconnection to Gladys included) publishes everything
    // again: a restarted Gladys has lost the discovered list.
    this.gladys.forgetPublishedStates();
    this.lastIndexAt = 0;
    await this.discover();
    // Always armed, whatever the first read gives: never a dead integration.
    this.timer = this.timers.setInterval(
      () => this.run(generation, () => this.tick()),
      POWER_INTERVAL,
    );
    // Not awaited: a start (a save of the form) answers at once.
    this.firstRun = this.run(generation, () => this.tick());
  }

  async doStop() {
    this.generation += 1;
    if (this.timer !== undefined) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Run a job of a generation: nothing after a restart. */
  async run(generation, job) {
    if (generation !== this.generation) {
      return;
    }
    try {
      await job();
    } catch (err) {
      this.logger.error(`YouLess: unexpected error (${err?.name ?? 'Error'})`);
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- Devices ---------------------------------------------------------------------

  externalIds() {
    return ids(this.gladys, this.device, this.config.address);
  }

  /** Every created device of this integration (the SDK keeps gladys.devices up to date). */
  ourDevices() {
    const prefix = this.gladys.externalId(`${EXTERNAL_ID_TYPE}:`);
    return (this.gladys.devices ?? []).filter((d) => String(d.external_id).startsWith(prefix));
  }

  /** The created Gladys device of the YouLess, undefined until the user creates it. */
  createdDevice() {
    if (!this.device) {
      return undefined;
    }
    const id = this.externalIds().device;
    return (this.gladys.devices ?? []).find((d) => d.external_id === id);
  }

  /** The capabilities known so far, with the features of the created device (never fewer). */
  knownCapabilities(seen) {
    return mergeCapabilities(
      mergeCapabilities(this.capabilities, capabilitiesOfDevice(this.createdDevice())),
      seen,
    );
  }

  async discover() {
    if (!this.device || !this.capabilities) {
      return;
    }
    await this.gladys
      .publishDiscoveredDevices([
        buildDevice(this.gladys, this.device, this.capabilities, this.config.address),
      ])
      .catch((err) => this.logger.warn(`Publishing the YouLess device failed: ${err.message}`));
  }

  /** The Discover tab asks: the known device, or a read now to find it. */
  async scan() {
    if (this.device && this.capabilities) {
      await this.discover();
    } else if (this.client) {
      this.nextTryAt = 0;
      await this.run(this.generation, () => this.tick());
    }
  }

  async onDeviceCreated(device) {
    if (this.device && device?.external_id === this.externalIds().device) {
      // A new device: no reference of the index yet (nor a value held in
      // /data for a deleted device of the same id), its values right away.
      const indexId = this.externalIds().feature(FEATURE.CONSUMPTION_INDEX);
      const kept = this.store.load();
      if (indexId in kept) {
        delete kept[indexId];
        await this.store
          .save(kept)
          .catch((err) =>
            this.logger.warn(`Clearing the YouLess index state failed (${err?.code ?? 'error'})`),
          );
      }
      // After the save: a read finished meanwhile must not leave its guard.
      this.guard = undefined;
      this.guardIndexId = undefined;
      this.savedGuard = undefined;
      this.tariffRef = undefined;
      this.indexUndefined = false;
      this.publishedTariffs.clear();
      this.lastIndexAt = 0;
      await this.run(this.generation, () => this.tick());
    }
  }

  async onDeviceUpdated(device) {
    if (this.device && device?.external_id === this.externalIds().device) {
      // New features (Update in Discovery): their values right away.
      this.lastIndexAt = 0;
      await this.run(this.generation, () => this.tick());
    }
  }

  /**
   * A detection never downgrades a created device known by its MAC: an LS120
   * taken for an LS110 (another external id) or for the PVOutput firmware
   * (another billed index) is a passing error, tried again.
   */
  checkDetection(detected) {
    const known = this.ourDevices().find((d) => paramOf(d, 'mac'));
    if (!known) {
      return;
    }
    const mac = paramOf(known, 'mac');
    const lostMac = !detected.mac;
    const lostEnelogic =
      detected.mac === mac &&
      paramOf(known, 'model') === MODEL.LS120 &&
      detected.model !== MODEL.LS120;
    if (lostMac || lostEnelogic) {
      throw new YoulessError('downgrade', `detected as ${detected.model}, created as LS120`);
    }
  }

  // --- Reads -------------------------------------------------------------------------

  /** One read; a read still running (a slow device) is never doubled. */
  tick() {
    if (!this.busy) {
      this.busy = this.doTick().finally(() => {
        this.busy = undefined;
      });
    }
    return this.busy;
  }

  async doTick() {
    const now = this.now();
    if (!this.client || now < this.nextTryAt) {
      return;
    }
    let snapshot;
    try {
      if (!this.device) {
        const detected = await this.client.detect();
        this.checkDetection(detected);
        this.device = detected;
        this.logger.info(`YouLess ${this.device.model} found`);
      }
      const p1Known = Boolean(this.knownCapabilities().tariffs);
      snapshot = await this.client.read(this.device, { p1Known });
    } catch (err) {
      if (err?.code === 'unknown_answer' && this.device) {
        this.unknownAnswers += 1;
        if (this.unknownAnswers >= REDETECT_AFTER) {
          // The firmware may have changed: detected again (never downgraded).
          this.unknownAnswers = 0;
          this.device = undefined;
        }
      }
      await this.failed(err, now);
      return;
    }
    this.failures = 0;
    this.nextTryAt = 0;
    this.unknownAnswers = 0;
    const target = this.knownCapabilities(capabilitiesOf(snapshot));
    if (!this.capabilities || bringsNew(this.capabilities, target)) {
      this.capabilities = target;
      await this.discover();
    }
    this.followPhases(snapshot);
    this.p1Outage = Boolean(snapshot.p1Outage);
    await this.publish(snapshot, now);
    const created = this.createdDevice();
    await this.setStatus(true, created ? this.okMessage() : T.noDevice(this.device.model));
  }

  okMessage() {
    const notes = [];
    if (this.phasesFailing) notes.push(T.notes.phases);
    if (this.p1Outage) notes.push(T.notes.p1Outage);
    else if (this.indexUndefined) notes.push(T.notes.noIndex);
    notes.push(...this.heldNotes());
    return T.ok(this.device.model, this.config.address, notes);
  }

  /** The index held back, if any, as a note: shown in every status, connected or not. */
  heldNotes() {
    const held = this.currentGuard()?.held;
    return held ? [T.notes.held(held)] : [];
  }

  /**
   * The created device of the YouLess: the detected one, or, before a
   * detection (a password refused at a start), the only created device of
   * this integration.
   */
  guardedDevice() {
    if (this.device) {
      return this.createdDevice();
    }
    const ours = this.ourDevices();
    return ours.length === 1 ? ours[0] : undefined;
  }

  /** The guard of the created device, built from Gladys and /data when needed. */
  currentGuard() {
    const created = this.guardedDevice();
    if (!created) {
      return undefined;
    }
    return this.guardOf(created, `${created.external_id}:${FEATURE.CONSUMPTION_INDEX}`);
  }

  /** The guard of a created device, from Gladys and /data (built again for another device). */
  guardOf(created, indexId) {
    if (!this.guard || this.guardIndexId !== indexId) {
      const saved = this.store.load()[indexId];
      this.guard = new IndexGuard(lastValueOf(created, indexId), saved, this.now());
      this.guardIndexId = indexId;
      this.savedGuard = undefined;
      this.tariffRef = validTariffs(saved?.tariffs);
    }
    return this.guard;
  }

  /** The phases page is secondary: its failure is logged once, the rest goes on. */
  followPhases(snapshot) {
    if (snapshot.phasesError && !this.phasesFailing) {
      this.phasesFailing = true;
      this.logger.warn(`YouLess phases page unavailable (${snapshot.phasesError.code ?? 'error'})`);
    } else if (!snapshot.phasesError && this.phasesFailing) {
      this.phasesFailing = false;
      this.logger.info('YouLess phases page back');
    }
  }

  async failed(err, now) {
    const code = err?.code ?? 'error';
    let wait;
    let message;
    // The index held back stays shown while the YouLess cannot be read.
    const notes = this.heldNotes();
    if (PASSWORD_ERRORS.has(code)) {
      wait = AUTH_RETRY;
      message = code === 'auth' ? T.auth(wait, notes) : T.protected(wait, notes);
    } else {
      wait = Math.min(RETRY_MIN * 2 ** this.failures, RETRY_MAX);
      this.failures += 1;
      message =
        code === 'downgrade'
          ? T.downgrade(this.config.address, wait, notes)
          : T.unreachable(this.config.address, err, wait, notes);
    }
    this.nextTryAt = now + wait;
    // Our own words only (YoulessError): never a text of the device, never the password.
    this.logger.warn(`YouLess read failed: ${code}${err?.status ? ` ${err.status}` : ''}`);
    await this.setStatus(false, message);
  }

  /** The states of a read: the live values every time, the indexes once a minute. */
  async publish(snapshot, now) {
    const created = this.createdDevice();
    if (!created) {
      return;
    }
    const external = this.externalIds();
    const states = liveStates(external, snapshot);
    if (now - this.lastIndexAt >= INDEX_INTERVAL) {
      this.lastIndexAt = now;
      const indexId = external.feature(FEATURE.CONSUMPTION_INDEX);
      const guard = this.guardOf(created, indexId);
      const { t1, t2 } = snapshot.consumption;
      // The P1 path of an LS120: both tariffs checked before their sum. Never
      // for `cnt` (LS110, PVOutput) nor `net` (LS120 without P1).
      const sum = snapshot.p1Meter
        ? indexOfTariffs(t1, t2, this.tariffRef)
        : snapshot.consumption.total;
      this.indexUndefined = Boolean(snapshot.p1Meter) && sum === undefined;
      // The value Gladys will hold (3 decimals) is the one the guard checks.
      const total = sum === undefined ? undefined : round(sum, 3);
      const plausible = total !== undefined && guard.accept(total, now);
      if (plausible && snapshot.p1Meter) {
        this.tariffRef = { p1: t1, p2: t2 };
      }
      await this.saveGuard(indexId);
      if (total !== undefined && !plausible) {
        this.logger.warn(
          guard.held
            ? `YouLess consumption index ${guard.held.direction === 'down' ? 'drop' : 'jump'} held back: only its action accepts it`
            : 'YouLess consumption index held back: 0 or not a number',
        );
      }
      // While a value is held, the last accepted one is sent again (no delta
      // for the core; the heartbeat keeps its date recent in Gladys).
      const held = guard.held ? guard.last?.value : undefined;
      const tariffIds = new Set(
        [FEATURE.CONSUMPTION_T1, FEATURE.CONSUMPTION_T2].map((key) => external.feature(key)),
      );
      for (const state of indexStates(external, snapshot, plausible ? total : held)) {
        const id = state.device_feature_external_id;
        if (tariffIds.has(id) && !this.tariffStateAllowed(created, id, state.state, sum)) {
          continue;
        }
        states.push(state);
      }
    }
    // Only the features the created device has (they are fixed at its creation).
    const features = created.features ? new Set(created.features.map((f) => f.external_id)) : null;
    const allowed = features
      ? states.filter((s) => features.has(s.device_feature_external_id))
      : states;
    if (allowed.length === 0) {
      return;
    }
    await this.gladys
      .publishChangedStates(allowed, { heartbeat: STATE_HEARTBEAT })
      .catch((err) => this.logger.warn(`Publishing the YouLess values failed: ${err.message}`));
  }

  /**
   * A P1 tariff counter (plain sensor): not sent when the tariffs give no
   * index (a register glitching), and never 0 after a value above 0 (sent
   * by us, or held by Gladys).
   */
  tariffStateAllowed(created, id, value, sum) {
    if (sum === undefined) {
      return false;
    }
    const before = this.publishedTariffs.get(id) ?? lastValueOf(created, id)?.value;
    if (value === 0 && before > 0) {
      return false;
    }
    this.publishedTariffs.set(id, value);
    return true;
  }

  /** Keeps the guard in /data when its reference, its value held or the tariffs changed. */
  async saveGuard(indexId) {
    const state = { ...this.guard.state(), tariffs: this.tariffRef ?? null };
    const key = JSON.stringify([
      indexId,
      state.last,
      state.held && {
        direction: state.held.direction,
        from: state.held.from,
        threshold: state.held.threshold,
      },
      state.tariffs,
    ]);
    if (key === this.savedGuard) {
      return;
    }
    try {
      await this.store.save({ ...this.store.load(), [indexId]: state });
      this.savedGuard = key;
    } catch (err) {
      this.logger.warn(`Saving the YouLess index state in /data failed (${err?.code ?? 'error'})`);
    }
  }

  // --- Configuration screen button --------------------------------------------------

  messageOf(err) {
    if (err?.code === 'auth') return T.auth(AUTH_RETRY);
    if (err?.code === 'protected') return T.protected(AUTH_RETRY);
    if (err?.code === 'downgrade') return T.downgrade(this.config.address, RETRY_MIN);
    return T.unreachable(this.config.address, err, RETRY_MIN);
  }

  /**
   * The "Accept the held index" button: takes the value held as shown now
   * (plus what the home may draw until the next read, src/guard.js), never
   * anything else. Answers with what will be counted.
   */
  async acceptHeldIndex() {
    const accepted = this.currentGuard()?.acceptHeld();
    if (!accepted) {
      return T.accept.nothing;
    }
    this.logger.info(
      `YouLess consumption index ${accepted.direction === 'down' ? 'drop' : 'jump'} accepted by the user`,
    );
    // Published at the next read, which comes now.
    this.lastIndexAt = 0;
    this.firstRun = this.run(this.generation, () => this.tick());
    return accepted.direction === 'down' ? T.accept.down(accepted) : T.accept.up(accepted);
  }

  /** The test button: find the device and read it once. */
  async testConnection() {
    if (!this.client) {
      return this.config.invalidAddress ? T.badAddress : T.noAddress;
    }
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve(T.test.slow), TEST_ANSWER_WITHIN);
    });
    try {
      return await Promise.race([this.check(), late]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  async check() {
    const client = this.client;
    try {
      let device = this.device;
      if (!device) {
        device = await client.detect();
        this.checkDetection(device);
      }
      const snapshot = await client.read(device, {
        p1Known: Boolean(this.knownCapabilities().tariffs),
      });
      if (client === this.client) {
        // A good answer ends the retry delay: the next tick reads (and finds) it.
        this.device ??= device;
        this.failures = 0;
        this.nextTryAt = 0;
      }
      return T.test.ok(device.model, snapshot);
    } catch (err) {
      return this.messageOf(err);
    }
  }
}
