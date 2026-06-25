/**
 * @file Source-agnostic 6-DOF pose helm — integrates a live rate stream into a
 *       { pos, rot } pose. Renderer- and transport-agnostic. Zero dependencies.
 * @module tree/helm
 * @license AGPL-3.0-only
 *
 * A helm is the rate-stream sibling of the Track family: where a Track produces
 * a pose from keyframes over time, a helm produces a pose from a live 6-DOF
 * delta stream (a SpaceNavigator, a tracked hand, an agent policy). It is NOT a
 * handle — a handle reports a `vec3` solved from a pointer ray; a helm reports a
 * pose (position + orientation).
 *
 * Family placement (peer of PoseTrack, NOT a Track subclass — no timeline):
 *   feed(translation, rotation)  push the latest raw device rate (input, as Track.add)
 *   step(out, dt, basis)         integrate the rate by dt into the pose (BRIDGE-DRIVEN,
 *                                as Track.tick) — writes the new pose into out
 *   eval(out)                    read the current { pos, rot } (zero-alloc, as Track.eval)
 *   home(pose?)                  re-home the integrated pose (NOT reset — no keyframes to clear)
 *
 * Value layer (opt-in, §10): a per-helm `fullScale` keeps the read-outs honest
 * across input scales; an opt-in `filter` (oneEuro) conditions the fed rates
 * before the deadzone inside step; `poseDelta` differences two absolute poses
 * into a feedable rate. With `filter` null and the default `fullScale`, the
 * clean rate-native path is unchanged.
 *
 * Quaternion algebra is provided by quat.js. Out-first throughout; no allocation
 * in feed/step/eval. Storage convention (matches the rest of the core): vec3 and
 * quat state are plain number[] (f64) — the same shape as track.js keyframes and
 * the frozen basis-vector constants.
 *
 * ── Frame discipline (`from` / `basis`) ──────────────────────────────────────
 * The space the rates are interpreted in is named by `from` (WORLD | EYE | mat4),
 * a declaration the BRIDGE reads — the core never learns about a camera. The
 * resolved orientation arrives per-step as `basis`: an eye→world mat4 (or null
 * for WORLD ≡ the identity basis). Both the linear and angular rates are rotated
 * through that basis, then the quaternion is composed world-frame. This is the
 * single code path that covers both manipulation conventions:
 *
 *   - camera body-fly  — basis is the driven camera's own eye matrix (which this
 *                        helm produced last frame ⇒ equals the integrated `q`,
 *                        zero staleness); rotating a body delta through `q` then
 *                        world-composing is algebraically a body-frame compose.
 *   - screen-relative  — basis is the *viewing* camera's eye matrix (an external
 *                        frame); a push moves the target relative to the screen.
 *
 * Per-channel `from` ({ translation, rotation }) is a deferred, non-breaking
 * extension (one basis suffices today — pose-helm-design.md §8.3).
 */

'use strict';

import { qFromAxisAngle, qMul, qNormalize } from './quat.js';

// =========================================================================
// Module-level scratch — shared across helm instances (non-reentrant; step
// is synchronous and called at most once per helm per frame).
// =========================================================================

const _dq = [0, 0, 0, 1];

// Scratch for the optional input filter (helm.filter). The fed rates are packed
// into one 6-vector, conditioned, and unpacked to lin/ang triples before the
// deadzone — so a single filter carries one state per helm. Shared across
// instances (step is synchronous, at most once per helm per frame).
const _f6raw = [0, 0, 0, 0, 0, 0];
const _f6out = [0, 0, 0, 0, 0, 0];
const _fLin  = [0, 0, 0];
const _fAng  = [0, 0, 0];

/**
 * Default full-deflection input magnitude — the fed rate a read-out shows as
 * full (the SpaceNavigator's saturated lane). Private to core: a transport on a
 * different raw scale sets helm.fullScale and never reads this, so there is no
 * public HELM_FULL export. Display-only; integration uses profile.sens directly.
 */
const HELM_FULL_SCALE = 500;

