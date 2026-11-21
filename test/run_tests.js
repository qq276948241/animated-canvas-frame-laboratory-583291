// Test suite for omggif canvas-level compositing, reader hardening and
// writer round-trips.  Every assertion is on decoded canvas pixels or frame
// metadata — never on "the file opens" or "the byte size matches".
//
// Run: node test/run_tests.js
// (Regenerate fixtures first with: node test/gen_fixtures.js)

"use strict";

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var omggif = require('../omggif.js');
var ref = require('./reference.js');

var FIXTURE_DIR = path.join(__dirname, 'fixtures');
function fixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name));
}

var tests = [];
function test(name, fn) { tests.push({name: name, fn: fn}); }

// ---------------------------------------------------------------------------
// A. Compositor matches the independent per-pixel reference on every frame
//    of every valid fixture, including out-of-canvas clipping.
// ---------------------------------------------------------------------------
var VALID_FIXTURES = [
  'disposal0.gif', 'disposal1.gif', 'disposal2.gif', 'disposal3.gif',
  'transparent_edge.gif', 'local_palette.gif', 'oob_frame.gif',
  'interlaced.gif', 'no_loop.gif', 'loop0.gif', 'gce_reset.gif',
];

VALID_FIXTURES.forEach(function(name) {
  test('compositor matches reference: ' + name, function() {
    var buf = fixture(name);
    var parsed = ref.parseGif(buf);
    var reader = new omggif.GifReader(buf);
    assert.strictEqual(reader.numFrames(), parsed.frames.length, 'frame count');
    assert.strictEqual(reader.width, parsed.width, 'logical width');
    assert.strictEqual(reader.height, parsed.height, 'logical height');

    var comp = new omggif.GifCompositor(reader);
    for (var n = 0; n < parsed.frames.length; ++n) {
      var expected = ref.composeFrames(parsed, n);
      var actual = comp.compositeFrame(n);
      assert.deepStrictEqual(Array.from(actual), Array.from(expected),
                             name + ' frame ' + n + ' canvas');
    }
  });
});

// ---------------------------------------------------------------------------
// B. Metadata: delays, disposal, transparency, loop counts.
// ---------------------------------------------------------------------------
test('metadata matches reference for all fixtures', function() {
  VALID_FIXTURES.forEach(function(name) {
    var parsed = ref.parseGif(fixture(name));
    var reader = new omggif.GifReader(fixture(name));
    assert.strictEqual(reader.loopCount(), parsed.loopCount,
                       name + ' loopCount');
    for (var n = 0; n < parsed.frames.length; ++n) {
      var info = reader.frameInfo(n);
      var rf = parsed.frames[n];
      assert.strictEqual(info.delay, rf.delay, name + ' frame ' + n + ' delay');
      assert.strictEqual(info.disposal, rf.disposal,
                         name + ' frame ' + n + ' disposal');
      assert.strictEqual(info.transparent_index, rf.transparent,
                         name + ' frame ' + n + ' transparent index');
    }
  });
});

test('missing Netscape block means null loop count (play once), not infinite', function() {
  var reader = new omggif.GifReader(fixture('no_loop.gif'));
  assert.strictEqual(reader.loopCount(), null);
});

test('explicit Netscape loop count 0 is preserved as 0', function() {
  var reader = new omggif.GifReader(fixture('loop0.gif'));
  assert.strictEqual(reader.loopCount(), 0);
});

test('GCE does not leak into the following frame', function() {
  var reader = new omggif.GifReader(fixture('gce_reset.gif'));
  var f0 = reader.frameInfo(0);
  assert.strictEqual(f0.delay, 50);
  assert.strictEqual(f0.disposal, 2);
  assert.strictEqual(f0.transparent_index, 0);
  // Frame 1 has no GCE of its own: explicit defaults, not frame 0's values.
  var f1 = reader.frameInfo(1);
  assert.strictEqual(f1.delay, 0, 'delay resets to 0');
  assert.strictEqual(f1.disposal, 0, 'disposal resets to 0');
  assert.strictEqual(f1.transparent_index, null, 'transparency resets');
  // Frame 2 has an explicit all-zero GCE: same defaults.
  var f2 = reader.frameInfo(2);
  assert.strictEqual(f2.delay, 0);
  assert.strictEqual(f2.disposal, 0);
  assert.strictEqual(f2.transparent_index, null);
});

