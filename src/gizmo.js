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
  PATH, CENTER, CONTROLS, TANGENTS_IN, TANGENTS_OUT,
  TRANSLATE, ROTATE,
  AIM, LOCUS, RING,
  SPHERE, PLANE, AXIS, DIAL,
  CIRCLE, WEBGL,
  COLOR_X, COLOR_Y, COLOR_Z, COLOR_DIM,
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
const _tIn = [0, 0, 0], _tOut = [0, 0, 0];     // a keyframe's tangents
const _act = [0, 0, 0, 0, 0, 0];               // a helm's activity
const _tip = [0, 0, 0], _ha = [0, 0, 0];       // an arrow's tip and head base
const _AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const _b0 = [0, 0, 0], _b1 = [0, 0, 0], _b2 = [0, 0, 0];   // a locus basis
const _UV_DEFAULT = [0, 1, 1, 1, 1, 0, 0, 0];  // paneTris: p0 top-left → (0, 1), clockwise

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

/** A vertex with a texture coordinate (written when out.texcoord exists). */
function _vertexUV(x, y, z, u, v) {
  const n = _w.n;
  _vertex(x, y, z);
  if (_w.tex && n < _w.cap) { _w.tex[2*n] = u; _w.tex[2*n + 1] = v; }
}

/** Normalise v in place; a zero vector becomes (dx, dy, dz). */
function _unit(v, dx, dy, dz) {
  const l = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
  if (l < 1e-9) { v[0] = dx; v[1] = dy; v[2] = dz; return v; }
  v[0] /= l; v[1] /= l; v[2] /= l;
  return v;
}

/** Orthonormal in-plane basis (ub, vb) for a unit normal n, seeded from the least-aligned axis. */
function _basis(n, ub, vb) {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  let rx = 0, ry = 0, rz = 0;
  if (ax <= ay && ax <= az) rx = 1; else if (ay <= az) ry = 1; else rz = 1;
  ub[0] = ry*n[2] - rz*n[1]; ub[1] = rz*n[0] - rx*n[2]; ub[2] = rx*n[1] - ry*n[0];
  _unit(ub, 1, 0, 0);
  vb[0] = n[1]*ub[2] - n[2]*ub[1]; vb[1] = n[2]*ub[0] - n[0]*ub[2]; vb[2] = n[0]*ub[1] - n[1]*ub[0];
}

