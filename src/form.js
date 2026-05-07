/**
 * @file Matrix construction from geometric specs and partial decomposition.
 * @module tree/form
 * @license AGPL-3.0-only
 *
 * Constructs mat4s from higher-level specs: TRS transforms, orthonormal
 * bases, lookat parameters, projection parameters, and special-purpose
 * matrices (bias, reflection).
 *
 * Design invariant: form.js has no dependency on query.js. Construction
 * from specs requires only scalar arithmetic and quaternion conversions.
 * Callers compose the resulting matrices using query.js (mat4Mul etc.).
 *
 * ── NDC Z convention ──────────────────────────────────────────────────────
 * Controlled by `ndcZMin` in every projection constructor:
 *   WEBGL  = −1   near → NDC z = −1,  far → NDC z = +1
 *   WEBGPU =  0   near → NDC z =  0,  far → NDC z = +1
 *
 * ── NDC Y convention ──────────────────────────────────────────────────────
 * Controlled by `ndcYSign` in every projection constructor (default +1):
 *   +1  NDC y-up   — standard: OpenGL / WebGL / WebGPU browser / Three.js / p5v2
 *   −1  NDC y-down — native Vulkan clip space
 *
 * Negating ndcYSign flips row 1 of the projection matrix (elements
 * out[1], out[5], out[9], out[13]), reversing the y-axis in clip space.
 * mat4View, mat4Eye, and all non-projection constructors are convention-
 * agnostic — they produce the same matrix regardless of the NDC y direction.
 *
 * ── Screen Y convention ───────────────────────────────────────────────────
 * Screen-y direction (DOM y-down vs OpenGL y-up) is a separate concern from
 * NDC-y direction and is handled in query.js via the signed viewport height.
 * See the query.js module header for details.
 *
 * All functions follow the out-first, zero-allocation contract.
 */

'use strict';

// =========================================================================
// Frame construction
// =========================================================================

/**
 * Rigid frame from orthonormal basis + translation.
 * Column-major layout: col0=right, col1=up, col2=forward, col3=translation.
 *
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} rx,ry,rz  Right vector (col 0).
 * @param {number} ux,uy,uz  Up vector    (col 1).
 * @param {number} fx,fy,fz  Forward vec  (col 2).
 * @param {number} tx,ty,tz  Translation  (col 3).
 */
export function mat4FromBasis(out, rx,ry,rz, ux,uy,uz, fx,fy,fz, tx,ty,tz) {
  out[0]=rx;  out[1]=ry;  out[2]=rz;  out[3]=0;
  out[4]=ux;  out[5]=uy;  out[6]=uz;  out[7]=0;
  out[8]=fx;  out[9]=fy;  out[10]=fz; out[11]=0;
  out[12]=tx; out[13]=ty; out[14]=tz; out[15]=1;
  return out;
}

/**
 * View matrix (world→eye) from lookat parameters.
 * Camera looks along −Z in eye space; right = normalize(up × (−Z)).
 * Cheaper than building the eye matrix and inverting.
 *
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} ex,ey,ez   Eye (camera) position.
 * @param {number} cx,cy,cz   Look-at target.
 * @param {number} ux,uy,uz   World up hint (need not be unit).
 */
export function mat4View(out, ex,ey,ez, cx,cy,cz, ux,uy,uz) {
  let zx=ex-cx, zy=ey-cy, zz=ez-cz;
  const zl=Math.sqrt(zx*zx+zy*zy+zz*zz)||1;
  zx/=zl; zy/=zl; zz/=zl;
  let xx=uy*zz-uz*zy, xy=uz*zx-ux*zz, xz=ux*zy-uy*zx;
  const xl=Math.sqrt(xx*xx+xy*xy+xz*xz)||1;
  xx/=xl; xy/=xl; xz/=xl;
  const yx=zy*xz-zz*xy, yy=zz*xx-zx*xz, yz=zx*xy-zy*xx;
  out[0]=xx;              out[1]=yx;              out[2]=zx;              out[3]=0;
  out[4]=xy;              out[5]=yy;              out[6]=zy;              out[7]=0;
  out[8]=xz;              out[9]=yz;              out[10]=zz;             out[11]=0;
  out[12]=-(xx*ex+xy*ey+xz*ez);
  out[13]=-(yx*ex+yy*ey+yz*ez);
  out[14]=-(zx*ex+zy*ey+zz*ez);
  out[15]=1;
  return out;
}

