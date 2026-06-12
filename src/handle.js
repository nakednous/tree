/**
 * @file Constraint solver, canonical handle state, and ray-primitive
 *       intersections for interactive manipulators.
 * @module tree/handle
 * @license AGPL-3.0-only
 *
 * The numeric brain of the manipulator handle. Renderer- and frame-agnostic:
 * inputs are plain numbers in ONE working space chosen by the caller (the
 * bridge), and the solver never learns world vs eye — it solves in whatever
 * space the ray and geometry are expressed in. The bridge converts the pointer
 * ray into the working frame before calling solve(), and converts the value
 * back out via mapLocation / mapDirection.
 *
 * Zero dependencies on p5, DOM, WebGL, or WebGPU. Out-first throughout; no
 * allocation in solve() / value(). Vectors are passed as flat scalars (matching
 * form.js), state is held as plain number[] (matching track.js keyframes).
 *
 * ── Storage convention ─────────────────────────────────────────────────────
 * The core distinguishes two value shapes deliberately:
 *   mat4   — 16-element ArrayLike, typically Float32Array, because matrices
 *            cross the GL boundary (contiguous f32 is what the renderer wants).
 *   vec3 / quat — plain number[] (f64), because they are authoring/state values
 *            and because the frozen basis-vector constants (i, j, k, ORIGIN)
 *            cannot be expressed as frozen typed arrays. Handle state follows
 *            the vec3 rule.
 *
 * ── Constraint kinds ───────────────────────────────────────────────────────
 *   SPHERE  2-DOF heading on a sphere of radius r about an anchor.
 *           Canonical state is a UNIT DIRECTION (renormalised every solve) —
 *           no stored Euler angles, so no gimbal degeneracy at the poles.
 *           az/el are derived on request via azEl().
 *   PLANE   2-DOF point on a fixed plane (anchor + unit normal).
 *   AXIS    1-DOF point on a line (anchor + unit dir), scalar t clamped to extent.
 *   DIAL    1-DOF angle on a circle of radius r in the plane (anchor, axis).
 *           Canonical state is an ACCUMULATED angle θ (multi-turn winding is
 *           preserved: each solve applies the smaller signed arc, so θ counts
 *           full turns — essential for bind targets like "rotate this 720°").
 *           θ=0 sits at the reference direction `zero` (derived from the axis
 *           when not supplied); θ grows right-handed about the axis. Near
 *           edge-on view (the ray almost parallel to the dial plane, where a
 *           plane hit races to infinity — the classic rotate-gizmo failure)
 *           the solve falls back to the TANGENT LINE of the circle at the
 *           current angle, converting linear drag to dθ: bounded, monotone,
 *           and still pure ray geometry.
 *
 *   VIEW (the camera-facing free-translate constraint) is NOT a core kind: the
 *   bridge implements it with PLANE, feeding a fresh camera-derived normal and
 *   anchor each frame. The core stays oblivious to the camera.
 *
 * ── Report modes ───────────────────────────────────────────────────────────
 *   DIRECTION  value() writes the unit direction: SPHERE → the heading;
 *              DIAL → the radial unit at θ.
 *   POINT      value() writes a position: SPHERE → anchor + dir·radius;
 *              DIAL → the point on the circle; PLANE / AXIS → the constrained
 *              point.
 *
 * ── State ownership & portability ──────────────────────────────────────────
 * Each Constraint owns its own state; there is no module-level scratch. solve()
 * writes into instance fields, never shared globals. This keeps the type a
 * plain-data state machine: it ports 1:1 to a Rust enum + impl that is
 * `Send + Sync` for free, with `&mut self` on solve() making concurrent
 * mutation a compile error. The binding closure deliberately lives in the
 * bridge, not here — a stored callback would forfeit that guarantee.
 *
 * ── Extension contract ─────────────────────────────────────────────────────
 * A constraint is any object exposing: `kind` (integer discriminant),
 * `solve(ox,oy,oz, dx,dy,dz)`, `value(out, report)`, `seed(x,y,z)`, and
 * optionally `scalar()` / `azEl(out2)` / `aim(ax,ay,az[, zx,zy,zz])` — the
 * basis re-aim seam the bridge's deferred `from` frame drives (§4.13).
 * The p5.tree handle controller drives
 * any conforming constraint (lifecycle, frame conversion, bind, hooks, pick);
 * a new kind — 6-DOF, or app-specific — implements this contract here
 * (portable, draw-free) plus a bridge-side locus/pick draw (`drawLocus` /
 * `pickProxy` on createHandle), rather than forking the controller. The
 * classes below are the reference implementation. See handle-design.md §9.
 *
 * ── Conventions ────────────────────────────────────────────────────────────
 * Ray direction `d` is assumed unit (the bridge normalises). Plane / axis
 * normals and directions are normalised at construction. The angular utilities
 * use a right-handed convention: az about +Y, el measured from the XZ plane.
 * solve() does NOT depend on this convention — it stores the hit direction
 * directly; az/el are a readout/authoring convenience only. DIAL's θ is
 * right-handed about its own axis, measured from `zero`.
 */

