# TODO

## Before announcing

- [ ] Test on a real Gladys 5.2+ with a real YouLess (LS110, LS120 with a P1
      meter, ideally with gas, solar injection and three phases): detection,
      test button, device creation, the consumption and cost the core derives
      from the index, the sensors.
- [ ] Test the Docker image (no Docker on the development PC yet).
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).

## To confirm on a real device (built without one)

- [ ] The login of a protected device: `GET /L?w=<password>` (assumed), and
      whether the device then knows the client by a cookie or by its IP
      address (both handled). What a protected device answers without login
      (a login page with 200, a 403?).
- [ ] The pages without `?f=j`: `/d`, `/e`, `/f` as youless-api reads them
      (the brief mentions `/d?f=j` and `/e?f=j`; youless-api, used by Home
      Assistant, calls them without the query).
- [ ] The answer of an LS110 to `/d` (404 or a web page assumed) and of the
      PVOutput firmware to `/e`.
- [ ] An LS120 without P1 (optical sensor): `p1`, `p2`, `n1`, `n2` at 0 and
      `net` as the meter count (assumed).
- [ ] The sign of `pwr` with a P1 meter while injecting (negative assumed),
      and of `l1`..`l3`.
- [ ] `gts` / `wts` are the local clock of the device (yymmddhhmm): a
      reading is dropped after 26 h, a margin for the time zone.
- [ ] The MAC format of `/d` (`72:b8:ad:14:16:2e` assumed; another format
      falls back to the address as id).
- [ ] The core's consumption from the index: one `energy-sensor` / `index`
      feature published every minute, the derived features attached to the
      main electric meter.
- [ ] The behaviour on a reconnection to Gladys: the device and values
      published again, the retry delay kept.

## Decisions

- **Versions**: 0.1.0 set once by hand when leaving the template (package,
  lock file, manifest, image tag), as for the sibling integrations; the
  Release workflow owns them from now on (the first patch release gives
  0.1.1).
- **Reused project**: youless-api (gjong/youless-python-bridge, MIT, by
  Gerben Jongerius, commit d5a6726) is ported to JavaScript: the detection,
  the pages and the meaning of their fields (`THIRD_PARTY_NOTICES.md`,
  README, docs). The Home Assistant integration (Apache-2.0) was consulted
  for the list of values and the 10-second polling; nothing copied. The SDK
  stays the only runtime dependency.
- **Paths**: `/d`, `/e`, `/f` without `?f=j` and `/a?f=j`, exactly as
  youless-api (the brief mentioned `?f=j` on every page; the library that
  Home Assistant users run every day was preferred).
- **Detection**: a network error (timeout, refused) never means "LS110": only
  a `/d` that answers without a device page does. A `/d` without a usable MAC
  still means LS120 (youless-api reads `/e` then).
- **External id**: `youless:<MAC>` (lower-case, no separator); without a MAC
  (LS110), `youless:host-<address>`: the docs ask for a fixed address.
- **One device per integration**: most homes have one meter; a list of
  addresses is an idea below.
- **Energy (lessons of the waves 2 and 3)**: `consumption_index` is the only
  `energy-sensor` / `index` feature (the core derives consumption and cost
  from it). With a P1 meter it is p1 + p2, never `net` (which subtracts the
  injection); without P1, `net`. The tariff indexes are plain sensors (as
  indexes they would be counted three times). The injection is never in a
  consumption index: plain sensors (`unknown` / `decimal`, kWh in the name),
  not `energy-production-sensor` (injection is not production) nor
  `grid-sensor` (recent category, not sure every Gladys 5.2 knows it). No
  `daily-consumption`, no `publishEnergyConsumption`.
- **Gas and water**: `volume-sensor` / `decimal` in m³ (a unit the core lists
  for that category), never in the energy monitoring.
- **Power**: `power` is the only `energy-sensor` / `power` feature (the
  energy contracts take the first one of the meter for its peaks); signed
  (min -100,000 W) because a P1 YouLess gives the net power. The power of
  each phase and of the S0 input are plain sensors; voltage and current per
  phase are `energy-sensor` voltage / current, as in gladys-tibber.
- **S0 input**: plain sensors, only once it holds something (`cs0` or `ps0`
  above 0): its meaning (solar production, a sub-meter) is unknown, so it
  never enters the energy monitoring.
- **Gas, water present**: the feature is created once the value is above 0
  or stamped (`gts` / `wts`): an LS120 without a gas meter answers `gas: 0`.
- **Capabilities**: from the reads, only growing (a new one publishes the
  discovered device again; the user clicks Update). The states are filtered
  on the features of the created device.
- **Index plausibility** (`src/guard.js`): a value lower than the last one
  published, or more than 100 kW on average since then (+ 0.5 kWh), waits
  for 3 reads in a row; the last value Gladys holds (`last_value`,
  `last_value_changed`) is the starting point after a restart. A meter set
  again by hand in the YouLess therefore goes through after 3 minutes.
- **Pace**: one timer every 10 s; the indexes (and gas, water, tariff, S0
  index) are published when 60 s have passed; `publishChangedStates` with a
  10-minute heartbeat. At most about 70 states a minute with three phases,
  far below the 300 a minute of Gladys.
- **Republication**: every start (each `connected`) calls
  `forgetPublishedStates()`, publishes the discovered device and the
  indexes again.
- **Errors**: unreachable → 10 s, doubled up to 5 min; a refused password or
  a protected device → every 5 min; a reconnection keeps the delay, a save of
  the form or a good test ends it. A read never overlaps another (5 s
  timeout per request). The phases page failing is logged once, shown in the
  status, never blocking. Logs hold our own codes only: no URL (the login one
  carries the password), no text of the device.
- **Hostile answers**: bodies read up to 64 KiB (stream cut beyond), no
  redirect followed (`redirect: 'manual'`), at most 10 cookies kept.
- **Password**: sent only to the configured address, as the device wants it
  (in the query of the login page, plain HTTP): said in the manifest and the
  docs. An address with `user:password@` is refused.
- **Stale gas and water**: youless-api drops a reading older than the
  current day; here older than 26 h (the device clock has no time zone).
- **Gladys version**: `>=5.2.0`, like the other energy integrations (index
  features of external integrations, volume-sensor).
- **Monthly peaks** (`pp`, `pa`, `pts` of `/f`): not read in v0.1 (not in
  the brief).

## Ideas

- Several YouLess (a list of addresses, one password each).
- The monthly peak and average power of the LS120 (`pp`, `pa`, `pts`).
- The S0 input as a production or sub-meter index, chosen by the user.
- The injection as `grid-sensor` / `output-index` once every supported
  Gladys knows the category.
