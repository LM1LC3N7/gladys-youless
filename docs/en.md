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
  - with a P1 meter (LS120), both tariffs are checked first: a tariff that
    falls to 0, or that goes down while the other does not, is a glitch of
    one register: no index for that read (the status says so), until the
    tariffs are consistent again;
  - a **drop** (meter replaced, counter set again in the YouLess) and a
    **jump up** (more than 100 kW on average since the last value) are
    **never** taken by themselves, neither with time, nor by repetition, nor
    by a restart, nor by saving the configuration: they are held (the hold is
    kept in `/data`), the last accepted value is sent to Gladys again, and the
    integration status shows the value held, also while the YouLess cannot be
    read. A value back to normal (the drop or the jump was a glitch) ends the
    hold, without billing anything; while a value is held, "normal" means
    close to the last accepted value since the last read, so a large rise is
    held in its turn (its kWh shown) rather than billed;
  - if the value held is right, click **Accept the held index** in the
    configuration of the integration. It takes **exactly the value shown**
    (plus what the home may draw until the next read): a **jump** is then
    **counted once** as consumption (the button says how many kWh), a
    **drop** bills nothing and the consumption goes on from there. Any other
    value read afterwards is held again. Accept a jump only if this energy
    was really consumed;
  - the margin grows with the time since the last value accepted (100 kW on
    average): after a **long outage** (YouLess off, network down), a large
    rise can pass at once, up to 2,400 kWh after 24 hours;
  - **way out of a dead end**: if the index stays held or absent for good (a
    new meter whose register stays at 0, for instance), delete the YouLess
    device in Gladys and create it again from the Discover tab: its
    reference starts again from the current index (the history of the old
    device is lost).
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