// Deadzone gate — |v| > dz keeps v, else 0. Module-level so step allocates no
// closure. Strictly-greater matches the e7 reference (rest reads exact 0).
const _dz = (v, dz) => (v > dz || v < -dz) ? v : 0;

/**
 * Build the canonical default profile. SpaceNavigator-tuned lane permutation
 * and the eye-frame manipulation feel found in the e7 experiments; it is the
 * per-app / per-device mapping layer and is meant to be overwritten wholesale
 * (`helm.profile = { … }`) for a different transport.
 *
 *   sign  — per-app direction (camera-fly vs object-grab invert; flip live).
 *   sens  — per-axis sensitivity (tame roll without touching the rest).
 *   lane  — input-channel permutation: which fed channel drives this DOF.
 *           T* lanes index the translation triple; R* lanes the rotation triple.
 */
function _defaultProfile() {
  return {
    Tx: { sign:  1, sens: 0.30,   lane: 0 },
    Ty: { sign:  1, sens: 0.30,   lane: 2 },
    Tz: { sign: -1, sens: 0.30,   lane: 1 },
    Rp: { sign: -1, sens: 0.0025, lane: 0 },
    Ry: { sign: -1, sens: 0.0025, lane: 2 },
    Rr: { sign:  1, sens: 0.0018, lane: 1 },
  };
}

/** Channel order — readout / iteration convenience (Tx Ty Tz Rp Ry Rr). */
export const HELM_CHANNELS = Object.freeze(['Tx', 'Ty', 'Tz', 'Rp', 'Ry', 'Rr']);

// =========================================================================
// PoseHelm
// =========================================================================

/**
 * Source-agnostic 6-DOF pose producer. Holds a profile + the integrated pose;
 * no timeline (no keyframes, no play/seek/loop).
 */
export class PoseHelm {
  constructor() {
    /**
     * DOF mapping table. Six channels, each `{ sign, sens, lane }`.
     * Public and mutable — set wholesale to re-map a device or app.
     * @type {{ Tx:Object, Ty:Object, Tz:Object, Rp:Object, Ry:Object, Rr:Object }}
     */
    this.profile = _defaultProfile();

    /**
     * Rest-drift floor. A fed rate with |value| ≤ deadzone reads as 0. Devices
     * that rest at exact 0 need only a small floor. @type {number}
     */
    this.deadzone = 8;

    /**
     * Full-deflection input magnitude for the read-outs (gizmo overlay + panel
     * meters): a fed rate of |fullScale| reads as a full bar / arrow. Set by a
     * transport whose saturated rate differs from the default (a gamepad stick
     * that saturates at 1 sets fullScale = 1). Display-only — integration uses
     * profile.sens directly, so this never affects flight. @type {number}
     */
    this.fullScale = HELM_FULL_SCALE;

    /**
     * Optional input conditioner applied to the fed rates BEFORE the deadzone,
     * inside step — a oneEuro filter, or any f(out, raw, dt) carrying function
     * with a reset(). null (the default) is the clean rate-native path: the
     * filter branch is skipped, so a clean device pays nothing. Set for noisy /
     * absolute sources; home() resets it. @type {?Function}
     */
    this.filter = null;

    /**
     * The space fed rates are interpreted in: a space constant (WORLD | EYE) or
     * a mat4 frame. Declarative only — the bridge reads this to resolve the
     * per-step `basis`; the core stays camera-agnostic. @type {string|ArrayLike<number>}
     */
    this.from = 'EYE';

    // Latest fed raw rates (refreshed by feed; persist until the next feed —
    // the transport is responsible for feeding 0 when motion should stop).
    this._lin = [0, 0, 0];
    this._ang = [0, 0, 0];

    // Integrated pose — the source of truth.
    this._pos = [0, 0, 0];
    this._q   = [0, 0, 0, 1];
  }