test('delay/loop metadata survives frames without a global palette', function() {
  var reader = new omggif.GifReader(fixture('local_palette.gif'));
  assert.strictEqual(reader.loopCount(), 2);
  assert.strictEqual(reader.frameInfo(0).delay, 4);
  assert.strictEqual(reader.frameInfo(1).delay, 6);
  assert.strictEqual(reader.frameInfo(0).has_local_palette, true);
  assert.strictEqual(reader.frameInfo(1).has_local_palette, true);
});

// ---------------------------------------------------------------------------
// C. Compositor behaviors beyond fixture equality.
// ---------------------------------------------------------------------------
test('repeated compositeFrame calls do not accumulate on the cached canvas', function() {
  var reader = new omggif.GifReader(fixture('disposal2.gif'));
  var comp = new omggif.GifCompositor(reader);
  var first = comp.compositeFrame(2);
  var second = comp.compositeFrame(2);
  var third = comp.compositeFrame(2);
  assert.deepStrictEqual(Array.from(second), Array.from(first));
  assert.deepStrictEqual(Array.from(third), Array.from(first));
  // Returned buffers are copies: mutating one must not corrupt the cache.
  var original = first[0];
  first[0] = (original + 1) & 0xff;
  assert.strictEqual(comp.compositeFrame(2)[0], original,
                     'cached canvas unaffected by caller mutation');
});

test('random access (backward seek) replays correctly', function() {
  var buf = fixture('disposal3.gif');
  var parsed = ref.parseGif(buf);
  var reader = new omggif.GifReader(buf);
  var comp = new omggif.GifCompositor(reader);
  comp.compositeFrame(2);
  comp.compositeFrame(0);
  var again = comp.compositeFrame(2);
  assert.deepStrictEqual(Array.from(again),
                         Array.from(ref.composeFrames(parsed, 2)));
  // And a fresh compositor agrees too.
  var fresh = new omggif.GifCompositor(reader);
  assert.deepStrictEqual(Array.from(fresh.compositeFrame(2)), Array.from(again));
});

test('reset() returns to the empty-canvas state', function() {
  var buf = fixture('disposal1.gif');
  var parsed = ref.parseGif(buf);
  var reader = new omggif.GifReader(buf);
  var comp = new omggif.GifCompositor(reader);
  comp.compositeFrame(2);
  comp.reset();
  assert.deepStrictEqual(Array.from(comp.compositeFrame(1)),
                         Array.from(ref.composeFrames(parsed, 1)));
});

test('disposal 2 clears exactly the frame rectangle', function() {
  var reader = new omggif.GifReader(fixture('disposal2.gif'));
  var comp = new omggif.GifCompositor(reader);
  var canvas = comp.compositeFrame(2);
  // Frame 1 covered (1,1)-(2,2) with disposal 2: those pixels are
  // transparent again, everything else from frame 0 remains, plus the
  // frame 2 pixel at (0,0).
  function px(x, y) {
    var o = (y * 4 + x) * 4;
    return [canvas[o], canvas[o + 1], canvas[o + 2], canvas[o + 3]];
  }
  assert.deepStrictEqual(px(0, 0), [0, 0, 255, 255], 'frame 2 pixel');
  assert.deepStrictEqual(px(1, 1), [0, 0, 0, 0], 'disposed to transparent');
  assert.deepStrictEqual(px(2, 2), [0, 0, 0, 0], 'disposed to transparent');
  assert.deepStrictEqual(px(3, 3), [255, 0, 0, 255], 'untouched stays red');
  assert.deepStrictEqual(px(1, 0), [255, 0, 0, 255], 'outside rect untouched');
});

