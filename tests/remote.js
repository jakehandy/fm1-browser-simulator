/* src/remote.js against a fake MIDIAccess and a fake FM-1 that speaks RemoteFM1's protocol: the session, the
 * panel events, PANEL_R's resync, losing the FM-1 and finding it again, and (with h1) the panel state the
 * firmware sees.   node tests/remote.js */
"use strict";
const fs = require("fs"), path = require("path"), assert = require("assert");
const Rfm1 = require("../src/rfm1.js"), F = require("../src/remote.js"), S = require("../src/remote-screen.js");

/* ---- the fakes ---- */
function emitter(o) {
  o.ls = {};
  o.addEventListener = (t, f) => { (o.ls[t] = o.ls[t] || []).push(f); };
  o.removeEventListener = (t, f) => { o.ls[t] = (o.ls[t] || []).filter(g => g !== f); };
  o.emit = (t, e) => (o.ls[t] || []).slice().forEach(f => f(e));
  return o;
}
function access() {
  const a = emitter({ inputs: new Map(), outputs: new Map() });
  a.plug = (id, name, dev) => {
    const i = emitter({ id: "i" + id, name, state: "connected", open: () => Promise.resolve() });
    const o = { id: "o" + id, name, state: "connected", sent: [], send(d) { if (this.state !== "connected") throw new Error("gone"); this.sent.push(d); if (dev) dev.got(d); } };
    if (dev) dev.input = i;
    a.inputs.set(i.id, i); a.outputs.set(o.id, o);
    a.emit("statechange", { port: i }); a.emit("statechange", { port: o });
    return { i, o };
  };
  a.unplug = ({ i, o }) => {
    i.state = o.state = "disconnected";
    a.inputs.delete(i.id); a.outputs.delete(o.id);
    a.emit("statechange", { port: i }); a.emit("statechange", { port: o });
  };
  return a;
}
const le16 = v => [v & 255, v >> 8 & 255];
/* an FM-1 running RemoteFM1: answers HELLO and SESSION into a queue that deliver() hands to the page */
function device(opt) {
  opt = opt || {};
  const d = { q: [], session: false, got: [], shadow: new Uint8Array(240 * 240 * 2), panel: { keys: 0, buttons: 0, enc: [0, 0, 0, 0, 0, 0, 0], master: 512 } };
  d.got = m => {
    const x = F.parse(m);
    if (!x) return;
    d.got.log = (d.got.log || []).concat([x]);
    if (x.cmd === 0x01) {
      const b = new Array(67).fill(0);
      "RemoteFM1".split("").forEach((c, i) => { b[i] = c.charCodeAt(0); });
      b[16] = opt.proto || 2;
      "0.4.0".split("").forEach((c, i) => { b[17 + i] = c.charCodeAt(0); });
      b[55] = (opt.caps || 0) & 255; b[56] = (opt.caps || 0) >> 8;
      b[25] = opt.ble ? 0x31 : 0x07; b[29] = opt.ble ? 128 : 960 & 255; b[30] = opt.ble ? 0 : 960 >> 8;
      d.reply(0x41, b);
    } else if (x.cmd === 0x10 && x.body.length) {
      d.session = !!x.body[0];
      d.keepalive = x.body[1] | x.body[2] << 8;
      if (opt.noAck) return;
      d.reply(0x46, []);
      if (d.session) d.panelR();
    } else if (x.cmd === 0x13) d.panelR();
    else if (x.cmd === 0x14) d.touch = x.body[0];
    else if (x.cmd === 0x11) d.leds = Array.from(x.body);
    else if (x.cmd === 0x12) { const r = applyTiles(d.shadow, x.body); d.tiles = (d.tiles || []).concat([r]); }
  };
  d.reply = (cmd, body) => d.q.push(F.sx(cmd, body));
  d.midi = (...b) => d.q.push(b);
  d.panelR = () => {
    const p = d.panel, b = [p.keys & 255, p.keys >> 8 & 255, p.keys >> 16 & 255, p.keys >>> 24];
    b.push(...le16(p.buttons));
    p.enc.forEach(e => b.push(...le16(e & 0xffff)));
    b.push(...le16(p.master), 0, 0, (d.session ? 1 : 0) | (d.touch ? 2 : 0));
    d.reply(0x53, b);
  };
  d.deliver = () => d.q.splice(0).forEach(m => d.input.emit("midimessage", { data: new Uint8Array(m) }));   /* one round trip */
  return d;
}
function page() {
  const calls = [], st = [];
  return {
    calls, st,
    h: {
      key: (k, down, vel) => calls.push(["key", k, down, vel]),
      button: (b, down) => calls.push(["button", b, down]),
      enc: (e, d) => calls.push(["enc", e, d]),
      master: v => calls.push(["master", v]),
      status: (s, t) => st.push(s + ": " + t)
    }
  };
}
let clock = 1000;
const now = () => clock;
function setup(opt) {
  const a = access(), dev = device(opt), pg = page();
  const other = a.plug(9, "IAC Driver Bus 1");                 /* not an FM-1: never sent HELLO */
  const ota = a.plug(8, "ota-FM-1_015");                       /* the update loader: never sent HELLO */
  const fm = a.plug(1, "h1 FM-1", dev);                        /* CoreMIDI keeps the first firmware's name */
  const r = F.start(a, pg.h, Object.assign({ now, manual: true, screen: false }, opt));
  return { a, dev, pg, r, other, ota, fm };
}
function live(opt) {
  const s = setup(opt);
  s.r.tick(); s.dev.deliver(); s.dev.deliver();
  assert.strictEqual(s.r.state, "live", "the session is live");
  s.pg.calls.length = 0;
  return s;
}
const step = (s, ms) => { const end = clock + ms; while (clock < end) { clock += 10; s.r.tick(); } };