'use strict';

import { SPHERE, PLANE, AXIS, DIAL, POINT, DIRECTION } from './constants.js';

const EPS = 1e-6;
const TWO_PI = Math.PI * 2;

// Edge-on threshold for DIAL: below this |d·n| the plane hit is ill-conditioned
// (dθ per pixel diverges) and the solve switches to the tangent-line fallback.
// ≈ 4.6° of incidence. Tune empirically (handle-experiments/e2).
const DIAL_EDGE = 0.08;

// =========================================================================
// H1  Small private helpers
// =========================================================================

const _isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const _clamp = (x, lo, hi) => x < lo ? lo : (x > hi ? hi : x);
const _num   = (x, d) => _isNum(x) ? x : d;

/** Wrap an angle to (−π, π]. */
const _wrapPi = (a) => a - TWO_PI * Math.round(a / TWO_PI);

/** Parse a vec3 from array / typed array / {x,y,z}. Returns a fresh [x,y,z] or null. */
function _vec3(v) {
  if (!v) return null;
  if (ArrayBuffer.isView(v) && v.length >= 3) return [v[0], v[1], v[2]];
  if (Array.isArray(v) && v.length >= 3) return [v[0], v[1], v[2]];
  if (typeof v === 'object' && 'x' in v) return [v.x || 0, v.y || 0, v.z || 0];
  return null;
}

/** Normalise a vec3 in place; zero-length falls back to the given default axis. */
function _unit(v, dx, dy, dz) {
  const l = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
  if (l < EPS) { v[0]=dx; v[1]=dy; v[2]=dz; return v; }
  v[0]/=l; v[1]/=l; v[2]/=l;
  return v;
}

/**
 * Orthonormal in-plane basis for a unit normal n, written into ub, vb. Seeds
 * from the world axis least aligned with n so the first cross can't degenerate.
 * (Same derivation the p5 bridge uses for its plane quad — duplicated here
 * because the core cannot depend on the bridge.)
 */
function _basis(n, ub, vb) {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  let rx = 0, ry = 0, rz = 0;
  if (ax <= ay && ax <= az) rx = 1; else if (ay <= az) ry = 1; else rz = 1;
  ub[0] = ry*n[2] - rz*n[1]; ub[1] = rz*n[0] - rx*n[2]; ub[2] = rx*n[1] - ry*n[0];
  _unit(ub, 1, 0, 0);
  vb[0] = n[1]*ub[2] - n[2]*ub[1]; vb[1] = n[2]*ub[0] - n[0]*ub[2]; vb[2] = n[0]*ub[1] - n[1]*ub[0];
}

// =========================================================================
// H2  Ray-primitive intersections (pure, out-first, scalar params)
// =========================================================================

/**
 * Nearest ray–sphere intersection. The ray direction is assumed unit, so the
 * quadratic's leading coefficient is 1. On a miss, writes the closest-approach
 * point projected onto the sphere (so the handle tracks the limb gracefully
 * rather than snapping away).
 *
 * @param {number[]} out  3-element destination (hit point).
 * @param {number} ox,oy,oz  Ray origin.
 * @param {number} dx,dy,dz  Ray direction (unit).
 * @param {number} cx,cy,cz  Sphere centre.
 * @param {number} r         Sphere radius.
 * @returns {number} Ray parameter t at the written hit.
 */
