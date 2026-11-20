/* SPDX-License-Identifier: MPL-2.0
 * Copyright (C) 2026 RemoteFM1 contributors
 *
 * remote-screen.js: the screen encoder that sends the simulator's screen to an FM-1 running RemoteFM1, as TILES
 * bodies. A translation to JavaScript of the lossless part of libremotefm1's host/src/screen.c
 * (https://github.com/Quixotic7/RemoteFM1, at commit 86e5975), which is MPL-2.0. Left out: the lossy
 * colour reduction, refinement and snapshots (HOLD), which only its Bluetooth links use. The rest of this
 * simulator is MIT; this one file stays under the Mozilla Public License 2.0 (https://mozilla.org/MPL/2.0/),
 * as MPL-2.0 section 3.3 allows in a larger work. Changes made in the translation are listed in NOTICE.md.
 *
 * Dirty 16x16 tiles, oldest first within a byte budget, the smallest of FILL / PAL / RLE / RAW per rect, greedy
 * horizontal merging, TILES bodies under the transport's limit. The model is what the device's shadow holds once
 * it has applied everything sent.
 *
 *   var s = new Fm1RemoteScreen.Screen();
 *   s.submit(core.lcdBytes());               // the new target: 240 x 240 RGB565, high byte first
 *   s.encode(frame, budget, bodyMax)         // -> the TILES bodies of one frame (the last has END), [] if none
 *   s.reset();  s.invalidate();  s.pending();
 */
