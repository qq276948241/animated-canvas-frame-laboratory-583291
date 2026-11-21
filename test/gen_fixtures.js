// Generates the minimal offline GIF fixtures under test/fixtures/.
//
// Fixtures are built byte-by-byte with the small independent builder below
// (not with GifWriter) so the tests do not depend on the writer to exercise
// the reader, and so malformed files (truncated extensions, palette index
// overflow, out-of-canvas frames) can be expressed exactly.
//
// Run: node test/gen_fixtures.js

"use strict";

var fs = require('fs');
var path = require('path');

var FIXTURE_DIR = path.join(__dirname, 'fixtures');

// ---------------------------------------------------------------------------
// Minimal LZW encoder: emits [clear, literal] pairs so the code size never
// grows above min_code_size + 1.  Valid per GIF89a, just not compressed.
// ---------------------------------------------------------------------------
function lzwEncodeLiteral(minCodeSize, indices) {
  var clear = 1 << minCodeSize;
  var eoi = clear + 1;
  var codeSize = minCodeSize + 1;
  var bytes = [];
  var cur = 0, shift = 0;
  function emit(code) {
    cur |= code << shift;
    shift += codeSize;
    while (shift >= 8) { bytes.push(cur & 0xff); cur >>= 8; shift -= 8; }
  }
  for (var i = 0; i < indices.length; ++i) { emit(clear); emit(indices[i]); }
  emit(eoi);
  if (shift > 0) bytes.push(cur & 0xff);

  var out = [minCodeSize];
  for (var off = 0; off < bytes.length; off += 255) {
    var chunk = bytes.slice(off, off + 255);
    out.push(chunk.length);
    for (var j = 0; j < chunk.length; ++j) out.push(chunk[j]);
  }
  out.push(0);  // Block terminator.
  return out;
}

// Row order in which an interlaced image's pixels are stored.
function interlaceRowOrder(h) {
  var order = [];
  var passes = [[0, 8], [4, 8], [2, 4], [1, 2]];
  for (var p = 0; p < passes.length; ++p)
    for (var r = passes[p][0]; r < h; r += passes[p][1]) order.push(r);
  return order;
}

function pow2AtLeast(n) {
  var p = 1;
  while (p < n) p <<= 1;
  return Math.max(p, 2);
}

// frame: {
//   x, y, w, h,
//   indices: w*h logical row-major palette indices,
//   interlaced: bool,
//   palette: [[r,g,b], ...] local palette or null,
//   gce: {delay, disposal, transparent} or null (no GCE emitted),
// }
function buildGif(opts) {
  var bytes = [];
  function push() { for (var i = 0; i < arguments.length; ++i) bytes.push(arguments[i]); }
  function push16(v) { push(v & 0xff, (v >> 8) & 0xff); }
  function pushPalette(pal, size) {
    for (var i = 0; i < size; ++i) {
      var c = pal[i] || [0, 0, 0];
      push(c[0], c[1], c[2]);
    }
  }

  // Header + Logical Screen Descriptor.
  push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);  // GIF89a
  push16(opts.width); push16(opts.height);
  var gpal = opts.globalPalette || null;
  var gsize = 0, gpow = 0;
  if (gpal) {
    gsize = pow2AtLeast(gpal.length);
    gpow = Math.log2(gsize) - 1;
  }
  push((gpal ? 0x80 : 0) | gpow, opts.background || 0, 0);
  if (gpal) pushPalette(gpal, gsize);

  // Netscape looping extension (only when explicitly requested).
  if (opts.loop !== undefined && opts.loop !== null) {
    push(0x21, 0xff, 0x0b);
    push(0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30);
    push(0x03, 0x01);
    push16(opts.loop);
    push(0x00);
  }

  (opts.frames || []).forEach(function(f) {
    if (f.gce) {
      var disposal = f.gce.disposal || 0;
      var delay = f.gce.delay || 0;
      var hasTrans = f.gce.transparent !== undefined && f.gce.transparent !== null;
      push(0x21, 0xf9, 0x04);
      push((disposal << 2) | (hasTrans ? 1 : 0));
      push16(delay);
      push(hasTrans ? f.gce.transparent : 0);
      push(0x00);
    }

    var lpal = f.palette || null;
    var lsize = 0, lpow = 0;
    if (lpal) {
      lsize = pow2AtLeast(lpal.length);
      lpow = Math.log2(lsize) - 1;
    }
    var palette = lpal || gpal;
    if (!palette) throw new Error('frame needs a palette');
    var minCodeSize = Math.max(2, Math.log2(pow2AtLeast(palette.length)));

    push(0x2c);
    push16(f.x || 0); push16(f.y || 0); push16(f.w); push16(f.h);
    push((lpal ? 0x80 : 0) | (f.interlaced ? 0x40 : 0) | lpow);
    if (lpal) pushPalette(lpal, lsize);

    // Reorder indices into storage order for interlaced images.
    var indices = f.indices;
    if (f.interlaced) {
      var order = interlaceRowOrder(f.h);
      indices = [];
      for (var oi = 0; oi < order.length; ++oi)
        for (var col = 0; col < f.w; ++col)
          indices.push(f.indices[order[oi] * f.w + col]);
    }
    var stream = lzwEncodeLiteral(minCodeSize, indices);
    for (var bi = 0; bi < stream.length; ++bi) push(stream[bi]);
  });

  (opts.rawTail || []).forEach(function(b) { push(b); });
  if (opts.trailer !== false) push(0x3b);
  return Buffer.from(bytes);
}

