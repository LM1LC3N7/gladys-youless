# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Fixed

- Fictitious kWh in the energy monitoring after a drop of the consumption
  index: version 0.1.1 took a drop after 60 minutes, then a rise back to the
  real value (or saving the configuration on a held jump) made Gladys count
  the whole difference as consumption, thousands of kWh at once. A drop and a
  jump are now held until the user accepts them, never confirmed by time, by
  repetition, by a restart nor by saving the configuration; while held, the
  last accepted value is sent again and the status shows the value held,
  also when the YouLess cannot be read (unreachable, password refused or
  asked, model changed).
- With a P1 meter (LS120), both tariffs are checked before their sum: one
  register falling to 0 or going down alone gives no index for that read
  instead of a drop.
- While a value is held, the margin of the usual rule counts from the last
  value held, never from an old reference (a long outage, a state migrated
  from 0.1.1): a large rise below the value held is held in its turn, with
  its kWh shown, and nothing is billed until the user accepts it.
- The P1 tariff counters are no longer sent when the tariffs give no index,
  and never at 0 after a value above 0.
- The value held is also shown in the "no address" and "invalid address"
  statuses.
- A frozen index no longer shrinks the margin of the next real rise (an
  unchanged value keeps its date; at a restart the oldest date is kept).

### Added

- "Accept the held index" button (`accept_held_index`) in the configuration:
  takes exactly the value shown (plus what the home may draw until the next
  read) and says what will be counted: the jump in kWh, or 0 kWh for a drop.
  Any other value is held again. Saving the configuration accepts nothing.

### Changed

- The state kept in `/data/youless-state.json` gains the value held (drop or
  jump) and the P1 tariffs; the jump held by 0.1.1 is migrated and stays
  held. No configuration key, external id nor feature changes: existing
  devices and their history are kept.

## [0.1.1] - 2026-10-17

### Added

- Local reading of a YouLess LS110, LS120 or LS120 with the PVOutput
  firmware over HTTP, the model detected as youless-api does (`/d`, `/e`,
  `/a?f=j`, `/f` from firmware 1.5). Optional password of a protected device.
- One device with what the YouLess gives: the power every 10 seconds; the
  consumption index (p1 + p2 with a P1 meter) as the only energy index, fed
  to the Gladys energy monitoring every minute; the tariff and injection
  indexes as plain sensors (never billed); the current tariff; power,
  voltage and current per phase; the S0 input; gas and water as volume
  sensors in m³, out of the energy monitoring.
- The consumption index is protected (the core counts every rise in full):
  never 0; no index at all during a P1 outage (never `net`); a drop taken
  after 60 minutes of non-zero, non-decreasing values (their consumption is
  lost); a jump over 100 kW on average held whatever the time passed and
  across restarts (kept in `/data`), shown in the status and accepted only
  when the user saves the configuration (the difference counted once).
- Detection that never guesses: only a 404 of `/d` means LS110, only a 404
  or a non-Enelogic answer of `/e` means the PVOutput firmware; a created
  LS120 is never downgraded; repeated unknown answers trigger a new
  detection.
- The device published again never loses a feature of the created one, and
  "Update" in Discovery gets the new features their values at once.
- Resilience: an unreachable device is tried again after 10 s, doubled up to
  5 minutes; a refused password every 5 minutes; the phases page failing
  never holds back the other values; each reconnection to Gladys publishes
  the device and every value again.
- "Test the connection" button: finds the YouLess and reads its power and
  consumption index once.
- Documentation in English and French; `LICENSE` (Apache-2.0) and
  `THIRD_PARTY_NOTICES.md` (MIT license of youless-api), shipped in the image.

[Unreleased]: https://github.com/LM1LC3N7/gladys-youless/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-youless/releases/tag/v0.1.1
