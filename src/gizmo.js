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
  NEAR, FAR, BODY, APEX,
  CIRCLE, WEBGL,
  COLOR_X, COLOR_Y, COLOR_Z,
} from './constants.js';
import {
  projIsOrtho, projNear, projFar, projLeft, projRight, projTop, projBottom, mat4MulPoint,
} from './query.js';
import { cameraEye } from './camera.js';
import { hermiteVec3 } from './track.js';

const TWO_PI = Math.PI * 2;
const _AXIS_COLORS = [COLOR_X, COLOR_Y, COLOR_Z];
const _U = [1, 0, 0], _V = [0, 1, 0];          // the HUD plane's basis
const _E   = new Float64Array(16);             // a camera state's eye matrix
const _p3  = [0, 0, 0];                        // a transformed corner / a sampled point
const _q3  = [0, 0, 0];                        // the previous sampled point
const _c24 = new Float64Array(24);             // frustum corners scratch

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

// =========================================================================
// G4  Frustum and Hermite
// =========================================================================

const _isMat = (cam) => cam != null && cam.mat4Eye != null && cam.mat4Proj != null;

/** Corner i of out24 ← E · (x, y, z). */
function _corner(out24, i, E, x, y, z) {
  mat4MulPoint(_p3, E, x, y, z);
  out24[3*i] = _p3[0]; out24[3*i + 1] = _p3[1]; out24[3*i + 2] = _p3[2];
}

/**
 * The eight world-space corners of a camera's frustum: the near face 0–3
 * counter-clockwise from bottom-left (BL, BR, TR, TL), then the far face
 * 4–7 in the same order — so corners 3, 2, 1, 0 are a pane's TL, TR, BR,
 * BL. `cam` is a camera state (its symmetric extents from fov or
 * halfHeight and `aspect`), or { mat4Eye, mat4Proj, ndcZMin? } for a
 * matrix-captured camera (the extents read off the projection). The far
 * extents follow by similar triangles, or equal the near ones under
 * orthographic.
 *
 * @param {Float64Array|number[]} out24  24-element destination.
 * @param {object} cam       Camera state, or { mat4Eye, mat4Proj, ndcZMin? }.
 * @param {number} [aspect=1]  Viewport width / height (state form).
 * @param {number} [ndcZMin=WEBGL]  NDC-z convention when the matrix form carries none.
 * @returns {Float64Array|number[]|null} out24, or null when the state's lens is unset.
 */
export function frustumCorners(out24, cam, aspect, ndcZMin) {
  let E, n, f, l, r, t, b, ortho;
  if (_isMat(cam)) {
    E = cam.mat4Eye;
    const P = cam.mat4Proj, z = cam.ndcZMin ?? ndcZMin ?? WEBGL;
    ortho = projIsOrtho(P);
    n = projNear(P, z); f = projFar(P);
    l = projLeft(P, z); r = projRight(P, z); t = projTop(P, z); b = projBottom(P, z);
  } else {
    ortho = cam.fov == null;
    if (ortho && cam.halfHeight == null) return null;
    n = cam.near; f = cam.far;
    t = ortho ? cam.halfHeight : n * Math.tan(cam.fov / 2);
    r = t * (aspect ?? 1);
    b = -t; l = -r;
    E = cameraEye(_E, cam);
  }
  const k = ortho ? 1 : f / n;
  _corner(out24, 0, E,   l,   b, -n);
  _corner(out24, 1, E,   r,   b, -n);
  _corner(out24, 2, E,   r,   t, -n);
  _corner(out24, 3, E,   l,   t, -n);
  _corner(out24, 4, E, k*l, k*b, -f);
  _corner(out24, 5, E, k*r, k*b, -f);
  _corner(out24, 6, E, k*r, k*t, -f);
  _corner(out24, 7, E, k*l, k*t, -f);
  return out24;
}

/** Line between corners i and j of the scratch corners. */
function _edge(i, j) {
  _line(_c24[3*i], _c24[3*i + 1], _c24[3*i + 2], _c24[3*j], _c24[3*j + 1], _c24[3*j + 2]);
}

/**
 * A camera's frustum as edges by bit: NEAR and FAR the two rectangles,
 * BODY the four edges joining them, APEX (perspective only) the eye to
 * the near corners. `cam` as frustumCorners takes it.
 *
 * Count: 8 · (NEAR + FAR + BODY + APEX), at most 32.
 *
 * @param {object} out  Arrays object.
 * @param {object} cam  Camera state, or { mat4Eye, mat4Proj, ndcZMin? }.
 * @param {{ aspect?:number, ndcZMin?:number, bits?:number, color?:number[] }} [opts]
 * @returns {number} Vertices needed (0 when the state's lens is unset).
 */
export function frustumLines(out, cam, opts) {
  const o = opts || {};
  const bits = o.bits ?? (NEAR | FAR | BODY | APEX);
  _begin(out);
  _color(o.color);
  if (frustumCorners(_c24, cam, o.aspect ?? 1, o.ndcZMin ?? WEBGL) === null) return _end(out);
  if (bits & NEAR) { _edge(0, 1); _edge(1, 2); _edge(2, 3); _edge(3, 0); }
  if (bits & FAR)  { _edge(4, 5); _edge(5, 6); _edge(6, 7); _edge(7, 4); }
  if (bits & BODY) { _edge(0, 4); _edge(1, 5); _edge(2, 6); _edge(3, 7); }
  const persp = _isMat(cam) ? !projIsOrtho(cam.mat4Proj) : cam.fov != null;
  if ((bits & APEX) && persp) {
    const E = _isMat(cam) ? cam.mat4Eye : null;
    const ex = E ? E[12] : cam.eye[0], ey = E ? E[13] : cam.eye[1], ez = E ? E[14] : cam.eye[2];
    for (let i = 0; i < 4; i++) _line(ex, ey, ez, _c24[3*i], _c24[3*i + 1], _c24[3*i + 2]);
  }
  return _end(out);
}

/**
 * One cubic Hermite segment through hermiteVec3, as a polyline of
 * `samples` steps.
 *
 * Count: 2 · samples.
 *
 * @param {object} out  Arrays object.
 * @param {number[]} p0,t0  Start point and its outgoing tangent.
 * @param {number[]} p1,t1  End point and its incoming tangent.
 * @param {{ samples?:number, color?:number[] }} [opts]
 * @returns {number} Vertices needed.
 */
export function hermiteLines(out, p0, t0, p1, t1, opts) {
  const o = opts || {};
  const N = Math.max(1, (o.samples ?? 32) | 0);
  _begin(out);
  _color(o.color);
  for (let i = 0; i <= N; i++) {
    hermiteVec3(_p3, p0, t0, p1, t1, i / N);
    if (i > 0) _line(_q3[0], _q3[1], _q3[2], _p3[0], _p3[1], _p3[2]);
    _q3[0] = _p3[0]; _q3[1] = _p3[1]; _q3[2] = _p3[2];
  }
  return _end(out);
}