/* TILES into a device's shadow (240 x 240, BE RGB565 bytes), written from the protocol: { frame, end, rects } */
function applyTiles(sh, b) {
  const frame = b[0] | b[1] << 8, flags = b[2], n = b[3], encs = [];
  let o = 4;
  const put = (i, hi, lo) => { sh[2 * i] = hi; sh[2 * i + 1] = lo; };
  for (let r = 0; r < n; r++) {
    const x = b[o], y = b[o + 1], w = b[o + 2], h = b[o + 3], enc = b[o + 4];
    o += 5;
    encs.push(enc);
    assert.ok(w >= 1 && h >= 1 && x + w <= 240 && y + h <= 240, "rect in bounds");
    if (enc === 0) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++, o += 2) put((y + j) * 240 + x + i, b[o], b[o + 1]); }
    else if (enc === 1) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put((y + j) * 240 + x + i, b[o], b[o + 1]); o += 2; }
    else if (enc === 2) {
      const nc = b[o++], pal = [], bpp = nc <= 2 ? 1 : nc <= 4 ? 2 : 4, rb = Math.ceil(w * bpp / 8);
      assert.ok(nc >= 2 && nc <= 16);
      for (let k = 0; k < nc; k++, o += 2) pal.push([b[o], b[o + 1]]);
      for (let j = 0; j < h; j++, o += rb) for (let i = 0; i < w; i++) {
        const bit = i * bpp, idx = b[o + (bit >> 3)] >> (8 - bpp - (bit & 7)) & ((1 << bpp) - 1);
        put((y + j) * 240 + x + i, pal[idx][0], pal[idx][1]);
      }
    } else if (enc === 3) {
      let p = 0;
      while (p < w * h) { const len = b[o] + 1; for (let k = 0; k < len; k++, p++) put((y + Math.floor(p / w)) * 240 + x + p % w, b[o + 1], b[o + 2]); o += 3; }
      assert.strictEqual(p, w * h, "RLE ends on the rect");
    } else assert.fail("unknown enc " + enc);
  }
  assert.strictEqual(o, b.length, "the body ends with its last rect");
  return { frame, end: !!(flags & 1), rects: n, encs };
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("7-in-8 packing round-trips and matches a known vector", () => {
  for (let n = 0; n < 40; n++) {
    const b = Array.from({ length: n }, (_, i) => (i * 73 + n * 31) & 255);
    const p = F.pack7(b);
    assert.ok(p.every(x => x < 128), "packed bytes are 7-bit");
    assert.strictEqual(p.length, n + Math.ceil(n / 7));
    assert.deepStrictEqual(Array.from(F.unpack7(p)), b);
  }
  assert.deepStrictEqual(F.sx(0x10, [1, 0xb8, 0x0b]), [0xf0, 0x7d, 0x52, 0x46, 0x10, 0x02, 0x01, 0x38, 0x0b, 0xf7]);
  assert.strictEqual(F.parse([0xf0, 0x7e, 0x52, 0x46, 0x41, 0, 0xf7]), null, "another maker's SysEx");
});

