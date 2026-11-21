// Independent per-pixel GIF decoding + compositing reference, used only by
// the tests.  It shares no code with omggif.js: its own block parser, its own
// textbook LZW decoder, its own deinterlacer and its own canvas compositor.
// If omggif and this reference agree on every canvas pixel for every frame,
// both are very likely implementing the same spec correctly.
//
// Compositing rules implemented here (GIF89a):
//  - canvas starts fully transparent;
//  - a frame's transparent pixels never overwrite the canvas;
//  - disposal 0/1 (and reserved 4-7): leave canvas as-is;
//  - disposal 2: clear the disposed frame's rectangle to transparent;
//  - disposal 3: restore the canvas to what it was before that frame;
//  - a frame's disposal is applied when moving on to the next frame;
//  - frames extending past the logical screen are clipped to it.

"use strict";

function parseGif(buf) {
  var p = 0;
  function u8() { return buf[p++]; }
  function u16() { var v = buf[p] | (buf[p + 1] << 8); p += 2; return v; }

  // Header.
  var sig = String.fromCharCode(buf[0], buf[1], buf[2],
                                buf[3], buf[4], buf[5]);
  if (sig !== 'GIF87a' && sig !== 'GIF89a')
    throw new Error('reference: bad header');
  p = 6;

  var width = u16(), height = u16();
  var packed = u8();
  var hasGlobal = (packed & 0x80) !== 0;
  var globalSize = 1 << ((packed & 0x07) + 1);
  u8();  // background index
  u8();  // aspect ratio

  function readPalette(size) {
    var pal = [];
    for (var i = 0; i < size; ++i)
      pal.push([buf[p++], buf[p++], buf[p++]]);
    return pal;
  }

  var globalPalette = hasGlobal ? readPalette(globalSize) : null;

  var loopCount = null;
  var frames = [];
  // Pending graphics control extension state (applies to one frame only).
  var delay = 0, transparent = null, disposal = 0;

  var done = false;
  while (!done && p < buf.length) {
    var introducer = u8();
    if (introducer === 0x3b) {  // Trailer.
      done = true;
    } else if (introducer === 0x21) {  // Extension.
      var label = u8();
      if (label === 0xf9) {  // Graphics Control Extension.
        var size = u8();
        if (size !== 4) throw new Error('reference: bad GCE size');
        var pf = u8();
        delay = u16();
        var t = u8();
        transparent = (pf & 1) ? t : null;
        disposal = (pf >> 2) & 7;
        u8();  // terminator
      } else {  // Anything else: skip sub-blocks.
        if (label === 0xff) {
          var appLen = u8();
          var app = '';
          for (var i = 0; i < appLen; ++i) app += String.fromCharCode(u8());
          // Netscape loop extension.
          if (app === 'NETSCAPE2.0') {
            u8();  // sub-block size (3)
            u8();  // sub-block id (1)
            loopCount = u16();
            u8();  // terminator
            continue;
          }
        }
        while (true) {
          var n = u8();
          if (n === 0 || n === undefined) break;
          p += n;
        }
      }
    } else if (introducer === 0x2c) {  // Image descriptor.
      var x = u16(), y = u16(), w = u16(), h = u16();
      var ipf = u8();
      var hasLocal = (ipf & 0x80) !== 0;
      var interlaced = (ipf & 0x40) !== 0;
      var localSize = 1 << ((ipf & 0x07) + 1);
      var palette = hasLocal ? readPalette(localSize) : globalPalette;
      var minCodeSize = u8();
      var data = [];
      while (true) {
        var bn = u8();
        if (bn === 0) break;
        for (var j = 0; j < bn; ++j) data.push(u8());
      }
      var indices = lzwDecode(data, minCodeSize, w * h);
      if (interlaced) indices = deinterlace(indices, w, h);
      frames.push({
        x: x, y: y, width: w, height: h,
        palette: palette,
        transparent: transparent,
        delay: delay,
        disposal: disposal,
        indices: indices,
      });
      // A GCE scopes to exactly one graphic block.
      delay = 0; transparent = null; disposal = 0;
    } else {
      throw new Error('reference: unknown block 0x' + introducer.toString(16));
    }
  }

  return {width: width, height: height, loopCount: loopCount, frames: frames};
}

