/**
 * @file Skin — sampled clips, blended poses, world matrices and the joint palette of a skeleton.
 * @module tree/skin
 * @license AGPL-3.0-only
 *
 * A pose is one flat buffer, ten numbers per node: translation (3), rotation
 * (4, [x,y,z,w]) and scale (3), local to the node's parent. A hierarchy is a
 * `parents` array, −1 for a root, every parent indexed before its children.
 *
 * A clip is `{ duration, channels }`, a channel `{ node, path, times, values,
 * interp }`: `path` one of 'translation' | 'rotation' | 'scale', `times` the
 * ascending key times in seconds, `values` the keys flat, `interp` one of
 * 'STEP' | 'LINEAR' | 'CUBICSPLINE' — glTF 2.0's animation model (Khronos),
 * its cubic spline keys stored as in-tangent, value, out-tangent. Rotations
 * interpolate spherically under LINEAR and are normalised under CUBICSPLINE.
 *
 * The frame: clipSample (twice and poseBlend, across a cross-fade) →
 * poseWorld → jointPalette, the matrices of linear blend skinning,
 * Σ wᵢ · world(jointᵢ) · inverseBindᵢ. Matrices are column-major. The clip
 * time is the caller's.
 */

'use strict';

/** Numbers per node in a pose buffer. */
export const POSE_STRIDE = 10;

const _local = new Float64Array(16);

// Column-major TRS of node i of a pose, into m at offset o.
function _trsAt(m, o, pose, i) {
  const p = i * POSE_STRIDE;
  const x=pose[p+3], y=pose[p+4], z=pose[p+5], w=pose[p+6];
  const sx=pose[p+7], sy=pose[p+8], sz=pose[p+9];
  const xx=x*x, yy=y*y, zz=z*z, xy=x*y, xz=x*z, yz=y*z, wx=w*x, wy=w*y, wz=w*z;
  m[o   ]=(1-2*(yy+zz))*sx; m[o+1 ]=(2*(xy+wz))*sx;   m[o+2 ]=(2*(xz-wy))*sx;   m[o+3 ]=0;
  m[o+4 ]=(2*(xy-wz))*sy;   m[o+5 ]=(1-2*(xx+zz))*sy; m[o+6 ]=(2*(yz+wx))*sy;   m[o+7 ]=0;
  m[o+8 ]=(2*(xz+wy))*sz;   m[o+9 ]=(2*(yz-wx))*sz;   m[o+10]=(1-2*(xx+yy))*sz; m[o+11]=0;
  m[o+12]=pose[p]; m[o+13]=pose[p+1]; m[o+14]=pose[p+2]; m[o+15]=1;
}

// out[oo…] = A[ao…] · B[bo…], affine (bottom row 0 0 0 1); out may be A or B.
function _mulAt(out, oo, A, ao, B, bo) {
  const a0=A[ao],a1=A[ao+1],a2=A[ao+2], a4=A[ao+4],a5=A[ao+5],a6=A[ao+6],
        a8=A[ao+8],a9=A[ao+9],a10=A[ao+10], a12=A[ao+12],a13=A[ao+13],a14=A[ao+14];
  for (let c = 0; c < 4; c++) {
    const b0=B[bo+4*c], b1=B[bo+4*c+1], b2=B[bo+4*c+2], t = c === 3 ? 1 : 0;
    out[oo+4*c  ]=a0*b0+a4*b1+a8*b2+a12*t;
    out[oo+4*c+1]=a1*b0+a5*b1+a9*b2+a13*t;
    out[oo+4*c+2]=a2*b0+a6*b1+a10*b2+a14*t;
    out[oo+4*c+3]=t;
  }
}

function _normalizeAt(out, o) {
  const l = Math.hypot(out[o], out[o+1], out[o+2], out[o+3]) || 1;
  out[o]/=l; out[o+1]/=l; out[o+2]/=l; out[o+3]/=l;
}

// The key at or before t: −1 before the first, n − 1 at or after the last.
function _key(times, t) {
  let lo = 0, hi = times.length - 1;
  if (t < times[0]) return -1;
  if (t >= times[hi]) return hi;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
  return lo;
}

/**
 * Sample a clip at time `t` into a pose. Only the nodes and paths the clip
 * animates are written; `opts.rest` seeds the others.
 * @param {number[]} out  Pose buffer, POSE_STRIDE per node.
 * @param {{duration:number, channels:object[]}} clip
 * @param {number} t  Seconds.
 * @param {{ loop?:boolean, rest?:number[] }} [opts]  loop (default true): wrap `t`
 *        over the duration, else clamp to it. rest: a pose copied into `out` first.
 * @returns {number[]} out
 */