/**
 * Eye matrix (eye→world) from lookat parameters.
 * Transpose of the rotation block + direct translation column.
 * Same parameters as mat4View.
 *
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} ex,ey,ez   Eye position.
 * @param {number} cx,cy,cz   Look-at target.
 * @param {number} ux,uy,uz   World up hint.
 */
export function mat4Eye(out, ex,ey,ez, cx,cy,cz, ux,uy,uz) {
  let zx=ex-cx, zy=ey-cy, zz=ez-cz;
  const zl=Math.sqrt(zx*zx+zy*zy+zz*zz)||1;
  zx/=zl; zy/=zl; zz/=zl;
  let xx=uy*zz-uz*zy, xy=uz*zx-ux*zz, xz=ux*zy-uy*zx;
  const xl=Math.sqrt(xx*xx+xy*xy+xz*xz)||1;
  xx/=xl; xy/=xl; xz/=xl;
  const yx=zy*xz-zz*xy, yy=zz*xx-zx*xz, yz=zx*xy-zy*xx;
  out[0]=xx;  out[1]=xy;  out[2]=xz;  out[3]=0;
  out[4]=yx;  out[5]=yy;  out[6]=yz;  out[7]=0;
  out[8]=zx;  out[9]=zy;  out[10]=zz; out[11]=0;
  out[12]=ex; out[13]=ey; out[14]=ez; out[15]=1;
  return out;
}

// =========================================================================
// TRS construction
// =========================================================================

/**
 * Column-major mat4 from flat TRS scalars. No struct allocation.
 *
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} tx,ty,tz      Translation.
 * @param {number} qx,qy,qz,qw   Rotation quaternion [x,y,z,w].
 * @param {number} sx,sy,sz      Scale.
 */
export function mat4FromTRS(out, tx,ty,tz, qx,qy,qz,qw, sx,sy,sz) {
  const x2=qx+qx,y2=qy+qy,z2=qz+qz;
  const xx=qx*x2,xy=qx*y2,xz=qx*z2,yy=qy*y2,yz=qy*z2,zz=qz*z2;
  const wx=qw*x2,wy=qw*y2,wz=qw*z2;
  out[0]=(1-(yy+zz))*sx; out[1]=(xy+wz)*sx;      out[2]=(xz-wy)*sx;      out[3]=0;
  out[4]=(xy-wz)*sy;     out[5]=(1-(xx+zz))*sy;  out[6]=(yz+wx)*sy;      out[7]=0;
  out[8]=(xz+wy)*sz;     out[9]=(yz-wx)*sz;      out[10]=(1-(xx+yy))*sz; out[11]=0;
  out[12]=tx; out[13]=ty; out[14]=tz; out[15]=1;
  return out;
}

/**
 * Translation-only mat4.
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} tx,ty,tz
 */
export function mat4FromTranslation(out, tx,ty,tz) {
  out[0]=1; out[1]=0; out[2]=0;  out[3]=0;
  out[4]=0; out[5]=1; out[6]=0;  out[7]=0;
  out[8]=0; out[9]=0; out[10]=1; out[11]=0;
  out[12]=tx; out[13]=ty; out[14]=tz; out[15]=1;
  return out;
}

/**
 * Scale-only mat4.
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} sx,sy,sz
 */
export function mat4FromScale(out, sx,sy,sz) {
  out[0]=sx; out[1]=0;  out[2]=0;   out[3]=0;
  out[4]=0;  out[5]=sy; out[6]=0;   out[7]=0;
  out[8]=0;  out[9]=0;  out[10]=sz; out[11]=0;
  out[12]=0; out[13]=0; out[14]=0;  out[15]=1;
  return out;
}

// =========================================================================
// Projection construction
// =========================================================================

/**
 * Orthographic projection matrix.
 *
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} left,right,bottom,top  Frustum extents.
 * @param {number} near,far              Clip plane distances (positive).
 * @param {number} ndcZMin               −1 (WEBGL) or 0 (WEBGPU).
 * @param {number} [ndcYSign=1]          +1 = NDC y-up (default); −1 = NDC y-down (native Vulkan).
 */
