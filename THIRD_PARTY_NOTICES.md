# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the project below, distributed under its own
license.

## youless-api (gjong/youless-python-bridge)

<https://github.com/gjong/youless-python-bridge>, by Gerben Jongerius, the
library the YouLess integration of Home Assistant uses.

Ported to JavaScript in `src/youless/client.js` and `src/youless/model.js`:
the detection of the model (`/d`, then the Enelogic answer of `/e`, else the
generic `/a?f=j` of the LS110 and of the LS120 PVOutput firmware), the
meaning of the fields of each page (`cnt`, `pwr`, `cs0`, `ps0`, `p1`, `p2`,
`n1`, `n2`, `net`, `gas`, `gts`, `wtr`, `wts`, and `tr`, `i1`..`i3`,
`v1`..`v3`, `l1`..`l3` of `/f`), the comma decimals of `/a?f=j`, the stale gas
and water readings, and the firmware (1.5) that brings the phases page.
NOT ported: its authentication (HTTP Basic credentials); the login of a
protected device through `/L?w=<password>` is this integration's own
assumption.

Its license, reproduced as it appears in the repository (commit d5a6726):

```
MIT License

Copyright (c) 2024 Gerben Jongerius

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Home Assistant, YouLess integration

<https://github.com/home-assistant/core/tree/dev/homeassistant/components/youless>
(Apache-2.0, the Home Assistant authors), consulted for the list of the
values a YouLess gives and the 10-second polling. No code is copied from it.
