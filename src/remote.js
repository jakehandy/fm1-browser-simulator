/* remote.js: a real FM-1 as the simulator's panel. The FM-1 runs the RemoteFM1 firmware; this file opens a
 * RemoteFM1 session with it over Web MIDI (SysEx) and turns its keys, buttons, encoders and MASTER into calls
 * the page makes on the simulated panel. It can send the page's LEDs back. No DOM in it (the tests run it in Node).
 *
 * Written from RemoteFM1's protocol, version 2 (Quixotic7 and the RemoteFM1 contributors: docs/PROTOCOL.md and
 * proto/rfm1.h in https://github.com/Quixotic7/RemoteFM1). No RemoteFM1 code is in this file: see NOTICE.md.
 *
 *   var r = Fm1Remote.start(midiAccess, {          // a MIDIAccess asked for with { sysex: true }
 *     key: function (k, down, vel) {},             // k 0..26, F3 = 0
 *     button: function (b, down) {},               // b the matrix id 0..13: 0 OCT-, 1 OCT+, 2 FX ... 12 PLAY, 13 REC
 *     enc: function (e, d) {},                     // matrix encoder 0..6, d detents in matrix sense (+ clockwise)
 *     master: function (adc) {},                   // 0..1023
 *     status: function (state, text) {}            // state: "looking", "starting", "live", "off"
 *   });
 *   r.leds(Fm1Remote.ledsBody(pos, level, green));  r.screen(core.lcdBytes());  r.owns(port);  r.stop();
 *
 * The screen goes back only when src/remote-screen.js (MPL-2.0, its encoder) is loaded too.
 */
