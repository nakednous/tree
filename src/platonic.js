/**
 * @file Platonic solids — the five regular polyhedra as meshes in the arrays shape.
 * @module tree/platonic
 * @license AGPL-3.0-only
 *
 * A solid is a mesh: built once, at setup, in the shape twgl's primitives and
 * a loaded mesh share — { position, normal, texcoord, color, indices }, with
 * its `bounds` beside them as a loaded mesh has — so a bridge uploads it as it
 * uploads those. All five are
 * inscribed in one sphere: `radius` is the circumradius, so duals nest and a
 * bound is the radius. The edge follows from it — radius times √(8/3), 2/√3,
 * √2, (√5 − 1)/√3 and 1/sin(2π/5), tetrahedron to icosahedron.
 *
 * ── Procedure ──────────────────────────────────────────────────────────────
 * 1. Vertices. The classical coordinates, scaled onto the unit sphere:
 *    alternate corners of a cube (tetrahedron); (±1, ±1, ±1) (hexahedron);
 *    the axis points (octahedron); (±1, ±1, ±1) with the cyclic shifts of
 *    (0, ±φ, ±1/φ) (dodecahedron); the cyclic shifts of (0, ±1, ±φ)
 *    (icosahedron), φ the golden ratio.
 * 2. Faces, from the dual. A face of a convex polyhedron is the set of its
 *    vertices that maximise a linear functional v · d, d the face's outward
 *    normal; and a regular solid's face normals are the vertex directions of
 *    its dual (tetrahedron ↔ itself, negated; hexahedron ↔ octahedron;
 *    dodecahedron ↔ icosahedron). So for each dual direction d the face is
 *    every vertex within 1e-9 of the largest v · d. Nothing is tabulated by
 *    hand, and a wrong table cannot give an irregular solid — it gives a face
 *    with the wrong number of vertices, which the golden cases would show.
 *    The dodecahedron above is the one oriented dual to the icosahedron above.
 * 3. Order. Each face gets its own frame: up is world +y projected into the
 *    face's plane (−z for a face looking straight up, +z for one looking
 *    straight down), right = up × normal. Its vertices are sorted by their
 *    angle in that frame, which is counter-clockwise seen from outside.
 * 4. Mesh. Every face owns its vertices — 12, 24, 24, 60 and 60 — with the
 *    face normal on each (flat shading), and is triangulated as a fan from its
 *    first vertex, valid because a face is convex.
 *
 * The routine is written for any convex polyhedron given as vertices plus
 * face directions, faces of different sizes included; the five solids are
 * five rows of its table, and the export stays closed to them.
 *
 * ── Texture coordinates (v up) ─────────────────────────────────────────────
 * 'face': the face's vertices in its own right / up, centred on their bounding
 * box and divided by half its longer side, so the polygon sits in the unit
 * square upright and unstretched. Every face shows the same texture; a square
 * face shows all of it, a triangle or a pentagon the part its outline covers.
 *
 * 'sphere': the equirectangular map of the vertex direction, u = ½ + atan2(z,
 * x) / 2π, v = ½ + asin(y) / π, made seam-free per face: a vertex's u is moved
 * by whole turns to within half a turn of the face centre's u, and a vertex on
 * a pole, where u is undefined, takes the face centre's. Limits: u leaves
 * [0, 1] on the faces that cross the seam, so the texture must repeat in u; a
 * face centred on a pole (the hexahedron's top and bottom) has no centre u and
 * unwraps vertex to vertex instead, its texture pinched as on any
 * latitude–longitude sphere; and the map is interpolated linearly across each
 * flat face, so it bends most where faces are largest — the tetrahedron.
 *
 * ── Colour ─────────────────────────────────────────────────────────────────
 * `colors` cycles per face, or per solid vertex with `fuse` (the shared corner
 * keeps one colour across its faces). Without `colors` a face takes nx² ·
 * COLOR_X + ny² · COLOR_Y + nz² · COLOR_Z: the squared components of a unit
 * normal sum to 1, so this is a convex blend of the axis palette, equal on
 * opposite faces, and exactly the palette on a hexahedron.
 *
 * ── Limits ─────────────────────────────────────────────────────────────────
 * Convex solids only — a supporting direction cannot find a star polyhedron's
 * faces. Flat normals only. Indices are 16-bit. A call allocates its arrays:
 * setup-time, never per frame. No centre: placing a solid is the caller's
 * model matrix.
 *
 * ── Sources ────────────────────────────────────────────────────────────────
 * The coordinates and the duality are classical: H. S. M. Coxeter, Regular
 * Polytopes (3rd ed., Dover, 1973), ch. 1–3. Faces as the maximisers of a
 * linear functional is the definition of a face of a convex polytope: G. M.
 * Ziegler, Lectures on Polytopes (Springer, 1995), ch. 2. Fan triangulation
 * and the equirectangular map are standard practice, as is moving u by whole
 * turns to clear the seam, common in icosphere texturing. Deriving the faces
 * from the dual's directions in place of face tables, the face frame, the
 * 'face' fit and the colour rule are this module's own arrangement of those
 * facts, not taken from a published algorithm. The solids' API — a length,
 * colours per face or fused per vertex — descends from p5.platonic (JP
 * Charalambos).
 */

