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
| Current tariff (1 or 2)                               | 1 min        | plain sensor                                     |
| Power, voltage, current per phase                     | 10 s         | sensors (LS120 firmware 1.5 and later)           |
| S0 input: power (W) and index (kWh)                   | 10 s / 1 min | plain sensors                                    |
| Gas (m³), water (m³)                                  | 1 min        | volume sensors, **out of the energy monitoring** |

The Gladys **energy monitoring** computes the consumption per half hour and
its cost by itself from the consumption index (with a P1 meter: tariff 1 +
tariff 2; the injection is never subtracted from it nor added to it). The
injection, gas and water stay apart: Gladys would price the gas at the
electricity tariff, and the injection would be counted as consumption.

With a P1 meter, the power is the **net** power: it goes below zero while you
inject.

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
- `/d` answers but not `/e`: **LS120 PVOutput firmware**, read through
  `/a?f=j`;
- no `/d`: **LS110**, read through `/a?f=j`.

An LS120 is known by its MAC address; an LS110 (no MAC) by its address.

## Good to know

- **Unreachable device**: the integration status says so, and it tries again
  after 10 s, then 20 s, 40 s… up to 5 minutes, never stuck. Saving the
  configuration tries at once.
- **Refused password**: one try every 5 minutes only.
- **Phases page** (`/f`) down: the power and the indexes go on; the status
  says so.
- **Odd index** (a drop to 0, a huge jump): it is not sent to Gladys until
  read 3 times in a row, so that the consumption and cost stay right (a
  replaced meter therefore goes through in the end).
- Gas and water readings older than 26 h are ignored (the YouLess keeps its
  last value when the meter stops answering).
- Unchanged values are sent again every 10 minutes only; at each
  reconnection to Gladys, the device and all its values are published again.
- The features of the device are fixed when it is created: if a value shows
  up later (a first gas reading, for instance), click "Update" in the Discover
  tab.

## Limits

- One YouLess per installation of the integration.
- The password travels in clear on the home network (a constraint of the
  device); the login through the `/L?w=<password>` page is assumed, not
  checked on a protected device.
- The monthly peaks (`pp`, `pa`) of the LS120 are not read for now.

## Credits

Reading logic ported from
[youless-api](https://github.com/gjong/youless-python-bridge) (MIT, Gerben
Jongerius), list of values inspired by the YouLess integration of Home
Assistant (Apache-2.0). Integration code under the Apache-2.0 license.
