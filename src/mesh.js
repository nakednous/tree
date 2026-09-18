/**
 * @file Mesh — vertex normals and bounds of an indexed triangle mesh.
 * @module tree/mesh
 * @license AGPL-3.0-only
 *
 * Positions are flat, three numbers per vertex; indices are flat, three per
 * triangle. What a loaded model may lack: meshNormals gives smooth normals
 * when a file carries none, meshBounds the extent a sketch frames and scales by.
 */

'use strict';

/**
 * Smooth vertex normals: each triangle's cross product — its normal scaled by
 * twice its area — accumulated on its three vertices, then normalised. A
 * vertex no triangle reaches, or one whose triangles cancel, gets [0, 0, 0].
 * @param {number[]} out  Destination, three numbers per vertex (the length of `positions`).
 * @param {number[]} positions  Flat xyz.
 * @param {number[]} [indices]  Flat triangles; omitted, every three vertices are one.
 * @returns {number[]} out
 */
export function meshNormals(out, positions, indices) {
  const n = positions.length, count = indices ? indices.length : n / 3;
  for (let i = 0; i < n; i++) out[i] = 0;
  for (let t = 0; t + 2 < count; t += 3) {
    const i0 = (indices ? indices[t] : t) * 3, i1 = (indices ? indices[t+1] : t+1) * 3, i2 = (indices ? indices[t+2] : t+2) * 3;
    const ax=positions[i1]-positions[i0], ay=positions[i1+1]-positions[i0+1], az=positions[i1+2]-positions[i0+2];
    const bx=positions[i2]-positions[i0], by=positions[i2+1]-positions[i0+1], bz=positions[i2+2]-positions[i0+2];
    const nx=ay*bz-az*by, ny=az*bx-ax*bz, nz=ax*by-ay*bx;
    out[i0]+=nx; out[i0+1]+=ny; out[i0+2]+=nz;
    out[i1]+=nx; out[i1+1]+=ny; out[i1+2]+=nz;
    out[i2]+=nx; out[i2+1]+=ny; out[i2+2]+=nz;
  }
  for (let i = 0; i + 2 < n; i += 3) {
    const l = Math.hypot(out[i], out[i+1], out[i+2]);
    if (l > 0) { out[i]/=l; out[i+1]/=l; out[i+2]/=l; }
  }
  return out;
}

/**
 * The axis-aligned bounds of a mesh's positions, written into `out`'s arrays.
 * No positions: everything zero.
 * @param {{ min:number[], max:number[], center:number[], diag:number }} out
 *        min, max: the box corners. center: their midpoint. diag: the box diagonal's length.
 * @param {number[]} positions  Flat xyz.
 * @returns {object} out
 */
export function meshBounds(out, positions) {
  const min = out.min, max = out.max, center = out.center;
  const none = positions.length < 3;
  for (let k = 0; k < 3; k++) { min[k] = none ? 0 : Infinity; max[k] = none ? 0 : -Infinity; }
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i+k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  for (let k = 0; k < 3; k++) center[k] = (min[k] + max[k]) / 2;
  out.diag = Math.hypot(max[0]-min[0], max[1]-min[1], max[2]-min[2]);
  return out;
}