test('disposal 3 restores the pre-frame canvas', function() {
  var reader = new omggif.GifReader(fixture('disposal3.gif'));
  var comp = new omggif.GifCompositor(reader);
  var canvas = comp.compositeFrame(2);
  function px(x, y) {
    var o = (y * 4 + x) * 4;
    return [canvas[o], canvas[o + 1], canvas[o + 2], canvas[o + 3]];
  }
  assert.deepStrictEqual(px(1, 1), [255, 0, 0, 255], 'restored to red');
  assert.deepStrictEqual(px(2, 2), [255, 0, 0, 255], 'restored to red');
  assert.deepStrictEqual(px(3, 3), [0, 0, 255, 255], 'frame 2 pixel');
});

test('transparent pixels never overwrite the canvas below', function() {
  var reader = new omggif.GifReader(fixture('transparent_edge.gif'));
  var comp = new omggif.GifCompositor(reader);
  var canvas = comp.compositeFrame(1);
  function px(x, y) {
    var o = (y * 4 + x) * 4;
    return [canvas[o], canvas[o + 1], canvas[o + 2], canvas[o + 3]];
  }
  assert.deepStrictEqual(px(0, 0), [255, 0, 0, 255], 'border shows through');
  assert.deepStrictEqual(px(3, 3), [255, 0, 0, 255], 'border shows through');
  assert.deepStrictEqual(px(1, 1), [0, 255, 0, 255], 'interior painted');
  assert.deepStrictEqual(px(2, 2), [0, 255, 0, 255], 'interior painted');
});

test('out-of-canvas frames are clipped by the compositor', function() {
  var reader = new omggif.GifReader(fixture('oob_frame.gif'));
  var comp = new omggif.GifCompositor(reader);
  var canvas = comp.compositeFrame(1);
  function px(x, y) {
    var o = (y * 4 + x) * 4;
    return [canvas[o], canvas[o + 1], canvas[o + 2], canvas[o + 3]];
  }
  assert.deepStrictEqual(px(3, 3), [0, 255, 0, 255], 'visible corner painted');
  assert.deepStrictEqual(px(2, 2), [255, 0, 0, 255], 'rest untouched');
});

test('interlaced frames decode in pass order', function() {
  var reader = new omggif.GifReader(fixture('interlaced.gif'));
  assert.strictEqual(reader.frameInfo(0).interlaced, true);
  var img = reader.decodeFrameRGBA(0);
  for (var row = 0; row < 9; ++row) {
    var o = (row * 3 + 1) * 4;  // middle column
    assert.strictEqual(img[o], row * 16, 'row ' + row + ' red channel');
    assert.strictEqual(img[o + 3], 255, 'row ' + row + ' opaque');
  }
});

// ---------------------------------------------------------------------------
// D. Stable errors, raised before any pixel is written.
// ---------------------------------------------------------------------------
test('out-of-canvas frame is rejected by decodeAndBlitFrameRGBA', function() {
  var reader = new omggif.GifReader(fixture('oob_frame.gif'));
  var pixels = new Uint8Array(reader.width * reader.height * 4);
  reader.decodeAndBlitFrameRGBA(0, pixels);  // frame 0 fits
  var before = Array.from(pixels);
  assert.throws(function() { reader.decodeAndBlitFrameRGBA(1, pixels); },
                /does not fit within the logical screen/);
  assert.throws(function() { reader.decodeAndBlitFrameBGRA(1, pixels); },
                /does not fit within the logical screen/);
  // The caller's canvas must be untouched by the rejected blit.
  assert.deepStrictEqual(Array.from(pixels), before, 'canvas untouched');
});

test('palette index out of range raises before writing pixels', function() {
  var reader = new omggif.GifReader(fixture('palette_overflow.gif'));
  var pixels = new Uint8Array(reader.width * reader.height * 4);
  assert.throws(function() { reader.decodeAndBlitFrameRGBA(0, pixels); },
                /Palette index 2 out of range/);
  assert.throws(function() { reader.decodeAndBlitFrameBGRA(0, pixels); },
                /Palette index 2 out of range/);
  assert.throws(function() { reader.decodeFrameRGBA(0); },
                /Palette index 2 out of range/);
  assert.deepStrictEqual(Array.from(pixels), new Array(16).fill(0),
                         'no pixel written');
  var comp = new omggif.GifCompositor(reader);
  assert.throws(function() { comp.compositeFrame(0); }, /Palette index/);
});

