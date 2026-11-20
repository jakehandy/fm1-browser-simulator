# Notice: the RemoteFM1 parts

The simulator is MIT ([LICENSE](LICENSE)), except **`src/remote-screen.js`**, which is under the
[Mozilla Public License 2.0](https://mozilla.org/MPL/2.0/). MPL-2.0 applies file by file, so the two sit side by
side in one page (MPL-2.0 section 3.3, a "Larger Work"); the MPL file's source is the file itself.

The "my FM-1" toggle talks to an FM-1 running [RemoteFM1](https://github.com/Quixotic7/RemoteFM1), whose protocol
(version 2) is the work of Michael P Jones (Quixotic7) and the RemoteFM1 contributors.

| File | Licence | Where it comes from |
|---|---|---|
| `src/remote.js` | MIT | New code. The protocol's facts (message numbers, body layouts, timings, the panel's MIDI) were taken from RemoteFM1's `docs/PROTOCOL.md` (GPL-3.0-only: facts only, see below), `proto/rfm1.h` and `firmware/src/remote_proto.h` (MPL-2.0), and the LED row bits from `firmware/src/rfm_host.c` (MPL-2.0). libremotefm1's `host/src/session.c` and `panel.c` (MPL-2.0) were read for how a host behaves (the 60 ms settle window before PANEL_R corrects a control, its waits and retries); none of their code was translated. |
| `src/remote-screen.js` | MPL-2.0 | A translation to JavaScript of part of libremotefm1's `host/src/screen.c` (MPL-2.0, Copyright (C) 2026 RemoteFM1 contributors), at RemoteFM1 commit `86e5975`. Changes: only the lossless path is kept (the lossy colour reduction, refinement and HOLD snapshots are left out); the input is the simulator's byte screen, converted to 16-bit pixels; pixels are written big-endian explicitly; the age sort uses `Array.prototype.sort`; a frame's bodies are returned instead of passed to a callback; no statistics. |
| `tests/remote.js` | MIT | New code: a fake MIDI port and a fake FM-1 written from the protocol, and a TILES decoder written from `docs/PROTOCOL.md` section 3. |

Not consulted: RemoteFM1's web player (`web/`, including `web/remote/remote.js`), which is GPL-3.0-only. No GPL
code went into any file here. RemoteFM1's `docs/PROTOCOL.md` is itself GPL-3.0-only: only facts about the
protocol were taken from it, never its text.