(function (root) {
  "use strict";

  var ID = [0x7d, 0x52, 0x46];                 /* non-commercial 7D, then "RF" */
  var HELLO = 0x01, SESSION = 0x10, LEDS = 0x11, TILES = 0x12, PANEL_REQ = 0x13, TOUCH = 0x14;
  var HELLO_R = 0x41, ACK = 0x46, FRAME_ACK = 0x52, PANEL_R = 0x53;
  var NKEY = 27, NBTN = 14, NENC = 7, KEEPALIVE = 3000, CAP_TOUCH = 1 << 10;
  /* in ms: between rounds of HELLO, for the ACK, between keepalives, without PANEL_R (it comes every 500 ms)
   * before the session counts as gone, how long a control's own MIDI event outranks PANEL_R, LEDS at least this often,
   * between screen frames (20 a second), for a FRAME_ACK */
  var T = { again: 1000, ack: 500, req: 1000, lost: 1600, settle: 60, leds: 1000, touch: 300, frame: 50, frameAck: 1000 };
  /* the screen over USB-MIDI SysEx: about 280 KB/s, so 14000 bytes a frame at 20 a second, in bodies of at most
   * 1024 bytes, at most 2 frames unacknowledged */
  var BUDGET = 14000, BODY = 1024, IN_FLIGHT = 2;
  var PORT = /FM-?1|RemoteFM1/i, NOT = /update|ota-/i;

  /* ---- the wire: 7-in-8 packing (a byte of top bits, then up to 7 low-bit bytes), little-endian fields ---- */
  function pack7(b) {
    var out = [], i, k, n, top;
    for (i = 0; i < b.length; i += 7) {
      n = Math.min(7, b.length - i);
      for (top = 0, k = 0; k < n; k++) top |= (b[i + k] >> 7 & 1) << k;
      out.push(top);
      for (k = 0; k < n; k++) out.push(b[i + k] & 0x7f);
    }
    return out;
  }
  function unpack7(b) {
    var out = [], i, k;
    for (i = 0; i < b.length; i += 8) for (k = 1; k < 8 && i + k < b.length; k++) out.push(b[i + k] & 0x7f | (b[i] >> (k - 1) & 1) << 7);
    return new Uint8Array(out);
  }
  function sx(cmd, body) { return [0xf0].concat(ID, [cmd], pack7(body || []), [0xf7]); }
  /* a RemoteFM1 SysEx message as { cmd, body }, or null for anything else */
  function parse(d) {
    var n = d.length;
    if (n < 6 || d[0] !== 0xf0 || d[n - 1] !== 0xf7 || d[1] !== ID[0] || d[2] !== ID[1] || d[3] !== ID[2]) return null;
    return { cmd: d[4], body: unpack7(Array.prototype.slice.call(d, 5, n - 1)) };
  }
  function u16(b, i) { return b[i] | b[i + 1] << 8; }
  function text(b, i, n) { var s = "", k; for (k = i; k < i + n && b[k]; k++) s += String.fromCharCode(b[k]); return s; }
  function hello(b) {
    if (b.length < 51) return null;
    /* a reply over Bluetooth MIDI has at most 256 send packets free (sxq) with transports bit4 set */
    return { name: text(b, 0, 16), proto: b[16], version: text(b, 17, 8), caps: b.length >= 57 ? u16(b, 55) : 0,
      ble: u16(b, 29) <= 256 && !!(b[25] & 16) };
  }
  function panel(b) {
    var enc = [], i;
    if (b.length < 25) return null;
    for (i = 0; i < NENC; i++) enc.push(u16(b, 6 + 2 * i) << 16 >> 16);
    return { keys: (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0, buttons: u16(b, 4), enc: enc,
      master: Math.min(1023, u16(b, 20)), battery: u16(b, 22), flags: b[24] };
  }
  /* LEDS' 45-byte body from brightness 0..255. pos[i] is a light's place as src/rfm1.js has it (column * 4 + line,
   * the line being keymap row - 1, -1 for none); each column byte holds row r in bit r. lit, mid, dim, faint
   * are the device's four levels; the thresholds are this file's choice */
  function ledsBody(pos, level, green) {
    var b = new Uint8Array(45), i, q, v, at;
    for (i = 0; i < pos.length; i++) {
      q = pos[i]; v = level[i] | 0;
      if (q < 0 || !v) continue;
      at = v >= 160 ? 0 : v >= 48 ? 11 : v >= 12 ? 22 : 33;
      b[at + (q >> 2)] |= 1 << ((q & 3) + 1);
    }
    b[44] = green >= 128 ? 1 : 0;
    return b;
  }

  /* ---- the session ---- */
  function Remote(access, h, opt) {
    opt = opt || {};
    this.access = access;
    this.h = h;
    this.now = opt.now || function () { return typeof performance !== "undefined" ? performance.now() : Date.now(); };
    this.touch = opt.touch !== false;          /* ask for the keys' real velocity when the unit can */
    this.scr = opt.screen !== false && root.Fm1RemoteScreen ? new root.Fm1RemoteScreen.Screen() : null;
    this.state = "off";
    this.hooked = {};
    this.timer = 0;
    this.ledsWant = null;
  }
  Remote.prototype.start = function (manual) {
    var self = this;
    this.onState = function (e) { self._portChange(e.port); };
    if (this.access.addEventListener) this.access.addEventListener("statechange", this.onState);
    this._hook();
    this._look("looking for an FM-1 running RemoteFM1");
    if (!manual) this.timer = setInterval(function () { self.tick(); }, 50);
    return this;
  };
  Remote.prototype.stop = function () {
    var self = this;
    if (this.state === "live" || this.state === "starting") this._send(SESSION, [0]);
    this._release();
    clearInterval(this.timer);
    this.timer = 0;
    if (this.access.removeEventListener) this.access.removeEventListener("statechange", this.onState);
    Object.keys(this.hooked).forEach(function (id) { var x = self.hooked[id]; x.port.removeEventListener("midimessage", x.fn); });
    this.hooked = {};
    this._set("off", "off");
  };
  /* the session's MIDI input: the page's own MIDI in leaves it alone (its panel events are not notes to play) */
  Remote.prototype.owns = function (port) {
    return !!this.input && !!port && (port.id === this.input.id || port.name === this.input.name);
  };
  Remote.prototype.leds = function (body) { this.ledsWant = body; };
  Remote.prototype.screen = function (lcd) { if (this.scr) this.scr.submit(lcd); };

  Remote.prototype._set = function (state, why) {
    this.state = state;
    if (this.h.status) this.h.status(state, why);
  };
  Remote.prototype._each = function (map, fn) { if (map) map.forEach(function (p) { fn(p); }); };
  Remote.prototype._fits = function (p) { return p.state !== "disconnected" && PORT.test(p.name || "") && !NOT.test(p.name || ""); };
  Remote.prototype._hook = function () {
    var self = this;
    this._each(this.access.inputs, function (i) {
      if (self.hooked[i.id] || !self._fits(i)) return;
      var fn = function (ev) { self._midi(i, ev.data); };
      self.hooked[i.id] = { port: i, fn: fn };
      i.addEventListener("midimessage", fn);
      if (i.open) try { var p = i.open(); if (p && p.catch) p.catch(function () {}); } catch (e) { /* fine */ }
    });
  };
  Remote.prototype._portChange = function (p) {
    if (!p) return;
    if (p.state === "disconnected") {
      if (this.hooked[p.id]) { this.hooked[p.id].port.removeEventListener("midimessage", this.hooked[p.id].fn); delete this.hooked[p.id]; }
      if ((this.input && p.id === this.input.id) || (this.out && p.id === this.out.id)) this._look("the FM-1 was unplugged: looking for it");
      return;
    }
    this._hook();
    if (this.state === "looking") this.tSent = -Infinity;   /* a port came: HELLO it now */
  };
  Remote.prototype._look = function (why) {
    this._release();
    this.input = this.out = this.info = null;
    this.tSent = -Infinity;
    this._set("looking", why);
  };
  Remote.prototype._send = function (cmd, body, out) {
    out = out || this.out;
    if (!out) return false;
    try { out.send(sx(cmd, body)); } catch (e) { return false; }
    this.tTx = this.now();
    return true;
  };
  /* every held key and button comes up, so nothing sticks when the FM-1 goes */
  Remote.prototype._release = function () {
    var p = this.p, k;
    if (p) {
      for (k = 0; k < NKEY; k++) if (p.keys >>> k & 1) this.h.key(k, 0, 0);
      for (k = 0; k < NBTN; k++) if (p.buttons >> k & 1) this.h.button(k, 0);
    }
    this.p = { keys: 0, buttons: 0, enc: [0, 0, 0, 0, 0, 0, 0], master: -1, msb: -1, synced: false, tKey: [], tBtn: [], tEnc: [], tMaster: 0 };
  };
  Remote.prototype._begin = function (input, info) {
    var self = this, outs = [];
    this._each(this.access.outputs, function (o) { if (self._fits(o)) outs.push(o); });
    var out = outs.filter(function (o) { return o.name === input.name; })[0] || (outs.length === 1 ? outs[0] : null);
    if (!out) return;
    this.input = input;
    this.out = out;
    this.info = info;
    this.tries = 0;
    this._release();
    this._session();
    this._set("starting", "starting a session with RemoteFM1 " + info.version);
  };
  Remote.prototype._session = function () {
    this._send(SESSION, [1, KEEPALIVE & 0xff, KEEPALIVE >> 8]);
    this.tSent = this.now();
  };
  Remote.prototype._live = function (now) {
    this.tPanel = now;
    this.tLeds = -Infinity;
    this.ledsSent = null;
    this.touchAsked = 0;
    if (this.touch && this.info.caps & CAP_TOUCH) { this._send(TOUCH, [1]); this.touchAsked = now; }
    if (this.scr) this.scr.reset();            /* a session starts with the device's screen black */
    this.frame = 0;
    this.inflight = [];
    this.tFrame = -Infinity;
    this._set("live", "playing from RemoteFM1 " + this.info.version);
  };

  Remote.prototype.tick = function (now) {
    var a = this.ledsWant, b = this.ledsSent, i, same;
    now = now === undefined ? this.now() : now;
    if (this.state === "looking") {
      if (now - this.tSent < T.again) return;
      var self = this, n = 0;
      this.tSent = now;
      this._hook();
      this._each(this.access.outputs, function (o) { if (self._fits(o) && self._send(HELLO, [], o)) n++; });
      if (!n && this.h.status) this.h.status("looking", "no FM-1 found: plug it in, running RemoteFM1");
    } else if (this.state === "starting") {
      if (now - this.tSent < T.ack) return;
      if (++this.tries > 3) { this._look("RemoteFM1 did not start a session: looking again"); return; }
      this._session();
    } else if (this.state === "live") {
      if (now - this.tPanel > T.lost) { this._look("lost the FM-1 (no answer): looking for it"); return; }
      if (a) {
        for (same = !!b, i = 0; same && i < 45; i++) same = a[i] === b[i];
        if (!same || now - this.tLeds >= T.leds) { this._send(LEDS, Array.prototype.slice.call(a)); this.ledsSent = a; this.tLeds = now; }
      }
      this._frame(now);
      if (now - this.tTx >= T.req) this._send(PANEL_REQ, []);   /* any message keeps the session; this one when nothing else went */
    }
  };

  /* one frame of the screen's changed tiles, when the device has room for it */
  Remote.prototype._frame = function (now) {
    var s = this.scr, self = this, f = this.frame;
    if (!s || this.info.ble) return;           /* a few KB/s over Bluetooth: too slow for this pacing, so no screen */           /* a few KB/s over Bluetooth: too slow for this pacing, so no screen */
    if (this.inflight.length && now - this.inflight[0].t > T.frameAck) { this.inflight = []; s.invalidate(); }   /* lost: all again */
    if (this.inflight.length >= IN_FLIGHT || now - this.tFrame < T.frame || !s.pending()) return;
    s.encode(f, BUDGET, BODY).forEach(function (b) { self._send(TILES, b); });
    this.inflight.push({ f: f, t: now });
    this.frame = (f + 1) & 0xffff;
    this.tFrame = now;
  };
  Remote.prototype._midi = function (port, d) {
    var now = this.now(), m, info, r;
    if (!d || !d.length) return;
    if (d[0] === 0xf0) {
      if (!(m = parse(d))) return;
      if (m.cmd === HELLO_R && this.state === "looking" && (info = hello(m.body)) && info.name === "RemoteFM1") {
        if (info.proto === 2) this._begin(port, info);
        else this._set("looking", "this RemoteFM1 speaks protocol " + info.proto + ", not 2");
        return;
      }
      if (!this.input || port.id !== this.input.id) return;
      if (m.cmd === ACK && this.state === "starting") this._live(now);
      else if (m.cmd === FRAME_ACK && this.state === "live" && m.body.length >= 3) {
        var f = u16(m.body, 0), at = -1;
        this.inflight.forEach(function (x, i) { if (x.f === f) at = i; });
        if (at >= 0) this.inflight.splice(0, at + 1);
        if (this.scr && m.body[2] & 2) this.scr.reset();             /* its shadow was reset: black */
        else if (this.scr && m.body[2] & 1) this.scr.invalidate();   /* a decode error */
      }
      else if (m.cmd === PANEL_R && (r = panel(m.body))) {
        if (this.state === "starting" && r.flags & 1) this._live(now);   /* (its ACK was lost) */
        if (this.state !== "live") return;
        if (!(r.flags & 1)) { this._look("the FM-1 ended the session: looking for it"); return; }
        this.tPanel = now;
        this._resync(r, now);
        if (this.touchAsked > 0 && !(r.flags & 2) && now - this.touchAsked > T.touch) {
          this._send(TOUCH, [1]);              /* lost on the way: asked again, once */
          this.touchAsked = -1;
        }
      }
      return;
    }
    if (this.state === "live" && this.input && port.id === this.input.id && d.length >= 3) this._event(d[0], d[1], d[2], now);
  };
  /* the panel's events, plain MIDI on the session's port: keys 9F/8F (ch 16), buttons 9E/8E (ch 15),
   * encoders BE 16+e 64+d, MASTER BE 07 then BE 27 (14 bits, the ADC << 4) */
  Remote.prototype._event = function (st, a, v, now) {
    var p = this.p, h = this.h, on = (st & 0xf0) === 0x90 && v > 0, k, d;
    if ((st === 0x9f || st === 0x8f) && a >= 53 && a < 53 + NKEY) {
      k = a - 53;
      p.tKey[k] = now;
      if ((p.keys >>> k & 1) === +on) return;
      p.keys = (p.keys ^ 1 << k) >>> 0;
      h.key(k, on ? 1 : 0, on ? v : 0);
    } else if ((st === 0x9e || st === 0x8e) && a < NBTN) {
      p.tBtn[a] = now;
      if ((p.buttons >> a & 1) === +on) return;
      p.buttons ^= 1 << a;
      h.button(a, on ? 1 : 0);
    } else if (st === 0xbe && a >= 16 && a < 16 + NENC) {
      k = a - 16; d = v - 64;
      p.tEnc[k] = now;
      if (!d) return;
      p.enc[k] = (p.enc[k] + d) << 16 >> 16;
      h.enc(k, d);
    } else if (st === 0xbe && a === 7) {
      p.msb = v;
    } else if (st === 0xbe && a === 39 && p.msb >= 0) {
      d = (p.msb << 7 | v) >> 4;
      p.msb = -1;
      p.tMaster = now;
      if (d !== p.master) { p.master = d; h.master(d); }
    }
  };
  /* PANEL_R is the truth. A control is put right only when no event of its own came in the last T.settle ms
   * (that PANEL_R may have left before the event); encoders by the difference between counters */
  Remote.prototype._resync = function (r, now) {
    var p = this.p, h = this.h, k, want, d, calm = function (t) { return !t || now - t >= T.settle; };
    for (k = 0; k < NKEY; k++) {
      want = r.keys >>> k & 1;
      if ((p.keys >>> k & 1) !== want && calm(p.tKey[k])) { p.keys = (p.keys ^ 1 << k) >>> 0; h.key(k, want, want ? 100 : 0); }
    }
    for (k = 0; k < NBTN; k++) {
      want = r.buttons >> k & 1;
      if ((p.buttons >> k & 1) !== want && calm(p.tBtn[k])) { p.buttons ^= 1 << k; h.button(k, want); }
    }
    for (k = 0; k < NENC; k++) {
      d = (r.enc[k] - p.enc[k]) << 16 >> 16;
      if (!p.synced) p.enc[k] = r.enc[k];
      else if (d && calm(p.tEnc[k])) { p.enc[k] = r.enc[k]; h.enc(k, d); }
    }
    if (r.master !== p.master && calm(p.tMaster)) { p.master = r.master; h.master(r.master); }
    p.synced = true;
  };

  var api = {
    start: function (access, h, opt) { return new Remote(access, h, opt).start(opt && opt.manual); },
    Remote: Remote, pack7: pack7, unpack7: unpack7, sx: sx, parse: parse, hello: hello, panel: panel, ledsBody: ledsBody, T: T
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Fm1Remote = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