export function raySphere(out, ox,oy,oz, dx,dy,dz, cx,cy,cz, r) {
  const lx=ox-cx, ly=oy-cy, lz=oz-cz;
  const b  = lx*dx + ly*dy + lz*dz;
  const cc = lx*lx + ly*ly + lz*lz - r*r;
  const disc = b*b - cc;
  let t;
  if (disc >= 0) {
    const s = Math.sqrt(disc);
    t = -b - s;
    if (t < 0) t = -b + s;              // origin inside the sphere: take far root
    out[0]=ox+t*dx; out[1]=oy+t*dy; out[2]=oz+t*dz;
  } else {
    t = -b;                             // closest approach along the ray
    let hx=ox+t*dx-cx, hy=oy+t*dy-cy, hz=oz+t*dz-cz;
    const hl = Math.sqrt(hx*hx + hy*hy + hz*hz) || 1;
    const k = r/hl;
    out[0]=cx+hx*k; out[1]=cy+hy*k; out[2]=cz+hz*k;
  }
  return t;
}

/**
 * Ray–plane intersection. A near-parallel ray (|d·n| < EPS) returns Infinity
 * and leaves `out` untouched — the caller keeps the previous value.
 *
 * @param {number[]} out  3-element destination (hit point).
 * @param {number} ox,oy,oz  Ray origin.
 * @param {number} dx,dy,dz  Ray direction (unit).
 * @param {number} px,py,pz  A point on the plane.
 * @param {number} nx,ny,nz  Plane normal (unit).
 * @returns {number} Ray parameter t, or Infinity if parallel.
 */
export function rayPlane(out, ox,oy,oz, dx,dy,dz, px,py,pz, nx,ny,nz) {
  const den = dx*nx + dy*ny + dz*nz;
  if (den < EPS && den > -EPS) return Infinity;
  const t = ((px-ox)*nx + (py-oy)*ny + (pz-oz)*nz) / den;
  out[0]=ox+t*dx; out[1]=oy+t*dy; out[2]=oz+t*dz;
  return t;
}

/**
 * Closest point on the infinite line (p, u) to the ray (o, d). Both `d` and
 * `u` are assumed unit. For a ray parallel to the line, projects the ray
 * origin onto the line.
 *
 * @param {number[]} out  3-element destination (closest point on the line).
 * @param {number} ox,oy,oz  Ray origin.
 * @param {number} dx,dy,dz  Ray direction (unit).
 * @param {number} px,py,pz  A point on the line.
 * @param {number} ux,uy,uz  Line direction (unit).
 * @returns {number} Signed parameter s along u at the written point (unclamped).
 */
export function rayClosestPointOnAxis(out, ox,oy,oz, dx,dy,dz, px,py,pz, ux,uy,uz) {
  const wx=ox-px, wy=oy-py, wz=oz-pz;
  const b  = dx*ux + dy*uy + dz*uz;     // d·u
  const dd = dx*wx + dy*wy + dz*wz;     // d·w
  const e  = ux*wx + uy*wy + uz*wz;     // u·w
  const den = 1 - b*b;                  // (d·d)(u·u) − (d·u)² with d,u unit
  const s = (den > EPS) ? (e - b*dd) / den : e;
  out[0]=px+s*ux; out[1]=py+s*uy; out[2]=pz+s*uz;
  return s;
}

// =========================================================================
// H3  Angular utilities (readout / authoring convenience)
// =========================================================================

/**
 * Unit direction from azimuth/elevation (right-handed: az about +Y, el from XZ).
 * @param {number[]} out  3-element destination.
 * @param {number} az  Azimuth (radians).
 * @param {number} el  Elevation (radians).
 * @returns {number[]} out
 */
export function dirFromAzEl(out, az, el) {
  const ce = Math.cos(el);
  out[0]=ce*Math.cos(az); out[1]=Math.sin(el); out[2]=ce*Math.sin(az);
  return out;
}

/**
 * Azimuth/elevation from a unit direction. Inverse of dirFromAzEl.
 * @param {number[]} out2  2-element destination [az, el] (radians).
 * @param {number} dx,dy,dz  Unit direction.
 * @returns {number[]} out2
 */
export function azElFromDir(out2, dx, dy, dz) {
  out2[0] = Math.atan2(dz, dx);                 // az
  out2[1] = Math.asin(_clamp(dy, -1, 1));       // el
  return out2;
}

// =========================================================================
// H4  Constraint — tagged state machine (one class, kind discriminant)
// =========================================================================

