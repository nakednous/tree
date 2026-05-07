/**
 * @file Quaternion algebra and mat4/mat3 conversions.
 * @module tree/quat
 * @license AGPL-3.0-only
 *
 * Quaternions are stored as flat [x, y, z, w] arrays (w-last, glTF layout).
 *
 * All functions follow the out-first, zero-allocation contract.
 * Conversion functions bridge between quaternion and matrix representations
 * but do not perform any higher-level graphics operations — those belong
 * in form.js (matrix construction from specs) or track.js (animation).
 */

'use strict';

// =========================================================================
// Basic ops
// =========================================================================

/** Set all four components. @returns {number[]} out */
export const qSet = (out, x, y, z, w) => {
  out[0] = x; out[1] = y; out[2] = z; out[3] = w; return out;
};

/** Copy quaternion a into out. @returns {number[]} out */
export const qCopy = (out, a) => {
  out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3]; return out;
};

/** Dot product of two quaternions. */
export const qDot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3];

/** Normalise quaternion in-place. @returns {number[]} out */
export const qNormalize = (out) => {
  const l = Math.sqrt(out[0]*out[0]+out[1]*out[1]+out[2]*out[2]+out[3]*out[3]) || 1;
  out[0]/=l; out[1]/=l; out[2]/=l; out[3]/=l; return out;
};

/** Negate quaternion (same rotation, different hemisphere). @returns {number[]} out */
export const qNegate = (out, a) => {
  out[0]=-a[0]; out[1]=-a[1]; out[2]=-a[2]; out[3]=-a[3]; return out;
};

/** Hamilton product out = a * b. @returns {number[]} out */
export const qMul = (out, a, b) => {
  const ax=a[0],ay=a[1],az=a[2],aw=a[3], bx=b[0],by=b[1],bz=b[2],bw=b[3];
  out[0]=aw*bx+ax*bw+ay*bz-az*by;
  out[1]=aw*by-ax*bz+ay*bw+az*bx;
  out[2]=aw*bz+ax*by-ay*bx+az*bw;
  out[3]=aw*bw-ax*bx-ay*by-az*bz;
  return out;
};

// =========================================================================
// Interpolation
// =========================================================================

/** Spherical linear interpolation. @returns {number[]} out */
export const qSlerp = (out, a, b, t) => {
  let bx=b[0],by=b[1],bz=b[2],bw=b[3];
  let d = a[0]*bx+a[1]*by+a[2]*bz+a[3]*bw;
  if (d < 0) { bx=-bx; by=-by; bz=-bz; bw=-bw; d=-d; }
  let f0, f1;
  if (1-d > 1e-10) {
    const th=Math.acos(d), st=Math.sin(th);
    f0=Math.sin((1-t)*th)/st; f1=Math.sin(t*th)/st;
  } else {
    f0=1-t; f1=t;
  }
  out[0]=a[0]*f0+bx*f1; out[1]=a[1]*f0+by*f1;
  out[2]=a[2]*f0+bz*f1; out[3]=a[3]*f0+bw*f1;
  return qNormalize(out);
};

/**
 * Normalised linear interpolation (nlerp).
 * Cheaper than slerp; slightly non-constant angular velocity.
 * Handles antipodal quats by flipping b when dot < 0.
 * @returns {number[]} out
 */
export const qNlerp = (out, a, b, t) => {
  let bx=b[0],by=b[1],bz=b[2],bw=b[3];
  if (a[0]*bx+a[1]*by+a[2]*bz+a[3]*bw < 0) { bx=-bx; by=-by; bz=-bz; bw=-bw; }
  out[0]=a[0]+t*(bx-a[0]); out[1]=a[1]+t*(by-a[1]);
  out[2]=a[2]+t*(bz-a[2]); out[3]=a[3]+t*(bw-a[3]);
  return qNormalize(out);
};

// =========================================================================
// Construction
// =========================================================================

/**
 * Build a quaternion from axis-angle.
 * @param {number[]} out
 * @param {number} ax @param {number} ay @param {number} az  Axis (need not be unit).
 * @param {number} angle  Radians.
 * @returns {number[]} out
 */
export const qFromAxisAngle = (out, ax, ay, az, angle) => {
  const half = angle * 0.5;
  const s    = Math.sin(half);
  const len  = Math.sqrt(ax*ax + ay*ay + az*az) || 1;
  out[0] = s * ax / len; out[1] = s * ay / len; out[2] = s * az / len;
  out[3] = Math.cos(half);
  return out;
};

