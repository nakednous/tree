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
