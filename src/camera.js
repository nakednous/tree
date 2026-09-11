/**
 * @file Camera state ↔ matrices: builders, decomposers, and in-place edits.
 * @module tree/camera
 * @license AGPL-3.0-only
 *
 * The camera is plain data — the CameraTrack keyframe shape:
 *
 *   cam = {
 *     eye:        [x, y, z],       // position
 *     center:     [x, y, z],       // lookat target; |center − eye| is the gaze distance
 *     up:         [x, y, z],       // up hint, need not be unit
 *     fov:        number | null,   // vertical field of view, radians — perspective
 *     halfHeight: number | null,   // world-unit half-height at the near plane — orthographic
 *     near:       number,          // > 0
 *     far:        number,          // > near
 *   }
 *
 * Exactly one of fov / halfHeight is meaningful; fov wins when both are set.
 * With both null the lens is "unchanged": cameraProj and cameraPlanes return
 * null and leave their output untouched, so a track that evaluates null into
 * the state keeps the last projection installed. A track writes the state
 * directly — `track.eval(cam)` — and a pose drives it through cameraFromPose.
 *
 * The state carries no aspect ratio — the viewport owns it — so one state is
 * portable between targets of different sizes; every builder that needs it
 * takes it as an argument.
 *
 * Vectors are plain number[] (f64, authoring state); matrices are written into
 * whatever 16-element buffer the caller passes. createCamera is the one
 * allocating call; everything else is out-first (or in-place) and zero-alloc.
 *
 * Every function that needs the camera frame derives it through mat4Eye, so
 * planes and edits agree with cameraEye / cameraView exactly — including the
 * up re-seed when the view direction is parallel to the up hint.
 */

'use strict';

import { mat4View, mat4Eye, mat4Persp, mat4Ortho } from './form.js';
import { projIsOrtho, projNear, projFar, projTop, projFov } from './query.js';
import { qFromLookDir } from './quat.js';
import { frustumPlanes } from './visibility.js';

const _E = new Float64Array(16);   // eye→world frame scratch: right 0–2, up 4–6, back 8–10
const _d = [0, 0, 0];              // view-direction scratch

/** Eye→world frame of `cam` into `_E`. */
function _frame(cam) {
  const e = cam.eye, c = cam.center, u = cam.up;
  mat4Eye(_E, e[0],e[1],e[2], c[0],c[1],c[2], u[0],u[1],u[2]);
}

/** Gaze distance |center − eye|, or 1 when the state is degenerate. */
function _gaze(cam) {
  const dx = cam.center[0]-cam.eye[0], dy = cam.center[1]-cam.eye[1], dz = cam.center[2]-cam.eye[2];
  const d = Math.sqrt(dx*dx+dy*dy+dz*dz);
  return d > 0 ? d : 1;
}

function _vec3(v, x, y, z) { return v != null ? [v[0], v[1], v[2]] : [x, y, z]; }

// =========================================================================
// State
// =========================================================================

/**
 * Allocate a camera state — the one allocating call, setup-time.
 * Defaults: eye [0, 0, 500], center [0, 0, 0], up [0, 1, 0], fov π/3,
 * halfHeight null, near 0.1, far 1000. Passing halfHeight without fov yields
 * an orthographic state (fov null).
 *
 * @param {{ eye?:number[], center?:number[], up?:number[], fov?:number|null,
 *           halfHeight?:number|null, near?:number, far?:number }} [opts]
 * @returns {{ eye:number[], center:number[], up:number[], fov:number|null,
 *             halfHeight:number|null, near:number, far:number }}
 */
export function createCamera(opts) {
  const o = opts || {};
  const ortho = o.halfHeight != null && o.fov === undefined;
  return {
    eye:        _vec3(o.eye,    0, 0, 500),
    center:     _vec3(o.center, 0, 0, 0),
    up:         _vec3(o.up,     0, 1, 0),
    fov:        o.fov        !== undefined ? o.fov        : (ortho ? null : Math.PI / 3),
    halfHeight: o.halfHeight !== undefined ? o.halfHeight : null,
    near:       typeof o.near === 'number' ? o.near : 0.1,
    far:        typeof o.far  === 'number' ? o.far  : 1000,
  };
}