function fullRect(w, h, v) {
  var a = new Array(w * h);
  for (var i = 0; i < a.length; ++i) a[i] = v;
  return a;
}

function writeFixture(name, buf) {
  fs.writeFileSync(path.join(FIXTURE_DIR, name), buf);
  console.log('wrote', name, buf.length, 'bytes');
}

var RED = [255, 0, 0], GREEN = [0, 255, 0], BLUE = [0, 0, 255],
    WHITE = [255, 255, 255], BLACK = [0, 0, 0], YELLOW = [255, 255, 0];

var PAL4 = [RED, GREEN, BLUE, WHITE];

// --- disposal 0: frames accumulate, nothing is cleared. ---------------------
writeFixture('disposal0.gif', buildGif({
  width: 4, height: 4, globalPalette: PAL4, loop: 0,
  frames: [
    {x: 0, y: 0, w: 4, h: 4, indices: fullRect(4, 4, 0),
     gce: {delay: 5, disposal: 0}},
    {x: 1, y: 1, w: 2, h: 2, indices: fullRect(2, 2, 1),
     gce: {delay: 7, disposal: 0}},
    {x: 3, y: 3, w: 1, h: 1, indices: [2],
     gce: {delay: 9, disposal: 0}},
  ],
}));

// --- disposal 1: leave in place. --------------------------------------------
writeFixture('disposal1.gif', buildGif({
  width: 4, height: 4, globalPalette: PAL4, loop: 1,
  frames: [
    {x: 0, y: 0, w: 4, h: 4, indices: fullRect(4, 4, 0),
     gce: {delay: 5, disposal: 1}},
    {x: 1, y: 1, w: 2, h: 2, indices: fullRect(2, 2, 1),
     gce: {delay: 7, disposal: 1}},
    {x: 0, y: 3, w: 1, h: 1, indices: [2],
     gce: {delay: 9, disposal: 1}},
  ],
}));

// --- disposal 2: restore frame rect to background (transparent). ------------
writeFixture('disposal2.gif', buildGif({
  width: 4, height: 4, globalPalette: PAL4,
  frames: [
    {x: 0, y: 0, w: 4, h: 4, indices: fullRect(4, 4, 0),
     gce: {delay: 5, disposal: 1}},
    {x: 1, y: 1, w: 2, h: 2, indices: fullRect(2, 2, 1),
     gce: {delay: 7, disposal: 2}},
    {x: 0, y: 0, w: 1, h: 1, indices: [2],
     gce: {delay: 9, disposal: 0}},
  ],
}));

// --- disposal 3: restore to previous. ---------------------------------------
writeFixture('disposal3.gif', buildGif({
  width: 4, height: 4, globalPalette: PAL4,
  frames: [
    {x: 0, y: 0, w: 4, h: 4, indices: fullRect(4, 4, 0),
     gce: {delay: 5, disposal: 1}},
    {x: 1, y: 1, w: 2, h: 2, indices: fullRect(2, 2, 1),
     gce: {delay: 7, disposal: 3}},
    {x: 3, y: 3, w: 1, h: 1, indices: [2],
     gce: {delay: 9, disposal: 0}},
  ],
}));

// --- transparent edges: border pixels of frame 1 are transparent and must
// --- not overwrite the red background of frame 0. ---------------------------
(function() {
  var indices = [];
  for (var row = 0; row < 4; ++row)
    for (var col = 0; col < 4; ++col)
      indices.push((row === 0 || row === 3 || col === 0 || col === 3) ? 3 : 1);
  writeFixture('transparent_edge.gif', buildGif({
    width: 4, height: 4, globalPalette: PAL4,
    frames: [
      {x: 0, y: 0, w: 4, h: 4, indices: fullRect(4, 4, 0),
       gce: {delay: 5, disposal: 1}},
      {x: 0, y: 0, w: 4, h: 4, indices: indices,
       gce: {delay: 5, disposal: 1, transparent: 3}},
    ],
  }));
})();

