/**
 * @file Gizmo line generators in the arrays shape.
 * @module tree/gizmo
 * @license AGPL-3.0-only
 *
 * A gizmo is geometry that explains: axes, a grid, a frustum, a path, a rig,
 * a handle's locus. This module generates its vertices — renderer-free, into
 * caller-owned arrays shaped the way twgl's createBufferInfoFromArrays
 * consumes them and a WebGPU vertex buffer is filled from — and nothing
 * else. Drawing, colour state, HUD mode, textures, the dot at a handle's
 * point, text: all the bridge's or the host's.
 *
 * ── The arrays shape ───────────────────────────────────────────────────────
 *
 *   out = {
 *     position: { numComponents: 3, data: Float32Array(3 · capacity) },
 *     color:    { numComponents: 4, data: Float32Array(4 · capacity) },   // optional
 *     texcoord: { numComponents: 2, data: Float32Array(2 · capacity) },   // optional — panes
 *     count:    0,                                                        // vertices written
 *     labels:   [],                                                       // optional — { x, y, z, text }
 *   }
 *
 * Line generators write line lists — vertex pairs, no indices; paneTris
 * writes two triangles. capacity is position.data.length / 3.
 *
 * ── The contract — snprintf-style ──────────────────────────────────────────
 * Every generator gen(out, …) → n returns the vertex count it needs, writes
 * min(n, capacity) vertices, and sets out.count to what it wrote. A caller
 * sizes once and grows never in steady state:
 *
 *   let n = axesLines(out, opts)
 *   if (n > capacityOf(out)) { growArrays(out, n); axesLines(out, opts) }
 *
 * Each generator states its count formula so a caller can pre-size exactly.
 *
 * ── Colour ─────────────────────────────────────────────────────────────────
 * If out.color exists, every vertex written gets a colour: a generator with
 * semantic colouring (axes, the helm rig) writes its palette, every other
 * generator writes opts.color (default white). If out.color is absent
 * nothing is written and the bridge draws with a uniform colour.
 *
 * ── Frames ─────────────────────────────────────────────────────────────────
 * A generator writes in the frame the caller means — model space for scene
 * gizmos (the bridge's M places them), screen pixels for HUD gizmos.
 * Nothing here consults a camera except locusLines and frustumLines, which
 * take what they need explicitly. Signatures: out first, the subject second
 * where there is one, options last.
 */

'use strict';

import {
  X, _X, Y, _Y, Z, _Z, LABELS,
  CIRCLE,
  COLOR_X, COLOR_Y, COLOR_Z,
} from './constants.js';

const TWO_PI = Math.PI * 2;
const _AXIS_COLORS = [COLOR_X, COLOR_Y, COLOR_Z];
const _U = [1, 0, 0], _V = [0, 1, 0];          // the HUD plane's basis

// =========================================================================
// G1  Arrays — the one allocating call, growth, capacity
// =========================================================================

/**
 * Allocate an arrays object of `capacity` vertices — the one allocating
 * call, setup-time. Flags add the optional attributes and the label list.
 *
 * @param {number} capacity  Vertices.
 * @param {{ color?:boolean, texcoord?:boolean, labels?:boolean }} [opts]
 * @returns {{ position:{numComponents:number,data:Float32Array},
 *             color?:{numComponents:number,data:Float32Array},
 *             texcoord?:{numComponents:number,data:Float32Array},
 *             count:number, labels?:object[] }}
 */
export function createArrays(capacity, opts) {
  const o = opts || {};
  const n = Math.max(0, capacity | 0);
  const out = { position: { numComponents: 3, data: new Float32Array(3 * n) } };
  if (o.color)    out.color    = { numComponents: 4, data: new Float32Array(4 * n) };
  if (o.texcoord) out.texcoord = { numComponents: 2, data: new Float32Array(2 * n) };
  out.count = 0;
  if (o.labels) out.labels = [];
  return out;
}

/**
 * Reallocate an arrays object to a new capacity, keeping its attribute set;
 * the data is fresh (a generator refills it) and count is 0.
 *
 * @param {object} out       An arrays object from createArrays.
 * @param {number} capacity  Vertices.
 * @returns {object} out
 */
export function growArrays(out, capacity) {
  const n = Math.max(0, capacity | 0);
  out.position.data = new Float32Array(3 * n);
  if (out.color)    out.color.data    = new Float32Array(4 * n);
  if (out.texcoord) out.texcoord.data = new Float32Array(2 * n);
  out.count = 0;
  if (out.labels) out.labels.length = 0;
  return out;
}