/**
 * A draggable constraint: maps a ray to a constrained value and holds the
 * canonical state between drags. One class with a `kind` discriminant (never
 * per-constraint subclasses) so it maps cleanly to a Rust enum.
 *
 * Construction options (all optional unless noted):
 *   SPHERE — { radius = 1, report = DIRECTION, anchor = [0,0,0] }
 *   PLANE  — { anchor = [0,0,0], normal = [0,1,0] }
 *   AXIS   — { anchor = [0,0,0], axis = [1,0,0], extent = [-1, 1] }
 *   DIAL   — { anchor = [0,0,0], axis = [0,1,0], radius = 1, zero?,
 *              extent = [-∞, ∞] }
 *            `axis` is the dial-plane normal (θ is right-handed about it);
 *            `zero` is the in-plane reference direction for θ=0 (projected
 *            onto the plane and normalised; derived from the axis when
 *            absent); `extent` clamps θ in radians — unbounded by default,
 *            so the dial winds multiple turns.
 *
 * @param {number} kind  SPHERE | PLANE | AXIS | DIAL.
 * @param {Object} [opts]
 */
export class Constraint {
  constructor(kind, opts = {}) {
    /** Constraint kind discriminant. @type {number} */
    this.kind = kind;

    /** Constraint origin (sphere centre / plane point / axis anchor / dial centre). @type {number[]} */
    this.anchor = _vec3(opts.anchor) || [0, 0, 0];
    /** Canonical unit direction — SPHERE. @type {number[]} */
    this.dir = [0, 0, 1];
    /** Constrained point — PLANE / AXIS / DIAL (and SPHERE scratch). @type {number[]} */
    this.pt = [this.anchor[0], this.anchor[1], this.anchor[2]];
    /** Plane normal (unit) — PLANE. @type {number[]} */
    this.n = _unit(_vec3(opts.normal) || [0, 1, 0], 0, 1, 0);
    /** Axis / dial-plane normal (unit) — AXIS / DIAL. @type {number[]} */
    this.u = kind === DIAL
      ? _unit(_vec3(opts.axis) || [0, 1, 0], 0, 1, 0)
      : _unit(_vec3(opts.axis) || [1, 0, 0], 1, 0, 0);
    /** Current scalar parameter — AXIS: t along the line; DIAL: accumulated θ. @type {number} */
    this.s = 0;

    // DIAL in-plane basis: r0 (the θ=0 reference) and r1 = u × r0, so the
    // point at θ is anchor + radius·(cosθ·r0 + sinθ·r1) — right-handed about u.
    /** θ=0 reference direction (unit, in-plane) — DIAL. @type {number[]} */
    this.r0 = [1, 0, 0];
    /** In-plane binormal u × r0 (unit) — DIAL. @type {number[]} */
    this.r1 = [0, 0, 1];
    if (kind === DIAL) {
      const z = _vec3(opts.zero);
      this._dialBasis(z ? z[0] : NaN, z ? z[1] : NaN, z ? z[2] : NaN);
    }

    // Extent: AXIS clamps t (default [-1, 1]); DIAL clamps θ in radians
    // (default unbounded, so the dial winds freely).
    const ext = Array.isArray(opts.extent) ? opts.extent : null;
    const dial = kind === DIAL;
    /** Minimum scalar parameter. @type {number} */
    this.min = ext && _isNum(ext[0]) ? ext[0] : (dial ? -Infinity : -1);
    /** Maximum scalar parameter. @type {number} */
    this.max = ext && _isNum(ext[1]) ? ext[1] : (dial ?  Infinity :  1);

    // Sphere / dial radius (private backing — see radius getter/setter).
    this._radius = _num(opts.radius, 1);

    /**
     * Default report mode. SPHERE defaults to DIRECTION; PLANE / AXIS / DIAL
     * report a POINT.
     * @type {number}
     */
    this.report = (opts.report === POINT || opts.report === DIRECTION)
      ? opts.report
      : (kind === SPHERE ? DIRECTION : POINT);

    if (kind === DIAL) this._dialPoint();
  }

  /** Sphere / dial radius. @type {number} */
  get radius()  { return this._radius; }
  set radius(r) { this._radius = _isNum(r) ? r : this._radius; if (this.kind === DIAL) this._dialPoint(); }

  // Recompute the DIAL point from θ (anchor + ρ(cosθ·r0 + sinθ·r1)).
  _dialPoint() {
    const c = Math.cos(this.s) * this._radius, sn = Math.sin(this.s) * this._radius;
    this.pt[0] = this.anchor[0] + c*this.r0[0] + sn*this.r1[0];
    this.pt[1] = this.anchor[1] + c*this.r0[1] + sn*this.r1[1];
    this.pt[2] = this.anchor[2] + c*this.r0[2] + sn*this.r1[2];
  }

