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
import { IndexGuard } from './guard.js';
import { createFileStore } from './store.js';
import { T } from './i18n.js';
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
    /** /data: the index reference and the jump held, across restarts. */
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
   * ends, and a consumption index jump held back is accepted (counted once).
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
      this.failures = 0;
      this.nextTryAt = 0;
      this.unknownAnswers = 0;
    }
    if (fresh) {
      this.failures = 0;
      this.nextTryAt = 0;
      if (this.guard?.jump) {
        this.logger.info('YouLess consumption index jump accepted by a save of the configuration');
        this.guard.acceptJump();
      }
    }
    if (!config.address) {
      await this.setStatus(false, config.invalidAddress ? T.badAddress : T.noAddress);
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
      // A new device: no reference of the index yet (nor a jump kept in /data
      // for a deleted device of the same id), its values right away.
      this.guard = undefined;
      this.savedGuard = undefined;
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
    if (this.guard?.jump) notes.push(T.notes.jump(this.guard.jump));
    return T.ok(this.device.model, this.config.address, notes);
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
    if (PASSWORD_ERRORS.has(code)) {
      wait = AUTH_RETRY;
      message = code === 'auth' ? T.auth(wait) : T.protected(wait);
    } else {
      wait = Math.min(RETRY_MIN * 2 ** this.failures, RETRY_MAX);
      this.failures += 1;
      message =
        code === 'downgrade'
          ? T.downgrade(this.config.address, wait)
          : T.unreachable(this.config.address, err, wait);
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
      this.guard ??= new IndexGuard(lastValueOf(created, indexId), this.store.load()[indexId]);
      // The value Gladys will hold (3 decimals) is the one the guard checks.
      const total =
        snapshot.consumption.total === undefined ? undefined : round(snapshot.consumption.total, 3);
      const plausible = total !== undefined && this.guard.accept(total, now);
      await this.saveGuard(indexId);
      if (total !== undefined && !plausible) {
        this.logger.warn(
          this.guard.jump
            ? 'YouLess consumption index jump held back: save the configuration to accept it'
            : 'YouLess consumption index held back: a drop or a 0, not confirmed',
        );
      }
      // While a jump is held, the last accepted value is sent again (no delta
      // for the core; the heartbeat keeps its date recent in Gladys).
      const held = this.guard.jump ? this.guard.last?.value : undefined;
      states.push(...indexStates(external, snapshot, plausible ? total : held));
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

  /** Keeps the guard in /data when its reference or its held jump changed. */
  async saveGuard(indexId) {
    const state = this.guard.state();
    const key = JSON.stringify([
      state.last,
      state.jump && { from: state.jump.from, threshold: state.jump.threshold },
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
