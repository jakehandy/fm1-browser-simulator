# FM-1 Browser Simulator

Play any M-VAVE FM-1 firmware in a web browser. Drop in an `.rfm1` file and it runs from its own code, with its
240 × 240 screen, its sound, the 27 keys, the seven encoders, MASTER, the 14 buttons and their lights. Nothing to
install, and nothing touches your FM-1.

It opens with **[h1 (or handy-1)](https://github.com/jakehandy/h1)** loaded. To put h1 on a real FM-1, install it from
[its listing on The Firmware Hub](https://thefirmwarehub.com/firmware/h1/).

![h1 running in the simulator, controls as sliders](docs/img/sliders.png)

## Try it

- **Online:** [jakehandy.github.io/fm1-browser-simulator](https://jakehandy.github.io/fm1-browser-simulator/)
- **One file:** download [`dist/fm1-simulator.html`](dist/fm1-simulator.html) and open it. h1 is inside it, so it
  works offline and from any static host.
- **From a clone:** `npm run serve` (or `python3 -m http.server`) and open http://localhost:8000.

Click anything to turn the sound on. Chrome, Edge, Firefox and Safari all work, on a phone too.

## Run another firmware

Press **firmware** at the top, then open an `.rfm1` file, paste a link to one, or drop it anywhere on the page.
The simulator keeps every file you load (in your browser, never uploaded), so it is there next time, and each
firmware keeps its own saved state the way the device keeps its flash.

Where to get them:

- **The [RemoteFM1FW release](https://github.com/Quixotic7/RemoteFM1FW/releases/latest)**: more than fifty
  community firmwares already built as `.rfm1`, Felucca, ChoralRoot, CTL-1, AMB-1, GHOULBOX and DUELL among them.
  Download one, drop it on the page.
- **Any fm1-base firmware:** `tools/build.py APP_DIR --rfm1` in [fm1-base](https://github.com/charlesvestal/fm1-base).
- **Felucca and the firmwares built on it:** [FM1VST](https://github.com/Quixotic7/FM1VST)'s `fm1_add_rfm1`.
- **Your own:** see [Firmware interface](docs/FIRMWARE-INTERFACE.md). h1's
  [`port/rfm1/rfm1.c`](https://github.com/jakehandy/h1/blob/main/port/rfm1/rfm1.c) is a complete example in one
  file with no libc.

You can also link straight to a firmware: `?fw=https://example.com/my-firmware.rfm1` (the host has to allow
cross-site downloads, which GitHub release links don't).

Four of them running here, straight from the release files:

<table>
<tr>
<td width="50%"><img src="docs/img/fw-felucca.png" alt="Felucca 1.8.2 in the simulator"><br><b>Felucca</b> 1.8.2, Leo Kuroshita</td>
<td width="50%"><img src="docs/img/fw-choralroot.png" alt="ChoralRoot 0.41 in the simulator, with its own skin and button names"><br><b>ChoralRoot</b> 0.41, Quixotic7: its own skin and button names</td>
</tr>
<tr>
<td><img src="docs/img/fw-amb.png" alt="AMB-1 1.3.2 in the simulator"><br><b>AMB-1</b> 1.3.2, Charles Vestal</td>
<td><img src="docs/img/fw-ctl.png" alt="CTL-1 1.0.3 in the simulator"><br><b>CTL-1</b> 1.0.3, Charles Vestal</td>
</tr>
</table>

![the firmware picker: h1 built in, Felucca and ChoralRoot loaded from files](docs/img/picker.png)

**What it can't run:** a firmware's `.fwsc` install package. That is machine code for the FM-1's JieLi chip and
would need an emulator of that CPU. Use the firmware's `.rfm1` build instead.

## Playing it

| | |
| --- | --- |
| **Keys** | Mouse, touch, or the computer keyboard: `A S D F G H J K L ; '` are the white keys from F, `W E R Y U O P [` the black ones. Where you hit a key sets its velocity: near the front is loud. |
| **Sliders or knobs** | The toggle at the top. Knobs turn with a drag up or down, the scroll wheel or the arrow keys. Sliders jump straight to a value when the firmware reports what the knob is tied to (h1 does). Otherwise a slider turns the encoder as far as you drag it, then springs back to the middle. |
| **Encoders from the keyboard** | `,` `.` SELECT, `←` `→` PRESETS, `↑` `↓` ALGORITHM, `1`–`4` the four knobs (`Shift` turns down). The ‹ › buttons beside a slider send single clicks, the way the real encoder steps. |
| **Buttons** | Labelled with the running firmware's own names, and its live labels when it gives them. Hold as long as you like. To press two at once, `Shift`-click the first (it gets a dashed outline), then click the second: both go down together, as two fingers would, and come up together (h1's SEQ + REC for LAYERS). `Shift`-click a button and then turn an encoder or play a key, and it stays held until you click it again (EDIT + SELECT). `Z` `X` are OCT − and OCT +. |
| **MIDI in** | Tick it to play the firmware from a MIDI keyboard or a DAW (Web MIDI). |
| **Power cycle** | Restarts the firmware with its saved state. *About this firmware* erases that state. |

![the same panel with knobs](docs/img/knobs.png)

<p align="center"><img src="docs/img/phone.png" width="300" alt="the simulator on a phone, with knobs"></p>

On a phone the panel stacks in the order a thumb wants: screen, the four knobs, keys, buttons, then the rest.

The **screen link** meter shows how long the part of the screen that changed would take to reach the FM-1's
panel over its SPI link. Under 16.7 ms means the device can draw that animation at 60 frames a second.

## How it works

An `.rfm1` is a firmware's host build compiled to WebAssembly behind the community's `fm1core` ABI: the format
RemoteFM1 for iOS and FM1VST also run, described in
[RFM1-FORMAT.md](https://github.com/Quixotic7/RemoteFM1IOS/blob/main/docs/RFM1-FORMAT.md). The simulator is a
host for that format, written from the spec:

- [`src/rfm1.js`](src/rfm1.js) checks and loads a file, then drives the firmware one device millisecond at a
  time with the same 44.1 kHz audio blocks and 15 ms frames the FM-1 uses. It has no DOM, so the tests run it
  in Node.
- [`src/app.js`](src/app.js) is the panel: screen, keys, buttons, sliders and knobs, LEDs, MIDI, and storage.
- The optional **sim1** extension lets a firmware report what each encoder is tied to, its range and its value
  text, plus an accent colour. That is how h1's sliders show `TEMPO 112 BPM` and the page takes on each
  instrument's ink. Other hosts ignore it. Details in [docs/FIRMWARE-INTERFACE.md](docs/FIRMWARE-INTERFACE.md).

What a simulator can't tell you: how hard the FM-1's own processor is working, how the speaker sounds, or how
the keys and encoders feel. Code that only exists on the chip (drivers, Bluetooth, USB) isn't in an `.rfm1`
either.

## Develop

```sh
npm run serve        # the page, from src/
npm test             # boots every .rfm1 in firmware/ headless: screen, sound, flash
node tests/run.js path/to/other.rfm1
npm run build        # dist/fm1-simulator.html, one self-contained file
tools/update-h1.sh ../h1 0.3   # rebuild the bundled h1 from a checkout and refresh dist/
```

No dependencies and no bundler: plain scripts, Node 18+ for the tests and the build. h1's `.rfm1` builds with
clang's wasm32 target, without emscripten.

## Credits

The `.rfm1` format and the `fm1core` ABI are Michael P Jones's (Quixotic7), from RemoteFM1 and FM1VST.
fm1-base is Charles Vestal's, and Felucca, the firmware most of the field grew from, is Leo Kuroshita's
(Hügelton Instruments). This project has no code from any of them. It isn't affiliated with M-VAVE.

The simulator is MIT licensed ([LICENSE](LICENSE)). Every firmware keeps its own licence: the page shows each
one's licence texts, credits and exact source under *About this firmware*. h1 is by Jake Handy, also MIT.