export function clipSample(out, clip, t, opts) {
  const o = opts || {}, rest = o.rest, d = clip.duration;
  if (rest && rest !== out) for (let i = 0; i < rest.length; i++) out[i] = rest[i];
  if (!(d > 0)) t = 0;
  else if (o.loop === false) t = t < 0 ? 0 : t > d ? d : t;
  else { t %= d; if (t < 0) t += d; }
  const channels = clip.channels;
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c], path = ch.path;
    const rot = path === 'rotation';
    if (!rot && path !== 'translation' && path !== 'scale') continue;
    const n = rot ? 4 : 3, p = ch.node * POSE_STRIDE + (rot ? 3 : path === 'scale' ? 7 : 0);
    const times = ch.times, v = ch.values, last = times.length - 1;
    if (last < 0) continue;
    const cubic = ch.interp === 'CUBICSPLINE', w = cubic ? 3 * n : n, mid = cubic ? n : 0;
    const k = _key(times, t);
    if (k < 0 || k === last || ch.interp === 'STEP') {
      const a = (k < 0 ? 0 : k) * w + mid;
      for (let i = 0; i < n; i++) out[p+i] = v[a+i];
      continue;
    }
    const dt = times[k+1] - times[k], u = dt > 0 ? (t - times[k]) / dt : 0;
    if (cubic) {
      const u2 = u*u, u3 = u2*u;
      const h00 = 2*u3-3*u2+1, h10 = (u3-2*u2+u)*dt, h01 = -2*u3+3*u2, h11 = (u3-u2)*dt;
      const a = k * w, b = (k+1) * w;
      for (let i = 0; i < n; i++) out[p+i] = h00*v[a+n+i] + h10*v[a+2*n+i] + h01*v[b+n+i] + h11*v[b+i];
      if (rot) _normalizeAt(out, p);
    } else if (rot) {
      const a = k * 4, b = a + 4;
      let dot = v[a]*v[b]+v[a+1]*v[b+1]+v[a+2]*v[b+2]+v[a+3]*v[b+3];
      const sign = dot < 0 ? -1 : 1;
      dot *= sign;
      let f0 = 1 - u, f1 = u;
      if (1 - dot > 1e-10) {
        const th = Math.acos(dot), st = Math.sin(th);
        f0 = Math.sin((1-u)*th)/st; f1 = Math.sin(u*th)/st;
      }
      f1 *= sign;
      for (let i = 0; i < 4; i++) out[p+i] = v[a+i]*f0 + v[b+i]*f1;
      _normalizeAt(out, p);
    } else {
      const a = k * 3, b = a + 3;
      for (let i = 0; i < 3; i++) out[p+i] = v[a+i] + u * (v[b+i] - v[a+i]);
    }
  }
  return out;
}

/**
 * Blend two poses node by node: translation and scale linearly, rotation by
 * normalised linear interpolation along the shorter arc. `out` may be `a` or `b`.
 * @param {number[]} out  Pose buffer.
 * @param {number[]} a  Pose at w = 0.
 * @param {number[]} b  Pose at w = 1.
 * @param {number} w  Blend weight.
 * @returns {number[]} out
 */
export function poseBlend(out, a, b, w) {
  for (let p = 0; p + POSE_STRIDE <= a.length; p += POSE_STRIDE) {
    const q = p + 3;
    const s = a[q]*b[q]+a[q+1]*b[q+1]+a[q+2]*b[q+2]+a[q+3]*b[q+3] < 0 ? -1 : 1;
    for (let i = 0; i < 3; i++) out[p+i] = a[p+i] + w * (b[p+i] - a[p+i]);
    for (let i = 3; i < 7; i++) out[p+i] = a[p+i] + w * (s*b[p+i] - a[p+i]);
    for (let i = 7; i < 10; i++) out[p+i] = a[p+i] + w * (b[p+i] - a[p+i]);
    _normalizeAt(out, q);
  }
  return out;
}

/**
 * The world matrix of every node of a pose: world(i) = world(parent(i)) · local(i).
 * @param {number[]} out  16 per node, column-major.
 * @param {number[]} pose  Pose buffer.
 * @param {number[]} parents  Parent index per node, −1 for a root, parents first.
 * @returns {number[]} out
 */
export function poseWorld(out, pose, parents) {
  for (let i = 0; i < parents.length; i++) {
    const parent = parents[i];
    if (parent < 0) { _trsAt(out, i * 16, pose, i); continue; }
    _trsAt(_local, 0, pose, i);
    _mulAt(out, i * 16, out, parent * 16, _local, 0);
  }
  return out;
}

/**
 * The joint palette of a skin: palette(j) = world(joints[j]) · inverseBind(j).
 * @param {number[]} out  16 per joint, column-major.
 * @param {number[]} world  World matrices, 16 per node (poseWorld's).
 * @param {number[]} joints  Node index per joint.
 * @param {number[]} inverseBind  Inverse bind matrices, 16 per joint.
 * @returns {number[]} out
 */
export function jointPalette(out, world, joints, inverseBind) {
  for (let j = 0; j < joints.length; j++) _mulAt(out, j * 16, world, joints[j] * 16, inverseBind, j * 16);
  return out;
}
