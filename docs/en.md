# YouLess for Gladys Assistant

**Unofficial** integration, not affiliated with YouLess. It reads your
**YouLess** energy monitor (LS110, LS120, LS120 with the PVOutput firmware)
**straight on your home network**, without any cloud or account.

> **Never tested on a real YouLess.** The integration was written from the
> youless-api library (used by Home Assistant) and simulated answers. Your
> feedback on the Gladys forum is welcome.

## What you get

A "YouLess LS110" or "YouLess LS120" device, with only what your monitor
gives:

| Value                                                 | Pace         | Type in Gladys                                   |
| ----------------------------------------------------- | ------------ | ------------------------------------------------ |
| Power (W)                                             | 10 s         | energy sensor, power                             |
| Consumption index (kWh)                               | 1 min        | energy sensor, **index**: energy monitoring      |
| Index per tariff 1 / 2 (kWh, P1 meter)                | 1 min        | plain sensors                                    |
| Injection index, total and per tariff (kWh, P1 meter) | 1 min        | plain sensors, **never billed**                  |
| Current tariff (as the YouLess gives it)              | 1 min        | plain sensor                                     |
| Power, voltage, current per phase                     | 10 s         | sensors, no history by default (LS120 1.5+)      |
| S0 input: power (W) and index (kWh)                   | 10 s / 1 min | plain sensors                                    |
| Gas (m³), water (m³)                                  | 1 min        | volume sensors, **out of the energy monitoring** |

The Gladys **energy monitoring** computes the consumption per half hour and
its cost by itself from the consumption index (with a P1 meter: tariff 1 +
tariff 2; the injection is never subtracted from it nor added to it). The
injection, gas and water stay apart: Gladys would price the gas at the
electricity tariff, and the injection would be counted as consumption.

With a P1 meter, the power is assumed to be the **net** power: it would go
below zero while you inject (not checked). The current tariff is published as
the YouLess gives it (0/1 or 1/2 depending on the sources).

## Setup

1. Give the YouLess a **fixed IP address** in your router (an LS110 is known
   by its address: changing it creates a new device).
2. In Gladys, install the YouLess integration from the store, open its
   configuration and enter the **address** of the YouLess (e.g.
   `192.168.1.50`, with `:port` only if it is not 80).
3. **Password**: only if the web page of the YouLess is protected. It is kept
   by Gladys in its database (not encrypted), never shown again, and only sent
   to the YouLess, over plain HTTP on your network (the device has no HTTPS).
4. Click **Test the connection**: the model, power and index read are shown.
5. In the **Discover** tab, create the YouLess device. Its values arrive at
   once.

## Model detection

- `/d` answers (MAC, firmware) and `/e` gives the Enelogic data: **LS120**,
  read through `/e`, plus `/f` (phases) from firmware 1.5;
- `/d` answers but `/e` answers 404 or without Enelogic data: **LS120
  PVOutput firmware**, read through `/a?f=j`;
- `/d` answers 404: **LS110**, read through `/a?f=j`.

Any other answer (another HTTP error, no answer) is a passing failure, tried
again: never a model guess. An LS120 is known by its MAC address; an LS110 (no
MAC) by its address. A device created as an LS120 is never "downgraded" to an
LS110 or to the PVOutput firmware by a detection: the status says so and the
integration tries again (if you replaced the YouLess, delete the old device).

## Good to know

- **Unreachable device**: the integration status says so, and it tries again
  after 10 s, then 20 s, 40 s… up to 5 minutes, never stuck. Saving the
  configuration tries at once.
- **Refused password**: one try every 5 minutes only.
- **Phases page** (`/f`) down: the power and the indexes go on; the status
  says so.
- **Protected consumption index** (Gladys counts every rise in full):
  - an index of 0 is never sent; with a P1 meter, a read without P1 data (P1
    cable cut) gives no index at all, never `net`;
  - a **drop** (meter replaced, counter set again in the YouLess) is taken
    only after 60 minutes of non-zero values that stop going down;
  - a **jump up** (more than 100 kW on average since the last value) is
    **never** taken by itself: it is held and the integration status shows
    it. If it is right, **save the configuration** of the integration: the
    current index is then accepted, and the difference is **counted once** as
    consumption.
- **Phases page refusing the password**: left alone for 5 minutes, without a
  new login; the rest goes on.
- Gas and water readings older than 26 h are ignored (the YouLess keeps its
  last value when the meter stops answering).
- Unchanged values are sent again every 10 minutes only; at each
  reconnection to Gladys, the device and all its values are published again.
- The features of the device are fixed when it is created: if a value shows
  up later (a first gas reading, for instance), click "Update" in the Discover
  tab: the new values arrive at once. The device published again never loses
  a feature of the created one, even while a value is missing.

## Limits

- One YouLess per installation of the integration.
- The password travels in clear on the home network (a constraint of the
  device); the login through the `/L?w=<password>` page is assumed
  (youless-api uses HTTP Basic authentication, not taken over here), not
  checked on a protected device.
- The monthly peaks (`pp`, `pa`) of the LS120 are not read for now.

## Credits

Reading logic ported from
[youless-api](https://github.com/gjong/youless-python-bridge) (MIT, Gerben
Jongerius), list of values inspired by the YouLess integration of Home
Assistant (Apache-2.0). Integration code under the Apache-2.0 license.