/**
 * Copy one camera state into another (an orbit's home, a track's capture).
 * @param {object} out  Destination state.
 * @param {object} cam  Source state.
 * @returns {object} out
 */
export function cameraCopy(out, cam) {
  out.eye[0]=cam.eye[0];       out.eye[1]=cam.eye[1];       out.eye[2]=cam.eye[2];
  out.center[0]=cam.center[0]; out.center[1]=cam.center[1]; out.center[2]=cam.center[2];
  out.up[0]=cam.up[0];         out.up[1]=cam.up[1];         out.up[2]=cam.up[2];
  out.fov = cam.fov; out.halfHeight = cam.halfHeight;
  out.near = cam.near; out.far = cam.far;
  return out;
}

// =========================================================================
// Builders — state → matrices
// =========================================================================

/**
 * View matrix (world→eye) from the state's lookat.
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {object} cam
 * @returns {Float32Array|number[]} out
 */
export function cameraView(out, cam) {
  const e = cam.eye, c = cam.center, u = cam.up;
  return mat4View(out, e[0],e[1],e[2], c[0],c[1],c[2], u[0],u[1],u[2]);
}

/**
 * Eye matrix (eye→world) from the state's lookat.
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {object} cam
 * @returns {Float32Array|number[]} out
 */
export function cameraEye(out, cam) {
  const e = cam.eye, c = cam.center, u = cam.up;
  return mat4Eye(out, e[0],e[1],e[2], c[0],c[1],c[2], u[0],u[1],u[2]);
}

/**
 * Projection matrix from the state's lens: mat4Persp from fov, or mat4Ortho
 * from halfHeight, with symmetric extents (top = near · tan(fov / 2) or
 * halfHeight; right = top · aspect).
 *
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {object} cam
 * @param {number} aspect        Viewport width / height.
 * @param {number} ndcZMin       WEBGL (−1) or WEBGPU (0).
 * @param {number} [ndcYSign=1]  +1 NDC y-up; −1 NDC y-down.
 * @returns {Float32Array|number[]|null} out, or null (out untouched) when
 *          both fov and halfHeight are null.
 */
export function cameraProj(out, cam, aspect, ndcZMin, ndcYSign = 1) {
  const near = cam.near, far = cam.far;
  if (cam.fov != null) {
    const top = near * Math.tan(cam.fov / 2), right = top * aspect;
    return mat4Persp(out, -right, right, -top, top, near, far, ndcZMin, ndcYSign);
  }
  if (cam.halfHeight != null) {
    const top = cam.halfHeight, right = top * aspect;
    return mat4Ortho(out, -right, right, -top, top, near, far, ndcZMin, ndcYSign);
  }
  return null;
}

/**
 * The six frustum planes of the state, world space — frustumPlanes over the
 * lookat basis and the symmetric extents cameraProj uses, so visibility tests
 * run against a camera state without any matrix.
 *
 * @param {Float64Array} planes  24-element destination.
 * @param {object} cam
 * @param {number} aspect        Viewport width / height.
 * @returns {Float64Array|null} planes, or null (planes untouched) when both
 *          fov and halfHeight are null.
 */
export function cameraPlanes(planes, cam, aspect) {
  const ortho = cam.fov == null;
  if (ortho && cam.halfHeight == null) return null;
  const top = ortho ? cam.halfHeight : cam.near * Math.tan(cam.fov / 2), right = top * aspect;
  _frame(cam);
  const e = cam.eye;
  return frustumPlanes(planes,
    e[0], e[1], e[2],
    -_E[8], -_E[9], -_E[10],
    _E[4], _E[5], _E[6],
    _E[0], _E[1], _E[2],
    ortho, cam.near, cam.far, -right, right, top, -top);
}

// =========================================================================
// Decomposers — matrices and poses → state
// =========================================================================

/**
 * Read a state back from an eye matrix and a projection: eye ← column 3,
 * up ← column 1, forward ← −column 2 of E; center ← eye + forward · d with d
 * the state's current gaze distance (1 when degenerate), so the distance
 * survives a round trip. The lens comes from the projection queries: fov or
 * halfHeight by projIsOrtho, near and far under `ndcZMin`.
 *
 * @param {object} cam                 State written in place.
 * @param {ArrayLike<number>} E        Eye matrix (eye→world), 16 elements.
 * @param {ArrayLike<number>} P        Projection matrix, 16 elements.
 * @param {number} ndcZMin             WEBGL (−1) or WEBGPU (0).
 * @returns {object} cam
 */