/**
 * Build a quaternion from a look direction (−Z forward) and optional up (default +Y).
 * @param {number[]} out
 * @param {number[]} dir  Forward direction [x,y,z].
 * @param {number[]} [up] Up vector [x,y,z].
 * @returns {number[]} out
 */
export const qFromLookDir = (out, dir, up) => {
  let fx=dir[0],fy=dir[1],fz=dir[2];
  const fl=Math.sqrt(fx*fx+fy*fy+fz*fz)||1;
  fx/=fl; fy/=fl; fz/=fl;
  let ux=up?up[0]:0, uy=up?up[1]:1, uz=up?up[2]:0;
  let rx=uy*fz-uz*fy, ry=uz*fx-ux*fz, rz=ux*fy-uy*fx;
  const rl=Math.sqrt(rx*rx+ry*ry+rz*rz)||1;
  rx/=rl; ry/=rl; rz/=rl;
  ux=fy*rz-fz*ry; uy=fz*rx-fx*rz; uz=fx*ry-fy*rx;
  return qFromRotMat3x3(out, rx,ry,rz, ux,uy,uz, -fx,-fy,-fz);
};

/**
 * Build a quaternion from a 3×3 rotation matrix (9 row-major scalars).
 * @returns {number[]} out (normalised)
 */
export const qFromRotMat3x3 = (out, m00,m01,m02, m10,m11,m12, m20,m21,m22) => {
  const tr = m00+m11+m22;
  if (tr > 0) {
    const s=0.5/Math.sqrt(tr+1);
    out[3]=0.25/s; out[0]=(m21-m12)*s; out[1]=(m02-m20)*s; out[2]=(m10-m01)*s;
  } else if (m00>m11 && m00>m22) {
    const s=2*Math.sqrt(1+m00-m11-m22);
    out[3]=(m21-m12)/s; out[0]=0.25*s; out[1]=(m01+m10)/s; out[2]=(m02+m20)/s;
  } else if (m11>m22) {
    const s=2*Math.sqrt(1+m11-m00-m22);
    out[3]=(m02-m20)/s; out[0]=(m01+m10)/s; out[1]=0.25*s; out[2]=(m12+m21)/s;
  } else {
    const s=2*Math.sqrt(1+m22-m00-m11);
    out[3]=(m10-m01)/s; out[0]=(m02+m20)/s; out[1]=(m12+m21)/s; out[2]=0.25*s;
  }
  return qNormalize(out);
};

/**
 * Extract a unit quaternion from the upper-left 3×3 of a column-major mat4.
 * @param {number[]} out
 * @param {Float32Array|number[]} m  Column-major mat4.
 * @returns {number[]} out
 */
export const qFromMat4 = (out, m) =>
  qFromRotMat3x3(out, m[0],m[4],m[8], m[1],m[5],m[9], m[2],m[6],m[10]);

/**
 * Write a quaternion into the rotation block of a column-major mat4.
 * Translation and perspective rows/cols are set to identity values.
 * @param {Float32Array|number[]} out  16-element array.
 * @param {number[]} q  [x,y,z,w].
 * @returns {Float32Array|number[]} out
 */
export const qToMat4 = (out, q) => {
  const x=q[0],y=q[1],z=q[2],w=q[3];
  const x2=x+x,y2=y+y,z2=z+z;
  const xx=x*x2,xy=x*y2,xz=x*z2,yy=y*y2,yz=y*z2,zz=z*z2,wx=w*x2,wy=w*y2,wz=w*z2;
  out[0]=1-(yy+zz); out[1]=xy+wz;     out[2]=xz-wy;     out[3]=0;
  out[4]=xy-wz;     out[5]=1-(xx+zz); out[6]=yz+wx;     out[7]=0;
  out[8]=xz+wy;     out[9]=yz-wx;     out[10]=1-(xx+yy); out[11]=0;
  out[12]=0;        out[13]=0;        out[14]=0;          out[15]=1;
  return out;
};

// =========================================================================
// Decomposition
// =========================================================================

/**
 * Decompose a unit quaternion into { axis:[x,y,z], angle } (radians).
 * @param {number[]} q  [x,y,z,w].
 * @param {Object}  [out]
 * @returns {{ axis: number[], angle: number }}
 */
export const qToAxisAngle = (q, out) => {
  out = out || {};
  const x=q[0],y=q[1],z=q[2],w=q[3];
  const sinHalf = Math.sqrt(x*x+y*y+z*z);
  if (sinHalf < 1e-8) { out.axis=[0,1,0]; out.angle=0; return out; }
  out.angle = 2*Math.atan2(sinHalf, w);
  out.axis  = [x/sinHalf, y/sinHalf, z/sinHalf];
  return out;
};