'use strict';

import { meshBounds } from './mesh.js';
import { TETRAHEDRON, HEXAHEDRON, OCTAHEDRON, DODECAHEDRON, ICOSAHEDRON, COLOR_X, COLOR_Y, COLOR_Z } from './constants.js';

const PHI = (1 + Math.sqrt(5)) / 2;

// Unit-sphere vertices, flat xyz.
function _unit(list) {
  const out = [];
  for (let i = 0; i < list.length; i += 3) {
    const l = Math.hypot(list[i], list[i+1], list[i+2]);
    out.push(list[i] / l, list[i+1] / l, list[i+2] / l);
  }
  return out;
}

// Every sign choice of (x, y, z); a zero component is not signed.
function _signs(x, y, z) {
  const out = [];
  for (const sx of x ? [1, -1] : [1]) for (const sy of y ? [1, -1] : [1]) for (const sz of z ? [1, -1] : [1]) out.push(sx * x, sy * y, sz * z);
  return out;
}

// (x, y, z) with its two cyclic shifts, every sign choice of each.
const _cyclic = (x, y, z) => [..._signs(x, y, z), ..._signs(z, x, y), ..._signs(y, z, x)];

const _TETRA = _unit([1, 1, 1, 1, -1, -1, -1, 1, -1, -1, -1, 1]);
const _CUBE  = _unit(_signs(1, 1, 1));
const _OCTA  = _unit(_cyclic(1, 0, 0));
const _DODE  = _unit([..._signs(1, 1, 1), ..._cyclic(0, PHI, 1 / PHI)]);   // the orientation dual to _ICOS
const _ICOS  = _unit(_cyclic(0, 1, PHI));

// kind → [vertices, face directions (the dual's vertices)]
const _SOLIDS = {
  [TETRAHEDRON]:  [_TETRA, _TETRA.map(v => -v)],
  [HEXAHEDRON]:   [_CUBE, _OCTA],
  [OCTAHEDRON]:   [_OCTA, _CUBE],
  [DODECAHEDRON]: [_DODE, _ICOS],
  [ICOSAHEDRON]:  [_ICOS, _DODE],
};

const _cache = new Map();

// The faces of a kind: { n: the outward normal, r / u: the face's right and up, ids: vertex indices
// counter-clockwise from outside }. Up is world +y projected onto the face, −z on a face that looks
// up and +z on one that looks down, so a texture reads upright.
function _faces(kind) {
  if (_cache.has(kind)) return _cache.get(kind);
  const [V, D] = _SOLIDS[kind], faces = [];
  for (let f = 0; f < D.length; f += 3) {
    const nx = D[f], ny = D[f+1], nz = D[f+2];
    let best = -Infinity;
    for (let i = 0; i < V.length; i += 3) best = Math.max(best, V[i]*nx + V[i+1]*ny + V[i+2]*nz);
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(ny) > 1 - 1e-9) { uy = 0; uz = ny > 0 ? -1 : 1; }
    const k = ux*nx + uy*ny + uz*nz;
    ux -= k*nx; uy -= k*ny; uz -= k*nz;
    const ul = Math.hypot(ux, uy, uz);
    ux /= ul; uy /= ul; uz /= ul;
    const rx = uy*nz - uz*ny, ry = uz*nx - ux*nz, rz = ux*ny - uy*nx;   // right = up × normal
    const ids = [];
    for (let i = 0; i < V.length; i += 3) {
      if (V[i]*nx + V[i+1]*ny + V[i+2]*nz > best - 1e-9) ids.push(i / 3);
    }
    const angle = (id) => Math.atan2(V[3*id]*ux + V[3*id+1]*uy + V[3*id+2]*uz, V[3*id]*rx + V[3*id+1]*ry + V[3*id+2]*rz);
    ids.sort((a, b) => angle(a) - angle(b));
    // the polygon's box in the face's own right / up, for the 'face' uvs: centre and half the longer side
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const id of ids) {
      const x = V[3*id]*rx + V[3*id+1]*ry + V[3*id+2]*rz, y = V[3*id]*ux + V[3*id+1]*uy + V[3*id+2]*uz;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    faces.push({ n: [nx, ny, nz], r: [rx, ry, rz], u: [ux, uy, uz], ids,
                 cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, half: Math.max(x1 - x0, y1 - y0) / 2 });
  }
  _cache.set(kind, faces);
  return faces;
}