  // Build the DIAL in-plane basis (r0, r1) from the current axis u and an
  // optional θ=0 reference (zx,zy,zz): the reference is projected onto the
  // dial plane and normalised; absent (NaN) or degenerate, r0 derives from u
  // via the least-aligned-axis seed. r1 = u × r0, right-handed about u.
  _dialBasis(zx, zy, zz) {
    if (_isNum(zx) && _isNum(zy) && _isNum(zz)) {
      const d = zx*this.u[0] + zy*this.u[1] + zz*this.u[2];
      this.r0[0] = zx - d*this.u[0];
      this.r0[1] = zy - d*this.u[1];
      this.r0[2] = zz - d*this.u[2];
      const l = Math.sqrt(this.r0[0]**2 + this.r0[1]**2 + this.r0[2]**2);
      if (l < EPS) _basis(this.u, this.r0, this.r1);
      else { this.r0[0]/=l; this.r0[1]/=l; this.r0[2]/=l; }
    } else {
      _basis(this.u, this.r0, this.r1);
    }
    // r1 = u × r0 (recomputed even when _basis ran — same result, one rule).
    this.r1[0] = this.u[1]*this.r0[2] - this.u[2]*this.r0[1];
    this.r1[1] = this.u[2]*this.r0[0] - this.u[0]*this.r0[2];
    this.r1[2] = this.u[0]*this.r0[1] - this.u[1]*this.r0[0];
  }

  /**
   * Update the canonical state from a ray in the working space. The ray
   * direction is assumed unit. Chainable.
   *
   * @param {number} ox,oy,oz  Ray origin.
   * @param {number} dx,dy,dz  Ray direction (unit).
   * @returns {Constraint} this
   */
  solve(ox, oy, oz, dx, dy, dz) {
    if (this.kind === SPHERE) {
      // Hit the sphere into pt, then derive the unit heading from the anchor.
      raySphere(this.pt, ox,oy,oz, dx,dy,dz,
                this.anchor[0], this.anchor[1], this.anchor[2], this._radius);
      this.dir[0] = this.pt[0] - this.anchor[0];
      this.dir[1] = this.pt[1] - this.anchor[1];
      this.dir[2] = this.pt[2] - this.anchor[2];
      _unit(this.dir, this.dir[0], this.dir[1], this.dir[2]);
    } else if (this.kind === PLANE) {
      // Parallel ray returns Infinity and leaves pt unchanged (keep last).
      rayPlane(this.pt, ox,oy,oz, dx,dy,dz,
               this.anchor[0], this.anchor[1], this.anchor[2],
               this.n[0], this.n[1], this.n[2]);
    } else if (this.kind === AXIS) {
      let s = rayClosestPointOnAxis(this.pt, ox,oy,oz, dx,dy,dz,
                                    this.anchor[0], this.anchor[1], this.anchor[2],
                                    this.u[0], this.u[1], this.u[2]);
      s = _clamp(s, this.min, this.max);
      this.s = s;
      this.pt[0] = this.anchor[0] + s*this.u[0];   // clamped point
      this.pt[1] = this.anchor[1] + s*this.u[1];
      this.pt[2] = this.anchor[2] + s*this.u[2];
    } else if (this.kind === DIAL) {
      this._solveDial(ox, oy, oz, dx, dy, dz);
    }
    return this;
  }

