/**
 * @file Frustum planes and visibility tests — zero allocations.
 * @module tree/visibility
 * @license AGPL-3.0-only
 *
 * Planes are a flat Float64Array(24): 6 planes × 4 floats [a, b, c, d].
 * All inputs are scalars. All outputs are INVISIBLE | VISIBLE | SEMIVISIBLE.
 */

import { INVISIBLE, VISIBLE, SEMIVISIBLE } from './constants.js';

// Plane indices
export const PLANE_LEFT = 0, PLANE_RIGHT = 1, PLANE_NEAR = 2,
             PLANE_FAR = 3, PLANE_TOP = 4, PLANE_BOTTOM = 5;

/**
 * Compute 6 frustum planes from camera basis (world space) + projection params.
 * All inputs are scalars — the addon extracts them from the inverse view matrix
 * and projection queries before calling.
 *
 * @param {Float64Array} out  24-float output.
 * @param {number} posX,posY,posZ  Camera world position.
 * @param {number} vdX,vdY,vdZ    View direction (−Z in eye space, world).
 * @param {number} upX,upY,upZ    Camera up.
 * @param {number} rtX,rtY,rtZ    Camera right.
 * @param {boolean} ortho         true if orthographic.
 * @param {number} near,far,left,right,top,bottom
 *   Projection extents in camera space.
 *   Sign contract: top > 0, bottom < 0, right > 0, left < 0 for standard y-up camera.
 */
export function frustumPlanes(
  out,
  posX, posY, posZ,
  vdX, vdY, vdZ,
  upX, upY, upZ,
  rtX, rtY, rtZ,
  ortho,
  near, far, left, right, top, bottom
) {
  const posViewDir = posX*vdX + posY*vdY + posZ*vdZ;
  const posRight   = posX*rtX + posY*rtY + posZ*rtZ;
  const posUp      = posX*upX + posY*upY + posZ*upZ;

  if (ortho) {
    // Left: normal = −right
    out[0] = -rtX; out[1] = -rtY; out[2] = -rtZ;
    out[3] = -(posRight - left) * -1; // dot(pos - right*left, -right) ... simplified:
    // Actually: d = dot(pointOnPlane, normal)
    // pointOnPlane = pos + right*left (left is negative for standard ortho)
    // normal = -right
    // d = dot(pos + right*left, -right) = -posRight - left
    out[3] = -posRight - left;

    // Right: normal = right
    out[4] = rtX; out[5] = rtY; out[6] = rtZ;
    out[7] = posRight + right;

    // Top: normal = up
    out[16] = upX; out[17] = upY; out[18] = upZ;
    out[19] = posUp + top;

    // Bottom: normal = -up
    out[20] = -upX; out[21] = -upY; out[22] = -upZ;
    out[23] = -posUp - bottom;
  } else {
    // Left
    const hfovl = Math.atan2(left, near);
    const shfovl = Math.sin(hfovl), chfovl = Math.cos(hfovl);
    out[0] = vdX*shfovl - rtX*chfovl;
    out[1] = vdY*shfovl - rtY*chfovl;
    out[2] = vdZ*shfovl - rtZ*chfovl;
    out[3] = shfovl*posViewDir - chfovl*posRight;

    // Right
    const hfovr = Math.atan2(right, near);
    const shfovr = Math.sin(hfovr), chfovr = Math.cos(hfovr);
    out[4] = -vdX*shfovr + rtX*chfovr;
    out[5] = -vdY*shfovr + rtY*chfovr;
    out[6] = -vdZ*shfovr + rtZ*chfovr;
    out[7] = -shfovr*posViewDir + chfovr*posRight;

    // Top
    const fovt = Math.atan2(top, near);
    const sfovt = Math.sin(fovt), cfovt = Math.cos(fovt);
    out[16] = -vdX*sfovt + upX*cfovt;
    out[17] = -vdY*sfovt + upY*cfovt;
    out[18] = -vdZ*sfovt + upZ*cfovt;
    out[19] = -sfovt*posViewDir + cfovt*posUp;

    // Bottom
    const fovb = Math.atan2(bottom, near);
    const sfovb = Math.sin(fovb), cfovb = Math.cos(fovb);
    out[20] = vdX*sfovb - upX*cfovb;
    out[21] = vdY*sfovb - upY*cfovb;
    out[22] = vdZ*sfovb - upZ*cfovb;
    out[23] = sfovb*posViewDir - cfovb*posUp;
  }

  // Near plane: normal = −viewDir
  out[8]  = -vdX; out[9]  = -vdY; out[10] = -vdZ;
  out[11] = -posViewDir - near;

  // Far plane: normal = viewDir
  out[12] = vdX; out[13] = vdY; out[14] = vdZ;
  out[15] = posViewDir + far;

  return out;
}

/**
 * Signed distance from point to one frustum plane.
 * @param {Float64Array} planes  24-float planes buffer.
 * @param {number} planeIdx  0–5 (LEFT, RIGHT, NEAR, FAR, TOP, BOTTOM).
 * @param {number} px,py,pz  Point coordinates.
 * @returns {number}
 */
export function distanceToPlane(planes, planeIdx, px, py, pz) {
  const b = planeIdx * 4;
  return planes[b]*px + planes[b+1]*py + planes[b+2]*pz - planes[b+3];
}

/** @returns {number} INVISIBLE | VISIBLE | SEMIVISIBLE */
export function pointVisibility(planes, px, py, pz) {
  for (let i = 0; i < 6; i++) {
    if (distanceToPlane(planes, i, px, py, pz) > 0) return INVISIBLE;
  }
  return VISIBLE;
}

/** @returns {number} INVISIBLE | VISIBLE | SEMIVISIBLE */
export function sphereVisibility(planes, cx, cy, cz, radius) {
  let allIn = true;
  for (let i = 0; i < 6; i++) {
    const d = distanceToPlane(planes, i, cx, cy, cz);
    if (d > radius) return INVISIBLE;
    if (d > 0 || -d < radius) allIn = false;
  }
  return allIn ? VISIBLE : SEMIVISIBLE;
}

/** @returns {number} INVISIBLE | VISIBLE | SEMIVISIBLE */
export function boxVisibility(planes, x0, y0, z0, x1, y1, z1) {
  let allIn = true;
  for (let i = 0; i < 6; i++) {
    const b = i * 4;
    const a = planes[b], bv = planes[b+1], c = planes[b+2], d = planes[b+3];
    let allOut = true;
    for (let corner = 0; corner < 8; corner++) {
      const cx = (corner & 4) ? x0 : x1;
      const cy = (corner & 2) ? y0 : y1;
      const cz = (corner & 1) ? z0 : z1;
      const dist = a*cx + bv*cy + c*cz - d;
      if (dist > 0) { allIn = false; }
      else { allOut = false; }
    }
    if (allOut) return INVISIBLE;
  }
  return allIn ? VISIBLE : SEMIVISIBLE;
}