  /**
   * Push the latest raw 6-DOF device rate. Either argument may be omitted to
   * leave that half unchanged (devices report the two halves on separate
   * frames). The value persists until the next feed. Raw device units — the
   * profile's `sens` does the scaling, so the same feed() suits any transport.
   *
   * @param {ArrayLike<number>} [translation]  [tx, ty, tz] raw lane rates.
   * @param {ArrayLike<number>} [rotation]     [rx, ry, rz] raw lane rates.
   * @returns {PoseHelm} this
   */
  feed(translation, rotation) {
    if (translation) {
      this._lin[0] = translation[0] || 0;
      this._lin[1] = translation[1] || 0;
      this._lin[2] = translation[2] || 0;
    }
    if (rotation) {
      this._ang[0] = rotation[0] || 0;
      this._ang[1] = rotation[1] || 0;
      this._ang[2] = rotation[2] || 0;
    }
    return this;
  }

  /**
   * Integrate the latest fed rate by `dt` seconds into the pose, then write the
   * pose into `out`. Bridge-driven (the player calls it each frame; a sketch
   * never does, as it never calls track.tick()).
   *
   * `basis` is the resolved `from` frame: an eye→world column-major mat4
   * (16-element ArrayLike), or null/omitted for WORLD (the identity basis). Its
   * columns supply the right/up/back axes; forward is −col2. Both the linear and
   * angular rates are rotated through it, then `q` is composed world-frame.
   *
   * Zero-allocation. `out` is `{ pos:number[3], rot:number[4] }`; omit it for a
   * fresh object.
   *
   * @param {{ pos:number[], rot:number[] }} [out]
   * @param {number} dt       Elapsed time in seconds.
   * @param {ArrayLike<number>} [basis]  Eye→world mat4, or null for WORLD.
   * @returns {{ pos:number[], rot:number[] }} out
   */
  step(out, dt, basis) {
    const p = this.profile, dz = this.deadzone;
    let lin = this._lin, ang = this._ang;

    // Value layer — condition the fed rates BEFORE the deadzone (the filter
    // narrows the jitter band; the deadzone then gates the residual to exact
    // zero). The filter carries state, so it is ticked exactly once per step;
    // activity() reads the raw fed rate and is left unfiltered (the read-out
    // shows device input, normalized by fullScale). Skipped when filter is null.
    const filter = this.filter;
    if (filter) {
      _f6raw[0] = lin[0]; _f6raw[1] = lin[1]; _f6raw[2] = lin[2];
      _f6raw[3] = ang[0]; _f6raw[4] = ang[1]; _f6raw[5] = ang[2];
      filter(_f6out, _f6raw, dt);
      _fLin[0] = _f6out[0]; _fLin[1] = _f6out[1]; _fLin[2] = _f6out[2];
      _fAng[0] = _f6out[3]; _fAng[1] = _f6out[4]; _fAng[2] = _f6out[5];
      lin = _fLin; ang = _fAng;
    }

    // Basis axes (right / up / forward). No basis ⇒ the identity eye matrix:
    // right +X, up +Y, forward −Z. Forward is −col2 (an eye→world matrix stores
    // the camera's BACK in col2), and the identity's col2 is +Z, so forward is
    // −Z — making step(out, dt, null) identical to step(out, dt, IDENTITY_MAT4),
    // as the `from` contract ("null ≡ the identity basis") promises.
    let rX = 1, rY = 0, rZ =  0;
    let uX = 0, uY = 1, uZ =  0;
    let fX = 0, fY = 0, fZ = -1;
    if (basis) {
      rX =  basis[0]; rY =  basis[1]; rZ =  basis[2];
      uX =  basis[4]; uY =  basis[5]; uZ =  basis[6];
      fX = -basis[8]; fY = -basis[9]; fZ = -basis[10];
    }

    // Angular: three rates → one delta quat, rotated into world, world-composed.
    const wx = _dz(ang[p.Rp.lane], dz) * p.Rp.sign * p.Rp.sens;
    const wy = _dz(ang[p.Ry.lane], dz) * p.Ry.sign * p.Ry.sens;
    const wz = _dz(ang[p.Rr.lane], dz) * p.Rr.sign * p.Rr.sens;
    const w  = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (w > 0) {
      // Axis in world = basis · (wx,wy,wz); its length is w (basis orthonormal),
      // so the rotation angle is w·dt. qFromAxisAngle renormalizes the axis.
      const ax = wx * rX + wy * uX + wz * fX;
      const ay = wx * rY + wy * uY + wz * fY;
      const az = wx * rZ + wy * uZ + wz * fZ;
      qFromAxisAngle(_dq, ax, ay, az, w * dt);
      qMul(this._q, _dq, this._q);        // delta already in world → world-frame compose
      qNormalize(this._q);
    }

    // Linear: three rates rotated into world, integrated by dt.
    const tx = _dz(lin[p.Tx.lane], dz) * p.Tx.sign * p.Tx.sens;
    const ty = _dz(lin[p.Ty.lane], dz) * p.Ty.sign * p.Ty.sens;
    const tz = _dz(lin[p.Tz.lane], dz) * p.Tz.sign * p.Tz.sens;
    this._pos[0] += (tx * rX + ty * uX + tz * fX) * dt;
    this._pos[1] += (tx * rY + ty * uY + tz * fY) * dt;
    this._pos[2] += (tx * rZ + ty * uZ + tz * fZ) * dt;

    return this.eval(out);
  }