test('truncated graphics control extension raises a stable error', function() {
  assert.throws(function() { new omggif.GifReader(fixture('truncated_gce.gif')); },
                /Invalid graphics extension block/);
});

test('truncated comment extension raises a stable error', function() {
  assert.throws(function() {
    new omggif.GifReader(fixture('truncated_comment.gif'));
  }, /Invalid block size/);
});

test('frame index out of range raises', function() {
  var reader = new omggif.GifReader(fixture('no_loop.gif'));
  assert.throws(function() { reader.frameInfo(5); }, /Frame index out of range/);
  assert.throws(function() { reader.frameInfo(-1); }, /Frame index out of range/);
  var comp = new omggif.GifCompositor(reader);
  assert.throws(function() { comp.compositeFrame(2); }, /Frame index out of range/);
});

// ---------------------------------------------------------------------------
// E. Existing indexed-frame API stays compatible.
// ---------------------------------------------------------------------------
test('decodeAndBlitFrameRGBA blits a frame rect into a caller canvas', function() {
  var reader = new omggif.GifReader(fixture('disposal0.gif'));
  var pixels = new Uint8Array(reader.width * reader.height * 4);
  reader.decodeAndBlitFrameRGBA(0, pixels);
  reader.decodeAndBlitFrameRGBA(1, pixels);
  var comp = new omggif.GifCompositor(new omggif.GifReader(fixture('disposal0.gif')));
  // disposal 0 leaves everything in place, so sequential blits == composited.
  assert.deepStrictEqual(Array.from(pixels), Array.from(comp.compositeFrame(1)));
});

test('decodeFrameRGBA returns the frame rect with transparent holes', function() {
  var reader = new omggif.GifReader(fixture('transparent_edge.gif'));
  var img = reader.decodeFrameRGBA(1);
  assert.strictEqual(img.length, 4 * 4 * 4);
  assert.strictEqual(img[3], 0, 'corner transparent');
  var interior = (1 * 4 + 1) * 4;
  assert.deepStrictEqual(Array.from(img.slice(interior, interior + 4)),
                         [0, 255, 0, 255]);
});

// ---------------------------------------------------------------------------
// F. Writer round-trips: composited frames and differential frames both
//    decode back to the same canvases and the same frame delays.
// ---------------------------------------------------------------------------
function makeCompositedAnimation() {
  // Three full-canvas indexed frames (4x4, palette of 4).
  var frames = [
    {indices: new Array(16).fill(0), delay: 5},
    {indices: new Array(16).fill(1), delay: 10},
    {indices: new Array(16).fill(2), delay: 20},
  ];
  return frames;
}

test('writer round-trip: composited (full-canvas) frames', function() {
  var palette = [0xff0000, 0x00ff00, 0x0000ff, 0xffffff];
  var frames = makeCompositedAnimation();
  var buf = new Uint8Array(1 << 16);
  var gf = new omggif.GifWriter(buf, 4, 4, {palette: palette, loop: 0});
  frames.forEach(function(f) { gf.addFrame(0, 0, 4, 4, f.indices, {delay: f.delay}); });
  var data = buf.slice(0, gf.end());

  var reader = new omggif.GifReader(data);
  assert.strictEqual(reader.numFrames(), 3);
  assert.strictEqual(reader.loopCount(), 0);
  var comp = new omggif.GifCompositor(reader);
  var expectedColors = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
  frames.forEach(function(f, n) {
    assert.strictEqual(reader.frameInfo(n).delay, f.delay, 'delay round-trip');
    var canvas = comp.compositeFrame(n);
    for (var i = 0; i < 16; ++i) {
      assert.deepStrictEqual(
          Array.from(canvas.slice(i * 4, i * 4 + 4)),
          expectedColors[n].concat([255]),
          'frame ' + n + ' pixel ' + i);
    }
  });
});