// Textbook LZW decoder: dictionary of index sequences, KwKwK handling.
function lzwDecode(bytes, minCodeSize, expectedPixels) {
  var clear = 1 << minCodeSize;
  var eoi = clear + 1;

  var dict, next, codeSize;
  function reset() {
    dict = [];
    for (var i = 0; i < clear; ++i) dict.push([i]);
    dict.push(null);  // clear
    dict.push(null);  // eoi
    next = eoi + 1;
    codeSize = minCodeSize + 1;
  }
  reset();

  var out = [];
  var bitPos = 0;
  var prev = null;

  function readCode() {
    var code = 0;
    for (var i = 0; i < codeSize; ++i) {
      var bytePos = bitPos >> 3;
      if (bytePos >= bytes.length) return -1;
      var bit = (bytes[bytePos] >> (bitPos & 7)) & 1;
      code |= bit << i;
      ++bitPos;
    }
    return code;
  }

  while (true) {
    var code = readCode();
    if (code < 0 || code === eoi) break;
    if (code === clear) { reset(); prev = null; continue; }

    var entry;
    if (code < next && dict[code] !== null && dict[code] !== undefined) {
      entry = dict[code];
    } else if (code === next && prev !== null) {
      entry = prev.concat([prev[0]]);  // KwKwK
    } else {
      throw new Error('reference: bad LZW code ' + code);
    }

    for (var k = 0; k < entry.length; ++k) out.push(entry[k]);

    if (prev !== null && next < 4096) {
      dict[next++] = prev.concat([entry[0]]);
      if (next === (1 << codeSize) && codeSize < 12) ++codeSize;
    }
    prev = entry;
    if (out.length >= expectedPixels) {
      // Keep consuming nothing; encoders may pad, we have all we need.
      // (We still break on EOI above when it comes first.)
    }
  }
  return out.slice(0, expectedPixels);
}

function deinterlace(indices, w, h) {
  var out = new Array(w * h);
  var src = 0;
  var passes = [[0, 8], [4, 8], [2, 4], [1, 2]];
  for (var pi = 0; pi < passes.length; ++pi) {
    for (var row = passes[pi][0]; row < h; row += passes[pi][1]) {
      for (var col = 0; col < w; ++col) {
        out[row * w + col] = indices[src++];
      }
    }
  }
  return out;
}

// Compose frames 0..frameNum onto a fresh logical canvas.
// Returns a Uint8Array of width*height*4 RGBA.
function composeFrames(parsed, frameNum) {
  var width = parsed.width, height = parsed.height;
  var canvas = new Uint8Array(width * height * 4);
  var saved = null;

  function clipRect(f) {
    var x0 = Math.max(f.x, 0), y0 = Math.max(f.y, 0);
    var x1 = Math.min(f.x + f.width, width);
    var y1 = Math.min(f.y + f.height, height);
    if (x1 <= x0 || y1 <= y0) return null;
    return {x: x0, y: y0, w: x1 - x0, h: y1 - y0};
  }

  for (var n = 0; n <= frameNum; ++n) {
    if (n > 0) {  // Apply the previous frame's disposal before drawing.
      var pf = parsed.frames[n - 1];
      if (pf.disposal === 2) {
        var rc = clipRect(pf);
        if (rc) {
          for (var ry = 0; ry < rc.h; ++ry)
            for (var rx = 0; rx < rc.w; ++rx) {
              var cp = ((rc.y + ry) * width + rc.x + rx) * 4;
              canvas[cp] = canvas[cp + 1] = canvas[cp + 2] = canvas[cp + 3] = 0;
            }
        }
      } else if (pf.disposal === 3 && saved !== null) {
        canvas.set(saved);
        saved = null;
      }
    }

    var f = parsed.frames[n];
    if (f.disposal === 3) saved = canvas.slice();
    var r = clipRect(f);
    if (r === null) continue;
    for (var row = 0; row < r.h; ++row) {
      for (var col = 0; col < r.w; ++col) {
        var sx = (r.x - f.x) + col, sy = (r.y - f.y) + row;
        var idx = f.indices[sy * f.width + sx];
        if (f.transparent !== null && idx === f.transparent) continue;
        var color = f.palette[idx];
        if (color === undefined)
          throw new Error('reference: palette index out of range');
        var dp = ((r.y + row) * width + r.x + col) * 4;
        canvas[dp] = color[0];
        canvas[dp + 1] = color[1];
        canvas[dp + 2] = color[2];
        canvas[dp + 3] = 255;
      }
    }
  }
  return canvas;
}

module.exports = {
  parseGif: parseGif,
  composeFrames: composeFrames,
  lzwDecode: lzwDecode,
};
