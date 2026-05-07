/**
 * @file Matrix arithmetic, space-transform dispatch, and projection queries.
 * @module tree/query
 * @license AGPL-3.0-only
 *
 * The operative layer — receives matrices and extracts information.
 * Contrast with form.js which constructs matrices from specs.
 *
 *   form.js  — specs  → matrix
 *   query.js — matrix → information
 *
 * Storage: column-major Float32Array / ArrayLike<number>.
 * Multiply: mat4Mul(out, A, B) = A · B  (standard math order).
 * Pipeline: clip = P · V · M · v
 *
 * ── NDC Z convention ──────────────────────────────────────────────────────
 * Passed as `ndcZMin` to every space-transform function:
 *   WEBGL  = −1   z ∈ [−1,  1]
 *   WEBGPU =  0   z ∈ [ 0,  1]
 *
 * ── NDC Y convention ──────────────────────────────────────────────────────
 * Standard (OpenGL / WebGL / WebGPU browser / Three.js / p5v2):
 *   NDC y-up  — y = +1 at top, y = −1 at bottom.
 * Native Vulkan: NDC y-down — projections constructed with ndcYSign = −1
 * (see form.js).  Query functions are convention-agnostic: they work on
 * whatever matrices are passed in.
 *
 * ── Viewport convention ───────────────────────────────────────────────────
 * vp = [x, y, w, h] — w and h are SIGNED.
 *
 * The sign of h encodes the relationship between NDC y and screen y:
 *   h < 0 (e.g. −canvasH): screen y-DOWN  (DOM / p5 mouseX·mouseY / Vulkan surface)
 *                            NDC y=+1 → screen y=0  (top)
 *                            NDC y=−1 → screen y=H  (bottom)
 *   h > 0 (e.g. +canvasH): screen y-UP   (OpenGL desktop / WebGL gl_FragCoord)
 *                            NDC y=−1 → screen y=0  (bottom)
 *                            NDC y=+1 → screen y=H  (top)
 *
 * Pass [0, canvasH, canvasW, −canvasH] for p5/DOM coordinates.
 * Pass [0, 0, canvasW, canvasH] for WebGL gl_FragCoord / OpenGL bottom-left.
 * All helpers use vp[2]/vp[3] signed — no Math.abs — so both conventions
 * work automatically without any branching.
 *
 * All functions follow the out-first, zero-allocation contract.
 * Returns null on degeneracy (singular matrix, etc.).
 */

'use strict';

import { WORLD, EYE, NDC, SCREEN, MATRIX } from './constants.js';
import { qFromRotMat3x3 } from './quat.js';

// ═══════════════════════════════════════════════════════════════════════════
// Mat4 arithmetic
// ═══════════════════════════════════════════════════════════════════════════

/** out = A · B  (column-major) */
export function mat4Mul(out, A, B) {
  const a0=A[0],a1=A[1],a2=A[2],a3=A[3],
        a4=A[4],a5=A[5],a6=A[6],a7=A[7],
        a8=A[8],a9=A[9],a10=A[10],a11=A[11],
        a12=A[12],a13=A[13],a14=A[14],a15=A[15];
  let b0=B[0],b1=B[1],b2=B[2],b3=B[3];
  out[0]=a0*b0+a4*b1+a8*b2+a12*b3;
  out[1]=a1*b0+a5*b1+a9*b2+a13*b3;
  out[2]=a2*b0+a6*b1+a10*b2+a14*b3;
  out[3]=a3*b0+a7*b1+a11*b2+a15*b3;
  b0=B[4];b1=B[5];b2=B[6];b3=B[7];
  out[4]=a0*b0+a4*b1+a8*b2+a12*b3;
  out[5]=a1*b0+a5*b1+a9*b2+a13*b3;
  out[6]=a2*b0+a6*b1+a10*b2+a14*b3;
  out[7]=a3*b0+a7*b1+a11*b2+a15*b3;
  b0=B[8];b1=B[9];b2=B[10];b3=B[11];
  out[8]=a0*b0+a4*b1+a8*b2+a12*b3;
  out[9]=a1*b0+a5*b1+a9*b2+a13*b3;
  out[10]=a2*b0+a6*b1+a10*b2+a14*b3;
  out[11]=a3*b0+a7*b1+a11*b2+a15*b3;
  b0=B[12];b1=B[13];b2=B[14];b3=B[15];
  out[12]=a0*b0+a4*b1+a8*b2+a12*b3;
  out[13]=a1*b0+a5*b1+a9*b2+a13*b3;
  out[14]=a2*b0+a6*b1+a10*b2+a14*b3;
  out[15]=a3*b0+a7*b1+a11*b2+a15*b3;
  return out;
}

