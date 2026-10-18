# gladys-youless

[Gladys Assistant](https://gladysassistant.com) external integration for the
**YouLess** energy monitors (LS110, LS120, LS120 PVOutput firmware), read
locally over HTTP: the power every 10 seconds, the electricity index for the
Gladys energy monitoring every minute, and, when the device gives them, the
tariff and injection indexes, the phases, the S0 input, gas and water.
**Unofficial, not affiliated with YouLess. Never tested on a real YouLess.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (YoulessApp)
                 ├─ src/youless/client.js  local HTTP: detection, login, reads (bounded, no redirect)
                 ├─ src/youless/model.js   /d, /a, /e, /f answers -> one snapshot (pure)
                 ├─ src/guard.js           plausibility of the billed index (pure)
                 └─ src/devices.js         the device, its features and states (pure)
```

- **Detection** (after youless-api, stricter): `/d` device page → `/e`
  Enelogic JSON → LS120 (plus `/f` from firmware 1.5); `/e` 404 or a 200
  without Enelogic data → LS120 PVOutput, read through `/a?f=j`; `/d` 404 →
  LS110, `/a?f=j`. Any other status and every network failure is a passing
  error, never a model guess. A created device known by its MAC is never
  downgraded (to an LS110 or to PVOutput); answers that are not a YouLess one,
  3 times in a row, trigger a new detection.
- **One device**, external id `youless:<MAC>` (`youless:host-<address>` for
  an LS110, which has no MAC). Its features are what the device showed plus
  what the created device carries (from `gladys.devices`): the published
  device never shrinks. Created and updated devices are read from
  `gladys.devices`, which the SDK keeps up to date.
- **Energy**: `consumption_index` (energy-sensor / index, kWh) is the only
  energy index; the core derives the consumption and cost from it. With a P1
  meter it is p1 + p2 (never `net`). Tariff and injection indexes are plain
  sensors (never billed, never counted twice); gas and water are volume
  sensors (m³), out of the energy monitoring. No `daily-consumption`, no
  `publishEnergyConsumption`.
- **Pace**: one read every 10 s (power, phases, S0 power); the indexes are
  published once a minute; `publishChangedStates` with a 10-minute heartbeat.
  The phases page is secondary: its failure never holds back the rest.
- **Index plausibility** (`src/guard.js`; the core skips a negative delta
  but counts every rise in full): never 0; once P1 values were seen, a read
  without them gives no index (never `net`); on the P1 path of an LS120 only
  (never `cnt` nor `net`), both tariffs are checked against those of the
  last index accepted (`indexOfTariffs`: one register at 0 or going down
  alone gives no index). A drop and a jump over 100 kW on average are never
  confirmed by repetition, by time, by a restart nor by a save of the
  configuration: they are held (kept with the tariffs in
  `/data/youless-state.json`, the 0.1.1 `{ last, jump }` state migrated),
  the last accepted value is sent again and every status shows the value
  held, connected or not. Only the **Accept the held index** action
  (`accept_held_index`) takes it, bounded to the value shown plus the margin
  since (a jump counted once, a drop billed 0); any other value is held
  again. The margin grows with the time since the last value accepted
  (2,400 kWh after 24 h of outage). Way out of a dead end: delete the device
  and create it again.
- **Errors**: unreachable → retries after 10 s, doubled up to 5 min; refused
  password → every 5 min; a reconnection to Gladys keeps the delay, a save of
  the form ends it. Errors are logged with our own codes, never a text of the
  device, a URL or the password.

## Credits

The detection and the meaning of the answers are ported from
[youless-api](https://github.com/gjong/youless-python-bridge) by Gerben
Jongerius (MIT, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)); the
list of values follows the YouLess integration of Home Assistant
(Apache-2.0). Modelled on the sibling integrations
[gladys-fluvius](https://github.com/LM1LC3N7/gladys-fluvius),
[gladys-tibber](https://github.com/LM1LC3N7/gladys-tibber) and
[gladys-mystrom](https://github.com/LM1LC3N7/gladys-mystrom).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never touch the network: the YouLess answers are synthetic, shaped
after the tests of youless-api. Gladys is the SDK's fake.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The logic ported from youless-api remains under its
MIT license, reproduced in full in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
(also shipped in the Docker image).
