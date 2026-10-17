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

- **Detection** (as youless-api): `/d` answers → `/e` Enelogic JSON → LS120
  (plus `/f` from firmware 1.5); `/d` without `/e` → LS120 PVOutput, read
  through `/a?f=j`; no `/d` → LS110, `/a?f=j`. A network failure is never
  taken for an LS110.
- **One device**, external id `youless:<MAC>` (`youless:host-<address>` for
  an LS110, which has no MAC). Its features follow what the device showed
  (they only grow; a new one republishes the discovered device).
- **Energy**: `consumption_index` (energy-sensor / index, kWh) is the only
  energy index; the core derives the consumption and cost from it. With a P1
  meter it is p1 + p2 (never `net`). Tariff and injection indexes are plain
  sensors (never billed, never counted twice); gas and water are volume
  sensors (m³), out of the energy monitoring. No `daily-consumption`, no
  `publishEnergyConsumption`.
- **Pace**: one read every 10 s (power, phases, S0 power); the indexes are
  published once a minute; `publishChangedStates` with a 10-minute heartbeat.
  The phases page is secondary: its failure never holds back the rest.
- **Index plausibility**: a drop or a jump over 100 kW on average is held
  back until read 3 times in a row (a glitch to 0 would otherwise count as a
  reset, then the whole index as one half hour).
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