  /**
   * Read the current pose into `out` (zero-alloc). The shared output contract
   * that feeds applyPose — mirrors Track.eval.
   *
   * @param {{ pos:number[], rot:number[] }} [out]
   * @returns {{ pos:number[], rot:number[] }} out
   */
  eval(out) {
    out = out || { pos: [0, 0, 0], rot: [0, 0, 0, 1] };
    out.pos[0] = this._pos[0]; out.pos[1] = this._pos[1]; out.pos[2] = this._pos[2];
    out.rot[0] = this._q[0];   out.rot[1] = this._q[1];
    out.rot[2] = this._q[2];   out.rot[3] = this._q[3];
    return out;
  }

  /**
   * Write the six effective channel rates (post deadzone·sign·sens) into `out6`,
   * in channel order [Tx, Ty, Tz, Rp, Ry, Rr]. The gizmo reads this to light the
   * DOFs being driven; readouts can show signed magnitudes. Zero-alloc.
   *
   * @param {number[]} out6  6-element destination.
   * @returns {number[]} out6
   */
  activity(out6) {
    const p = this.profile, dz = this.deadzone, lin = this._lin, ang = this._ang;
    out6[0] = _dz(lin[p.Tx.lane], dz) * p.Tx.sign * p.Tx.sens;
    out6[1] = _dz(lin[p.Ty.lane], dz) * p.Ty.sign * p.Ty.sens;
    out6[2] = _dz(lin[p.Tz.lane], dz) * p.Tz.sign * p.Tz.sens;
    out6[3] = _dz(ang[p.Rp.lane], dz) * p.Rp.sign * p.Rp.sens;
    out6[4] = _dz(ang[p.Ry.lane], dz) * p.Ry.sign * p.Ry.sens;
    out6[5] = _dz(ang[p.Rr.lane], dz) * p.Rr.sign * p.Rr.sens;
    return out6;
  }

  /**
   * Re-home the integrated pose. Sets position + orientation to `pose` (or the
   * identity pose when omitted) and clears any pending rate so the helm rests at
   * a clean, known state. NOT a reset — there are no keyframes to clear.
   *
   * @param {{ pos?:ArrayLike<number>, rot?:ArrayLike<number> }} [pose]
   * @returns {PoseHelm} this
   */
  home(pose) {
    if (pose && pose.pos) {
      this._pos[0] = pose.pos[0]; this._pos[1] = pose.pos[1]; this._pos[2] = pose.pos[2];
    } else {
      this._pos[0] = 0; this._pos[1] = 0; this._pos[2] = 0;
    }
    if (pose && pose.rot) {
      this._q[0] = pose.rot[0]; this._q[1] = pose.rot[1];
      this._q[2] = pose.rot[2]; this._q[3] = pose.rot[3];
    } else {
      this._q[0] = 0; this._q[1] = 0; this._q[2] = 0; this._q[3] = 1;
    }
    this._lin[0] = this._lin[1] = this._lin[2] = 0;
    this._ang[0] = this._ang[1] = this._ang[2] = 0;
    if (this.filter) this.filter.reset();   // drop filter state at the discontinuity
    return this;
  }
}