/** The four edges of a square of half-extent h at c, spanned by u, v. */
function _square(c, u, v, h) {
  const x0 = c[0] - h*u[0] - h*v[0], y0 = c[1] - h*u[1] - h*v[1], z0 = c[2] - h*u[2] - h*v[2];
  const x1 = c[0] + h*u[0] - h*v[0], y1 = c[1] + h*u[1] - h*v[1], z1 = c[2] + h*u[2] - h*v[2];
  const x2 = c[0] + h*u[0] + h*v[0], y2 = c[1] + h*u[1] + h*v[1], z2 = c[2] + h*u[2] + h*v[2];
  const x3 = c[0] - h*u[0] + h*v[0], y3 = c[1] - h*u[1] + h*v[1], z3 = c[2] - h*u[2] + h*v[2];
  _line(x0, y0, z0, x1, y1, z1);
  _line(x1, y1, z1, x2, y2, z2);
  _line(x2, y2, z2, x3, y3, z3);
  _line(x3, y3, z3, x0, y0, z0);
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

// =========================================================================
// G5  Path, helm rig, locus, pane
// =========================================================================

/**
 * A PoseTrack or CameraTrack's path by bit, over the track's own samplers
 * (samplePos / sampleEye / sampleCenter and the tangent readers), so the
 * interpolation modes are honoured: PATH the sampled polyline, `samples`
 * per segment; CONTROLS the straight control polygon; TANGENTS_IN /
 * TANGENTS_OUT the tangent at each keyframe scaled by `tangentScale`;
 * CENTER (camera tracks) the gaze line eye → center per keyframe and a
 * three-axis star of half-size `centerSize` at the center. `target`
 * ('eye' or 'center') picks a camera track's path for the first three
 * bits. Markers and handles are the bridge's composition.
 *
 * Count: 2 · samples · segments (PATH) + 2 · segments (CONTROLS) +
 * 2 · keyframes per tangent bit + 8 · keyframes (CENTER).
 *
 * @param {object} out    Arrays object.
 * @param {object} track  PoseTrack or CameraTrack.
 * @param {{ bits?:number, samples?:number, tangentScale?:number, target?:string,
 *           centerSize?:number, color?:number[] }} [opts]
 * @returns {number} Vertices needed.
 */
export function pathLines(out, track, opts) {
  const o = opts || {};
  const bits = o.bits ?? (PATH | CONTROLS | TANGENTS_IN | TANGENTS_OUT);
  const N = Math.max(1, (o.samples ?? 32) | 0);
  const ts = o.tangentScale ?? 0.25;
  const cs = o.centerSize ?? 4;
  const kfs = track.keyframes, n = kfs.length;
  const isCamera = typeof track.sampleEye === 'function';
  const useCenter = isCamera && o.target === 'center';
  const field    = isCamera ? (useCenter ? 'center'         : 'eye')         : 'pos';
  const sampler  = isCamera ? (useCenter ? 'sampleCenter'   : 'sampleEye')   : 'samplePos';
  const tangents = isCamera ? (useCenter ? 'centerTangents' : 'eyeTangents') : 'tangents';
  _begin(out);
  _color(o.color);
  if ((bits & PATH) && n > 1) {
    for (let seg = 0; seg < n - 1; seg++) {
      for (let i = 0; i <= N; i++) {
        track[sampler](_p3, seg, i / N);
        if (i > 0) _line(_q3[0], _q3[1], _q3[2], _p3[0], _p3[1], _p3[2]);
        _q3[0] = _p3[0]; _q3[1] = _p3[1]; _q3[2] = _p3[2];
      }
    }
  }
  if (bits & CONTROLS) {
    for (let i = 0; i < n - 1; i++) {
      const a = kfs[i][field], b = kfs[i + 1][field];
      _line(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
  }
  if (bits & (TANGENTS_IN | TANGENTS_OUT)) {
    for (let i = 0; i < n; i++) {
      track[tangents](_tIn, _tOut, i);
      const k = kfs[i][field];
      if (bits & TANGENTS_IN)  _line(k[0] - ts*_tIn[0], k[1] - ts*_tIn[1], k[2] - ts*_tIn[2], k[0], k[1], k[2]);
      if (bits & TANGENTS_OUT) _line(k[0], k[1], k[2], k[0] + ts*_tOut[0], k[1] + ts*_tOut[1], k[2] + ts*_tOut[2]);
    }
  }
  if ((bits & CENTER) && isCamera) {
    for (let i = 0; i < n; i++) {
      const e = kfs[i].eye, c = kfs[i].center;
      _line(e[0], e[1], e[2], c[0], c[1], c[2]);
      _line(c[0] - cs, c[1], c[2], c[0] + cs, c[1], c[2]);
      _line(c[0], c[1] - cs, c[2], c[0], c[1] + cs, c[2]);
      _line(c[0], c[1], c[2] - cs, c[0], c[1], c[2] + cs);
    }
  }
  return _end(out);
}

/** An arrow along principal axis `axis` (0 X, 1 Y, 2 Z): signed length L, head size h — 5 lines. */
function _arrow(axis, L, h) {
  const a = (axis + 1) % 3, b = (axis + 2) % 3;
  _tip[0] = _tip[1] = _tip[2] = 0; _tip[axis] = L;
  _line(0, 0, 0, _tip[0], _tip[1], _tip[2]);
  const s = Math.sign(L) || 1;
  _ha[0] = _ha[1] = _ha[2] = 0; _ha[axis] = L - s*h;
  _ha[a] =  h*0.5; _line(_tip[0], _tip[1], _tip[2], _ha[0], _ha[1], _ha[2]);
  _ha[a] = -h*0.5; _line(_tip[0], _tip[1], _tip[2], _ha[0], _ha[1], _ha[2]);
  _ha[a] = 0;
  _ha[b] =  h*0.5; _line(_tip[0], _tip[1], _tip[2], _ha[0], _ha[1], _ha[2]);
  _ha[b] = -h*0.5; _line(_tip[0], _tip[1], _tip[2], _ha[0], _ha[1], _ha[2]);
}

/**
 * A helm's rig, colour always semantic: per translation channel a dim
 * baseline arrow of signed length sign · size · sens / 0.30 and, while the
 * channel's activity is non-zero, a bright arrow of length ∝ |activity| /
 * (sens · fullScale); per rotation channel a dim ring of radius size / 2 ·
 * sens / 0.0025 and a bright arc sweeping π · f in the live direction.
 * Dim and bright are the alpha of the written colour (COLOR_DIM, 1). With
 * `identify`, one anchor per channel goes to out.labels as { x, y, z,
 * text: 'L' + lane }. Orientation is the caller's M.
 *
 * Count: 10 · 3 · 2 (arrows) + 96 · 3 (rings) + 48 · 3 (arcs), at most 492;
 * the bright half only while a channel is active.
 *
 * @param {object} out   Arrays object.
 * @param {object} helm  A PoseHelm (profile, fullScale, activity).
 * @param {{ size?:number, bits?:number, identify?:boolean }} [opts]
 * @returns {number} Vertices needed.
 */
export function helmRigLines(out, helm, opts) {
  const o = opts || {};
  const size = o.size ?? 100;
  const bits = o.bits ?? (TRANSLATE | ROTATE);
  const identify = o.identify === true;
  const prof = helm.profile;
  const head = size * 0.08, ringR0 = size * 0.5;
  const TREF = 0.30, RREF = 0.0025, FULL = helm.fullScale, ARC_FULL = Math.PI;
  helm.activity(_act);
  _begin(out);
  const labels = identify && out.labels ? out.labels : null;
  if (bits & TRANSLATE) {
    const T = [prof.Tx, prof.Ty, prof.Tz];
    for (let ax = 0; ax < 3; ax++) {
      const ch = T[ax];
      const L = ch.sign * size * (ch.sens / TREF);
      _color(_AXIS_COLORS[ax], COLOR_DIM);
      _arrow(ax, L, head);
      const a = _act[ax];
      if (a !== 0) {
        const f = Math.min(Math.abs(a) / (ch.sens * FULL), 1);
        _color(_AXIS_COLORS[ax], 1);
        _arrow(ax, Math.sign(a) * f * Math.abs(L), head);
      }
      if (labels) {
        const lp = [0, 0, 0]; lp[ax] = L + ch.sign * head * 1.5;
        labels.push({ x: lp[0], y: lp[1], z: lp[2], text: 'L' + ch.lane });
      }
    }
  }
  if (bits & ROTATE) {
    const R = [prof.Rp, prof.Ry, prof.Rr];       // pitch ⊥ X, yaw ⊥ Y, roll ⊥ Z
    for (let ax = 0; ax < 3; ax++) {
      const ch = R[ax];
      const r = ringR0 * (ch.sens / RREF);
      const u = _AXES[(ax + 1) % 3], v = _AXES[(ax + 2) % 3];
      _color(_AXIS_COLORS[ax], COLOR_DIM);
      _ring(0, 0, 0, r, u, v, 48, TWO_PI);
      const a = _act[3 + ax];
      if (a !== 0) {
        const f = Math.min(Math.abs(a) / (ch.sens * FULL), 1);
        _color(_AXIS_COLORS[ax], 1);
        _ring(0, 0, 0, r, u, v, 24, Math.sign(a) * f * ARC_FULL);
      }
      if (labels) {
        const lp = [0, 0, 0]; lp[(ax + 1) % 3] = r;
        labels.push({ x: lp[0], y: lp[1], z: lp[2], text: 'L' + ch.lane });
      }
    }
  }
  return _end(out);
}

/**
 * A handle's stroked parts by bit. AIM: anchor → `point` (the handle's
 * current point, read by the caller with value). LOCUS by constraint.kind:
 * SPHERE three great circles about the anchor; PLANE a square of
 * half-extent 100 in the plane's basis; AXIS the segment anchor + [min,
 * max] · u; DIAL the ring in the dial plane; a constraint flagged `view`
 * (the host's VIEW) a screen-aligned square of half-extent 100 at `point`,
 * its basis the camera's right and up read off `mat4View`. RING: SPHERE
 * the view-facing limb, a ring perpendicular to anchor − eye (the eye from
 * `mat4View`); PLANE the border of the locus square (written once when
 * both bits ask for it). A constraint supplying locus(out, opts) is
 * dispatched to it. The HANDLE dot is not a line and not generated here.
 *
 * Count: AIM 2; LOCUS SPHERE 288 · PLANE 8 · AXIS 2 · DIAL 96 · view 8;
 * RING SPHERE 96 · PLANE 8 (shared with LOCUS); at most 386.
 *
 * @param {object} out         Arrays object.
 * @param {object} constraint  A contract-conforming constraint.
 * @param {{ bits?:number, mat4View?:ArrayLike<number>, point?:number[], color?:number[] }} [opts]
 * @returns {number} Vertices needed.
 */
export function locusLines(out, constraint, opts) {
  const o = opts || {};
  if (typeof constraint.locus === 'function') return constraint.locus(out, o);
  const bits = o.bits ?? (AIM | LOCUS);
  const c = constraint, a = c.anchor, pt = o.point, V = o.mat4View;
  _begin(out);
  _color(o.color);
  if ((bits & AIM) && a && pt) _line(a[0], a[1], a[2], pt[0], pt[1], pt[2]);
  if (c.view === true) {
    if ((bits & LOCUS) && pt && V) {
      _b0[0] = V[0]; _b0[1] = V[4]; _b0[2] = V[8];      // the camera's right
      _b1[0] = V[1]; _b1[1] = V[5]; _b1[2] = V[9];      // the camera's up
      _square(pt, _b0, _b1, 100);
    }
  } else if (c.kind === SPHERE && a) {
    if (bits & LOCUS) {
      _ring(a[0], a[1], a[2], c.radius, _AXES[0], _AXES[1], 48, TWO_PI);
      _ring(a[0], a[1], a[2], c.radius, _AXES[1], _AXES[2], 48, TWO_PI);
      _ring(a[0], a[1], a[2], c.radius, _AXES[2], _AXES[0], 48, TWO_PI);
    }
    if ((bits & RING) && V) {
      // eye = −Rᵀ t of the view matrix; the limb is ⊥ anchor − eye
      const tx = V[12], ty = V[13], tz = V[14];
      _b2[0] = a[0] + (V[0]*tx + V[1]*ty + V[2]*tz);
      _b2[1] = a[1] + (V[4]*tx + V[5]*ty + V[6]*tz);
      _b2[2] = a[2] + (V[8]*tx + V[9]*ty + V[10]*tz);
      _unit(_b2, 0, 0, 1);
      _basis(_b2, _b0, _b1);
      _ring(a[0], a[1], a[2], c.radius, _b0, _b1, 48, TWO_PI);
    }
  } else if (c.kind === PLANE && a) {
    if (bits & (LOCUS | RING)) {
      _basis(c.n, _b0, _b1);
      _square(a, _b0, _b1, 100);
    }
  } else if (c.kind === AXIS && a) {
    if (bits & LOCUS) {
      const u = c.u;
      _line(a[0] + c.min*u[0], a[1] + c.min*u[1], a[2] + c.min*u[2],
            a[0] + c.max*u[0], a[1] + c.max*u[1], a[2] + c.max*u[2]);
    }
  } else if (c.kind === DIAL && a) {
    if (bits & LOCUS) _ring(a[0], a[1], a[2], c.radius, c.r0, c.r1, 48, TWO_PI);
  }
  return _end(out);
}

/**
 * A textured quad as two triangles (p0, p1, p2) (p0, p2, p3) — the winding
 * of the corner order — with texcoord written when the array exists.
 * Default uvs: p0 (top-left) → (0, 1), p1 → (1, 1), p2 → (1, 0), p3 →
 * (0, 0), so a texture in GL's bottom-up space reads upright with no
 * flip; `opts.uvs` overrides, four pairs flat in corner order.
 *
 * Count: 6.
 *
 * @param {object} out  Arrays object.
 * @param {number[]} p0,p1,p2,p3  Corners, top-left clockwise.
 * @param {{ uvs?:number[], color?:number[] }} [opts]
 * @returns {number} Vertices needed.
 */
export function paneTris(out, p0, p1, p2, p3, opts) {
  const o = opts || {};
  const uv = o.uvs || _UV_DEFAULT;
  _begin(out);
  _color(o.color);
  _vertexUV(p0[0], p0[1], p0[2], uv[0], uv[1]);
  _vertexUV(p1[0], p1[1], p1[2], uv[2], uv[3]);
  _vertexUV(p2[0], p2[1], p2[2], uv[4], uv[5]);
  _vertexUV(p0[0], p0[1], p0[2], uv[0], uv[1]);
  _vertexUV(p2[0], p2[1], p2[2], uv[4], uv[5]);
  _vertexUV(p3[0], p3[1], p3[2], uv[6], uv[7]);
  return _end(out);
}
