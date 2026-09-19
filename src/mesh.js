/**
 * @file Mesh — vertex normals, vertex groups, flattening and bounds of a triangle mesh.
 * @module tree/mesh
 * @license AGPL-3.0-only
 *
 * Positions are flat, three numbers per vertex; indices are flat, three per
 * triangle. What a loaded model may lack or need changed: meshNormals gives
 * its normals, meshBounds the extent a sketch frames and scales by.
 *
 * ── Smooth and flat ────────────────────────────────────────────────────────
 * One routine gives both, because the difference is in the mesh, not in the
 * formula. meshNormals sums on every vertex the cross product of each triangle
 * that uses it — the face normal scaled by twice the face's area, so large
 * faces weigh more — and normalises. Where triangles share their vertices
 * that sum is the smooth normal. Where every triangle owns its three vertices
 * (meshFlatten) each sum has one term, the face normal: flat shading.
 *
 * A mesh that arrives faceted, or one cut along a texture seam, holds several
 * vertices at one position; summed separately they stay flat, or crease.
 * meshGroups finds them — positions rounded to a grid of `eps` and hashed —
 * and meshNormals, given the groups, sums per position and hands every member
 * the result. The mesh itself is untouched, unlike a weld, which would merge
 * vertices a seam duplicates on purpose; and the groups, computed once, serve
 * every later call, so a deforming mesh re-smooths per frame without
 * allocating.
 *
 * ── Limits ─────────────────────────────────────────────────────────────────
 * No crease angle: grouping smooths every edge, so a box shades like a pillow
 * — flatten it instead. Grouping is by grid cell: exact duplicates, what files
 * hold, always meet; two points closer than `eps` but either side of a cell
 * boundary do not. A vertex no triangle reaches, or whose triangles cancel,
 * gets [0, 0, 0]. meshFlatten multiplies the vertex count by up to six.
 *
 * ── Sources ────────────────────────────────────────────────────────────────
 * Area-weighted vertex normals by summing unnormalised face cross products,
 * and de-indexing for flat shading, are standard practice. Smoothing across
 * coincident vertices by position hashing is the usual alternative to
 * welding; keeping the groups as a reusable index array beside an untouched
 * mesh is this module's arrangement.
 */

'use strict';

/**
 * Vertex normals: each triangle's cross product — its normal scaled by twice
 * its area — summed on its three vertices, then normalised. Shared vertices
 * give smooth normals; a flattened mesh (meshFlatten) gives flat ones. With
 * `opts.groups` (meshGroups) the sums are per position, so vertices that
 * coincide share one normal. A vertex no triangle reaches, or one whose
 * triangles cancel, gets [0, 0, 0]. Allocates nothing: a per-frame caller
 * keeps its `opts` object.
 * @param {number[]} out  Destination, three numbers per vertex (the length of `positions`).
 * @param {number[]} positions  Flat xyz.
 * @param {number[]} [indices]  Flat triangles; omitted, every three vertices are one.
 * @param {{ groups?:ArrayLike<number> }} [opts]  groups: per vertex, the index of its
 *        group's first vertex, from meshGroups.
 * @returns {number[]} out
 */