test('writer round-trip: differential frames with transparency', function() {
  // Same visual result as above, but written as diff rects against the
  // previous canvas: frame 1 repaints only rows 0-1, frame 2 only a 2x2
  // block, both using a transparent index elsewhere.
  var palette = [0xff0000, 0x00ff00, 0x0000ff, 0xffffff];
  var buf = new Uint8Array(1 << 16);
  var gf = new omggif.GifWriter(buf, 4, 4, {palette: palette, loop: 1});

  gf.addFrame(0, 0, 4, 4, new Array(16).fill(0), {delay: 5, disposal: 1});
  // Frame 1: top half becomes green, bottom half keeps frame 0 (transparent).
  gf.addFrame(0, 0, 4, 2,
              [1, 1, 1, 1,
               3, 3, 3, 3],
              {delay: 10, disposal: 1, transparent: 3});
  // Frame 2: 2x2 blue block at (1,1).
  gf.addFrame(1, 1, 2, 2, new Array(4).fill(2), {delay: 20, disposal: 1});
  var data = buf.slice(0, gf.end());

  var reader = new omggif.GifReader(data);
  assert.strictEqual(reader.loopCount(), 1);
  assert.deepStrictEqual([0, 1, 2].map(function(n) { return reader.frameInfo(n).delay; }),
                         [5, 10, 20], 'delays round-trip');
  assert.strictEqual(reader.frameInfo(1).transparent_index, 3,
                     'transparent control block round-trips');

  var comp = new omggif.GifCompositor(reader);
  var R = [255, 0, 0, 255], G = [0, 255, 0, 255], B = [0, 0, 255, 255];
  function row(canvas, y) {
    var out = [];
    for (var x = 0; x < 4; ++x)
      out.push(Array.from(canvas.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)));
    return out;
  }
  var c1 = comp.compositeFrame(1);
  assert.deepStrictEqual(row(c1, 0), [G, G, G, G]);
  assert.deepStrictEqual(row(c1, 1), [R, R, R, R], 'transparent kept red');
  var c2 = comp.compositeFrame(2);
  assert.deepStrictEqual(row(c2, 1), [R, B, B, R]);
  assert.deepStrictEqual(row(c2, 2), [R, B, B, R]);
});

test('writer round-trip: per-frame local palettes, no global palette', function() {
  var buf = new Uint8Array(1 << 16);
  var gf = new omggif.GifWriter(buf, 2, 2, {loop: 3});
  gf.addFrame(0, 0, 2, 2, [0, 1, 1, 0],
              {palette: [0xff0000, 0x00ff00], delay: 3});
  gf.addFrame(0, 0, 2, 2, [1, 0, 0, 1],
              {palette: [0x000000, 0x0000ff], delay: 6});
  var data = buf.slice(0, gf.end());

  var reader = new omggif.GifReader(data);
  assert.strictEqual(reader.loopCount(), 3);
  assert.strictEqual(reader.frameInfo(0).has_local_palette, true);
  assert.strictEqual(reader.frameInfo(1).has_local_palette, true);
  assert.strictEqual(reader.frameInfo(0).delay, 3);
  assert.strictEqual(reader.frameInfo(1).delay, 6);
  var comp = new omggif.GifCompositor(reader);
  assert.deepStrictEqual(Array.from(comp.compositeFrame(0).slice(0, 4)),
                         [255, 0, 0, 255]);
  assert.deepStrictEqual(Array.from(comp.compositeFrame(1).slice(0, 4)),
                         [0, 0, 255, 255]);
});

test('writer rejects pixel indices outside the palette', function() {
  var buf = new Uint8Array(1 << 16);
  var gf = new omggif.GifWriter(buf, 2, 2, {palette: [0xff0000, 0x00ff00]});
  assert.throws(function() { gf.addFrame(0, 0, 2, 2, [0, 1, 2, 0]); },
                /out of range/);
});

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------
var failures = 0;
tests.forEach(function(t) {
  try {
    t.fn();
    console.log('ok - ' + t.name);
  } catch (e) {
    ++failures;
    console.error('FAIL - ' + t.name);
    console.error('    ' + (e && e.message ? e.message.split('\n').join('\n    ')
                                           : String(e)));
  }
});
console.log(tests.length - failures + '/' + tests.length + ' tests passed');
process.exit(failures === 0 ? 0 : 1);