  // DIAL solve. Face-on: hit the dial plane, derive the raw angle of the hit
  // about the anchor, and accumulate the smaller signed arc into θ (winding
  // preserved). Edge-on (|d·u| < DIAL_EDGE): the plane hit diverges, so solve
  // the ray against the TANGENT LINE of the circle at the current θ instead —
  // the signed tangent parameter over the radius is dθ, bounded and monotone.
  _solveDial(ox, oy, oz, dx, dy, dz) {
    const u = this.u, r0 = this.r0, r1 = this.r1, a = this.anchor;
    const den = dx*u[0] + dy*u[1] + dz*u[2];
    let dth;
    if (den >= DIAL_EDGE || den <= -DIAL_EDGE) {
      // Well-conditioned: plane hit → raw angle → smaller signed arc.
      const t = rayPlane(this.pt, ox,oy,oz, dx,dy,dz,
                         a[0], a[1], a[2], u[0], u[1], u[2]);
      if (t === Infinity) return;                  // keep last (paranoia; den guards)
      const vx = this.pt[0]-a[0], vy = this.pt[1]-a[1], vz = this.pt[2]-a[2];
      const raw = Math.atan2(vx*r1[0] + vy*r1[1] + vz*r1[2],
                             vx*r0[0] + vy*r0[1] + vz*r0[2]);
      dth = _wrapPi(raw - _wrapPi(this.s));
    } else {
      // Edge-on fallback: tangent at the current point, w = −sinθ·r0 + cosθ·r1.
      const cs = Math.cos(this.s), sn = Math.sin(this.s);
      const wx = -sn*r0[0] + cs*r1[0];
      const wy = -sn*r0[1] + cs*r1[1];
      const wz = -sn*r0[2] + cs*r1[2];
      this._dialPoint();                           // tangent anchored at the current point
      const sl = rayClosestPointOnAxis(this.pt, ox,oy,oz, dx,dy,dz,
                                       this.pt[0], this.pt[1], this.pt[2],
                                       wx, wy, wz);
      dth = sl / (this._radius || 1);
    }
    this.s = _clamp(this.s + dth, this.min, this.max);
    this._dialPoint();
  }

  /**
   * Write the current value into `out`. `report` overrides the default for
   * this call (e.g. read a SPHERE's point even when its default is DIRECTION).
   * SPHERE+POINT and DIAL+POINT are derived from the angle/heading and the
   * live radius, so they stay correct after a radius change without
   * re-solving. DIAL+DIRECTION writes the radial unit at θ.
   *
   * @param {number[]} out  3-element destination.
   * @param {number} [report]  POINT | DIRECTION override.
   * @returns {number[]} out
   */
  value(out, report) {
    const r = (report === POINT || report === DIRECTION) ? report : this.report;
    if (this.kind === SPHERE) {
      if (r === DIRECTION) {
        out[0]=this.dir[0]; out[1]=this.dir[1]; out[2]=this.dir[2];
      } else {
        out[0]=this.anchor[0]+this.dir[0]*this._radius;
        out[1]=this.anchor[1]+this.dir[1]*this._radius;
        out[2]=this.anchor[2]+this.dir[2]*this._radius;
      }
    } else if (this.kind === DIAL) {
      const cs = Math.cos(this.s), sn = Math.sin(this.s);
      if (r === DIRECTION) {
        out[0]=cs*this.r0[0]+sn*this.r1[0];
        out[1]=cs*this.r0[1]+sn*this.r1[1];
        out[2]=cs*this.r0[2]+sn*this.r1[2];
      } else {
        out[0]=this.anchor[0]+(cs*this.r0[0]+sn*this.r1[0])*this._radius;
        out[1]=this.anchor[1]+(cs*this.r0[1]+sn*this.r1[1])*this._radius;
        out[2]=this.anchor[2]+(cs*this.r0[2]+sn*this.r1[2])*this._radius;
      }
    } else {
      out[0]=this.pt[0]; out[1]=this.pt[1]; out[2]=this.pt[2];
    }
    return out;
  }

  /**
   * Current scalar parameter: AXIS → signed t along the line; DIAL →
   * accumulated angle θ in radians (multi-turn).
   * @returns {number} The parameter, or NaN for non-scalar constraints.
   */
  scalar() {
    return (this.kind === AXIS || this.kind === DIAL) ? this.s : NaN;
  }

  /**
   * Derive [az, el] from the current SPHERE direction (SPHERE only).
   * @param {number[]} out2  2-element destination [az, el].
   * @returns {number[]} out2
   */
  azEl(out2) {
    return azElFromDir(out2, this.dir[0], this.dir[1], this.dir[2]);
  }