test("HELLO goes only to FM-1 ports, and SESSION starts with a 3000 ms keepalive", () => {
  const s = setup();
  s.r.tick();
  assert.strictEqual(s.other.o.sent.length, 0);
  assert.strictEqual(s.ota.o.sent.length, 0);
  assert.strictEqual(F.parse(s.fm.o.sent[0]).cmd, 0x01);
  s.dev.deliver();
  assert.strictEqual(s.r.state, "starting");
  assert.strictEqual(s.dev.keepalive, 3000);
  s.dev.deliver();
  assert.strictEqual(s.r.state, "live");
  assert.ok(s.pg.st.some(t => /RemoteFM1 0\.4\.0/.test(t)), "the status names the version");
  assert.ok(s.r.owns(s.fm.i) && !s.r.owns(s.other.i));
});

test("a RemoteFM1 of another protocol version is not taken", () => {
  const s = setup({ proto: 3 });
  s.r.tick(); s.dev.deliver();
  assert.strictEqual(s.r.state, "looking");
  assert.ok(/protocol 3/.test(s.pg.st[s.pg.st.length - 1]));
});

test("SESSION is sent again when its ACK is lost, then the search starts over", () => {
  const s = setup({ noAck: true });
  s.r.tick(); s.dev.deliver();
  const sessions = () => s.dev.got.log.filter(x => x.cmd === 0x10).length;
  step(s, 1100);
  assert.ok(sessions() >= 3, "SESSION retried");
  step(s, 1500);
  assert.strictEqual(s.r.state, "looking");
});

test("keys, buttons, encoders and MASTER become panel calls", () => {
  const s = live();
  const d = s.dev;
  d.midi(0x9f, 53, 100); d.midi(0x8f, 53, 0);                  /* F3 */
  d.midi(0x9f, 79, 100); d.midi(0x9f, 79, 0);                  /* G5, its Note Off as a Note On at 0 */
  d.midi(0x9e, 12, 127); d.midi(0x8e, 12, 0);                  /* PLAY, matrix id 12 */
  d.midi(0x9e, 0, 127);                                        /* OCT- held */
  d.midi(0xbe, 16 + 6, 64 + 3); d.midi(0xbe, 16, 64 - 2);      /* matrix encoders 6 and 0 */
  d.midi(0xbe, 16 + 3, 64 + 63); d.midi(0xbe, 16 + 3, 64 + 7); /* a fast turn, split */
  d.midi(0xbe, 7, (1000 << 4) >> 7); d.midi(0xbe, 39, (1000 << 4) & 127);
  d.midi(0xbe, 39, 5);                                         /* an LSB without its MSB */
  d.midi(0x9f, 40, 100); d.midi(0x90, 60, 100);                /* not panel events */
  d.deliver();
  assert.deepStrictEqual(s.pg.calls, [
    ["key", 0, 1, 100], ["key", 0, 0, 0], ["key", 26, 1, 100], ["key", 26, 0, 0],
    ["button", 12, 1], ["button", 12, 0], ["button", 0, 1],
    ["enc", 6, 3], ["enc", 0, -2], ["enc", 3, 63], ["enc", 3, 7], ["master", 1000]]);
});

test("panel events from other ports, or before the session, are ignored", () => {
  const s = setup();
  s.dev.midi(0x9f, 53, 100); s.dev.deliver();
  s.other.i.emit("midimessage", { data: new Uint8Array([0x9f, 53, 100]) });
  assert.deepStrictEqual(s.pg.calls, []);
});

