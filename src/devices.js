// -----------------------------------------------------------------------------
// The Gladys device of a YouLess and its states. Pure.
//
// External id (forever): youless:<MAC> (12 lower-case hex digits, from /d);
// an LS110 has no /d page (and a /d without a usable MAC is possible), so
// such a device is known by its address: youless:host-<address>.
//
// Energy rules of the Gladys core (server/utils/constants.js and the
// energy-monitoring service):
// - `consumption_index` is the ONLY energy-sensor / index feature: the core
//   derives the consumption and its cost from its deltas, by itself. It holds
//   the electricity taken from the grid (p1 + p2 with a P1 smart meter), never
//   `net` (which subtracts the injection) when the tariffs are known;
// - the tariff indexes (p1, p2) are plain sensors: as indexes they would be
//   counted a second and a third time;
// - the injection is never in a consumption index (it would be billed): plain
//   sensors, kWh in the name;
// - gas and water are NEVER in the energy monitoring (the core would price
//   them at the electricity tariff): volume sensors in m³;
// - `power` is the first energy-sensor / power feature of the device: the
//   energy contracts read it for the peaks. The power of each phase and of the
//   S0 input are plain sensors, so they are never taken for it.
// - units: only the ones the core lists for the category
//   (DEVICE_FEATURE_UNITS_BY_CATEGORY): W, V, A, kWh for energy-sensor, m³
//   for volume-sensor, none for unknown.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { EXTERNAL_ID_TYPE } from './constants.js';

/** Feature keys (forever). */
export const FEATURE = {
  POWER: 'power',
  CONSUMPTION_INDEX: 'consumption_index',
  CONSUMPTION_T1: 'consumption_tariff1',
  CONSUMPTION_T2: 'consumption_tariff2',
  INJECTION_INDEX: 'injection_index',
  INJECTION_T1: 'injection_tariff1',
  INJECTION_T2: 'injection_tariff2',
  TARIFF: 'tariff',
  S0_POWER: 's0_power',
  S0_INDEX: 's0_index',
  GAS: 'gas',
  WATER: 'water',
  phasePower: (n) => `power_l${n}`,
  phaseVoltage: (n) => `voltage_l${n}`,
  phaseCurrent: (n) => `current_l${n}`,
};

/** The platform id of a device: its MAC, or its address without one (an LS110). */
export function platformId(device, address) {
  return device.mac ?? `host-${String(address).replace(/[^a-z0-9.-]/gi, '-')}`;
}

export const ids = (gladys, device, address) =>
  gladys.externalIds(EXTERNAL_ID_TYPE, platformId(device, address));

const feature = (external, key, name, category, type, extra = {}) => ({
  name,
  external_id: external.feature(key),
  category,
  type,
  min: 0,
  max: 1_000_000_000,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...extra,
});

/** A value shown, never summed nor billed: no energy category, no unit (it is in the name). */
const plain = (external, key, name, extra = {}) =>
  feature(external, key, name, C.UNKNOWN, T.SENSOR.DECIMAL, extra);

/**
 * The device, with the features its capabilities show (src/youless/model.js
 * capabilitiesOf). The features are fixed when the user creates it.
 */