  /**
   * Seed the canonical state from a value (used by the bridge on bind() so the
   * handle starts at the bound target's value). Chainable.
   *   SPHERE — sets the unit direction (a point value recovers its heading).
   *   PLANE  — projects the value onto the plane.
   *   AXIS   — projects the value onto the line, clamped to extent.
   *   DIAL   — projects the value onto the dial plane, derives the wrapped
   *            angle, and picks the WINDING NEAREST the current θ (so an
   *            external sync doesn't unwind accumulated turns), clamped.
   *
   * @param {number} x,y,z  Seed value.
   * @returns {Constraint} this
   */
  seed(x, y, z) {
    if (this.kind === SPHERE) {
      const vx=x-this.anchor[0], vy=y-this.anchor[1], vz=z-this.anchor[2];
      const l = Math.sqrt(vx*vx + vy*vy + vz*vz);
      if (l >= EPS) { this.dir[0]=vx/l; this.dir[1]=vy/l; this.dir[2]=vz/l; }
    } else if (this.kind === PLANE) {
      const wx=x-this.anchor[0], wy=y-this.anchor[1], wz=z-this.anchor[2];
      const d = wx*this.n[0] + wy*this.n[1] + wz*this.n[2];
      this.pt[0]=x-d*this.n[0]; this.pt[1]=y-d*this.n[1]; this.pt[2]=z-d*this.n[2];
    } else if (this.kind === AXIS) {
      const wx=x-this.anchor[0], wy=y-this.anchor[1], wz=z-this.anchor[2];
      const s = _clamp(wx*this.u[0] + wy*this.u[1] + wz*this.u[2], this.min, this.max);
      this.s = s;
      this.pt[0]=this.anchor[0]+s*this.u[0];
      this.pt[1]=this.anchor[1]+s*this.u[1];
      this.pt[2]=this.anchor[2]+s*this.u[2];
    } else if (this.kind === DIAL) {
      const wx=x-this.anchor[0], wy=y-this.anchor[1], wz=z-this.anchor[2];
      const px = wx*this.r0[0] + wy*this.r0[1] + wz*this.r0[2];
      const py = wx*this.r1[0] + wy*this.r1[1] + wz*this.r1[2];
      if (px*px + py*py >= EPS*EPS) {
        const a = Math.atan2(py, px);
        // Nearest winding to the current θ preserves accumulated turns.
        this.s = _clamp(a + TWO_PI * Math.round((this.s - a) / TWO_PI),
                        this.min, this.max);
      }
      this._dialPoint();
    }
    return this;
  }

  /**
   * Re-aim the constraint basis in the working space — the deferred-frame
   * seam (the p5.tree bridge's `from` opt resolves its symbolic basis through
   * mapDirection and calls this). Per kind:
   *   PLANE  — new normal; the point is re-projected onto the new plane.
   *   AXIS   — new direction; the scalar t is preserved, the point recomputed.
   *   DIAL   — new plane normal + optional θ=0 reference; θ is preserved, the
   *            in-plane basis rebuilt (reference re-derived when omitted),
   *            the point recomputed.
   *   SPHERE — no basis; no-op.
   * Inputs are normalised; a zero-length axis keeps the previous one.
   * Chainable.
   *
   * @param {number} ax,ay,az  New normal (PLANE) / direction (AXIS) / dial-plane normal (DIAL).
   * @param {number} [zx,zy,zz]  DIAL only — θ=0 reference (re-derived when omitted).
   * @returns {Constraint} this
   */
  aim(ax, ay, az, zx, zy, zz) {
    if (this.kind === PLANE) {
      const px = this.n[0], py = this.n[1], pz = this.n[2];
      this.n[0] = ax; this.n[1] = ay; this.n[2] = az;
      _unit(this.n, px, py, pz);
      this.seed(this.pt[0], this.pt[1], this.pt[2]);
    } else if (this.kind === AXIS) {
      const px = this.u[0], py = this.u[1], pz = this.u[2];
      this.u[0] = ax; this.u[1] = ay; this.u[2] = az;
      _unit(this.u, px, py, pz);
      this.pt[0] = this.anchor[0] + this.s*this.u[0];
      this.pt[1] = this.anchor[1] + this.s*this.u[1];
      this.pt[2] = this.anchor[2] + this.s*this.u[2];
    } else if (this.kind === DIAL) {
      const px = this.u[0], py = this.u[1], pz = this.u[2];
      this.u[0] = ax; this.u[1] = ay; this.u[2] = az;
      _unit(this.u, px, py, pz);
      this._dialBasis(zx, zy, zz);
      this._dialPoint();
    }
    return this;
  }
}

/**
 * Convenience factory mirroring the constructor. Handy for headless tests and
 * for the bridge, which otherwise calls `new Constraint(...)` directly.
 * @param {number} kind  SPHERE | PLANE | AXIS | DIAL.
 * @param {Object} [opts]
 * @returns {Constraint}
 */
export function createConstraint(kind, opts) {
  return new Constraint(kind, opts);
}