test("PANEL_R puts right what the events missed, but not a control that just moved", () => {
  const s = live();
  const d = s.dev, p = d.panel;
  p.keys = 1 << 4; p.buttons = 1 << 9; p.enc[2] = 5; p.master = 300;   /* nothing was heard of these */
  step(s, 100); d.panelR(); d.deliver();
  assert.deepStrictEqual(s.pg.calls, [["key", 4, 1, 100], ["button", 9, 1], ["enc", 2, 5], ["master", 300]]);
  s.pg.calls.length = 0;
  d.midi(0xbe, 16 + 2, 64 + 1); d.deliver();                     /* an event PANEL_R has not seen yet */
  d.panelR(); d.deliver();
  assert.deepStrictEqual(s.pg.calls, [["enc", 2, 1]], "a fresh event outranks an older PANEL_R");
  s.pg.calls.length = 0;
  step(s, 100); p.enc[2] = 6; d.panelR(); d.deliver();
  assert.deepStrictEqual(s.pg.calls, [], "the counters agree");
  p.enc[2] = 6 - 10; d.panelR(); d.deliver();
  assert.deepStrictEqual(s.pg.calls, [["enc", 2, -10]]);
  s.pg.calls.length = 0;
  p.enc[5] = 32767; d.panelR(); d.deliver();
  s.pg.calls.length = 0;
  p.enc[5] = -32767; d.panelR(); d.deliver();                       /* the int16 counter wraps */
  assert.deepStrictEqual(s.pg.calls, [["enc", 5, 2]]);
});

test("the first PANEL_R takes the encoder counters as they are", () => {
  const s = setup();
  s.dev.panel.enc = [100, -7, 0, 32000, 0, 0, 1]; s.dev.panel.keys = 1 << 26;
  s.r.tick(); s.dev.deliver(); s.dev.deliver();
  assert.deepStrictEqual(s.pg.calls, [["key", 26, 1, 100], ["master", 512]]);
});

test("keepalive: PANEL_REQ when idle, LEDS on change and once a second", () => {
  const s = live();
  const sent = cmd => s.fm.o.sent.map(F.parse).filter(x => x.cmd === cmd).length;
  const body = F.ledsBody([0], [255], 0);
  s.r.leds(body);
  s.r.tick();
  assert.strictEqual(sent(0x11), 1);
  assert.strictEqual(s.dev.leds[0], 2);                                 /* column 0, keymap row 1 */
  for (let i = 0; i < 30; i++) { clock += 100; s.r.tick(); s.dev.panelR(); s.dev.deliver(); }
  assert.ok(sent(0x11) >= 3 && sent(0x11) <= 4, "LEDS at least once a second, not every tick: " + sent(0x11));
  assert.strictEqual(sent(0x13), 0, "LEDS keep it alive, so no PANEL_REQ is needed");
  s.r.leds(null);
  for (let i = 0; i < 30; i++) { clock += 100; s.r.tick(); s.dev.panelR(); s.dev.deliver(); }
  assert.ok(sent(0x13) >= 2, "PANEL_REQ when nothing else goes");
  assert.strictEqual(s.r.state, "live");
});

test("TOUCH asks for real velocity where the unit has it", () => {
  const s = live({ caps: 1 << 10 });
  assert.strictEqual(s.dev.touch, 1);
  s.dev.midi(0x9f, 60, 37); s.dev.deliver();
  assert.deepStrictEqual(s.pg.calls, [["key", 7, 1, 37]]);
  assert.strictEqual(live().dev.touch, undefined, "not asked of a unit without it");
});

test("losing the FM-1 lets go of everything held, then finds it again", () => {
  const s = live();
  s.dev.midi(0x9f, 60, 100); s.dev.midi(0x9e, 6, 127); s.dev.deliver();
  s.pg.calls.length = 0;
  step(s, 1700);                                                         /* no PANEL_R */
  assert.strictEqual(s.r.state, "looking");
  assert.deepStrictEqual(s.pg.calls, [["key", 7, 0, 0], ["button", 6, 0]]);
  step(s, 1000); s.dev.deliver(); s.dev.deliver();
  assert.strictEqual(s.r.state, "live", "a new session");
});

test("PANEL_R without the session flag ends it", () => {
  const s = live();
  s.dev.session = false; s.dev.panelR(); s.dev.deliver();
  assert.strictEqual(s.r.state, "looking");
});

test("unplug and plug in again", () => {
  const s = live();
  s.dev.midi(0x9f, 53, 100); s.dev.deliver();
  s.a.unplug(s.fm);
  assert.strictEqual(s.r.state, "looking");
  assert.deepStrictEqual(s.pg.calls.slice(-1), [["key", 0, 0, 0]]);
  s.dev.session = false;
  const fm = s.a.plug(2, "h1 FM-1", s.dev);
  s.r.tick();
  assert.strictEqual(F.parse(fm.o.sent[0]).cmd, 0x01, "HELLO at once to the new port");
  s.dev.deliver(); s.dev.deliver();
  assert.strictEqual(s.r.state, "live");
  assert.ok(s.r.owns(fm.i));
});