/**
 * A Platonic solid as a mesh in the arrays shape, centred at the origin,
 * inscribed in the sphere of `radius`. Every face owns its vertices and its
 * flat normal, and is fanned into triangles through the indices. The module
 * header states the procedure, its limits and its sources.
 *
 * Colour: `opts.colors`, a list of [r, g, b, a?], is cycled per face, or per
 * solid vertex with `fuse`, a shared corner keeping one colour across its
 * faces. Without it a face is coloured by its orientation — nx² · COLOR_X +
 * ny² · COLOR_Y + nz² · COLOR_Z, a convex blend since the squares sum to 1 —
 * so a hexahedron shows the axis palette exactly.
 *
 * Texture coordinates, v up. 'face' fits every face's polygon in the unit
 * square, centred, upright (world +y projected into the face) and
 * unstretched, its longer side spanning 0 … 1: every face shows the same
 * texture, a hexahedron's all of it. 'sphere' is the equirectangular map of
 * the vertex direction with each face's u moved by whole turns to within half
 * a turn of the face centre's, so no face straddles the seam; a vertex on a
 * pole takes its face's u. Its limits: u leaves [0, 1] on faces crossing the
 * seam, so the texture must repeat in u; a face centred on a pole (the
 * hexahedron's top and bottom) unwraps vertex to vertex and pinches as a
 * latitude–longitude sphere does; the map bends most across the largest
 * faces, the tetrahedron's.
 *
 * Allocates: a setup-time call, never per frame.
 *
 * @param {number} kind  TETRAHEDRON | HEXAHEDRON | OCTAHEDRON | DODECAHEDRON | ICOSAHEDRON — the face count.
 * @param {{ radius?:number, uvs?:'face'|'sphere', colors?:number[][], fuse?:boolean }} [opts]
 *        radius: the circumradius, default 100; the edge is radius × √(8/3), 2/√3, √2,
 *        (√5 − 1)/√3, 1/sin(2π/5) by kind. uvs: default 'face'.
 * @returns {{ position:{numComponents:number,data:Float32Array}, normal:{numComponents:number,data:Float32Array},
 *             texcoord:{numComponents:number,data:Float32Array}, color:{numComponents:number,data:Float32Array},
 *             indices:{numComponents:number,data:Uint16Array},
 *             bounds:{min:number[],max:number[],center:number[],diag:number} }|null} null for an unknown kind.
 */
export function platonic(kind, opts) {
  if (!_SOLIDS[kind]) return null;
  const o = opts || {}, R = typeof o.radius === 'number' ? o.radius : 100;
  const sphere = o.uvs === 'sphere', colors = Array.isArray(o.colors) && o.colors.length ? o.colors : null, fuse = !!o.fuse;
  const V = _SOLIDS[kind][0], faces = _faces(kind);
  let count = 0, tris = 0;                                  // faces may differ in size: count per face
  for (const face of faces) { count += face.ids.length; tris += face.ids.length - 2; }
  const position = new Float32Array(3 * count), normal = new Float32Array(3 * count);
  const texcoord = new Float32Array(2 * count), color = new Float32Array(4 * count);
  const indices = new Uint16Array(3 * tris);
  let v = 0, t = 0;
  faces.forEach((face, f) => {
    const [nx, ny, nz] = face.n, first = v;
    const uc = 0.5 + Math.atan2(nz, nx) / (2 * Math.PI), polar = Math.abs(ny) > 1 - 1e-9;
    let prev = uc;
    for (const id of face.ids) {
      const x = V[3*id], y = V[3*id+1], z = V[3*id+2];
      position[3*v] = x * R; position[3*v+1] = y * R; position[3*v+2] = z * R;
      normal[3*v] = nx; normal[3*v+1] = ny; normal[3*v+2] = nz;
      if (sphere) {
        let u = Math.abs(y) > 1 - 1e-9 ? uc : 0.5 + Math.atan2(z, x) / (2 * Math.PI);
        const ref = polar ? (v === first ? u : prev) : uc;   // a face on a pole unwraps vertex to vertex
        while (u - ref > 0.5) u -= 1;
        while (u - ref < -0.5) u += 1;
        prev = u;
        texcoord[2*v] = u; texcoord[2*v+1] = 0.5 + Math.asin(Math.max(-1, Math.min(1, y))) / Math.PI;
      } else {
        texcoord[2*v]   = 0.5 + 0.5 * (x*face.r[0] + y*face.r[1] + z*face.r[2] - face.cx) / face.half;
        texcoord[2*v+1] = 0.5 + 0.5 * (x*face.u[0] + y*face.u[1] + z*face.u[2] - face.cy) / face.half;
      }
      const c = colors ? colors[(fuse ? id : f) % colors.length] : null;
      for (let k = 0; k < 4; k++) {
        color[4*v+k] = c ? (k < c.length ? c[k] : 1) : nx*nx*COLOR_X[k] + ny*ny*COLOR_Y[k] + nz*nz*COLOR_Z[k];
      }
      v++;
    }
    for (let k = 1; k + 1 < face.ids.length; k++) { indices[t++] = first; indices[t++] = first + k; indices[t++] = first + k + 1; }
  });
  return {
    position: { numComponents: 3, data: position }, normal: { numComponents: 3, data: normal },
    texcoord: { numComponents: 2, data: texcoord }, color: { numComponents: 4, data: color },
    indices: { numComponents: 3, data: indices },
    bounds: meshBounds({ min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], diag: 0 }, position),
  };
}