/** out = inverse(src). Returns null if singular (|det| < 1e-12). */
export function mat4Invert(out, src) {
  const s0=src[0],s1=src[1],s2=src[2],s3=src[3],
        s4=src[4],s5=src[5],s6=src[6],s7=src[7],
        s8=src[8],s9=src[9],s10=src[10],s11=src[11],
        s12=src[12],s13=src[13],s14=src[14],s15=src[15];
  const b0=s0*s5-s1*s4, b1=s0*s6-s2*s4, b2=s0*s7-s3*s4,
        b3=s1*s6-s2*s5, b4=s1*s7-s3*s5, b5=s2*s7-s3*s6,
        b6=s8*s13-s9*s12, b7=s8*s14-s10*s12, b8=s8*s15-s11*s12,
        b9=s9*s14-s10*s13, b10=s9*s15-s11*s13, b11=s10*s15-s11*s14;
  let det=b0*b11-b1*b10+b2*b9+b3*b8-b4*b7+b5*b6;
  if (Math.abs(det) < 1e-12) return null;
  det = 1/det;
  out[0]=(s5*b11-s6*b10+s7*b9)*det;
  out[1]=(s2*b10-s1*b11-s3*b9)*det;
  out[2]=(s13*b5-s14*b4+s15*b3)*det;
  out[3]=(s10*b4-s9*b5-s11*b3)*det;
  out[4]=(s6*b8-s4*b11-s7*b7)*det;
  out[5]=(s0*b11-s2*b8+s3*b7)*det;
  out[6]=(s14*b2-s12*b5-s15*b1)*det;
  out[7]=(s8*b5-s10*b2+s11*b1)*det;
  out[8]=(s4*b10-s5*b8+s7*b6)*det;
  out[9]=(s1*b8-s0*b10-s3*b6)*det;
  out[10]=(s12*b4-s13*b2+s15*b0)*det;
  out[11]=(s9*b2-s8*b4-s11*b0)*det;
  out[12]=(s5*b7-s4*b9-s6*b6)*det;
  out[13]=(s0*b9-s1*b7+s2*b6)*det;
  out[14]=(s13*b1-s12*b3-s14*b0)*det;
  out[15]=(s8*b3-s9*b1+s10*b0)*det;
  return out;
}

/**
 * Normal matrix: inverseTranspose(upper-left 3×3 of src).
 * On degeneracy writes zeros and returns out.
 * @param {Float32Array|number[]} out  9-element destination.
 * @param {Float32Array|number[]} src  16-element mat4.
 */
export function mat3NormalFromMat4(out, src) {
  const a00=src[0],a01=src[1],a02=src[2],
        a10=src[4],a11=src[5],a12=src[6],
        a20=src[8],a21=src[9],a22=src[10];
  const b01=a22*a11-a12*a21, b11=-a22*a01+a02*a21, b21=a12*a01-a02*a11;
  let det=a00*b01+a10*b11+a20*b21;
  if (Math.abs(det) < 1e-12) { for(let i=0;i<9;i++)out[i]=0; return out; }
  det=1/det;
  out[0]=b01*det;           out[1]=(-a22*a10+a12*a20)*det; out[2]=(a21*a10-a11*a20)*det;
  out[3]=b11*det;           out[4]=(a22*a00-a02*a20)*det;  out[5]=(-a21*a00+a01*a20)*det;
  out[6]=b21*det;           out[7]=(-a12*a00+a02*a10)*det; out[8]=(a11*a00-a01*a10)*det;
  return out;
}

/** out = mat4 * [x,y,z,1], perspective-divides, writes xyz. */
export function mat4MulPoint(out, m, x, y, z) {
  const rx=m[0]*x+m[4]*y+m[8]*z+m[12], ry=m[1]*x+m[5]*y+m[9]*z+m[13],
        rz=m[2]*x+m[6]*y+m[10]*z+m[14], rw=m[3]*x+m[7]*y+m[11]*z+m[15];
  if (rw!==0&&rw!==1) { out[0]=rx/rw; out[1]=ry/rw; out[2]=rz/rw; }
  else                 { out[0]=rx;    out[1]=ry;    out[2]=rz;    }
  return out;
}

/**
 * Apply only the 3×3 linear block of a mat4 to a direction (no translation,
 * no perspective divide). Use mat3NormalFromMat4 for normals under non-uniform scale.
 */