test("stop() ends the session and lets go", () => {
  const s = live();
  s.dev.midi(0x9e, 3, 127); s.dev.deliver();
  s.r.stop();
  assert.strictEqual(s.dev.session, false, "SESSION 0 sent");
  assert.deepStrictEqual(s.pg.calls.slice(-1), [["button", 3, 0]]);
  assert.strictEqual(s.r.state, "off");
  s.dev.midi(0x9f, 53, 100); s.dev.deliver();
  assert.strictEqual(s.pg.calls.length, 2, "nothing after stop");
});

test("with h1: the FM-1's panel reaches the firmware as the same matrix state", async () => {
  const fw = Rfm1.parse(fs.readFileSync(path.join(__dirname, "../firmware/h1.rfm1")));
  const core = await Rfm1.Core.create(fw);
  core.boot(null);
  core.runMs(300);
  const s = live();
  /* the page's handlers (src/app.js remoteOn), without the DOM */
  s.r.h.key = (k, d, v) => core.key(k, d, v);
  s.r.h.button = (b, d) => { const i = core.btnId.indexOf(b); if (i >= 0) core.button(i, d); };
  s.r.h.enc = (e, d) => { const r = core.encId.indexOf(e); if (r >= 0) core.turn(r, d * core.encDir[r]); };
  s.r.h.master = v => core.master(v);
  const dv = core.dv(), u32 = n => dv.getUint32(core.p(n), true), enc = e => dv.getInt32(core.p("enc") + 4 * e, true);
  const e0 = [0, 1, 2, 3, 4, 5, 6].map(enc);
  s.dev.midi(0x9f, 53 + 9, 90);                                  /* D4 */
  s.dev.midi(0x9e, 2, 127);                                      /* FX, matrix id 2 */
  for (let e = 0; e < 7; e++) s.dev.midi(0xbe, 16 + e, 64 + e + 1);
  s.dev.midi(0xbe, 7, (700 << 4) >> 7); s.dev.midi(0xbe, 39, (700 << 4) & 127);
  s.dev.deliver();
  assert.strictEqual(u32("keys"), 1 << 9);
  assert.strictEqual(dv.getUint8(core.p("key_vel") + 9), 90);
  assert.strictEqual(u32("buttons"), 1 << 2);
  for (let e = 0; e < 7; e++) assert.strictEqual(enc(e) - e0[e], e + 1, "matrix encoder " + e);
  assert.strictEqual(core.master(), 700);
  core.runMs(100);
  assert.ok(!core.halted);
  s.dev.midi(0x8f, 53 + 9, 0); s.dev.midi(0x8e, 2, 0); s.dev.deliver();
  assert.strictEqual(u32("keys"), 0);
  assert.strictEqual(u32("buttons"), 0);
  /* h1's LEDs as LEDS: each light at its keymap column, in bit (row) */
  const l = core.leds(), b = F.ledsBody(core.btnLed.concat(core.keyLed), l.buttons.concat(l.keys), l.playGreen);
  assert.strictEqual(b.length, 45);
  const one = F.ledsBody(core.btnLed.concat(core.keyLed), core.btnLed.map(() => 0).concat([255]), 0);
  assert.strictEqual(one[3], 1 << 4, "key F3 (matrix id 14) is keymap row 4, column 3");
  const fx = F.ledsBody(core.btnLed, [255], 0);
  assert.strictEqual(fx[6], 1 << 1, "FX (matrix id 2) is keymap row 1, column 6");
});

