# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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
- An implausible consumption index (a drop, a jump over 100 kW on average)
  is held back until read 3 times in a row.
- Resilience: an unreachable device is tried again after 10 s, doubled up to
  5 minutes; a refused password every 5 minutes; the phases page failing
  never holds back the other values; each reconnection to Gladys publishes
  the device and every value again.
- "Test the connection" button: finds the YouLess and reads its power and
  consumption index once.
- Documentation in English and French; `LICENSE` (Apache-2.0) and
  `THIRD_PARTY_NOTICES.md` (MIT license of youless-api), shipped in the image.

[Unreleased]: https://github.com/LM1LC3N7/gladys-youless/commits/main