export function mat4MulDir(out, m, dx, dy, dz) {
  out[0]=m[0]*dx+m[4]*dy+m[8]*dz;
  out[1]=m[1]*dx+m[5]*dy+m[9]*dz;
  out[2]=m[2]*dx+m[6]*dy+m[10]*dz;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Projection queries
// ═══════════════════════════════════════════════════════════════════════════

/** @returns {boolean} true if orthographic. */
export function projIsOrtho(p) { return p[15] !== 0; }

/**
 * Near plane distance.
 * @param {ArrayLike<number>} p       Projection mat4.
 * @param {number}            ndcZMin WEBGL (−1) or WEBGPU (0).
 */
export function projNear(p, ndcZMin) {
  return p[15]===0 ? p[14]/(p[10]+ndcZMin) : (p[14]-ndcZMin)/p[10];
}

/** Far plane distance (far always maps to NDC z = 1, convention-independent). */
export function projFar(p) {
  return p[15]===0 ? p[14]/(1+p[10]) : (p[14]-1)/p[10];
}

export function projLeft  (p, ndcZMin) { return p[15]===1 ? -(1+p[12])/p[0]  : projNear(p,ndcZMin)*(p[8]-1)/p[0];  }
export function projRight (p, ndcZMin) { return p[15]===1 ?  (1-p[12])/p[0]  : projNear(p,ndcZMin)*(1+p[8])/p[0];  }

/**
 * Top extent of the near plane in camera space (y_max, positive for standard y-up camera).
 * Sign-normalized: returns the larger of the two y boundaries regardless of whether
 * the projection was built with ndcYSign = +1 or −1.
 */
export function projTop(p, ndcZMin) {
  return p[15]===1
    ? ( Math.sign(p[5]) - p[13]) / p[5]   // ortho
    : projNear(p,ndcZMin)*(1+p[9])/p[5];  // perspective (p[5]>0 in practice)
}

/**
 * Bottom extent of the near plane in camera space (y_min, negative for standard y-up camera).
 */
export function projBottom(p, ndcZMin) {
  return p[15]===1
    ? (-Math.sign(p[5]) - p[13]) / p[5]   // ortho
    : projNear(p,ndcZMin)*(p[9]-1)/p[5];  // perspective
}

/** Vertical field of view in radians (perspective only). */
export function projFov (p) { return Math.abs(2*Math.atan(1/p[5])); }
/** Horizontal field of view in radians (perspective only). */
export function projHfov(p) { return Math.abs(2*Math.atan(1/p[0])); }

// ═══════════════════════════════════════════════════════════════════════════
// Derived matrices
// ═══════════════════════════════════════════════════════════════════════════

/** out = P · V */
export function mat4PV(out, proj, view)  { return mat4Mul(out, proj, view); }
/** out = V · M */
export function mat4MV(out, model, view) { return mat4Mul(out, view, model); }

// ═══════════════════════════════════════════════════════════════════════════
// Frame-relative transforms
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Location transform between frames: out = inv(to) · from.
 * Assumes both matrices are affine (bottom row [0,0,0,1]).
 * @returns {ArrayLike<number>|null} out, or null if `to` is singular.
 */
export function mat4Location(out, from, to) {
  // Same as: return mat4Invert(out, to) && mat4Mul(out, out, from);
  const a00=to[0],a01=to[1],a02=to[2],
        a10=to[4],a11=to[5],a12=to[6],
        a20=to[8],a21=to[9],a22=to[10];
  const b01=a22*a11-a12*a21, b11=a12*a20-a22*a10, b21=a21*a10-a11*a20;
  let det=a00*b01+a01*b11+a02*b21;
  if (Math.abs(det) < 1e-12) return null;
  det=1/det;
  const i00=b01*det,             i01=(a02*a21-a22*a01)*det, i02=(a12*a01-a02*a11)*det;
  const i10=b11*det,             i11=(a22*a00-a02*a20)*det, i12=(a02*a10-a12*a00)*det;
  const i20=b21*det,             i21=(a01*a20-a21*a00)*det, i22=(a11*a00-a01*a10)*det;
  const f00=from[0],f01=from[1],f02=from[2],
        f10=from[4],f11=from[5],f12=from[6],
        f20=from[8],f21=from[9],f22=from[10];
  out[0]=i00*f00+i01*f01+i02*f02; out[1]=i10*f00+i11*f01+i12*f02; out[2]=i20*f00+i21*f01+i22*f02; out[3]=0;
  out[4]=i00*f10+i01*f11+i02*f12; out[5]=i10*f10+i11*f11+i12*f12; out[6]=i20*f10+i21*f11+i22*f12; out[7]=0;
  out[8]=i00*f20+i01*f21+i02*f22; out[9]=i10*f20+i11*f21+i12*f22; out[10]=i20*f20+i21*f21+i22*f22; out[11]=0;
  const dx=from[12]-to[12], dy=from[13]-to[13], dz=from[14]-to[14];
  out[12]=i00*dx+i01*dy+i02*dz; out[13]=i10*dx+i11*dy+i12*dz; out[14]=i20*dx+i21*dy+i22*dz; out[15]=1;
  return out;
}

/**
 * Direction transform between frames: out = to₃ · inv(from₃).
 * Uses only the upper-left 3×3 blocks (rotation/scale, no translation).
 * @returns {ArrayLike<number>|null} out, or null if `from` is singular.
 */
export function mat3Direction(out, from, to) {
  const a00=from[0],a01=from[1],a02=from[2],
        a10=from[4],a11=from[5],a12=from[6],
        a20=from[8],a21=from[9],a22=from[10];
  const b01=a22*a11-a12*a21, b11=a12*a20-a22*a10, b21=a21*a10-a11*a20;
  let det=a00*b01+a01*b11+a02*b21;
  if (Math.abs(det) < 1e-12) return null;
  det=1/det;
  const i00=b01*det,             i01=(a02*a21-a22*a01)*det, i02=(a12*a01-a02*a11)*det;
  const i10=b11*det,             i11=(a22*a00-a02*a20)*det, i12=(a02*a10-a12*a00)*det;
  const i20=b21*det,             i21=(a01*a20-a21*a00)*det, i22=(a11*a00-a01*a10)*det;
  const t00=to[0],t01=to[1],t02=to[2], t10=to[4],t11=to[5],t12=to[6], t20=to[8],t21=to[9],t22=to[10];
  out[0]=t00*i00+t10*i01+t20*i02; out[1]=t01*i00+t11*i01+t21*i02; out[2]=t02*i00+t12*i01+t22*i02;
  out[3]=t00*i10+t10*i11+t20*i12; out[4]=t01*i10+t11*i11+t21*i12; out[5]=t02*i10+t12*i11+t22*i12;
  out[6]=t00*i20+t10*i21+t20*i22; out[7]=t01*i20+t11*i21+t21*i22; out[8]=t02*i20+t12*i21+t22*i22;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Space transforms — mapLocation / mapDirection
// ═══════════════════════════════════════════════════════════════════════════
//
// Flat dispatch: every from→to pair is a self-contained leaf with only stack
// locals — no reentrancy, no shared state between calls.
//
// Matrices bag `m`:
//   mat4Proj    Float32Array(16)  projection  (eye → clip)
//   mat4View    Float32Array(16)  view        (world → eye)
//   mat4Eye?    Float32Array(16)  eye         (eye → world); caller fills before passing
//   mat4PV?     Float32Array(16)  P · V;      caller fills or _ensurePV allocates once
//   mat4PVInv?  Float32Array(16)  inv(P · V); caller fills
//   fromFrame?  Float32Array(16)  MATRIX source frame
//   toFrameInv? Float32Array(16)  inv(MATRIX dest frame)
//
// Viewport `vp` = [x, y, w, h]:
//   Use SIGNED h to encode screen-y direction (see module header).
//   Core formula: screen = (ndc*0.5+0.5)*vp[k] + vp[k-2]  (k=2 for x, k=3 for y)
//   Inverse:      ndc    = ((screen-vp[k-2])/vp[k])*2 - 1
//   Negative vp[3] flips NDC y-up to screen y-down automatically.
//

// ── Location helpers ─────────────────────────────────────────────────────

function _worldToScreen(out, px, py, pz, pv, vp, ndcZMin) {
  const x=pv[0]*px+pv[4]*py+pv[8]*pz+pv[12], y=pv[1]*px+pv[5]*py+pv[9]*pz+pv[13],
        z=pv[2]*px+pv[6]*py+pv[10]*pz+pv[14], w=pv[3]*px+pv[7]*py+pv[11]*pz+pv[15];
  const xi=(w!==0&&w!==1)?1/w:1;
  out[0]=(x*xi*0.5+0.5)*vp[2]+vp[0];
  out[1]=(y*xi*0.5+0.5)*vp[3]+vp[1];
  out[2]=(z*xi-ndcZMin)/(1-ndcZMin);
  return out;
}

function _screenToWorld(out, sx, sy, sz, ipv, vp, ndcZMin) {
  return mat4MulPoint(out, ipv,
    ((sx-vp[0])/vp[2])*2-1,
    ((sy-vp[1])/vp[3])*2-1,
    sz*(1-ndcZMin)+ndcZMin);
}

function _worldToNDC(out, px, py, pz, pv) {
  const x=pv[0]*px+pv[4]*py+pv[8]*pz+pv[12], y=pv[1]*px+pv[5]*py+pv[9]*pz+pv[13],
        z=pv[2]*px+pv[6]*py+pv[10]*pz+pv[14], w=pv[3]*px+pv[7]*py+pv[11]*pz+pv[15];
  const xi=(w!==0&&w!==1)?1/w:1;
  out[0]=x*xi; out[1]=y*xi; out[2]=z*xi;
  return out;
}

function _ndcToWorld(out, nx, ny, nz, ipv) { return mat4MulPoint(out,ipv,nx,ny,nz); }

function _screenToNDC(out, sx, sy, sz, vp, ndcZMin) {
  out[0]=((sx-vp[0])/vp[2])*2-1;
  out[1]=((sy-vp[1])/vp[3])*2-1;
  out[2]=sz*(1-ndcZMin)+ndcZMin;
  return out;
}

function _ndcToScreen(out, nx, ny, nz, vp, ndcZMin) {
  out[0]=(nx*0.5+0.5)*vp[2]+vp[0];
  out[1]=(ny*0.5+0.5)*vp[3]+vp[1];
  out[2]=(nz-ndcZMin)/(1-ndcZMin);
  return out;
}

function _ensurePV(m) {
  if (m.mat4PV) return m.mat4PV;
  m.mat4PV = new Float32Array(16);
  mat4Mul(m.mat4PV, m.mat4Proj, m.mat4View);
  return m.mat4PV;
}

/**
 * Map a point between named coordinate spaces.
 *
 * @param {number[]} out     3-element destination — written and returned.
 * @param {number}   px,py,pz Input point.
 * @param {string}   from    Source space (WORLD, EYE, SCREEN, NDC, MATRIX).
 * @param {string}   to      Destination space.
 * @param {object}   m       Matrices bag — see module header.
 * @param {number[]} vp      Viewport [x, y, w, h]; sign of h encodes screen-y direction.
 * @param {number}   ndcZMin WEBGL (−1) or WEBGPU (0).
 * @returns {number[]} out
 */
export function mapLocation(out, px, py, pz, from, to, m, vp, ndcZMin) {
  if (from===WORLD && to===SCREEN) return _worldToScreen(out,px,py,pz,_ensurePV(m),vp,ndcZMin);
  if (from===SCREEN && to===WORLD) return _screenToWorld(out,px,py,pz,m.mat4PVInv,vp,ndcZMin);

  if (from===WORLD && to===NDC)   return _worldToNDC(out,px,py,pz,_ensurePV(m));
  if (from===NDC   && to===WORLD) return _ndcToWorld(out,px,py,pz,m.mat4PVInv);

  if (from===SCREEN && to===NDC)    return _screenToNDC(out,px,py,pz,vp,ndcZMin);
  if (from===NDC    && to===SCREEN) return _ndcToScreen(out,px,py,pz,vp,ndcZMin);

  if (from===WORLD && to===EYE) return mat4MulPoint(out,m.mat4View,px,py,pz);
  if (from===EYE && to===WORLD) return mat4MulPoint(out,m.mat4Eye,px,py,pz);

  if (from===EYE && to===SCREEN) {
    const e=m.mat4Eye;
    return _worldToScreen(out,e[0]*px+e[4]*py+e[8]*pz+e[12],
                              e[1]*px+e[5]*py+e[9]*pz+e[13],
                              e[2]*px+e[6]*py+e[10]*pz+e[14],_ensurePV(m),vp,ndcZMin);
  }
  if (from===SCREEN && to===EYE) {
    _screenToWorld(out,px,py,pz,m.mat4PVInv,vp,ndcZMin);
    return mat4MulPoint(out,m.mat4View,out[0],out[1],out[2]);
  }

  if (from===EYE && to===NDC) {
    const e=m.mat4Eye;
    return _worldToNDC(out,e[0]*px+e[4]*py+e[8]*pz+e[12],
                           e[1]*px+e[5]*py+e[9]*pz+e[13],
                           e[2]*px+e[6]*py+e[10]*pz+e[14],_ensurePV(m));
  }
  if (from===NDC && to===EYE) {
    _ndcToWorld(out,px,py,pz,m.mat4PVInv);
    return mat4MulPoint(out,m.mat4View,out[0],out[1],out[2]);
  }

  if (from===MATRIX && to===WORLD) return mat4MulPoint(out,m.fromFrame,px,py,pz);
  if (from===WORLD && to===MATRIX) return mat4MulPoint(out,m.toFrameInv,px,py,pz);

  if (from===MATRIX && to===EYE) {
    const f=m.fromFrame;
    return mat4MulPoint(out,m.mat4View,f[0]*px+f[4]*py+f[8]*pz+f[12],
                                       f[1]*px+f[5]*py+f[9]*pz+f[13],
                                       f[2]*px+f[6]*py+f[10]*pz+f[14]);
  }
  if (from===EYE && to===MATRIX) {
    const e=m.mat4Eye;
    return mat4MulPoint(out,m.toFrameInv,e[0]*px+e[4]*py+e[8]*pz+e[12],
                                         e[1]*px+e[5]*py+e[9]*pz+e[13],
                                         e[2]*px+e[6]*py+e[10]*pz+e[14]);
  }

  if (from===MATRIX && to===SCREEN) {
    const f=m.fromFrame;
    return _worldToScreen(out,f[0]*px+f[4]*py+f[8]*pz+f[12],
                              f[1]*px+f[5]*py+f[9]*pz+f[13],
                              f[2]*px+f[6]*py+f[10]*pz+f[14],_ensurePV(m),vp,ndcZMin);
  }
  if (from===SCREEN && to===MATRIX) {
    _screenToWorld(out,px,py,pz,m.mat4PVInv,vp,ndcZMin);
    return mat4MulPoint(out,m.toFrameInv,out[0],out[1],out[2]);
  }

  if (from===MATRIX && to===NDC) {
    const f=m.fromFrame;
    return _worldToNDC(out,f[0]*px+f[4]*py+f[8]*pz+f[12],
                           f[1]*px+f[5]*py+f[9]*pz+f[13],
                           f[2]*px+f[6]*py+f[10]*pz+f[14],_ensurePV(m));
  }
  if (from===NDC && to===MATRIX) {
    _ndcToWorld(out,px,py,pz,m.mat4PVInv);
    return mat4MulPoint(out,m.toFrameInv,out[0],out[1],out[2]);
  }

  if (from===MATRIX && to===MATRIX) {
    const f=m.fromFrame;
    return mat4MulPoint(out,m.toFrameInv,f[0]*px+f[4]*py+f[8]*pz+f[12],
                                         f[1]*px+f[5]*py+f[9]*pz+f[13],
                                         f[2]*px+f[6]*py+f[10]*pz+f[14]);
  }

  out[0]=px; out[1]=py; out[2]=pz;
  return out;
}

// ── Direction helpers ────────────────────────────────────────────────────
//
// Directions use only the linear 3×3 block — no translation, no w-divide.
// The signed vp[2]/vp[3] carries the y-convention automatically.
//

function _applyDir(out, m, dx, dy, dz) {
  out[0]=m[0]*dx+m[4]*dy+m[8]*dz;
  out[1]=m[1]*dx+m[5]*dy+m[9]*dz;
  out[2]=m[2]*dx+m[6]*dy+m[10]*dz;
  return out;
}

function _worldToScreenDir(out, dx, dy, dz, proj, view, vpW, vpH, ndcZMin) {
  const vx=view[0]*dx+view[4]*dy+view[8]*dz,
        vy=view[1]*dx+view[5]*dy+view[9]*dz,
        vz=view[2]*dx+view[6]*dy+view[10]*dz;
  // vpH is signed — negative flips y component automatically.
  out[0]=(proj[0]*vx+proj[4]*vy+proj[8]*vz)*vpW*0.5;
  out[1]=(proj[1]*vx+proj[5]*vy+proj[9]*vz)*vpH*0.5;
  out[2]=(proj[2]*vx+proj[6]*vy+proj[10]*vz)*(1-ndcZMin)*0.5;
  return out;
}

function _screenToWorldDir(out, dx, dy, dz, proj, eye, vpW, vpH, ndcZMin) {
  // Inverse of _worldToScreenDir; signed vpW/vpH cancel the y-flip.
  _applyDir(out, eye, dx/(vpW*0.5)/proj[0], dy/(vpH*0.5)/proj[5], dz/((1-ndcZMin)*0.5));
  return out;
}

function _screenToNDCDir(out, dx, dy, dz, vpW, vpH, ndcZMin) {
  out[0]=dx/(vpW*0.5); out[1]=dy/(vpH*0.5); out[2]=dz/((1-ndcZMin)*0.5);
  return out;
}

function _ndcToScreenDir(out, dx, dy, dz, vpW, vpH, ndcZMin) {
  out[0]=dx*vpW*0.5; out[1]=dy*vpH*0.5; out[2]=dz*(1-ndcZMin)*0.5;
  return out;
}

/**
 * Map a direction between named coordinate spaces.
 * Same bag and viewport contract as mapLocation.
 *
 * @param {number[]} out     3-element destination.
 * @param {number}   dx,dy,dz Input direction.
 * @param {string}   from    Source space.
 * @param {string}   to      Destination space.
 * @param {object}   m       Matrices bag — see module header.
 * @param {number[]} vp      Viewport [x, y, w, h]; sign of h encodes screen-y direction.
 * @param {number}   ndcZMin WEBGL (−1) or WEBGPU (0).
 * @returns {number[]} out
 */
export function mapDirection(out, dx, dy, dz, from, to, m, vp, ndcZMin) {
  const vpW=vp[2], vpH=vp[3];  // signed — carry y-convention through all helpers

  if (from===EYE   && to===WORLD)  return _applyDir(out,m.mat4Eye, dx,dy,dz);
  if (from===WORLD && to===EYE)    return _applyDir(out,m.mat4View,dx,dy,dz);

  if (from===WORLD  && to===SCREEN) return _worldToScreenDir(out,dx,dy,dz,m.mat4Proj,m.mat4View,vpW,vpH,ndcZMin);
  if (from===SCREEN && to===WORLD)  return _screenToWorldDir(out,dx,dy,dz,m.mat4Proj,m.mat4Eye, vpW,vpH,ndcZMin);

  if (from===SCREEN && to===NDC)    return _screenToNDCDir(out,dx,dy,dz,vpW,vpH,ndcZMin);
  if (from===NDC    && to===SCREEN) return _ndcToScreenDir(out,dx,dy,dz,vpW,vpH,ndcZMin);

  if (from===WORLD && to===NDC) {
    _worldToScreenDir(out,dx,dy,dz,m.mat4Proj,m.mat4View,vpW,vpH,ndcZMin);
    return _screenToNDCDir(out,out[0],out[1],out[2],vpW,vpH,ndcZMin);
  }
  if (from===NDC && to===WORLD) {
    _ndcToScreenDir(out,dx,dy,dz,vpW,vpH,ndcZMin);
    return _screenToWorldDir(out,out[0],out[1],out[2],m.mat4Proj,m.mat4Eye,vpW,vpH,ndcZMin);
  }

  if (from===EYE && to===SCREEN) {
    _applyDir(out,m.mat4Eye,dx,dy,dz);
    return _worldToScreenDir(out,out[0],out[1],out[2],m.mat4Proj,m.mat4View,vpW,vpH,ndcZMin);
  }
  if (from===SCREEN && to===EYE) {
    _screenToWorldDir(out,dx,dy,dz,m.mat4Proj,m.mat4Eye,vpW,vpH,ndcZMin);
    return _applyDir(out,m.mat4View,out[0],out[1],out[2]);
  }

  if (from===EYE && to===NDC) {
    _applyDir(out,m.mat4Eye,dx,dy,dz);
    _worldToScreenDir(out,out[0],out[1],out[2],m.mat4Proj,m.mat4View,vpW,vpH,ndcZMin);
    return _screenToNDCDir(out,out[0],out[1],out[2],vpW,vpH,ndcZMin);
  }
  if (from===NDC && to===EYE) {
    _ndcToScreenDir(out,dx,dy,dz,vpW,vpH,ndcZMin);
    _screenToWorldDir(out,out[0],out[1],out[2],m.mat4Proj,m.mat4Eye,vpW,vpH,ndcZMin);
    return _applyDir(out,m.mat4View,out[0],out[1],out[2]);
  }

  if (from===MATRIX && to===WORLD)  return _applyDir(out,m.fromFrame, dx,dy,dz);
  if (from===WORLD  && to===MATRIX) return _applyDir(out,m.toFrameInv,dx,dy,dz);

  if (from===MATRIX && to===EYE) {
    _applyDir(out,m.fromFrame,dx,dy,dz);
    return _applyDir(out,m.mat4View,out[0],out[1],out[2]);
  }
  if (from===EYE && to===MATRIX) {
    _applyDir(out,m.mat4Eye,dx,dy,dz);
    return _applyDir(out,m.toFrameInv,out[0],out[1],out[2]);
  }

  if (from===MATRIX && to===SCREEN) {
    _applyDir(out,m.fromFrame,dx,dy,dz);
    return _worldToScreenDir(out,out[0],out[1],out[2],m.mat4Proj,m.mat4View,vpW,vpH,ndcZMin);
  }
  if (from===SCREEN && to===MATRIX) {
    _screenToWorldDir(out,dx,dy,dz,m.mat4Proj,m.mat4Eye,vpW,vpH,ndcZMin);
    return _applyDir(out,m.toFrameInv,out[0],out[1],out[2]);
  }

  if (from===MATRIX && to===NDC) {
    _applyDir(out,m.fromFrame,dx,dy,dz);
    _worldToScreenDir(out,out[0],out[1],out[2],m.mat4Proj,m.mat4View,vpW,vpH,ndcZMin);
    return _screenToNDCDir(out,out[0],out[1],out[2],vpW,vpH,ndcZMin);
  }
  if (from===NDC && to===MATRIX) {
    _ndcToScreenDir(out,dx,dy,dz,vpW,vpH,ndcZMin);
    _screenToWorldDir(out,out[0],out[1],out[2],m.mat4Proj,m.mat4Eye,vpW,vpH,ndcZMin);
    return _applyDir(out,m.toFrameInv,out[0],out[1],out[2]);
  }

  if (from===MATRIX && to===MATRIX) {
    _applyDir(out,m.fromFrame,dx,dy,dz);
    return _applyDir(out,m.toFrameInv,out[0],out[1],out[2]);
  }

  out[0]=dx; out[1]=dy; out[2]=dz;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// pixelRatio
// ═══════════════════════════════════════════════════════════════════════════

/**
 * World-units-per-pixel at a given eye-space Z depth.
 * @param {ArrayLike<number>} proj    Projection mat4.
 * @param {number}            vpH     Viewport height in pixels (positive).
 * @param {number}            eyeZ    Eye-space Z — negative means in front of camera.
 * @param {number}            ndcZMin WEBGL (−1) or WEBGPU (0).
 */
export function pixelRatio(proj, vpH, eyeZ, ndcZMin) {
  return projIsOrtho(proj)
    ? Math.abs(projTop(proj,ndcZMin)-projBottom(proj,ndcZMin)) / vpH
    : 2*Math.abs(eyeZ)*Math.tan(projFov(proj)/2) / vpH;
}

// ═══════════════════════════════════════════════════════════════════════════
// Pick-matrix
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mutate a projection matrix in-place so that the pixel at (px, py) maps to
 * the full NDC square — making a 1×1 FBO render contain exactly that pixel.
 *
 * Premultiplies by M_pick (column-major, rows 2 and 3 unchanged):
 *
 *   ┌  sx   0   0   tx ┐     sx = |vp[2]|,   sy = |vp[3]|
 *   │   0  sy   0   ty │     cx = ((px−vp[0])/vp[2])·2 − 1   (NDC x of pixel centre)
 *   │   0   0   1    0 │     cy = ((py−vp[1])/vp[3])·2 − 1   (NDC y, sign-aware)
 *   └   0   0   0    1 ┘     tx = −cx·sx,  ty = −cy·sy
 *
 * Result: P_pick = M_pick · P_original.
 * The viewport sign convention (vp[3] < 0 for screen y-down) is preserved
 * automatically through cx/cy — no separate flip needed.
 *
 * @param {Float32Array} proj  Projection mat4 — mutated in place.
 * @param {number} px  Query pixel X in screen coordinates.
 * @param {number} py  Query pixel Y in screen coordinates.
 * @param {number[]} vp  Viewport [x, y, w, h]; same signed convention as mapLocation.
 */
export function mat4Pick(proj, px, py, vp) {
  const cx=((px-vp[0])/vp[2])*2-1;
  const cy=((py-vp[1])/vp[3])*2-1;
  const sx=Math.abs(vp[2]), sy=Math.abs(vp[3]);
  const tx=-cx*sx, ty=-cy*sy;
  for (let j=0; j<4; j++) {
    const a=proj[j*4], b=proj[j*4+1], d=proj[j*4+3];
    proj[j*4]   = sx*a + tx*d;
    proj[j*4+1] = sy*b + ty*d;
  }
}

// =========================================================================
// Decomposition
// =========================================================================

/**
 * Extract translation from a column-major mat4 (column 3).
 * @param {Float32Array|number[]} out3  3-element destination.
 * @param {Float32Array|number[]} m     16-element source.
 */
export function mat4ToTranslation(out3, m) {
  out3[0]=m[12]; out3[1]=m[13]; out3[2]=m[14];
  return out3;
}

/**
 * Extract scale from a column-major mat4 (column lengths of the rotation block).
 * Assumes no shear.
 * @param {Float32Array|number[]} out3  3-element destination.
 * @param {Float32Array|number[]} m     16-element source.
 */
export function mat4ToScale(out3, m) {
  out3[0]=Math.sqrt(m[0]*m[0]+m[1]*m[1]+m[2]*m[2]);
  out3[1]=Math.sqrt(m[4]*m[4]+m[5]*m[5]+m[6]*m[6]);
  out3[2]=Math.sqrt(m[8]*m[8]+m[9]*m[9]+m[10]*m[10]);
  return out3;
}

/**
 * Extract rotation as a unit quaternion from a column-major mat4.
 * Scale is factored out from each column. Assumes no shear.
 * @param {number[]} out4  4-element [x,y,z,w] destination.
 * @param {Float32Array|number[]} m  16-element source.
 */
export function mat4ToRotation(out4, m) {
  const sx=Math.sqrt(m[0]*m[0]+m[1]*m[1]+m[2]*m[2])||1;
  const sy=Math.sqrt(m[4]*m[4]+m[5]*m[5]+m[6]*m[6])||1;
  const sz=Math.sqrt(m[8]*m[8]+m[9]*m[9]+m[10]*m[10])||1;
  return qFromRotMat3x3(out4,
    m[0]/sx, m[4]/sy, m[8]/sz,
    m[1]/sx, m[5]/sy, m[9]/sz,
    m[2]/sx, m[6]/sy, m[10]/sz);
}
