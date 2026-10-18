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
- [ ] The answer of an LS110 to `/d` (404 required now: any other answer is
      a passing error) and of the PVOutput firmware to `/e` (404 or a 200
      without Enelogic data required).
- [ ] The values of `tr` in `/f`: 0/1 (youless-api comment) or 1/2 (Home
      Assistant options); published as given, 0 to 2 accepted.
- [ ] What `/e` gives during a P1 outage (p1..n2 at 0, absent?): no index is
      published then, once P1 values were seen.
- [ ] The phases page with a password: whether it shares the session of
      `/e` (a refusal pauses it for 5 minutes, without a new login).
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
- **Detection** (review): stricter than youless-api, which takes any non-ok
  `/d` for an LS110 and any non-JSON `/e` for PVOutput. Here only a 404 of
  `/d` means LS110, only a 404 or a 200 without Enelogic data of `/e` means
  PVOutput; any other status, a web page on `/d` (password) and every network
  error are passing errors, retried with the growing delay. A `/d` without a
  usable MAC still means LS120 (youless-api reads `/e` then). A detection
  never downgrades a created device carrying a MAC (`mac` param): no MAC
  detected, or the same MAC detected as PVOutput while created as LS120 →
  `downgrade` error, status message, retries (another MAC is a new device).
  3 answers in a row that are not a YouLess one → detected again.
- **Password not ported**: youless-api sends HTTP Basic credentials; the
  `/L?w=<password>` login of the web page is our assumption (README, docs,
  THIRD_PARTY_NOTICES say so). The phases page never logs in again by itself:
  a refusal pauses it for AUTH_RETRY, the main session is kept.
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
  (min -100,000 W) because a P1 YouLess is assumed to give the net power
  (not verified). The power of each phase and of the S0 input are plain
  sensors; voltage and current per phase are `energy-sensor` voltage /
  current, as in gladys-tibber. The nine phase features have
  `keep_history: false` (a value every 10 s; the user can turn it on).
- **Tariff**: `tr` published as the device gives it (0, 1 or 2 accepted),
  feature named "as the YouLess gives it" (sources disagree: 0/1 or 1/2).
- **S0 input**: plain sensors, only once it holds something (`cs0` or `ps0`
  above 0): its meaning (solar production, a sub-meter) is unknown, so it
  never enters the energy monitoring.
- **Gas, water present**: the feature is created once the value is above 0
  or stamped (`gts` / `wts`): an LS120 without a gas meter answers `gas: 0`.
- **Capabilities** (review): the reads plus the features of the created
  device (`gladys.devices`, by external id), only growing: after a restart
  with gas stale and `/f` down, the device published again is still the
  created one (no `structure_changed`, no history lost by "Update"). The
  states are filtered on the features of the created device.
- **Created devices**: read from `gladys.devices` only (the SDK upserts it
  on creation and update, removes it on deletion); no Map of our own.
  `onDeviceUpdated` publishes the values of the new features at once.
- **Index plausibility** (`src/guard.js`, fixed after 0.1.1, ported from
  gladys-p1-monitor b110655): the core skips a negative delta but counts
  every rise in full, so 9,194 → 0 → 9,194, and 9,194 → 10 (a drop taken)
  → 9,194, would bill 9,184 kWh or more. 0.1.1 took a drop after 60 minutes
  and accepted a held jump on a save of the configuration: both removed.
  Rules:
  - (a) once P1 values were seen (read, or the tariff features of the
    created device), a read without them gives no index at all, never
    `net` (`p1Known`, `p1Outage` unchanged);
  - (b) `indexOfTariffs`, ONLY on the P1 path of an LS120 (`p1`, `p2`;
    never `cnt` of the LS110 / PVOutput, never `net`): both tariffs present,
    finite, at or above 0, their sum above 0; against the tariffs `{ p1, p2
}` of the last index accepted (kept in /data with the guard, never
    cleared by a save, cleared by `onDeviceCreated`), both lower is a real
    drop for the guard; otherwise a tariff above 0 that reads 0, or one
    lower alone, gives no index for that read (status note). A tariff at 0
    is accepted when it already was 0 or with no reference (single-tariff
    meter);
  - (c) 0 is never published; a value plausible after the reference (not
    lower, at most 100 kW on average + 0.5 kWh) goes through; a value EQUAL
    to the reference goes through without moving its date; at a restart,
    the same value in /data and in Gladys keeps the OLDEST date, otherwise
    the most recent reference wins;
  - (d) a drop and a jump up are held (`held = { direction, from, to,
threshold, at }`), never confirmed by repetition, by time, by a restart
    nor by a save; every value at or above a held jump stays held; the last
    accepted value is sent again; the held note is in EVERY status
    (connected, unreachable, password refused or asked, downgrade); a value
    back to the usual rule ends the hold;
  - (e) only the `accept_held_index` action accepts: the value shown
    (`held.to` read at `held.at`), a jump for `held.to ≤ v ≤ held.to + 100
kW × (at − held.at) + 0.5 kWh`, a drop for `v ≤ held.to + margin`; any
    other value is held again and the acceptance dropped. An acceptance is
    not kept in /data. A value held read back from /data is dated at its
    loading (never its old date, which would widen the range);
  - (f) migration: the 0.1.1 `{ last, jump: { from, to, threshold } }` of
    `/data/youless-state.json` is read as `held` with `direction: 'up'`,
    `at` = load time; written in the new shape `{ last, held, tariffs }` at
    the next save. Tested with a `last.at` six days old;
  - (g) the guard starts again at `onDeviceCreated` (its /data entry, the
    guard, the tariffs and the saved key reset after the save); `doStart`
    resets the guard and the tariff reference when the address or the
    password changes. Way out of a dead end (a register stuck in a state
    that gives no index): delete the device and create it again;
  - (h) the margin grows with the time since the last value accepted: after
    24 h of outage, up to 2,400 kWh pass at once (documented).
    The value checked is the one published (3 decimals). /data is written
    through a temporary file, only when the reference, the hold or the
    tariffs change; a failure is logged, not fatal.
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