// --- local palettes only (no global palette); delay/loop metadata must
// --- survive the absence of a global palette. -------------------------------
writeFixture('local_palette.gif', buildGif({
  width: 3, height: 2, loop: 2,
  frames: [
    {x: 0, y: 0, w: 3, h: 2, indices: [0, 1, 0, 1, 0, 1],
     palette: [RED, GREEN], gce: {delay: 4, disposal: 1}},
    {x: 2, y: 0, w: 1, h: 2, indices: [1, 3],
     palette: [BLACK, BLUE, WHITE, YELLOW], gce: {delay: 6, disposal: 0}},
  ],
}));

// --- frame rectangle extends past the canvas (compositor clips, raw blit
// --- rejects). --------------------------------------------------------------
writeFixture('oob_frame.gif', buildGif({
  width: 4, height: 4, globalPalette: PAL4,
  frames: [
    {x: 0, y: 0, w: 4, h: 4, indices: fullRect(4, 4, 0),
     gce: {delay: 5, disposal: 1}},
    {x: 3, y: 3, w: 4, h: 4, indices: fullRect(4, 4, 1),
     gce: {delay: 5, disposal: 0}},
  ],
}));

// --- truncated graphics control extension (block cut off mid-way). ----------
writeFixture('truncated_gce.gif', buildGif({
  width: 2, height: 2, globalPalette: [RED, GREEN],
  frames: [],
  rawTail: [0x21, 0xf9, 0x04, 0x01, 0x00],  // GCE missing delay/trans/term.
  trailer: false,
}));

// --- truncated comment extension (sub-block runs past EOF). -----------------
writeFixture('truncated_comment.gif', buildGif({
  width: 2, height: 2, globalPalette: [RED, GREEN],
  frames: [],
  rawTail: [0x21, 0xfe, 0x05, 0x68, 0x65, 0x6c],  // size 5, only 3 bytes.
  trailer: false,
}));

// --- palette index out of range: 2-color palette, indices up to 3. ----------
writeFixture('palette_overflow.gif', buildGif({
  width: 2, height: 2, globalPalette: [RED, GREEN],
  frames: [{
    x: 0, y: 0, w: 2, h: 2, indices: [0, 1, 2, 3],
    gce: {delay: 5, disposal: 0},
  }],
}));

// --- interlaced: 3x9, pixel color index == its row number, so a wrong pass
// --- order is immediately visible in the decoded canvas. --------------------
(function() {
  var palette = [];
  for (var i = 0; i < 16; ++i) palette.push([i * 16, i * 16, i * 16]);
  var indices = [];
  for (var row = 0; row < 9; ++row)
    for (var col = 0; col < 3; ++col) indices.push(row);
  writeFixture('interlaced.gif', buildGif({
    width: 3, height: 9, globalPalette: palette,
    frames: [{x: 0, y: 0, w: 3, h: 9, indices: indices, interlaced: true,
              gce: {delay: 5, disposal: 1}}],
  }));
})();

// --- no Netscape block: loopCount() must be null (play once), never a
// --- guessed "infinite". -----------------------------------------------------
writeFixture('no_loop.gif', buildGif({
  width: 2, height: 2, globalPalette: PAL4,
  frames: [
    {x: 0, y: 0, w: 2, h: 2, indices: fullRect(2, 2, 0),
     gce: {delay: 5, disposal: 1}},
    {x: 0, y: 0, w: 2, h: 2, indices: fullRect(2, 2, 1),
     gce: {delay: 5, disposal: 1}},
  ],
}));

// --- explicit Netscape loop count of 0 (the only "loop forever" source). ----
writeFixture('loop0.gif', buildGif({
  width: 2, height: 2, globalPalette: PAL4, loop: 0,
  frames: [
    {x: 0, y: 0, w: 2, h: 2, indices: fullRect(2, 2, 0),
     gce: {delay: 5, disposal: 1}},
  ],
}));

// --- GCE applies only to the frame immediately after it: frame 1 has no GCE
// --- and must show the defaults (delay 0, disposal 0, no transparency). -----
writeFixture('gce_reset.gif', buildGif({
  width: 2, height: 2, globalPalette: PAL4,
  frames: [
    {x: 0, y: 0, w: 2, h: 2, indices: [0, 0, 1, 1],
     gce: {delay: 50, disposal: 2, transparent: 0}},
    {x: 0, y: 0, w: 2, h: 2, indices: [1, 1, 2, 2], gce: null},
    {x: 0, y: 0, w: 2, h: 2, indices: [2, 2, 3, 3],
     gce: {delay: 0, disposal: 0}},  // explicit zero GCE
  ],
}));