export function mat4Ortho(out, left, right, bottom, top, near, far, ndcZMin, ndcYSign=1) {
  const rl=1/(right-left), tb=1/(top-bottom), fn=1/(far-near);
  out[0]=2*rl;              out[1]=0;                       out[2]=0;               out[3]=0;
  out[4]=0;                 out[5]=ndcYSign*2*tb;           out[6]=0;               out[7]=0;
  out[8]=0;                 out[9]=0;                       out[10]=(ndcZMin-1)*fn; out[11]=0;
  out[12]=-(right+left)*rl; out[13]=ndcYSign*(-(top+bottom)*tb);
  out[14]=(ndcZMin*far-near)*fn;
  out[15]=1;
  return out;
}

/**
 * Perspective projection matrix (general / off-centre frustum).
 * Symmetric case: left=-right, bottom=-top — derive from fov+aspect in user space:
 *   top = near * Math.tan(fov / 2);  right = top * aspect
 *   mat4Persp(out, -right, right, -top, top, near, far, ndcZMin)
 *
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} left,right,bottom,top  Near-plane extents (signed, y-up: top>0, bottom<0).
 * @param {number} near,far              Clip plane distances (positive).
 * @param {number} ndcZMin               −1 (WEBGL) or 0 (WEBGPU).
 * @param {number} [ndcYSign=1]          +1 = NDC y-up (default); −1 = NDC y-down (native Vulkan).
 */
export function mat4Persp(out, left, right, bottom, top, near, far, ndcZMin, ndcYSign=1) {
  const rl=1/(right-left), tb=1/(top-bottom);
  out[0]=2*near*rl;        out[1]=0;                          out[2]=0;  out[3]=0;
  out[4]=0;                out[5]=ndcYSign*2*near*tb;         out[6]=0;  out[7]=0;
  out[8]=(right+left)*rl;  out[9]=ndcYSign*(top+bottom)*tb;
  out[10]=(ndcZMin*near-far)/(far-near);
  out[11]=-1;
  out[12]=0; out[13]=0;
  out[14]=(ndcZMin-1)*far*near/(far-near);
  out[15]=0;
  return out;
}

// =========================================================================
// Special-purpose construction
// =========================================================================

/**
 * Bias matrix: remaps xyz from NDC to texture/UV space [0, 1].
 * xy remap from [−1, 1]; z remaps from [ndcZMin, 1].
 * Used to convert light-space NDC coordinates to shadow map UV.
 *
 * Convention note: the standard bias maps NDC y = −1 → texture v = 0 and
 * NDC y = +1 → texture v = 1. This is correct for both NDC y-up and y-down
 * conventions because the shadow map was rendered with the same projection.
 *
 * Column-major (WEBGL, ndcZMin=−1):   Column-major (WEBGPU, ndcZMin=0):
 *   [ 0.5  0    0    0.5 ]              [ 0.5  0    0    0.5 ]
 *   [ 0    0.5  0    0.5 ]              [ 0    0.5  0    0.5 ]
 *   [ 0    0    0.5  0.5 ]              [ 0    0    1    0   ]
 *   [ 0    0    0    1   ]              [ 0    0    0    1   ]
 *
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} ndcZMin  WEBGL (−1) or WEBGPU (0).
 */
export function mat4Bias(out, ndcZMin) {
  const sz=1/(1-ndcZMin), tz=-ndcZMin/(1-ndcZMin);
  out[0]=0.5; out[1]=0;   out[2]=0;   out[3]=0;
  out[4]=0;   out[5]=0.5; out[6]=0;   out[7]=0;
  out[8]=0;   out[9]=0;   out[10]=sz; out[11]=0;
  out[12]=0.5; out[13]=0.5; out[14]=tz; out[15]=1;
  return out;
}

/**
 * Reflection matrix across a plane ax + by + cz = d.
 * [nx, ny, nz] must be a unit normal.
 *
 * @param {Float32Array|number[]} out  16-element destination.
 * @param {number} nx,ny,nz  Unit plane normal.
 * @param {number} d         Plane offset (dot(point_on_plane, normal)).
 */
export function mat4Reflect(out, nx,ny,nz,d) {
  out[0]=1-2*nx*nx;  out[1]=-2*ny*nx;  out[2]=-2*nz*nx;  out[3]=0;
  out[4]=-2*nx*ny;   out[5]=1-2*ny*ny; out[6]=-2*nz*ny;  out[7]=0;
  out[8]=-2*nx*nz;   out[9]=-2*ny*nz;  out[10]=1-2*nz*nz; out[11]=0;
  out[12]=2*d*nx;    out[13]=2*d*ny;   out[14]=2*d*nz;   out[15]=1;
  return out;
}