(function (root) {
  "use strict";

  var W = 240, H = 240, T = 16, TX = W / T, TY = H / T, NT = TX * TY, NPIX = W * H;
  var RAW = 0, FILL = 1, PAL = 2, RLE = 3, RECT_HDR = 5, TILES_HDR = 4, F_END = 1, BODY_MIN = 64, BODY_MAX = 16384;

  function palBpp(n) { return n <= 2 ? 1 : n <= 4 ? 2 : 4; }
  function palRowBytes(w, n) { return (w * palBpp(n) + 7) >> 3; }

  /* ---- one rect ---- */
  /* distinct colours (17 = more than 16) in first-seen order, and RLE runs (each at most 256 pixels) */
  function analyze(img, x, y, w, h) {
    var a = { ncol: 0, pal: [], runs: 0 }, i, j, c, k, runlen = 0, prev = 0;
    for (j = 0; j < h; j++) {
      for (i = 0; i < w; i++) {
        c = img[(y + j) * W + x + i];
        if (a.ncol <= 16) {
          k = a.pal.indexOf(c);
          if (k < 0) { if (a.ncol < 16) a.pal.push(c); a.ncol++; }
        }
        if (!runlen || c !== prev || runlen === 256) { a.runs++; runlen = 1; prev = c; } else runlen++;
      }
    }
    return a;
  }
  function costOf(a, w, h, enc) {
    var n;
    switch (enc) {
      case FILL: return a.ncol === 1 ? RECT_HDR + 2 : 0;
      case PAL: n = a.ncol < 2 ? 2 : a.ncol; return n <= 16 ? RECT_HDR + 1 + 2 * n + h * palRowBytes(w, n) : 0;
      case RLE: return RECT_HDR + 3 * a.runs;
      case RAW: return RECT_HDR + 2 * w * h;
    }
    return 0;
  }
  var ORDER = [FILL, PAL, RLE, RAW];           /* ties: the cheaper decode */
  function bestOf(a, w, h) {
    var best = 0, enc = RAW, k, c;
    for (k = 0; k < 4; k++) {
      c = k === 1 && a.ncol < 2 ? 0 : costOf(a, w, h, ORDER[k]);
      if (c && (!best || c < best)) { best = c; enc = ORDER[k]; }
    }
    return { cost: best, enc: enc };
  }
  function px(out, o, c) { out[o] = c >> 8; out[o + 1] = c & 255; }
  function emitRect(img, r, a, out, o0) {
    var x = r.x, y = r.y, w = r.w, h = r.h, o = o0 + RECT_HDR, i, j, k, n, bpp, rb, c, bit, idx, runlen, prev;
    out[o0] = x; out[o0 + 1] = y; out[o0 + 2] = w; out[o0 + 3] = h; out[o0 + 4] = r.enc;
    switch (r.enc) {
      case RAW:
        for (j = 0; j < h; j++) for (i = 0; i < w; i++, o += 2) px(out, o, img[(y + j) * W + x + i]);
        break;
      case FILL:
        px(out, o, a.pal[0]); o += 2;
        break;
      case PAL:
        n = a.ncol < 2 ? 2 : a.ncol; bpp = palBpp(n); rb = palRowBytes(w, n);
        out[o++] = n;
        for (k = 0; k < n; k++, o += 2) if (k < a.ncol) px(out, o, a.pal[k]); else out[o] = out[o + 1] = 0;   /* padding: never indexed */
        for (j = 0; j < h; j++) {
          for (k = 0; k < rb; k++) out[o + k] = 0;
          for (i = 0; i < w; i++) {
            bit = i * bpp;
            idx = a.pal.indexOf(img[(y + j) * W + x + i]);
            out[o + (bit >> 3)] |= idx << (8 - bpp - (bit & 7));
          }
          o += rb;
        }
        break;
      case RLE:
        runlen = 0; prev = 0;
        for (j = 0; j < h; j++) for (i = 0; i < w; i++) {
          c = img[(y + j) * W + x + i];
          if (runlen && c === prev && runlen < 256) { runlen++; out[o - 3] = runlen - 1; }
          else { runlen = 1; prev = c; out[o] = 0; px(out, o + 1, c); o += 3; }
        }
        break;
      default: return 0;
    }
    return o - o0;
  }
  function rectCost(img, x, y, w, h) { return bestOf(analyze(img, x, y, w, h), w, h); }

  /* ---- the screen ---- */
  function Screen() {
    this.model = new Uint16Array(NPIX);        /* what the device shows */
    this.target = new Uint16Array(NPIX);
    this.age = new Uint32Array(NT);
    this.dirty = new Uint8Array(NT);
    this.forced = new Uint8Array(NT);
    this.seq = 0;
    this.merge = true;
  }
  function tileDiffers(a, b, t) {
    var x = (t % TX) * T, y = Math.floor(t / TX) * T, i, j, at;
    for (j = 0; j < T; j++) for (at = (y + j) * W + x, i = 0; i < T; i++) if (a[at + i] !== b[at + i]) return true;
    return false;
  }
  function copyTile(dst, src, t) {
    var x = (t % TX) * T, y = Math.floor(t / TX) * T, j, at;
    for (j = 0; j < T; j++) { at = (y + j) * W + x; dst.set(src.subarray(at, at + T), at); }
  }
  Screen.prototype._refresh = function () {
    for (var t = 0; t < NT; t++) {
      if (this.forced[t] || tileDiffers(this.model, this.target, t)) {
        if (!this.dirty[t]) { this.dirty[t] = 1; this.age[t] = this.seq; }
      } else this.dirty[t] = 0;
    }
  };
  /* the device's shadow is black (a session start, or its FRAME_ACK says it was reset) */
  Screen.prototype.reset = function () { this.model.fill(0); this.forced.fill(0); this._refresh(); };
  /* everything goes again */
  Screen.prototype.invalidate = function () { this.forced.fill(1); this._refresh(); };
  Screen.prototype.submit = function (lcd) {
    var t = this.target, i;
    for (i = 0; i < NPIX; i++) t[i] = lcd[2 * i] << 8 | lcd[2 * i + 1];
    this.seq++;
    this._refresh();
  };
  Screen.prototype.pending = function () { var n = 0, t; for (t = 0; t < NT; t++) n += this.dirty[t]; return n; };

  /* tile t alone: one rect, or (if its best encoding is too big for a message) strips of hs rows */
  function planTile(img, t, maxRect) {
    var x = (t % TX) * T, y = Math.floor(t / TX) * T, b = rectCost(img, x, y, T, T), hs, j, h, out = [], total = 0;
    if (b.cost <= maxRect) return { rects: [{ x: x, y: y, w: T, h: T, enc: b.enc, cost: b.cost }], cost: b.cost };
    hs = Math.max(1, Math.floor((maxRect - RECT_HDR) / (2 * T)));   /* RAW of hs rows always fits */
    for (j = 0; j < T; j += hs) {
      h = Math.min(hs, T - j);
      b = rectCost(img, x, y + j, T, h);
      out.push({ x: x, y: y + j, w: T, h: h, enc: b.enc, cost: b.cost });
      total += b.cost;
    }
    return { rects: out, cost: total };
  }

  Screen.prototype.encode = function (frame, budget, bodyMax) {
    var self = this, img = this.target, order = [], plan = [], sel = new Uint8Array(NT), remaining = budget, t, k, ty, tx;
    var bodies = [], msg = null, len = 0, nr = 0, maxRect;
    bodyMax = Math.max(BODY_MIN, Math.min(BODY_MAX, bodyMax));
    maxRect = bodyMax - TILES_HDR;
    for (t = 0; t < NT; t++) if (this.dirty[t]) order.push(t);
    if (!order.length) return bodies;
    order.sort(function (a, b) { return self.age[a] - self.age[b] || a - b; });   /* oldest first, then raster order */
    for (k = 0; k < order.length; k++) {
      t = order[k];
      plan[t] = planTile(img, t, maxRect);
      if (k === 0 || plan[t].cost <= remaining) {
        sel[t] = 1;
        remaining = plan[t].cost >= remaining ? 0 : remaining - plan[t].cost;
      }
      if (remaining < RECT_HDR + 2) break;
    }

    var flush = function (last) {
      msg[0] = frame & 255; msg[1] = frame >> 8 & 255; msg[2] = last ? F_END : 0; msg[3] = nr;
      bodies.push(msg.slice(0, len));
      msg = new Uint8Array(bodyMax); len = TILES_HDR; nr = 0;
    };
    var put = function (r) {
      if (len + r.cost > bodyMax || nr === 255) flush(false);
      var n = emitRect(img, r, analyze(img, r.x, r.y, r.w, r.h), msg, len);
      if (n !== r.cost) throw new Error("remote-screen: a rect's plan and its encoding differ");
      len += n; nr++;
    };
    msg = new Uint8Array(bodyMax); len = TILES_HDR;
    /* tile rows: greedy merge of selected neighbours, then pack */
    for (ty = 0; ty < TY; ty++) {
      var cur = null;
      for (tx = 0; tx <= TX; tx++) {
        t = ty * TX + tx;
        if (tx < TX && sel[t] && plan[t].rects.length === 1) {
          if (cur && this.merge) {
            var mw = cur.w + T, m = rectCost(img, cur.x, cur.y, mw, T);
            if (m.cost <= maxRect && m.cost < cur.cost + plan[t].cost) { cur = { x: cur.x, y: cur.y, w: mw, h: T, enc: m.enc, cost: m.cost }; continue; }
          }
          if (cur) put(cur);
          cur = plan[t].rects[0];
          continue;
        }
        if (cur) { put(cur); cur = null; }
        if (tx < TX && sel[t]) plan[t].rects.forEach(put);   /* a split tile: its strips as they are */
      }
    }
    flush(true);
    /* the model takes what was sent */
    for (t = 0; t < NT; t++) if (sel[t]) { copyTile(this.model, img, t); this.dirty[t] = 0; this.forced[t] = 0; }
    return bodies;
  };

  var api = { Screen: Screen };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Fm1RemoteScreen = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