test("the screen encoder: every kind of picture arrives exact, in bodies of at most 1024 bytes", async () => {
  const core = await Rfm1.Core.create(Rfm1.parse(fs.readFileSync(path.join(__dirname, "../firmware/h1.rfm1"))));
  core.boot(null);
  const pics = [];
  const pic = f => { const b = new Uint8Array(240 * 240 * 2); for (let i = 0; i < 57600; i++) { const c = f(i % 240, Math.floor(i / 240)) & 0xffff; b[2 * i] = c >> 8; b[2 * i + 1] = c & 255; } return b; };
  pics.push(pic(() => 0xf800));                                          /* FILL */
  pics.push(pic((x, y) => (x >> 3 ^ y >> 3) & 1 ? 0xffff : 0x0010));     /* two colours: PAL */
  pics.push(pic((x, y) => ((x + y) >> 2) * 0x0841));                     /* many colours, runs: RLE */
  let z = 7; pics.push(pic(() => (z = z * 1103515245 + 12345 >>> 0) >>> 16));   /* noise: RAW */
  pics.push(pic((x, y) => [0, 0x1234, 0xabcd, 0xffff, 0x07e0][(x * 7 + y * 3) % 5]));   /* 5 colours: PAL at 4 bpp */
  for (let k = 0; k < 4; k++) { core.runMs(400); core.turn(2, 1); pics.push(core.lcdBytes().slice()); }
  const s = new S.Screen(), sh = new Uint8Array(240 * 240 * 2);
  let frame = 0, frames = 0;
  const used = new Set();
  for (const p of pics) {
    s.submit(p);
    while (s.pending()) {
      const bodies = s.encode(frame++, 14000, 1024);
      frames++;
      bodies.forEach((b, i) => {
        assert.ok(b.length <= 1024, "a body fits SysEx");
        const r = applyTiles(sh, b);
        r.encs.forEach(e => used.add(e));
        assert.strictEqual(r.end, i === bodies.length - 1, "END on the last body only");
      });
    }
    assert.ok(same(sh, p), "the shadow is the picture");
  }
  assert.deepStrictEqual([...used].sort(), [0, 1, 2, 3], "RAW, FILL, PAL and RLE all used");
  assert.ok(frames > pics.length, "the noise took more than one frame's budget");
  s.submit(pics[pics.length - 1]);
  assert.deepStrictEqual(s.encode(frame, 14000, 1024), [], "nothing changed: nothing sent");
  s.invalidate();
  assert.strictEqual(s.pending(), 225);
});

test("the screen goes to the device: frames in flight wait for FRAME_ACK, a lost one sends it all again", async () => {
  const core = await Rfm1.Core.create(Rfm1.parse(fs.readFileSync(path.join(__dirname, "../firmware/h1.rfm1"))));
  core.boot(null);
  core.runMs(1500);
  const s = live({ screen: true });
  const tilesSent = () => s.fm.o.sent.map(F.parse).filter(x => x.cmd === 0x12);
  const lcd = core.lcdBytes().slice();
  for (let i = 0; i < 57600; i += 3) { lcd[2 * i] ^= 0x55; }             /* a busy picture: several frames */
  s.r.screen(lcd);
  for (let i = 0; i < 10; i++) { clock += 60; s.r.tick(); }
  const frames = new Set(tilesSent().map(x => x.body[0] | x.body[1] << 8));
  assert.strictEqual(frames.size, 2, "two frames, then it waits for FRAME_ACK");
  const ack = f => { s.dev.reply(0x52, [f & 255, f >> 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); s.dev.deliver(); };
  for (let k = 0; k < 40 && !same(s.dev.shadow, lcd); k++) {
    const last = tilesSent().pop();
    ack(last.body[0] | last.body[1] << 8);
    clock += 60; s.r.tick();
  }
  assert.ok(same(s.dev.shadow, lcd), "the device's shadow is the simulator's screen");
  const before = tilesSent().length;
  s.r.screen(core.lcdBytes().slice());
  clock += 60; s.r.tick();                                               /* sent, and never acknowledged */
  clock += 60; s.r.tick();
  clock += 1100; s.r.tick();
  assert.ok(tilesSent().length > before + 1, "sent again after the FRAME_ACK timeout");
  assert.ok(F.T.frameAck === 1000);
});

test("no screen over Bluetooth MIDI, where the link is a few KB/s", async () => {
  const s = live({ screen: true, ble: true });
  s.r.screen(new Uint8Array(240 * 240 * 2).fill(0x5a));
  for (let i = 0; i < 10; i++) { clock += 60; s.r.tick(); }
  assert.strictEqual(s.fm.o.sent.map(F.parse).filter(x => x.cmd === 0x12).length, 0);
  assert.ok(s.r.info.ble && !live({ screen: true }).r.info.ble);
});

(async () => {
  let bad = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok   " + name); } catch (e) { bad++; console.log("FAIL " + name + "\n     " + (e.stack || e).toString().split("\n").slice(0, 3).join("\n     ")); }
  }
  console.log(tests.length - bad + "/" + tests.length + " passed");
  process.exit(bad ? 1 : 0);
})();