// =========================================================================
// poseDelta — absolute pose → 6-DOF rate
// =========================================================================

/**
 * Difference two consecutive absolute poses into a 6-DOF rate the helm can be
 * fed — the bridge for absolute-pose transports (gesture / landmark / marker /
 * IMU) into feed(lin, ang). Out-first, zero-allocation.
 *
 * Linear rate is (cur.pos − prev.pos) / dt. Angular rate is the world-frame
 * angular velocity ω carrying prev.rot onto cur.rot over dt: the relative
 * rotation r = cur · conj(prev) (so cur = r · prev, the world-frame compose the
 * step integrates), read as axis · angle / dt.
 *
 * The double-cover guard is the whole reason to ship this rather than inline it:
 * a quaternion and its negation are the same orientation, so when
 * dot(prev.rot, cur.rot) < 0 the two samples sit on opposite hemispheres and a
 * naive difference takes the long way round — the angular rate spikes at the
 * crossing. Flipping cur into prev's hemisphere first keeps r the shortest arc.
 *
 * Fed through a helm with an identity profile in WORLD, the integrated pose
 * retraces the source (the round-trip e9 asserts). A 1:1, non-integrated
 * consumer skips the helm and applyPoses the absolute pose directly.
 *
 * @param {{ lin:number[], ang:number[] }} [out]  Destination; omit for a fresh one.
 * @param {{ pos:ArrayLike<number>, rot:ArrayLike<number> }} prev  Previous pose.
 * @param {{ pos:ArrayLike<number>, rot:ArrayLike<number> }} cur   Current pose.
 * @param {number} dt  Elapsed seconds between the two samples.
 * @returns {{ lin:number[], ang:number[] }} out
 */
export function poseDelta(out, prev, cur, dt) {
  out = out || { lin: [0, 0, 0], ang: [0, 0, 0] };
  const inv = 1 / dt;

  out.lin[0] = (cur.pos[0] - prev.pos[0]) * inv;
  out.lin[1] = (cur.pos[1] - prev.pos[1]) * inv;
  out.lin[2] = (cur.pos[2] - prev.pos[2]) * inv;

  const px = prev.rot[0], py = prev.rot[1], pz = prev.rot[2], pw = prev.rot[3];
  let   cx = cur.rot[0],  cy = cur.rot[1],  cz = cur.rot[2],  cw = cur.rot[3];

  // Double-cover guard: bring cur into prev's hemisphere so r is the short arc.
  if (px * cx + py * cy + pz * cz + pw * cw < 0) { cx = -cx; cy = -cy; cz = -cz; cw = -cw; }

  // Relative rotation r = cur · conj(prev), conj(prev) = (−px, −py, −pz, pw).
  const rx = -cw * px + cx * pw - cy * pz + cz * py;
  const ry = -cw * py + cx * pz + cy * pw - cz * px;
  const rz = -cw * pz - cx * py + cy * px + cz * pw;
  const rw =  cw * pw + cx * px + cy * py + cz * pz;   // = dot(prev, cur) ≥ 0 → angle ≤ π

  // Axis · angle of r → ω = axis · angle / dt. Below the threshold the rotation
  // is negligible (no well-defined axis) and the angular rate is exact zero.
  const sinHalf = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (sinHalf < 1e-8) {
    out.ang[0] = 0; out.ang[1] = 0; out.ang[2] = 0;
  } else {
    const k = (2 * Math.atan2(sinHalf, rw)) * inv / sinHalf;
    out.ang[0] = rx * k; out.ang[1] = ry * k; out.ang[2] = rz * k;
  }
  return out;
}