/**
 * The vertex capacity of an arrays object: position.data.length / 3.
 * @param {object} out
 * @returns {number}
 */
export function capacityOf(out) {
  return (out.position.data.length / 3) | 0;
}

// =========================================================================
// G2  The writer — a cursor over out; counts every vertex, writes those
//     within capacity. Module-level scratch: a generator runs to completion.
// =========================================================================

const _w = { pos: null, col: null, tex: null, cap: 0, n: 0, r: 1, g: 1, b: 1, a: 1 };
const _WHITE = [1, 1, 1, 1];

function _begin(out) {
  _w.pos = out.position.data;
  _w.col = out.color ? out.color.data : null;
  _w.tex = out.texcoord ? out.texcoord.data : null;
  _w.cap = (_w.pos.length / 3) | 0;
  _w.n = 0;
  if (out.labels) out.labels.length = 0;
}

/** Set the current colour from an RGB(A) array, with an alpha override. */
function _color(c, alpha) {
  const v = c || _WHITE;
  _w.r = v[0]; _w.g = v[1]; _w.b = v[2];
  _w.a = alpha != null ? alpha : (v.length > 3 ? v[3] : 1);
}

function _vertex(x, y, z) {
  const n = _w.n++;
  if (n >= _w.cap) return;
  const p = _w.pos, i = 3 * n;
  p[i] = x; p[i + 1] = y; p[i + 2] = z;
  const c = _w.col;
  if (c) { const j = 4 * n; c[j] = _w.r; c[j + 1] = _w.g; c[j + 2] = _w.b; c[j + 3] = _w.a; }
}

function _line(x0, y0, z0, x1, y1, z1) {
  _vertex(x0, y0, z0);
  _vertex(x1, y1, z1);
}

/** Close the write: count ← what fits; return what was needed. */
function _end(out) {
  out.count = _w.n < _w.cap ? _w.n : _w.cap;
  return _w.n;
}

/** A sampled circle (or arc of `sweep`) of radius r at c, spanned by u, v: n segments. */
function _ring(cx, cy, cz, r, u, v, n, sweep) {
  let px = 0, py = 0, pz = 0;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * sweep;
    const ct = Math.cos(t) * r, st = Math.sin(t) * r;
    const x = cx + ct*u[0] + st*v[0];
    const y = cy + ct*u[1] + st*v[1];
    const z = cz + ct*u[2] + st*v[2];
    if (i > 0) _line(px, py, pz, x, y, z);
    px = x; py = y; pz = z;
  }
}

// =========================================================================
// G3  Axes, grid, cross, bulls-eye, ring
// =========================================================================

/**
 * A coordinate frame at the origin: six half-axes by bit and, with LABELS,
 * the X (2 lines) · Y (4) · Z (3) glyphs at 1.04 · size, sized size / 40 ×
 * size / 30. Semantic colour per axis and its glyph (COLOR_X / Y / Z), or
 * opts.color when `semantic` is false.
 *
 * Count: 2 · axes + 18 · (LABELS ? 1 : 0), at most 30.
 *
 * @param {object} out  Arrays object.
 * @param {{ size?:number, bits?:number, semantic?:boolean, color?:number[] }} [opts]
 * @returns {number} Vertices needed.
 */
export function axesLines(out, opts) {
  const o = opts || {};
  const size = o.size ?? 100;
  const bits = o.bits ?? (LABELS | X | Y | Z);
  const semantic = o.semantic !== false;
  const axis = (i) => _color(semantic ? _AXIS_COLORS[i] : o.color);
  _begin(out);
  if (bits & LABELS) {
    const cw = size/40, ch = size/30, cs = 1.04*size;
    axis(0);
    _line(cs,  cw, -ch, cs, -cw,  ch);
    _line(cs, -cw, -ch, cs,  cw,  ch);
    axis(1);
    _line( cw, cs,  ch,  0, cs,   0);
    _line(  0, cs,   0, -cw, cs,  ch);
    _line(-cw, cs,  ch,  0, cs,   0);
    _line(  0, cs,   0,  0, cs, -ch);
    axis(2);
    _line(-cw, -ch, cs,  cw, -ch, cs);
    _line( cw, -ch, cs, -cw,  ch, cs);
    _line(-cw,  ch, cs,  cw,  ch, cs);
  }
  axis(0);
  if (bits & X)  _line(0, 0, 0,  size, 0, 0);
  if (bits & _X) _line(0, 0, 0, -size, 0, 0);
  axis(1);
  if (bits & Y)  _line(0, 0, 0, 0,  size, 0);
  if (bits & _Y) _line(0, 0, 0, 0, -size, 0);
  axis(2);
  if (bits & Z)  _line(0, 0, 0, 0, 0,  size);
  if (bits & _Z) _line(0, 0, 0, 0, 0, -size);
  return _end(out);
}

