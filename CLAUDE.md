# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

It reads a **YouLess** energy monitor (LS110, LS120, LS120 PVOutput
firmware) on the home network over plain HTTP: `/d`, `/e`, `/f`, `/a?f=j`.
The detection and the meaning of the answers are ported from
[youless-api](https://github.com/gjong/youless-python-bridge) (MIT, see
`THIRD_PARTY_NOTICES.md`). Unofficial: not affiliated with YouLess. Sibling
of `gladys-fluvius`, `gladys-tibber` and `gladys-mystrom`.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/model.test.js            # one file
node --test --test-name-pattern "guard"   # tests whose name matches
npm run audit                             # npm audit --omit=dev
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/app.js                        YoulessApp: detection, device, 10 s reads, indexes
                                  every minute, retries, test button
src/youless/client.js             the only HTTP access (login, bounded body, no redirect)
src/youless/model.js              /d, /a, /e, /f answers -> snapshot, capabilities (pure)
src/guard.js                      plausibility of the billed index (pure)
src/store.js                      the guard state kept in /data across restarts
src/devices.js                    the device, feature keys, states (pure)
src/config.js                     the address and password, normalized
src/constants.js                  pages, pacing, limits, manifest keys
src/i18n.js                       runtime texts (en/fr)
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys (integration-sdk/testing)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **Energy monitoring**: `consumption_index` is the ONLY `energy-sensor` /
  `index` (or `energy`) feature: the core derives consumption and cost from
  it. Never a second index (tariffs), never the injection in it, never a
  daily total, never `daily-consumption` through `publishStates`. Gas and
  water are `volume-sensor` in m³, NEVER in the energy monitoring (the core
  would price them at the electricity tariff). `power` stays the only
  `energy-sensor` / `power` feature (the energy contracts read the first one).
- **The billed index passes `IndexGuard`** (`src/guard.js`): a glitch would
  become a huge consumption.
- **A secondary page never blocks the main data**: `/f` (phases) failing
  keeps the power and the indexes going.
- **The password goes to the configured address only**: never log a URL (the
  login URL holds it), a body or a header; error messages use our own words
  and codes, never a text of the device.
- **External ids are forever**: `youless:<MAC>` or `youless:host-<address>`,
  the `FEATURE` keys of `src/devices.js`, the manifest keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume: `src/store.js` keeps the index reference and a jump held
  in `/data/youless-state.json`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code.
- **User-facing text** is bilingual (English and French): runtime messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync. Files are
  UTF-8 without BOM (`test/encoding.test.js`, sources included).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