export function meshNormals(out, positions, indices, opts) {
  const n = positions.length, count = indices ? indices.length : n / 3;
  const groups = opts && opts.groups ? opts.groups : null;
  for (let i = 0; i < n; i++) out[i] = 0;
  for (let t = 0; t + 2 < count; t += 3) {
    const v0 = indices ? indices[t] : t, v1 = indices ? indices[t+1] : t+1, v2 = indices ? indices[t+2] : t+2;
    const i0 = v0 * 3, i1 = v1 * 3, i2 = v2 * 3;
    const ax=positions[i1]-positions[i0], ay=positions[i1+1]-positions[i0+1], az=positions[i1+2]-positions[i0+2];
    const bx=positions[i2]-positions[i0], by=positions[i2+1]-positions[i0+1], bz=positions[i2+2]-positions[i0+2];
    const nx=ay*bz-az*by, ny=az*bx-ax*bz, nz=ax*by-ay*bx;
    const o0 = groups ? groups[v0] * 3 : i0, o1 = groups ? groups[v1] * 3 : i1, o2 = groups ? groups[v2] * 3 : i2;
    out[o0]+=nx; out[o0+1]+=ny; out[o0+2]+=nz;
    out[o1]+=nx; out[o1+1]+=ny; out[o1+2]+=nz;
    out[o2]+=nx; out[o2+1]+=ny; out[o2+2]+=nz;
  }
  for (let i = 0; i + 2 < n; i += 3) {
    if (groups && groups[i / 3] !== i / 3) continue;       // a member: copied below
    const l = Math.hypot(out[i], out[i+1], out[i+2]);
    if (l > 0) { out[i]/=l; out[i+1]/=l; out[i+2]/=l; }
  }
  if (groups) {
    for (let v = 0; v * 3 + 2 < n; v++) {
      const g = groups[v] * 3, i = v * 3;
      if (g !== i) { out[i] = out[g]; out[i+1] = out[g+1]; out[i+2] = out[g+2]; }
    }
  }
  return out;
}

/**
 * Group the vertices that coincide: for every vertex, the index of the first
 * vertex at its position, positions rounded to a grid of `eps`. A vertex
 * alone in its cell is its own group. Allocates its hash: a setup-time call,
 * its result reusable for as long as the mesh's topology holds.
 * @param {ArrayLike<number>} out  Destination, one integer per vertex (an Int32Array).
 * @param {number[]} positions  Flat xyz.
 * @param {number} eps  The grid's cell, in the mesh's units; 0 or less groups exact duplicates only.
 * @returns {ArrayLike<number>} out
 */
export function meshGroups(out, positions, eps) {
  const first = new Map(), k = eps > 0 ? 1 / eps : 0;
  for (let v = 0; v * 3 + 2 < positions.length; v++) {
    const x = positions[3*v], y = positions[3*v+1], z = positions[3*v+2];
    const key = k ? Math.round(x * k) + ',' + Math.round(y * k) + ',' + Math.round(z * k) : x + ',' + y + ',' + z;
    const g = first.get(key);
    if (g === undefined) { first.set(key, v); out[v] = v; } else out[v] = g;
  }
  return out;
}

/**
 * A mesh with every triangle owning its three vertices: each attribute of
 * `arrays` — every key holding { numComponents, data } except `indices` —
 * expanded through the indices into a new array of the same type; any other
 * key (a bounds) is copied as it is. The result's indices count up, 0 … n − 1,
 * so a mesh always has them. Flat shading is this, then meshNormals. Pass
 * `indices` to expand arrays that carry none of their own — a morph target's
 * deltas through its mesh's indices. Allocates: a setup-time call.
 * @param {object} arrays  The arrays shape.
 * @param {ArrayLike<number>} [indices]  Default `arrays.indices.data`; with neither, the arrays are copied.
 * @returns {object} A new arrays object.
 */
export function meshFlatten(arrays, indices) {
  const idx = indices || (arrays.indices ? arrays.indices.data : null);
  const out = {};
  let count = 0;
  for (const key in arrays) {
    const a = arrays[key];
    if (key === 'indices') continue;
    if (!a || !a.data || !a.numComponents) { out[key] = a; continue; }
    const c = a.numComponents, n = idx ? idx.length : a.data.length / c;
    const data = new a.data.constructor(n * c);
    for (let i = 0; i < n; i++) {
      const s = (idx ? idx[i] : i) * c;
      for (let j = 0; j < c; j++) data[i * c + j] = a.data[s + j];
    }
    out[key] = { ...a, data };
    count = n;
  }
  const data = new Uint32Array(count);
  for (let i = 0; i < count; i++) data[i] = i;
  out.indices = { numComponents: 3, data };
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