/**
 * A grid in the XY plane: subdivisions + 1 lines each way spanning ±size.
 * Orientation is the caller's M (a ground plane is a rotation about X).
 *
 * Count: 4 · (subdivisions + 1).
 *
 * @param {object} out  Arrays object.
 * @param {{ size?:number, subdivisions?:number, color?:number[] }} [opts]
 * @returns {number} Vertices needed.
 */
export function gridLines(out, opts) {
  const o = opts || {};
  const size = o.size ?? 100;
  const sub = Math.max(1, (o.subdivisions ?? 10) | 0);
  _begin(out);
  _color(o.color);
  for (let i = 0; i <= sub; i++) {
    const pos = size * (2*i/sub - 1);
    _line(pos, -size, 0, pos, size, 0);
    _line(-size, pos, 0, size, pos, 0);
  }
  return _end(out);
}

/**
 * A crosshair in HUD space (z = 0, target pixels): two lines of `size`
 * through (x, y). The bridge projects a model origin and converts a world
 * size to pixels before this call.
 *
 * Count: 4.
 *
 * @param {object} out  Arrays object.
 * @param {{ x?:number, y?:number, size?:number, color?:number[] }} [opts]
 * @returns {number} Vertices needed.
 */
export function crossLines(out, opts) {
  const o = opts || {};
  const x = o.x ?? 0, y = o.y ?? 0, half = (o.size ?? 50) / 2;
  _begin(out);
  _color(o.color);
  _line(x - half, y, 0, x + half, y, 0);
  _line(x, y - half, 0, x, y + half, 0);
  return _end(out);
}

/**
 * A bulls-eye in HUD space (z = 0, target pixels): a sampled circle of
 * radius size / 2 (`detail` segments) or the cornered square (8 lines),
 * plus the central cross at 0.6 · half.
 *
 * Count: 2 · detail + 4 (CIRCLE) or 20 (SQUARE).
 *
 * @param {object} out  Arrays object.
 * @param {{ x?:number, y?:number, size?:number, shape?:number, detail?:number, color?:number[] }} [opts]
 * @returns {number} Vertices needed.
 */
export function bullsEyeLines(out, opts) {
  const o = opts || {};
  const x = o.x ?? 0, y = o.y ?? 0, half = (o.size ?? 50) / 2;
  const shape = o.shape ?? CIRCLE;
  const detail = Math.max(3, (o.detail ?? 50) | 0);
  _begin(out);
  _color(o.color);
  if (shape === CIRCLE) {
    _ring(x, y, 0, half, _U, _V, detail, TWO_PI);
  } else {
    const c = 0.6 * half;
    _line(x-half, y-half+c, 0, x-half, y-half, 0);
    _line(x-half, y-half, 0, x-half+c, y-half, 0);
    _line(x+half-c, y-half, 0, x+half, y-half, 0);
    _line(x+half, y-half, 0, x+half, y-half+c, 0);
    _line(x+half, y+half-c, 0, x+half, y+half, 0);
    _line(x+half, y+half, 0, x+half-c, y+half, 0);
    _line(x-half+c, y+half, 0, x-half, y+half, 0);
    _line(x-half, y+half, 0, x-half, y+half-c, 0);
  }
  const ch = 0.6 * half;
  _line(x - ch, y, 0, x + ch, y, 0);
  _line(x, y - ch, 0, x, y + ch, 0);
  return _end(out);
}

/**
 * A sampled circle of radius r at (cx, cy, cz) spanned by the orthonormal
 * u, v — the shared primitive; a partial `sweep` gives an arc from u.
 *
 * Count: 2 · detail.
 *
 * @param {object} out  Arrays object.
 * @param {number} cx,cy,cz  Centre.
 * @param {number} r         Radius.
 * @param {number[]} u,v     Orthonormal in-plane basis.
 * @param {{ detail?:number, sweep?:number, color?:number[] }} [opts]
 * @returns {number} Vertices needed.
 */
export function ringLines(out, cx, cy, cz, r, u, v, opts) {
  const o = opts || {};
  const detail = Math.max(1, (o.detail ?? 48) | 0);
  const sweep = o.sweep ?? TWO_PI;
  _begin(out);
  _color(o.color);
  _ring(cx, cy, cz, r, u, v, detail, sweep);
  return _end(out);
}