export function cameraFromMat4(cam, E, P, ndcZMin) {
  const d = _gaze(cam);
  let fx = -E[8], fy = -E[9], fz = -E[10];
  const fl = Math.sqrt(fx*fx+fy*fy+fz*fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;
  cam.eye[0]=E[12]; cam.eye[1]=E[13]; cam.eye[2]=E[14];
  cam.up[0]=E[4];   cam.up[1]=E[5];   cam.up[2]=E[6];
  cam.center[0]=cam.eye[0]+fx*d; cam.center[1]=cam.eye[1]+fy*d; cam.center[2]=cam.eye[2]+fz*d;
  if (projIsOrtho(P)) { cam.fov = null;       cam.halfHeight = projTop(P, ndcZMin); }
  else                { cam.fov = projFov(P); cam.halfHeight = null; }
  cam.near = projNear(P, ndcZMin);
  cam.far  = projFar(P);
  return cam;
}

/**
 * Drive the lookat from a TRS pose: eye ← pos, up and forward from the
 * rotation's columns 1 and −2, center ← eye + forward · d with d the current
 * gaze distance (1 when degenerate). The lens is untouched; `scl` is ignored.
 *
 * @param {object} cam                            State written in place.
 * @param {{ pos:number[], rot:number[] }} pose   rot is a unit quaternion [x,y,z,w].
 * @returns {object} cam
 */
export function cameraFromPose(cam, pose) {
  const d = _gaze(cam);
  const q = pose.rot, x=q[0], y=q[1], z=q[2], w=q[3];
  const x2=x+x, y2=y+y, z2=z+z;
  const xx=x*x2, xy=x*y2, xz=x*z2, yy=y*y2, yz=y*z2, zz=z*z2, wx=w*x2, wy=w*y2, wz=w*z2;
  const ux=xy-wz, uy=1-(xx+zz), uz=yz+wx;        // column 1 of qToMat4(rot): up
  const bx=xz+wy, by=yz-wx, bz=1-(xx+yy);        // column 2: back
  cam.eye[0]=pose.pos[0]; cam.eye[1]=pose.pos[1]; cam.eye[2]=pose.pos[2];
  cam.up[0]=ux; cam.up[1]=uy; cam.up[2]=uz;
  cam.center[0]=cam.eye[0]-bx*d; cam.center[1]=cam.eye[1]-by*d; cam.center[2]=cam.eye[2]-bz*d;
  return cam;
}

/**
 * The lookat as a TRS pose: pos ← eye, rot ← qFromLookDir(center − eye, up) —
 * the rotation of cameraEye, so a helm seeded from it continues the frame.
 *
 * @param {{ pos:number[], rot:number[] }} pose  Written in place.
 * @param {object} cam
 * @returns {{ pos:number[], rot:number[] }} pose
 */
export function cameraToPose(pose, cam) {
  pose.pos[0]=cam.eye[0]; pose.pos[1]=cam.eye[1]; pose.pos[2]=cam.eye[2];
  _d[0]=cam.center[0]-cam.eye[0]; _d[1]=cam.center[1]-cam.eye[1]; _d[2]=cam.center[2]-cam.eye[2];
  qFromLookDir(pose.rot, _d, cam.up);
  return pose;
}

// =========================================================================
// Edits — in place, chainable, zero-alloc
// =========================================================================

/**
 * Orbit the eye about the center: `dAz` rotates it about the up hint
 * (right-handed); `dEl` raises its elevation above the plane through the
 * center perpendicular to the hint, clamped to ±opts.maxEl so the view
 * direction never reaches the hint (the pole guard). `up` is left as the hint
 * it was, so an orbit never rolls. A state already at the pole is pulled
 * inside the guard by its first non-zero edit; (0, 0) is a no-op.
 *
 * @param {object} cam
 * @param {number} dAz  Azimuth delta, radians.
 * @param {number} dEl  Elevation delta, radians.
 * @param {{ maxEl?:number }} [opts]  Elevation limit; default π/2 − 1e-3.
 * @returns {object} cam
 */
export function cameraOrbit(cam, dAz, dEl, opts) {
  if (dAz === 0 && dEl === 0) return cam;
  const maxEl = opts && typeof opts.maxEl === 'number' ? opts.maxEl : Math.PI / 2 - 1e-3;
  const e = cam.eye, c = cam.center;
  let ux=cam.up[0], uy=cam.up[1], uz=cam.up[2];
  const ul = Math.sqrt(ux*ux+uy*uy+uz*uz) || 1;
  ux/=ul; uy/=ul; uz/=ul;
  const dx=e[0]-c[0], dy=e[1]-c[1], dz=e[2]-c[2];
  const r = Math.sqrt(dx*dx+dy*dy+dz*dz);
  _frame(cam);
  const px=_E[4], py=_E[5], pz=_E[6];            // the eye's up
  const bx=_E[8], by=_E[9], bz=_E[10];           // back: center → eye, unit
  // elevation: raise by θ within the (back, up) plane, clamped
  const el  = Math.asin(Math.max(-1, Math.min(1, bx*ux+by*uy+bz*uz)));
  const th  = Math.max(-maxEl, Math.min(maxEl, el + dEl)) - el;
  const ct = Math.cos(th), st = Math.sin(th);
  const ox = r*(bx*ct+px*st), oy = r*(by*ct+py*st), oz = r*(bz*ct+pz*st);
  // azimuth: rotate about the hint (Rodrigues)
  const ca = Math.cos(dAz), sa = Math.sin(dAz), k = (ux*ox+uy*oy+uz*oz)*(1-ca);
  e[0] = c[0] + ox*ca + (uy*oz-uz*oy)*sa + ux*k;
  e[1] = c[1] + oy*ca + (uz*ox-ux*oz)*sa + uy*k;
  e[2] = c[2] + oz*ca + (ux*oy-uy*ox)*sa + uz*k;
  return cam;
}

/**
 * Dolly: scale the gaze distance by `factor` — the eye moves along the view
 * direction under perspective; under orthographic (fov null, halfHeight set)
 * halfHeight is scaled instead, since moving the eye changes nothing on
 * screen. opts.min / opts.max clamp the scaled quantity. An edit that would
 * make it non-positive is a no-op.
 *
 * @param {object} cam
 * @param {number} factor
 * @param {{ min?:number, max?:number }} [opts]
 * @returns {object} cam
 */
export function cameraDolly(cam, factor, opts) {
  const min = opts && typeof opts.min === 'number' ? opts.min : 0;
  const max = opts && typeof opts.max === 'number' ? opts.max : Infinity;
  if (cam.fov == null && cam.halfHeight != null) {
    const h = Math.max(min, Math.min(max, cam.halfHeight * factor));
    if (h > 0) cam.halfHeight = h;
    return cam;
  }
  const e = cam.eye, c = cam.center;
  const dx=e[0]-c[0], dy=e[1]-c[1], dz=e[2]-c[2];
  const r = Math.sqrt(dx*dx+dy*dy+dz*dz);
  if (r === 0) return cam;
  const r1 = Math.max(min, Math.min(max, r * factor));
  if (!(r1 > 0)) return cam;
  const s = r1 / r;
  e[0]=c[0]+dx*s; e[1]=c[1]+dy*s; e[2]=c[2]+dz*s;
  return cam;
}

/**
 * Pan: translate eye and center by `dx` along the eye's right and `dy` along
 * its up, world units. The caller converts pixels through pixelRatio at the
 * center's depth so a pan tracks the pointer.
 *
 * @param {object} cam
 * @param {number} dx
 * @param {number} dy
 * @returns {object} cam
 */
export function cameraPan(cam, dx, dy) {
  _frame(cam);
  const tx=_E[0]*dx+_E[4]*dy, ty=_E[1]*dx+_E[5]*dy, tz=_E[2]*dx+_E[6]*dy;
  const e = cam.eye, c = cam.center;
  e[0]+=tx; e[1]+=ty; e[2]+=tz;
  c[0]+=tx; c[1]+=ty; c[2]+=tz;
  return cam;
}
