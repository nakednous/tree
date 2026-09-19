/**
 * @file Platonic solids — the five regular polyhedra as meshes in the arrays shape.
 * @module tree/platonic
 * @license AGPL-3.0-only
 *
 * A solid is a mesh: built once, at setup, in the shape twgl's primitives and
 * a loaded model's meshes share — { position, normal, texcoord, color,
 * indices } — so a bridge uploads it as it uploads those. Every face owns its
 * vertices (flat normals), fan-triangulated through the indices: 12, 24, 24,
 * 60 and 60 vertices for the tetrahedron, hexahedron, octahedron,
 * dodecahedron and icosahedron.
 *
 * All five are inscribed in one sphere: `radius` is the circumradius, so duals
 * nest and a bound is the radius. The edge follows from it — radius times
 * √(8/3), 2/√3, √2, (√5 − 1)/√3 and 1/sin(2π/5), in that order.
 *
 * Faces come from the dual: each face's outward normal is a vertex direction
 * of the dual solid, its vertices the ones farthest along it, ordered
 * counter-clockwise seen from outside — regular by construction.
 *
 * Descends from p5.platonic (JP Charalambos), whose colouring by face or by
 * fused vertex it keeps.
 */

'use strict';

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
 * A Platonic solid as a mesh in the arrays shape, centred at the origin.
 *
 * Colour: `opts.colors`, a list of [r, g, b, a?], is cycled per face, or per
 * solid vertex with `fuse` so that faces blend at their shared corners.
 * Without it a face is coloured by its orientation — nx² · COLOR_X + ny² ·
 * COLOR_Y + nz² · COLOR_Z — so a hexahedron shows the axis palette exactly.
 *
 * Texture coordinates, v up: 'face' fits every face's polygon in the unit
 * square, upright, centred and unstretched — its longer side spans 0 … 1, so a
 * hexahedron's faces each show the whole texture; 'sphere' is the
 * equirectangular map of the vertex direction, each face unwrapped around its
 * own centre so none straddles the seam — u may leave [0, 1], so the texture
 * repeats in u — and a vertex at a pole takes its face's u.
 *
 * @param {number} kind  TETRAHEDRON | HEXAHEDRON | OCTAHEDRON | DODECAHEDRON | ICOSAHEDRON.
 * @param {{ radius?:number, uvs?:'face'|'sphere', colors?:number[][], fuse?:boolean }} [opts]
 *        radius: the circumradius, default 100. uvs: default 'face'.
 * @returns {{ position:{numComponents:number,data:Float32Array}, normal:{numComponents:number,data:Float32Array},
 *             texcoord:{numComponents:number,data:Float32Array}, color:{numComponents:number,data:Float32Array},
 *             indices:{numComponents:number,data:Uint16Array} }|null} null for an unknown kind.
 */
export function platonic(kind, opts) {
  if (!_SOLIDS[kind]) return null;
  const o = opts || {}, R = typeof o.radius === 'number' ? o.radius : 100;
  const sphere = o.uvs === 'sphere', colors = Array.isArray(o.colors) && o.colors.length ? o.colors : null, fuse = !!o.fuse;
  const V = _SOLIDS[kind][0], faces = _faces(kind), sides = faces[0].ids.length;
  const count = faces.length * sides;
  const position = new Float32Array(3 * count), normal = new Float32Array(3 * count);
  const texcoord = new Float32Array(2 * count), color = new Float32Array(4 * count);
  const indices = new Uint16Array(3 * faces.length * (sides - 2));
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
    for (let k = 1; k + 1 < sides; k++) { indices[t++] = first; indices[t++] = first + k; indices[t++] = first + k + 1; }
  });
  return {
    position: { numComponents: 3, data: position }, normal: { numComponents: 3, data: normal },
    texcoord: { numComponents: 2, data: texcoord }, color: { numComponents: 4, data: color },
    indices: { numComponents: 3, data: indices },
  };
}