export function buildDevice(gladys, device, capabilities, address) {
  const external = ids(gladys, device, address);
  const caps = capabilities ?? {};
  const features = [];
  if (caps.power) {
    features.push(
      feature(external, FEATURE.POWER, 'Power', C.ENERGY_SENSOR, T.ENERGY_SENSOR.POWER, {
        unit: U.WATT,
        // With a P1 meter the YouLess gives the net power: below 0 while injecting.
        min: -100_000,
        max: 100_000,
      }),
    );
  }
  if (caps.consumption) {
    features.push(
      feature(
        external,
        FEATURE.CONSUMPTION_INDEX,
        'Consumption index',
        C.ENERGY_SENSOR,
        T.ENERGY_SENSOR.INDEX,
        { unit: U.KILOWATT_HOUR },
      ),
    );
  }
  if (caps.tariffs) {
    features.push(
      plain(external, FEATURE.CONSUMPTION_T1, 'Consumption index, tariff 1 (kWh)'),
      plain(external, FEATURE.CONSUMPTION_T2, 'Consumption index, tariff 2 (kWh)'),
    );
  }
  if (caps.injection) {
    features.push(
      plain(external, FEATURE.INJECTION_INDEX, 'Injection index (kWh)'),
      plain(external, FEATURE.INJECTION_T1, 'Injection index, tariff 1 (kWh)'),
      plain(external, FEATURE.INJECTION_T2, 'Injection index, tariff 2 (kWh)'),
    );
  }
  if (caps.tariff) {
    features.push(
      feature(external, FEATURE.TARIFF, 'Current tariff (1 or 2)', C.UNKNOWN, T.SENSOR.INTEGER, {
        min: 1,
        max: 2,
      }),
    );
  }
  for (let n = 1; n <= Math.min(3, caps.phases ?? 0); n += 1) {
    features.push(
      plain(external, FEATURE.phasePower(n), `Power L${n} (W)`, {
        min: -100_000,
        max: 100_000,
      }),
      feature(
        external,
        FEATURE.phaseVoltage(n),
        `Voltage L${n}`,
        C.ENERGY_SENSOR,
        T.ENERGY_SENSOR.VOLTAGE,
        { unit: U.VOLT, max: 500 },
      ),
      feature(
        external,
        FEATURE.phaseCurrent(n),
        `Current L${n}`,
        C.ENERGY_SENSOR,
        T.ENERGY_SENSOR.CURRENT,
        { unit: U.AMPERE, max: 1000 },
      ),
    );
  }
  if (caps.s0) {
    features.push(
      plain(external, FEATURE.S0_POWER, 'S0 input power (W)', { max: 100_000 }),
      plain(external, FEATURE.S0_INDEX, 'S0 input index (kWh)'),
    );
  }
  if (caps.gas) {
    features.push(
      feature(external, FEATURE.GAS, 'Gas index', C.VOLUME_SENSOR, T.VOLUME_SENSOR.DECIMAL, {
        unit: U.CUBIC_METER,
      }),
    );
  }
  if (caps.water) {
    features.push(
      feature(external, FEATURE.WATER, 'Water index', C.VOLUME_SENSOR, T.VOLUME_SENSOR.DECIMAL, {
        unit: U.CUBIC_METER,
      }),
    );
  }
  return {
    name: `YouLess ${device.model}`,
    external_id: external.device,
    features,
    params: [
      { name: 'model', value: device.model },
      { name: 'mac', value: device.mac ?? '' },
      { name: 'firmware', value: device.firmware ?? '' },
      { name: 'address', value: address },
    ],
  };
}

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

const state = (external, key, value, digits) =>
  value === undefined || value === null || !Number.isFinite(value)
    ? []
    : [{ device_feature_external_id: external.feature(key), state: round(value, digits) }];

/** The live values, read every 10 s: power, phases, S0 power. */
export function liveStates(external, snapshot) {
  return [
    ...state(external, FEATURE.POWER, snapshot.power, 1),
    ...snapshot.phases.flatMap((phase, i) => [
      ...state(external, FEATURE.phasePower(i + 1), phase.power, 1),
      ...state(external, FEATURE.phaseVoltage(i + 1), phase.voltage, 1),
      ...state(external, FEATURE.phaseCurrent(i + 1), phase.current, 2),
    ]),
    ...state(external, FEATURE.S0_POWER, snapshot.s0?.power, 1),
  ];
}

/**
 * The indexes, published once a minute. `consumptionIndex` is the value the
 * IndexGuard let through (undefined: not published this time).
 */
export function indexStates(external, snapshot, consumptionIndex) {
  return [
    ...state(external, FEATURE.CONSUMPTION_INDEX, consumptionIndex, 3),
    ...state(external, FEATURE.CONSUMPTION_T1, snapshot.consumption.t1, 3),
    ...state(external, FEATURE.CONSUMPTION_T2, snapshot.consumption.t2, 3),
    ...state(external, FEATURE.INJECTION_INDEX, snapshot.injection.total, 3),
    ...state(external, FEATURE.INJECTION_T1, snapshot.injection.t1, 3),
    ...state(external, FEATURE.INJECTION_T2, snapshot.injection.t2, 3),
    ...state(external, FEATURE.TARIFF, snapshot.tariff, 0),
    ...state(external, FEATURE.S0_INDEX, snapshot.s0?.index, 3),
    ...state(external, FEATURE.GAS, snapshot.gas, 3),
    ...state(external, FEATURE.WATER, snapshot.water, 3),
  ];
}
