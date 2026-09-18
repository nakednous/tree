#!/usr/bin/env node
/**
 * @file Golden-vector generator — regenerates every fixture under golden/ from
 *       the JavaScript core. Zero dependencies. `npm run golden`.
 *
 * One fixture per src module, plain JSON:
 *
 *   {
 *     "module":     "quat",
 *     "tolerance":  { "exact": 0, "f64": 1e-6, "f32": 1e-5 },
 *     "constants":  { NAME: value, … },
 *     "functions":  { name: { "tol", "cases": [ { "args", "out", "writes" } ] } },
 *     "transcripts": [ { "name", "class", "args", "tol",
 *                        "steps": [ { "call", "args", "expect", "writes", "tol" } ] } ]
 *   }
 *
 * A case calls `name(...args)` on a fresh decode of `args` and compares the
 * return value with `out`. `writes` is the post-call content of the argument
 * buffers the function writes into, keyed by argument index — recorded for
 * functions whose return is not the buffer (a ray parameter, a void). A
 * transcript builds one instance — `new Class(...args)` for a capitalised
 * export, `factory(...args)` otherwise — and runs its steps in order. `call`
 * is a method name, or one of four pseudo-calls: `$get` reads a public field
 * (args [name]); `$set` assigns one (args [name, value]); `f`, on a carrying-
 * function instance such as oneEuro's, invokes the instance itself; `$fn`, on
 * a plain-data instance such as a camera state, applies a free function with
 * the instance as its first argument (args [name, ...rest]) and records its
 * return even when that is the instance — the state after an in-place edit
 * (a `$fn` step is that function's fixture for the coverage rule).
 * An omitted `out` / `expect` means the return is not checked (void, or
 * `this`).
 *
 * Comparison — a number passes when |a − b| ≤ tol · max(1, |a|, |b|), tol
 * taken from the case's class: exact for ints, enums, booleans, strings and
 * null; f64 (1e-6) for vec3 / quat / keyframe state and scalars; f32 (1e-5)
 * for matrices. Structure (array length, object keys) is exact.
 *
 * Encoding — non-finite numbers are { "$num": "Infinity" | "-Infinity" |
 * "NaN" }. In args: { "$alias": i } is the same object as argument i (alias-
 * safety cases); { "$oneEuro": opts } builds a oneEuro filter; { "$hook":
 * name } installs a callback that logs `name`, and `$get` of `$hooks` reads and
 * clears that log. The gizmo generators take live subjects: { "$constraint":
 * [kind, opts] } builds a Constraint; { "$track": { class, add, set } } builds
 * a PoseTrack or CameraTrack, adds each spec and assigns `set`'s fields;
 * { "$helm": { profile?, feed? } } builds a PoseHelm, installs the profile
 * and feeds [lin, ang].
 *
 * Hand-authored fixtures — `<module>.<source>.json`, such as golden/camera.p5.json
 * for the p5 parity cases — carry the same shape, are replayed by the test, and
 * are never regenerated here.
 *
 * @module tree/tools/golden
 * @license AGPL-3.0-only
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tree from '../src/index.js';

export const TOL = { exact: 0, f64: 1e-6, f32: 1e-5 };

// =========================================================================
// Codec — shared with test/golden.test.js
// =========================================================================

/**
 * Materialise fixture values: deep-clones, resolves `$num`, `$alias`,
 * `$oneEuro` and `$hook`. `ctx` carries the hook log and, for `$alias`, the
 * argument list being decoded.
 * @param {*} v
 * @param {{ hooks?: string[], args?: *[] }} [ctx]
 * @returns {*}
 */
export function decode(v, ctx = {}) {
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = decode(v[i], ctx);
    return out;
  }
  if (v && typeof v === 'object') {
    if ('$num' in v)     return Number(v.$num);
    if ('$alias' in v)   return ctx.args[v.$alias];
    if ('$oneEuro' in v) return tree.oneEuro(decode(v.$oneEuro, ctx));
    if ('$hook' in v)    { const n = v.$hook; return () => { ctx.hooks.push(n); }; }
    if ('$constraint' in v) return tree.createConstraint(...decode(v.$constraint, ctx));
    if ('$track' in v) {
      const d = decode(v.$track, ctx), t = new tree[d.class]();
      for (const s of d.add ?? []) t.add(s);
      Object.assign(t, d.set ?? {});
      return t;
    }
    if ('$helm' in v) {
      const d = decode(v.$helm, ctx), h = new tree.PoseHelm();
      if (d.profile) h.profile = d.profile;
      if (d.feed) h.feed(d.feed[0], d.feed[1]);
      return h;
    }
    const out = {};
    for (const k of Object.keys(v)) out[k] = decode(v[k], ctx);
    return out;
  }
  return v;
}

/** Decode an argument list, resolving `$alias` against the list itself. */
export function decodeArgs(args, ctx = {}) {
  const out = new Array(args.length);
  ctx.args = out;
  const isAlias = (a) => a && typeof a === 'object' && '$alias' in a;
  for (let i = 0; i < args.length; i++) if (!isAlias(args[i])) out[i] = decode(args[i], ctx);
  for (let i = 0; i < args.length; i++) if (isAlias(args[i]))  out[i] = out[args[i].$alias];
  return out;
}

/** Serialisable form of a live value: typed arrays → arrays, non-finite → `$num`. */
function encode(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : { $num: String(v) };
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v, encode);
  if (v && typeof v === 'object') {
    if ('$num' in v || '$alias' in v || '$oneEuro' in v || '$hook' in v ||
        '$constraint' in v || '$track' in v || '$helm' in v) return v;
    const out = {};
    for (const k of Object.keys(v)) out[k] = encode(v[k]);
    return out;
  }
  return v;
}

// =========================================================================
// Formatter — objects and long mixed arrays break per element; short values
// and numeric arrays (a mat4 is one line) inline
// =========================================================================

const WIDTH = 110;

function inline(v) {
  if (Array.isArray(v)) return '[' + v.map(inline).join(', ') + ']';
  if (v && typeof v === 'object')
    return '{' + Object.keys(v).map(k => JSON.stringify(k) + ': ' + inline(v[k])).join(', ') + '}';
  return JSON.stringify(v);
}

function fmt(v, ind = '') {
  const one = inline(v);
  if (one.length <= WIDTH || (Array.isArray(v) && v.every(x => typeof x === 'number'))) return one;
  const pad = ind + '  ';
  if (Array.isArray(v))
    return '[\n' + v.map(x => pad + fmt(x, pad)).join(',\n') + '\n' + ind + ']';
  if (v && typeof v === 'object')
    return '{\n' + Object.keys(v).map(k => pad + JSON.stringify(k) + ': ' + fmt(v[k], pad)).join(',\n') + '\n' + ind + '}';
  return one;
}

// =========================================================================
// Runner — evaluate a module spec against the core
// =========================================================================

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = join(ROOT, 'golden');

/** Run one function case: `{ args, out?, writes? }` from a spec `args` list. */
function runCase(name, args, writes) {
  const live = decodeArgs(args);
  const ret  = tree[name](...live);
  const c = { args: encode(args) };
  if (ret !== undefined) c.out = encode(ret);
  if (writes) { c.writes = {}; for (const i of writes) c.writes[i] = encode(live[i]); }
  return c;
}

/** Run one transcript: build the instance, replay the steps, record results. */
function runTranscript(t) {
  const ctx  = { hooks: [] };
  const ctor = tree[t.class];
  const args = decodeArgs(t.args ?? [], ctx);
  const inst = /^[A-Z]/.test(t.class) ? new ctor(...args) : ctor(...args);
  const steps = t.steps.map(s => {
    const live = decodeArgs(s.args ?? [], ctx);
    let ret;
    if (s.call === '$get')      ret = live[0] === '$hooks' ? ctx.hooks.splice(0) : inst[live[0]];
    else if (s.call === '$set') inst[live[0]] = live[1];
    else if (s.call === 'f')    ret = inst(...live);
    else if (s.call === '$fn')  ret = tree[live[0]](inst, ...live.slice(1));
    else                        ret = inst[s.call](...live);
    const step = { call: s.call };
    if (s.args)  step.args = encode(s.args);
    if (s.call !== '$set' && ret !== undefined && (ret !== inst || s.call === '$fn')) step.expect = encode(ret);
    if (s.writes) { step.writes = {}; for (const i of s.writes) step.writes[i] = encode(live[i]); }
    if (s.tol) step.tol = s.tol;
    return step;
  });
  const out = { name: t.name, class: t.class };
  if (t.args) out.args = encode(t.args);
  out.tol = t.tol ?? 'f64';
  out.steps = steps;
  return out;
}

function generate(module, spec) {
  const fx = { module, tolerance: TOL };
  if (spec.constants) {
    fx.constants = {};
    for (const n of spec.constants) fx.constants[n] = encode(tree[n]);
  }
  if (spec.functions) {
    fx.functions = {};
    for (const [name, f] of Object.entries(spec.functions)) {
      if (typeof tree[name] !== 'function') throw new Error(`${module}: ${name} is not exported`);
      fx.functions[name] = { tol: f.tol, cases: f.cases.map(a => runCase(name, a, f.writes)) };
    }
  }
  if (spec.transcripts) fx.transcripts = spec.transcripts.map(runTranscript);
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `${module}.json`);
  writeFileSync(path, fmt(fx) + '\n');
  const n = Object.values(fx.functions ?? {}).reduce((s, f) => s + f.cases.length, 0);
  console.log(`golden/${module}.json  ${Object.keys(fx.constants ?? {}).length} constants, ${n} cases, ${(fx.transcripts ?? []).length} transcripts`);
}

// =========================================================================
// Spec helpers
// =========================================================================

const exact = (cases, extra) => ({ tol: 'exact', cases, ...extra });
const f64   = (cases, extra) => ({ tol: 'f64',   cases, ...extra });
const f32   = (cases, extra) => ({ tol: 'f32',   cases, ...extra });
const alias = (i) => ({ $alias: i });

const { PI } = Math;
const Z3  = [0, 0, 0];
const Z4  = [0, 0, 0, 0];
const M16 = new Array(16).fill(0);
const I16 = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

const aa   = (x, y, z, a) => tree.qFromAxisAngle([0, 0, 0, 1], x, y, z, a);
const unit = (q) => tree.qNormalize(q.slice());
const neg  = (q) => q.map(x => -x);

// Reference quaternions — every value below is the core's own output.
const Q = {
  id:   [0, 0, 0, 1],
  x90:  aa(1, 0, 0, PI / 2), y90: aa(0, 1, 0, PI / 2), z90: aa(0, 0, 1, PI / 2),
  x180: aa(1, 0, 0, PI),     y180: aa(0, 1, 0, PI),    z180: aa(0, 0, 1, PI),
  g:    unit([1, 2, 3, 4]),
  h:    unit([3, -1, 2, 5]),
};
const U = { a: unit([1, 1, 0, 0]).slice(0, 3), b: unit([0, 1, 1, 0]).slice(0, 3), c: unit([1, 2, 3, 0]).slice(0, 3) };

// =========================================================================
// constants
// =========================================================================

const constants = {
  constants: [
    'WORLD', 'EYE', 'NDC', 'SCREEN', 'MODEL', 'MATRIX', 'SELF',
    'WEBGL', 'WEBGPU',
    'INVISIBLE', 'VISIBLE', 'SEMIVISIBLE',
    'ORIGIN', 'i', 'j', 'k', '_i', '_j', '_k',
    'SPHERE', 'PLANE', 'AXIS', 'DIAL', 'POINT', 'DIRECTION',
    'CIRCLE', 'SQUARE',
    'NONE', 'X', '_X', 'Y', '_Y', 'Z', '_Z', 'LABELS',
    'NEAR', 'FAR', 'LEFT', 'RIGHT', 'BOTTOM', 'TOP', 'BODY', 'APEX',
    'PATH', 'CENTER', 'CONTROLS', 'TANGENTS_IN', 'TANGENTS_OUT', 'TANGENTS', 'HANDLES',
    'TRANSLATE', 'ROTATE',
    'HANDLE', 'AIM', 'LOCUS', 'RING',
    'COLOR_X', 'COLOR_Y', 'COLOR_Z', 'COLOR_DIM',
  ],
};

// =========================================================================
// quat
// =========================================================================

const quat = {
  functions: {
    quat:  f64([[]]),
    qSet:  f64([[Z4, 1, 2, 3, 4]]),
    qCopy: f64([[Z4, Q.g]]),
    qDot:  f64([[Q.id, Q.id], [Q.g, Q.h], [Q.g, neg(Q.g)], [Q.x90, Q.y90]]),
    qNormalize: f64([
      [[3, 0, 4, 0]], [[1, 2, 3, 4]], [[0, 0, 0, -1]],
      [[0, 0, 0, 0]],                                   // zero-length: unchanged (||1 guard)
    ]),
    qNegate: f64([[Z4, Q.g]]),
    qMul: f64([
      [Z4, Q.id, Q.g], [Z4, Q.g, Q.id],
      [Z4, Q.x90, Q.y90], [Z4, Q.y90, Q.x90],           // non-commutative pair
      [Z4, Q.g, Q.h],
      [alias(1), Q.x90, Q.y90], [alias(2), Q.x90, Q.y90],  // out may be a or b
    ]),
    qConjugate: f64([[Z4, Q.g], [Z4, Q.id]]),
    qRotateVec3: f64([
      [Z3, Q.z90, [1, 0, 0]], [Z3, Q.x90, [0, 1, 0]], [Z3, Q.id, [0.5, -1, 2]],
      [Z3, Q.g, [0, 0, 1]], [Z3, Q.h, [1, -2, 0.5]],
      [alias(2), Q.y90, [1, 0, 0]],                     // out may be v
    ]),
    qSlerp: f64([
      [Z4, Q.id, Q.z90, 0], [Z4, Q.id, Q.z90, 0.5], [Z4, Q.id, Q.z90, 1],
      [Z4, Q.x90, Q.y90, 0.25],
      [Z4, Q.g, neg(Q.h), 0.5],                          // dot < 0: b flipped
      [Z4, Q.g, Q.g, 0.5],                               // coincident: linear fallback
    ]),
    qNlerp: f64([
      [Z4, Q.id, Q.z90, 0.5], [Z4, Q.x90, Q.y90, 0.75],
      [Z4, Q.g, neg(Q.h), 0.3],                          // dot < 0: b flipped
    ]),
    qFromUnitVectors: f64([
      [Z4, [1, 0, 0], [0, 1, 0]], [Z4, [0, 0, 1], [0, 0, 1]], [Z4, U.a, U.b],
      [Z4, [1, 0, 0], [-1, 0, 0]], [Z4, [0, 1, 0], [0, -1, 0]], [Z4, [0, 0, 1], [0, 0, -1]],  // antiparallel seeds
      [Z4, U.c, neg(U.c)],
    ]),
    qFromAxisAngle: f64([
      [Z4, 0, 1, 0, PI / 2], [Z4, 0, 0, 2, PI / 3], [Z4, 1, 1, 1, -PI], [Z4, 1, 0, 0, 0],
      [Z4, 0, 0, 0, 1],                                  // zero axis: (||1 guard)
    ]),
    qFromLookDir: f64([
      [Z4, [0, 0, -1]], [Z4, [1, 0, 0]], [Z4, [0, 0, 1]], [Z4, [3, 0, -4]], [Z4, [2, -1, 3]],
      [Z4, [1, 1, -1], [0, 1, 0]], [Z4, [0, 0, -1], [1, 0, 0]],
      [Z4, [0, 1, 0]], [Z4, [0, -1, 0]], [Z4, [0, 0, -1], [0, 0, 1]],  // dir ∥ up: up re-seeded
    ]),
    qFromRotMat3x3: f64([
      [Z4, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      [Z4, 0, -1, 0, 1, 0, 0, 0, 0, 1],                 // z90, trace > 0
      [Z4, 1, 0, 0, 0, -1, 0, 0, 0, -1],                // x180, m00 branch
      [Z4, -1, 0, 0, 0, 1, 0, 0, 0, -1],                // y180, m11 branch
      [Z4, -1, 0, 0, 0, -1, 0, 0, 0, 1],                // z180, m22 branch
      [Z4, ...rowMajor3(tree.qToMat4(M16.slice(), Q.g))],
    ]),
    qFromMat4: f64([
      [Z4, I16], [Z4, tree.qToMat4(M16.slice(), Q.g)], [Z4, tree.qToMat4(M16.slice(), Q.x180)],
    ]),
    qToMat4: f32([[M16, Q.id], [M16, Q.z90], [M16, Q.g]]),
    qToAxisAngle: f64([
      [Q.id], [Q.x90], [Q.g], [[0, 0, 0, -1]], [neg(Q.z90)],
    ]),
  },
};

/** Upper-left 3×3 of a column-major mat4 as the 9 row-major scalars qFromRotMat3x3 takes. */
function rowMajor3(m) { return [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]; }

// =========================================================================
// filter
// =========================================================================

const DT = 1 / 60;
const V6 = [0, 0, 0, 0, 0, 0];

const filter = {
  transcripts: [
    { name: 'oneEuro scalar — defaults, step response', class: 'oneEuro', steps: [
      { call: '$get', args: ['minCutoff'] }, { call: '$get', args: ['beta'] }, { call: '$get', args: ['dCutoff'] },
      { call: 'f', args: [0, DT] },                                   // primes: returns the raw sample
      { call: 'f', args: [1, DT] }, { call: 'f', args: [1, DT] }, { call: 'f', args: [1, DT] }, { call: 'f', args: [1, DT] },
      { call: 'f', args: [1, 1] },                                    // long period: α → 1, converges
      { call: 'f', args: [0, 0.001] },                                // short period: α → 0, barely moves
    ] },
    { name: 'oneEuro scalar — beta opens the cutoff under motion', class: 'oneEuro', args: [{ minCutoff: 1, beta: 0.5 }], steps: [
      { call: 'f', args: [0, DT] },
      { call: 'f', args: [10, DT] }, { call: 'f', args: [20, DT] }, { call: 'f', args: [30, DT] },       // fast: low lag
      { call: 'f', args: [30, DT] }, { call: 'f', args: [30, DT] },                                     // at rest: settles
      { call: 'f', args: [30.2, DT] }, { call: 'f', args: [29.8, DT] }, { call: 'f', args: [30.1, DT] },  // jitter: smoothed
    ] },
    { name: 'oneEuro vec — 3 lanes, alias, reset re-seeds', class: 'oneEuro', args: [{ minCutoff: 1.5, beta: 0.1, dCutoff: 2 }], steps: [
      { call: 'f', args: [Z3, [1, 2, 3], DT] },                       // primes: out = raw
      { call: 'f', args: [Z3, [1.5, 2, 2.5], DT] },
      { call: 'f', args: [alias(1), [2, 2, 2], DT] },                 // out may be raw
      { call: 'reset' },
      { call: 'f', args: [Z3, [10, 10, 10], DT] },                    // primes again
      { call: 'f', args: [Z3, [10, 11, 12], DT] },
    ] },
    { name: 'oneEuro vec — live-mutable params, lane count change after reset', class: 'oneEuro', steps: [
      { call: 'f', args: [[0, 0], [0, 0], DT] },
      { call: 'f', args: [[0, 0], [1, -1], DT] },
      { call: '$set', args: ['minCutoff', 5] },
      { call: 'f', args: [[0, 0], [1, -1], DT] },
      { call: '$set', args: ['beta', 1] },
      { call: 'f', args: [[0, 0], [2, -2], DT] },
      { call: '$get', args: ['minCutoff'] }, { call: '$get', args: ['beta'] },
      { call: 'reset' },
      { call: 'f', args: [V6, [1, 2, 3, 4, 5, 6], DT] },              // the helm's 6-lane packing
      { call: 'f', args: [V6, [0, 0, 0, 0, 0, 0], DT] },
    ] },
  ],
};

// =========================================================================
// form
// =========================================================================

const { WEBGL, WEBGPU } = tree;
/** Symmetric near-plane extents [left, right, bottom, top] from a vertical fov and aspect. */
const frustum = (fov, aspect, near) => { const t = near * Math.tan(fov / 2), r = t * aspect; return [-r, r, -t, t]; };

const form = {
  functions: {
    mat4FromBasis: f32([
      [M16, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      [M16, 0, 1, 0, -1, 0, 0, 0, 0, 1, 5, -2, 3],          // z90 columns + translation
    ]),
    mat4View: f32([
      [M16, 0, 0, 5, 0, 0, 0, 0, 1, 0],
      [M16, 3, 4, 5, 0, 1, 0, 0, 1, 0],
      [M16, 3, 4, 5, 0, 1, 0, 0, 2, 0],                      // up hint need not be unit
      [M16, -2, 1, -3, 1, 1, 1, 0, 0, 1],                    // z-up world
      [M16, 0, 5, 0, 0, 0, 0, 0, 1, 0],                      // up ∥ view direction: up re-seeded
    ]),
    mat4Eye: f32([
      [M16, 0, 0, 5, 0, 0, 0, 0, 1, 0],
      [M16, 3, 4, 5, 0, 1, 0, 0, 1, 0],
      [M16, -2, 1, -3, 1, 1, 1, 0, 0, 1],
      [M16, 0, 5, 0, 0, 0, 0, 0, 1, 0],                      // up ∥ view direction: up re-seeded
    ]),
    mat4FromTRS: f32([
      [M16, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
      [M16, 1, -2, 3, ...Q.z90, 2, 3, 4],
      [M16, 10, 20, 30, ...Q.g, 1, 1, 1],
      [M16, 0, 0, 0, ...Q.g, 2, -3, 0.5],                    // negative scale
    ]),
    mat4FromTranslation: f32([[M16, 1, 2, 3]]),
    mat4FromScale: f32([[M16, 2, 3, 4], [M16, -1, 1, 1]]),
    mat4: f32([[]]),
    mat3: f32([[]]),
    vec3: f64([[]]),
    vec2: f64([[]]),
    mat4Ortho: f32([
      [M16, -2, 2, -1, 1, 0.1, 100, WEBGL],
      [M16, -2, 2, -1, 1, 0.1, 100, WEBGPU],
      [M16, 0, 4, 0, 3, 1, 10, WEBGL],                       // off-centre
      [M16, -2, 2, -1, 1, 0.1, 100, WEBGL, -1],              // NDC y-down
    ]),
    mat4Persp: f32([
      [M16, ...frustum(PI / 3, 4 / 3, 0.1), 0.1, 100, WEBGL],
      [M16, ...frustum(PI / 3, 4 / 3, 0.1), 0.1, 100, WEBGPU],
      [M16, -0.05, 0.15, -0.1, 0.1, 0.1, 50, WEBGL],         // off-centre
      [M16, ...frustum(PI / 3, 4 / 3, 0.1), 0.1, 100, WEBGL, -1],  // NDC y-down
    ]),
    mat4Bias: f32([[M16, WEBGL], [M16, WEBGPU]]),
    mat4Reflect: f32([
      [M16, 0, 1, 0, 0], [M16, 1, 0, 0, 2], [M16, Math.SQRT1_2, Math.SQRT1_2, 0, 1],
    ]),
  },
};

// =========================================================================
// query
// =========================================================================

const { WORLD, EYE, NDC, SCREEN, MATRIX, CIRCLE, SQUARE } = tree;

// Reference matrices — a 60° 4:3 perspective, a symmetric ortho, a generic camera.
const P     = tree.mat4Persp([], ...frustum(PI / 3, 4 / 3, 0.1), 0.1, 100, WEBGL);
const Pgpu  = tree.mat4Persp([], ...frustum(PI / 3, 4 / 3, 0.1), 0.1, 100, WEBGPU);
const Pdown = tree.mat4Persp([], ...frustum(PI / 3, 4 / 3, 0.1), 0.1, 100, WEBGL, -1);
const Poff  = tree.mat4Persp([], -0.05, 0.15, -0.1, 0.1, 0.1, 50, WEBGL);
const O     = tree.mat4Ortho([], -2, 2, -1, 1, 0.1, 100, WEBGL);
const Ogpu  = tree.mat4Ortho([], -2, 2, -1, 1, 0.1, 100, WEBGPU);
const Ooff  = tree.mat4Ortho([], 0, 4, 0, 3, 1, 10, WEBGL);
const V     = tree.mat4View([], 3, 4, 5, 0, 1, 0, 0, 1, 0);
const E     = tree.mat4Eye([], 3, 4, 5, 0, 1, 0, 0, 1, 0);
const PV    = tree.mat4Mul([], P, V);
const PVInv = tree.mat4Invert([], PV);
const F     = tree.mat4FromTRS([], 1, 2, 3, ...Q.g, 2, 2, 2);         // MATRIX source frame
const G     = tree.mat4FromTRS([], -1, 0, 2, ...Q.x90, 1, 1, 1);      // MATRIX destination frame
const GInv  = tree.mat4Invert([], G);
const S234  = tree.mat4FromScale([], 2, 3, 4);
const SING  = tree.mat4FromScale([], 0, 1, 1);                        // singular

// Matrices bags (query.js header) and signed viewports.
const bag    = { mat4Proj: P, mat4View: V, mat4Eye: E, mat4PV: PV, mat4PVInv: PVInv, fromFrame: F, toFrameInv: GInv };
const PVgpu  = tree.mat4Mul([], Pgpu, V);
const bagGpu = { ...bag, mat4Proj: Pgpu, mat4PV: PVgpu, mat4PVInv: tree.mat4Invert([], PVgpu) };
const PVo    = tree.mat4Mul([], O, V);
const bagO   = { mat4Proj: O, mat4View: V, mat4PV: PVo, mat4PVInv: tree.mat4Invert([], PVo) };   // orthographic
const DOWN = [0, 480, 640, -480];   // screen y-down (DOM)
const UP   = [0, 0, 640, 480];      // screen y-up (gl_FragCoord)
const OFF  = [10, 20, 300, 200];    // offset sub-viewport, y-up

// Points and directions; the lookat centre maps to the screen centre.
const c = [0, 1, 0], p = [1, 0.5, -1], q = [-2, 3, 1];
const d1 = [1, 0, 0], d2 = [0, 0, 1], d3 = [0.3, -0.4, 0.5];
const loc  = (v, from, to, m = bag, vp = DOWN, ndc = WEBGL) => [Z3, ...v, from, to, m, vp, ndc];
const runL = (v, from, to, m = bag, vp = DOWN, ndc = WEBGL) => tree.mapLocation([0, 0, 0], ...v, from, to, m, vp, ndc);
const runD = (v, from, to, m = bag, vp = DOWN, ndc = WEBGL) => tree.mapDirection([0, 0, 0], ...v, from, to, m, vp, ndc);
const sp = runL(p, WORLD, SCREEN), np = runL(p, WORLD, NDC), ep = runL(p, WORLD, EYE);
const spGpu = runL(p, WORLD, SCREEN, bagGpu, DOWN, WEBGPU);

const query = {
  functions: {
    mat4Mul: f32([
      [M16, I16, F], [M16, F, I16], [M16, P, V], [M16, F, G], [M16, G, F],   // non-commutative pair
      [alias(1), F, G], [alias(2), F, G],                                     // out may be A or B
    ]),
    mat4Invert: f32([
      [M16, I16], [M16, F], [M16, P], [M16, O],
      [M16, SING], [M16, new Array(16).fill(0)],                              // singular: null
    ]),
    mat3NormalFromMat4: f32([
      [new Array(9).fill(0), I16], [new Array(9).fill(0), F], [new Array(9).fill(0), S234],
      [new Array(9).fill(0), SING],                                           // singular: zeros
    ]),
    mat4MulPoint: f32([
      [Z3, I16, 1, 2, 3], [Z3, F, 1, 1, 1], [Z3, V, 0, 1, 0],
      [Z3, P, 0, 0, -1], [Z3, PV, ...p],                                     // w ≠ 1: perspective divide
      [Z3, P, 0, 0, 0],                                                       // w = 0: no divide
    ]),
    mat4MulDir: f32([[Z3, I16, 1, 2, 3], [Z3, F, 1, 0, 0], [Z3, V, ...d3]]),
    projIsOrtho: exact([[P], [O], [Pgpu], [Ogpu]]),
    projNear:    f32([[P, WEBGL], [Pgpu, WEBGPU], [O, WEBGL], [Ogpu, WEBGPU], [Poff, WEBGL], [Ooff, WEBGL]]),
    projFar:     f32([[P], [Pgpu], [O], [Ogpu], [Poff], [Ooff]]),
    projLeft:    f32([[P, WEBGL], [Poff, WEBGL], [O, WEBGL], [Ooff, WEBGL], [Pgpu, WEBGPU]]),
    projRight:   f32([[P, WEBGL], [Poff, WEBGL], [O, WEBGL], [Ooff, WEBGL], [Pgpu, WEBGPU]]),
    projTop:     f32([[P, WEBGL], [Poff, WEBGL], [O, WEBGL], [Ooff, WEBGL], [Pdown, WEBGL]]),   // Pdown: sign-normalised
    projBottom:  f32([[P, WEBGL], [Poff, WEBGL], [O, WEBGL], [Ooff, WEBGL], [Pdown, WEBGL]]),
    projFov:     f32([[P], [Poff], [Pdown]]),
    projHfov:    f32([[P], [Poff]]),
    mat4PV: f32([[M16, P, V], [M16, O, V]]),
    mat4MV: f32([[M16, F, V], [M16, I16, V]]),
    mat4Location: f32([
      [M16, F, G], [M16, I16, F], [M16, F, I16],
      [M16, F, SING],                                                         // singular `to`: null
      // two placed frames, A rotated about Y and B rotated off-axis and scaled: inv(B) · A, so
      // B · out · origin lands on A's origin (the frame-A / frame-B figure)
      [M16,
        tree.mat4FromTRS(new Array(16).fill(0), 5, -2, 3, ...tree.qFromAxisAngle([0, 0, 0, 1], 0, 1, 0, 0.7), 1, 1, 1),
        tree.mat4FromTRS(new Array(16).fill(0), 1, 2, 3, ...tree.qFromAxisAngle([0, 0, 0, 1], 0.3, 1, 0.2, 1.1), 2, 1, 0.5)],
    ]),
    mat3Direction: f32([
      [new Array(9).fill(0), F, G], [new Array(9).fill(0), I16, F], [new Array(9).fill(0), F, I16],
      [new Array(9).fill(0), F, SING],                                        // singular `to`: null
      // the two placed frames of the mat4Location case: inv(B₃) · A₃, a direction's A-coordinates
      // becoming its B-coordinates — drawn inside each frame the two lines are parallel
      [new Array(9).fill(0),
        tree.mat4FromTRS(new Array(16).fill(0), 5, -2, 3, ...tree.qFromAxisAngle([0, 0, 0, 1], 0, 1, 0, 0.7), 1, 1, 1),
        tree.mat4FromTRS(new Array(16).fill(0), 1, 2, 3, ...tree.qFromAxisAngle([0, 0, 0, 1], 0.3, 1, 0.2, 1.1), 2, 1, 0.5)],
    ]),
    mapLocation: f32([
      loc(c, WORLD, SCREEN),                                                  // lookat centre → screen centre
      loc(p, WORLD, SCREEN), loc(p, WORLD, SCREEN, bag, UP), loc(p, WORLD, SCREEN, bag, OFF),
      loc(p, WORLD, SCREEN, bagGpu, DOWN, WEBGPU),
      loc(p, WORLD, SCREEN, { mat4Proj: P, mat4View: V }),                    // mat4PV absent: computed
      loc(sp, SCREEN, WORLD), loc(spGpu, SCREEN, WORLD, bagGpu, DOWN, WEBGPU),
      loc(p, WORLD, NDC), loc(q, WORLD, NDC, bagGpu, DOWN, WEBGPU), loc(np, NDC, WORLD),
      loc(sp, SCREEN, NDC), loc([320, 240, 0.5], SCREEN, NDC, bag, UP), loc(np, NDC, SCREEN), loc([0, 0, 0], NDC, SCREEN, bag, UP, WEBGPU),
      loc(p, WORLD, EYE), loc(ep, EYE, WORLD),
      loc(ep, EYE, SCREEN), loc(sp, SCREEN, EYE), loc(ep, EYE, NDC), loc(np, NDC, EYE),
      loc(p, MATRIX, WORLD), loc(p, WORLD, MATRIX), loc(p, MATRIX, EYE), loc(ep, EYE, MATRIX),
      loc(p, MATRIX, SCREEN), loc(sp, SCREEN, MATRIX), loc(p, MATRIX, NDC), loc(np, NDC, MATRIX), loc(p, MATRIX, MATRIX),
      loc(p, WORLD, WORLD),                                                   // same space: identity
    ]),
    mapDirection: f32([
      loc(d1, WORLD, EYE), loc(d3, WORLD, EYE), loc(runD(d3, WORLD, EYE), EYE, WORLD),
      loc(d1, WORLD, SCREEN), loc(d1, WORLD, SCREEN, bag, UP), loc(d3, WORLD, SCREEN, bagGpu, DOWN, WEBGPU),
      loc(runD(d3, WORLD, SCREEN), SCREEN, WORLD),
      loc([64, -48, 0.1], SCREEN, NDC), loc([64, 48, 0.1], SCREEN, NDC, bag, UP, WEBGPU), loc([0.2, 0.2, 0.1], NDC, SCREEN),
      loc(d3, WORLD, NDC), loc(runD(d3, WORLD, NDC), NDC, WORLD),
      loc(d2, EYE, SCREEN), loc(runD(d2, EYE, SCREEN), SCREEN, EYE), loc(d2, EYE, NDC), loc(runD(d2, EYE, NDC), NDC, EYE),
      loc(d1, MATRIX, WORLD), loc(d1, WORLD, MATRIX), loc(d3, MATRIX, EYE), loc(d3, EYE, MATRIX),
      loc(d3, MATRIX, SCREEN), loc(runD(d3, MATRIX, SCREEN), SCREEN, MATRIX), loc(d3, MATRIX, NDC), loc(runD(d3, MATRIX, NDC), NDC, MATRIX),
      loc(d3, MATRIX, MATRIX),
      loc(d3, WORLD, WORLD),                                                  // same space: identity
    ]),
    pixelRatio: f32([
      [P, 480, -5, WEBGL], [P, 480, 5, WEBGL], [P, 480, -50, WEBGL],          // |eyeZ|; scales with depth
      [O, 480, -5, WEBGL], [O, 480, -50, WEBGL],                              // ortho: depth-independent
      [Pgpu, 480, -5, WEBGPU],
    ]),
    mat4Viewport: f32([
      [M16, DOWN, WEBGL], [M16, UP, WEBGL], [M16, OFF, WEBGL], [M16, DOWN, WEBGPU],
    ], { writes: [0] }),
    mat4Pick: f32([
      [P, 320, 240, DOWN], [P, 100, 50, UP], [P, 100, 50, DOWN], [O, 320, 240, DOWN],
    ], { writes: [0] }),
    mat4ToTranslation: f32([[Z3, F], [Z3, I16]]),
    mat4ToScale: f32([[Z3, F], [Z3, S234], [Z3, tree.mat4FromTRS([], 0, 0, 0, ...Q.g, 2, 3, 4)]]),
    mat4ToRotation: f32([[Z4, I16], [Z4, F], [Z4, tree.mat4FromTRS([], 0, 0, 0, ...Q.g, 2, 3, 4)], [Z4, tree.qToMat4([], Q.x180)]]),
    unproject: f32([
      ...[[320, 240], [0, 0], [640, 0], [0, 480], [640, 480]].map(([sx, sy]) => [Z3, Z3, sx, sy, bag, DOWN, WEBGL]),   // centre and corners
      [Z3, Z3, 320, 240, bagGpu, DOWN, WEBGPU], [Z3, Z3, 0, 0, bagGpu, DOWN, WEBGPU],
      [Z3, Z3, 0, 0, bag, UP, WEBGL], [Z3, Z3, 100, 50, bag, OFF, WEBGL],
      ...[[320, 240], [0, 0], [640, 480]].map(([sx, sy]) => [Z3, Z3, sx, sy, bagO, DOWN, WEBGL]),                   // orthographic: parallel rays
      [Z3, Z3, 320, 240, { mat4Proj: P, mat4View: V }, DOWN, WEBGL],                                                 // no mat4PVInv: null
    ], { writes: [0, 1] }),
    pointerHit: exact([
      [sp[0], sp[1], ...p, 10, bag, DOWN, WEBGL],                                    // dead centre
      [sp[0] + 10, sp[1], ...p, 10, bag, DOWN, WEBGL],                               // on the circle: hits
      [sp[0] + 10.01, sp[1], ...p, 10, bag, DOWN, WEBGL],                            // just outside
      [sp[0] + 7, sp[1] + 7, ...p, 10, bag, DOWN, WEBGL],                            // diagonal, inside
      [sp[0] + 10, sp[1] + 10, ...p, 10, bag, DOWN, WEBGL],                          // the square's corner: the circle misses
      [sp[0] + 10, sp[1] + 10, ...p, 10, bag, DOWN, WEBGL, SQUARE],                  // the square hits
      [sp[0] + 10.01, sp[1], ...p, 10, bag, DOWN, WEBGL, SQUARE],
      [sp[0] + 7, sp[1] + 7, ...p, 10, bag, DOWN, WEBGL, CIRCLE],
      [spGpu[0] + 10, spGpu[1], ...p, 10, bagGpu, DOWN, WEBGPU],
      [320, 240, 6, 7, 10, 1e9, bag, DOWN, WEBGL],                                   // behind the camera: never
      [320, 240, -300, -99, -500, 1e9, bag, DOWN, WEBGL],                            // beyond the far plane: never
    ]),
    idToRgba: f64([[Z4, 0], [Z4, 1], [Z4, 255], [Z4, 256], [Z4, 65536], [Z4, 2 ** 24 - 1], [Z4, 123456], [Z4, 2 ** 24 + 1]]),   // 2²⁴ + 1 wraps to 1
    rgbaToId: exact([[0, 0, 0], [1, 0, 0], [255, 0, 0], [0, 1, 0], [0, 0, 1], [255, 255, 255], [64, 226, 1], [1.9, 0, 0]]),   // 123456; fractions truncated
  },
};

// =========================================================================
// track
// =========================================================================

const hook  = (name) => ({ $hook: name });
const HOOKS = ['onPlay', 'onEnd', 'onStop', '_onPlay', '_onEnd', '_onStop', '_onActivate', '_onDeactivate'];
const installHooks = HOOKS.map(h => ({ call: '$set', args: [h, hook(h)] }));
const TRS0  = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scl: [1, 1, 1] };
const TRSg  = tree.mat4FromTRS([], 1, 2, 3, ...Q.g, 2, 3, 4);
const times = (n, step) => Array.from({ length: n }, () => step);

const track = {
  functions: {
    hermiteVec3: f64([
      [Z3, [0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 0, 0], 0],
      [Z3, [0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 0, 0], 1],
      [Z3, [0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 0, 0], 0.5],
      [Z3, [0, 0, 0], [0, 0, 0], [2, 4, 6], [0, 0, 0], 0.5],           // zero tangents: smoothstep midpoint
      [Z3, [1, 2, 3], [0, 5, 0], [4, 0, -2], [-3, 0, 0], 0.25],
    ]),
    lerpVec3: f64([
      [Z3, [1, 2, 3], [4, 0, -2], 0], [Z3, [1, 2, 3], [4, 0, -2], 0.5], [Z3, [1, 2, 3], [4, 0, -2], 1],
      [Z3, [1, 2, 3], [4, 0, -2], 1.5],                                // no clamp: extrapolates
    ]),
    transformToMat4: f32([
      [M16, TRS0], [M16, { pos: [1, 2, 3], rot: Q.g, scl: [2, 3, 4] }], [M16, { pos: [0, 0, 0], rot: Q.z90, scl: [1, -1, 1] }],
    ]),
    mat4ToTransform: f32([
      [TRS0, I16], [TRS0, TRSg], [TRS0, tree.qToMat4([], Q.x180)], [TRS0, tree.mat4FromTranslation([], 5, 6, 7)],
    ]),
  },
  transcripts: [
    { name: 'PoseTrack — spec parser: every rot form, vec forms, mat4Model, rejects', class: 'PoseTrack', steps: [
      { call: 'add', args: [{ pos: [0, 0, 0] }] },                                   // defaults: rot identity, scl 1, no tangents
      { call: 'add', args: [{ pos: [1, 0, 0], rot: [0, 0, 0, 2] }] },                // raw quaternion, normalised
      { call: 'add', args: [{ pos: [2, 0, 0], rot: { axis: [0, 2, 0], angle: PI / 2 }, scl: [2, 2, 2], tanOut: [0, 5, 0] }] },
      { call: 'add', args: [{ pos: { x: 3, y: 0, z: 0 }, rot: { dir: [1, 0, 0] } }] },          // {x,y,z} vec, look dir
      { call: 'add', args: [{ pos: [4, 0, 0], rot: { dir: [0, 0, -1], up: [1, 0, 0] } }] },
      { call: 'add', args: [{ pos: [5, 0, 0], rot: { euler: [PI / 2, 0, 0] } }] },
      { call: 'add', args: [{ pos: [6, 0, 0], rot: { euler: [0.1, 0.2, 0.3], order: 'ZYX' } }] },
      { call: 'add', args: [{ pos: [7, 0, 0], rot: { euler: [0.1, 0.2, 0.3], order: 'BAD' } }] },   // unknown order → YXZ
      { call: 'add', args: [{ pos: [8, 0, 0], rot: { from: [1, 0, 0], to: [0, 1, 0] } }] },
      { call: 'add', args: [{ pos: [9, 0, 0], rot: { from: [1, 0, 0], to: [-1, 0, 0] } }] },     // antiparallel
      { call: 'add', args: [{ pos: [10, 0, 0], rot: { from: [0, 0, 1], to: [0, 0, 2] } }] },     // parallel → identity
      { call: 'add', args: [{ pos: [11, 0, 0], rot: { mat3: [0, 1, 0, -1, 0, 0, 0, 0, 1] } }] }, // column-major z90
      { call: 'add', args: [{ pos: [12, 0, 0], rot: { mat4Eye: tree.qToMat4([], Q.g) } }] },
      { call: 'add', args: [{ pos: [13, 0, 0], rot: { mat4Eye: { mat4: tree.qToMat4([], Q.g) } } }] },   // wrapper form
      { call: 'add', args: [{ mat4Model: TRSg }] },                                  // decomposed TRS
      { call: 'add', args: [{ mat4Model: { mat4: TRSg }, pos: [99, 99, 99] }] },      // mat4Model wins; adjacent duplicate → skipped
      { call: 'add', args: [{ mat4Model: [1, 2, 3] }] },                              // too short → ignored
      { call: 'add', args: [{ pos: [14, 0, 0], rot: { mat3: [1, 2] } }] },            // bad mat3 → rot null → identity
      { call: 'add', args: [null] }, { call: 'add', args: ['spec'] }, { call: 'add', args: [] },   // ignored
      { call: 'add', args: [[{ pos: [15, 0, 0] }, { pos: [16, 0, 0], tanIn: [1, 1, 1] }]] },       // bulk
      { call: '$get', args: ['keyframes'] },
      { call: '$get', args: ['segments'] },
    ] },
    { name: 'PoseTrack — edits: dedup, set, remove, reset', class: 'PoseTrack', steps: [
      { call: 'add', args: [{ pos: [0, 0, 0] }] },
      { call: 'add', args: [{ pos: [0, 0, 0] }] },                                   // adjacent duplicate: skipped
      { call: 'add', args: [{ pos: [0, 0, 0] }, { deduplicate: false }] },
      { call: 'add', args: [{ pos: [1, 0, 0] }] },
      { call: 'add', args: [{ pos: [0, 0, 0] }] },                                   // not adjacent: kept
      { call: '$get', args: ['segments'] },
      { call: '$set', args: ['seg', 3] }, { call: '$set', args: ['f', 10] },
      { call: 'set', args: [0, { pos: [9, 9, 9] }] },
      { call: 'set', args: [4, { pos: [4, 4, 4] }] },                              // index === length: append
      { call: 'set', args: [99, { pos: [1, 1, 1] }] }, { call: 'set', args: [-1, { pos: [1, 1, 1] }] },
      { call: 'set', args: [0, null] }, { call: 'set', args: ['0', { pos: [1, 1, 1] }] },
      { call: 'remove', args: [1] }, { call: 'remove', args: [99] }, { call: 'remove', args: [-1] }, { call: 'remove', args: ['1'] },
      { call: '$get', args: ['keyframes'] },
      { call: '$get', args: ['seg'] }, { call: '$get', args: ['f'] },                 // cursor clamped by remove
      { call: 'remove', args: [0] }, { call: 'remove', args: [0] }, { call: 'remove', args: [0] },
      { call: '$get', args: ['seg'] }, { call: '$get', args: ['f'] },                 // no segments left: origin
      { call: 'add', args: [{ pos: [1, 0, 0] }] },
      { call: 'reset' },
      { call: '$get', args: ['keyframes'] }, { call: 'info' },
    ] },
    { name: 'PoseTrack — transport: play/tick/eval/seek/time/info, once mode, hook order', class: 'PoseTrack', steps: [
      ...installHooks,
      { call: 'play' },                                                             // no keyframes: no-op, no hooks
      { call: 'add', args: [{ pos: [0, 0, 0] }] },
      { call: 'play' }, { call: '$get', args: ['playing'] }, { call: '$get', args: ['$hooks'] },   // one keyframe: snaps, no hooks
      { call: 'eval' },
      { call: 'add', args: [[{ pos: [10, 0, 0], rot: Q.z90 }, { pos: [10, 10, 0], scl: [2, 2, 2] }]] },
      { call: 'eval' },                                                             // cursor at origin
      { call: 'play', args: [{ duration: 4, rate: 1 }] },
      { call: '$get', args: ['$hooks'] }, { call: 'info' },
      { call: 'play' },                                                             // already playing: no hooks
      { call: '$get', args: ['$hooks'] },
      { call: 'tick' }, { call: 'tick' }, { call: 'tick' },
      { call: '$get', args: ['seg'] }, { call: '$get', args: ['f'] }, { call: 'time' },
      { call: 'eval' },                                                             // hermite / slerp / lerp at t = 0.75
      ...times(4, { call: 'tick' }),
      { call: '$get', args: ['seg'] }, { call: '$get', args: ['f'] },
      { call: 'tick' },                                                             // reaches the end: stops, onEnd
      { call: '$get', args: ['$hooks'] }, { call: '$get', args: ['playing'] }, { call: 'time' },
      { call: 'eval' },
      { call: 'tick' },                                                             // not playing: false, no advance
      { call: 'seek', args: [0.5] }, { call: 'time' }, { call: '$get', args: ['seg'] }, { call: '$get', args: ['f'] },
      { call: 'seek', args: [0.25, 1] }, { call: '$get', args: ['seg'] }, { call: '$get', args: ['f'] },
      { call: 'seek', args: [-1] }, { call: 'time' }, { call: 'seek', args: [7, 99] }, { call: '$get', args: ['seg'] }, { call: '$get', args: ['f'] },
      { call: 'play', args: [-1] },                                                 // bare number: rate
      { call: '$get', args: ['rate'] }, { call: '$get', args: ['$hooks'] },
      { call: 'tick' }, { call: '$get', args: ['seg'] }, { call: '$get', args: ['f'] },
      { call: '$set', args: ['rate', 'x'] }, { call: '$get', args: ['rate'] },        // non-number → 1
      { call: '$set', args: ['rate', 0] }, { call: 'tick' }, { call: '$get', args: ['f'] },   // frozen, still playing
      { call: 'stop' }, { call: '$get', args: ['$hooks'] }, { call: '$get', args: ['playing'] },
      { call: 'stop' }, { call: '$get', args: ['$hooks'] },                          // already stopped: no hooks
      { call: 'play', args: [{ rate: -1 }] }, { call: 'stop', args: [true] }, { call: 'time' },   // rewind while reversed → 1
      { call: 'play', args: [{ rate: 1 }] }, { call: 'stop', args: [true] }, { call: 'time' },    // rewind forward → 0
      { call: 'play' }, { call: 'reset' }, { call: '$get', args: ['$hooks'] }, { call: 'info' },
    ] },
    { name: 'PoseTrack — loop and bounce modes', class: 'PoseTrack', steps: [
      ...installHooks,
      { call: 'add', args: [[{ pos: [0, 0, 0] }, { pos: [3, 0, 0] }, { pos: [6, 0, 0] }]] },
      { call: 'play', args: [{ duration: 3, loop: true }] },
      ...times(5, { call: 'tick' }), { call: '$get', args: ['seg'] }, { call: '$get', args: ['f'] },
      { call: 'tick' }, { call: '$get', args: ['seg'] }, { call: '$get', args: ['f'] },   // 6 → wraps to 0
      { call: '$set', args: ['rate', -2] },
      { call: 'tick' }, { call: '$get', args: ['seg'] }, { call: '$get', args: ['f'] },   // −2 → wraps to 4
      { call: '$get', args: ['$hooks'] }, { call: '$get', args: ['playing'] },
      { call: 'play', args: [{ bounce: true, rate: 1 }] },                          // loop + bounce: reverse at each boundary
      { call: 'seek', args: [1] },
      { call: 'tick' }, { call: '$get', args: ['seg'] }, { call: '$get', args: ['f'] },   // 6 + 1 → 5, direction flipped
      ...times(4, { call: 'tick' }), { call: '$get', args: ['seg'] }, { call: '$get', args: ['f'] },
      { call: 'tick' }, { call: 'tick' }, { call: '$get', args: ['seg'] }, { call: '$get', args: ['f'] },   // through 0, flips again
      { call: '$set', args: ['rate', 15] }, { call: 'tick' }, { call: '$get', args: ['seg'] }, { call: '$get', args: ['f'] },   // multiple flips in one tick
      { call: 'stop' },
      { call: 'play', args: [{ loop: false, bounce: true, rate: 1 }] },              // bounce once
      { call: 'seek', args: [0] }, { call: '$get', args: ['$hooks'] },
      ...times(6, { call: 'tick' }), { call: '$get', args: ['seg'] }, { call: '$get', args: ['f'] },   // reaches 6, flips
      ...times(5, { call: 'tick' }), { call: '$get', args: ['seg'] }, { call: '$get', args: ['f'] },
      { call: 'tick' }, { call: '$get', args: ['playing'] }, { call: '$get', args: ['$hooks'] }, { call: 'time' },   // stops at the origin
    ] },
    { name: 'PoseTrack — samplers and interpolation modes', class: 'PoseTrack', steps: [
      { call: 'samplePos', args: [Z3, 0, 0.5] }, { call: 'tangents', args: [Z3, Z3, 0], writes: [0, 1] },   // empty: zeros
      { call: 'add', args: [[{ pos: [0, 0, 0], rot: Q.id }, { pos: [10, 0, 0], rot: Q.z90, tanOut: [0, 20, 0] },
                            { pos: [10, 10, 0], rot: Q.y90, scl: [2, 2, 2] }, { pos: [0, 10, 0], rot: neg(Q.z90), scl: [1, 3, 1] }]] },
      { call: 'samplePos', args: [Z3, 0, 0] }, { call: 'samplePos', args: [Z3, 0, 0.5] }, { call: 'samplePos', args: [Z3, 0, 1] },   // auto-CR tangents
      { call: 'samplePos', args: [Z3, 1, 0.5] },                                    // stored tanOut at k1 mirrors into tanIn
      { call: 'samplePos', args: [Z3, 2, 0.5] },
      { call: 'samplePos', args: [Z3, 3, 0] },                                      // seg === segments → (2, 1)
      { call: 'samplePos', args: [Z3, -1, 0.5] }, { call: 'samplePos', args: [Z3, 0, 1.5] }, { call: 'samplePos', args: [Z3, 1.9, 0.5] },   // clamps, |0
      { call: 'tangents', args: [Z3, Z3, 0], writes: [0, 1] }, { call: 'tangents', args: [Z3, Z3, 1], writes: [0, 1] },
      { call: 'tangents', args: [Z3, Z3, 2], writes: [0, 1] }, { call: 'tangents', args: [Z3, Z3, 3], writes: [0, 1] },
      { call: 'tangents', args: [Z3, Z3, 9], writes: [0, 1] },                      // clamped to the last keyframe
      { call: 'mat4Model', args: [M16, 1, 0.25], tol: 'f32' },
      { call: 'seek', args: [0.4] }, { call: 'samplePos', args: [Z3] }, { call: 'mat4Model', args: [M16], tol: 'f32' },   // cursor forms (t = 0.2)
      { call: 'eval' },                                                             // slerp
      { call: '$set', args: ['rotInterp', 'nlerp'] }, { call: 'eval' },
      { call: '$set', args: ['rotInterp', 'step'] }, { call: 'eval' },
      { call: '$set', args: ['posInterp', 'linear'] }, { call: 'samplePos', args: [Z3, 1, 0.5] }, { call: 'samplePos', args: [Z3] },
      { call: '$set', args: ['posInterp', 'step'] }, { call: 'samplePos', args: [Z3, 1, 0.5] }, { call: 'samplePos', args: [Z3, 1, 1] },
      { call: '$set', args: ['posInterp', 'hermite'] },
      { call: 'set', args: [2, { pos: [10, 10, 0], tanIn: [-5, 0, 0], tanOut: [0, 0, 5] }] },   // both tangents stored
      { call: 'tangents', args: [Z3, Z3, 2], writes: [0, 1] }, { call: 'samplePos', args: [Z3, 1, 0.5] }, { call: 'samplePos', args: [Z3, 2, 0.5] },
    ] },
    { name: 'CameraTrack — spec parser, defaults, edits', class: 'CameraTrack', steps: [
      { call: 'add', args: [{ eye: [0, 0, 5] }] },                                   // defaults: center 0, up +Y, fov/halfHeight null, near 0.1, far 1000
      { call: 'add', args: [{ eye: [3, 4, 5], center: [0, 1, 0], up: [0, 2, 0], fov: PI / 3, near: 1, far: 50, eyeTanOut: [1, 0, 0], centerTanIn: { x: 0, y: 1, z: 0 } }] },
      { call: 'add', args: [{ eye: [3, 4, 5], center: [0, 1, 0], up: [0, 2, 0], fov: PI / 3, near: 1, far: 50 }] },   // adjacent duplicate (tangents ignored): skipped
      { call: 'add', args: [{ eye: [0, 0, -5], halfHeight: 2, fov: '1' }] },         // non-number fov → null
      { call: 'add', args: [{ center: [1, 1, 1] }] }, { call: 'add', args: [{ eye: [1, 2] }] }, { call: 'add', args: [null] },   // no eye: ignored
      { call: 'add', args: [[{ eye: [1, 0, 0], up: [0, 0, 3] }, { eye: [1, 0, 0], up: [0, 0, 3] }]] },   // bulk, second is a duplicate
      { call: '$get', args: ['keyframes'] }, { call: '$get', args: ['segments'] },
      { call: 'set', args: [0, { eye: [0, 0, 9] }] }, { call: 'set', args: [0, { center: [0, 0, 9] }] }, { call: 'set', args: [4, { eye: [7, 7, 7] }] },
      { call: 'remove', args: [1] },
      { call: '$get', args: ['keyframes'] }, { call: 'info' },
      { call: '$get', args: ['eyeInterp'] }, { call: '$get', args: ['centerInterp'] },
    ] },
    { name: 'CameraTrack — eval: projection scalars, near/far lerp, up nlerp, one keyframe', class: 'CameraTrack', steps: [
      { call: 'eval' },                                                             // empty: defaults
      { call: 'add', args: [{ eye: [0, 0, 5], fov: PI / 3, near: 0.1, far: 100 }] },
      { call: 'eval' }, { call: 'play' }, { call: '$get', args: ['playing'] },       // one keyframe
      { call: 'add', args: [{ eye: [0, 5, 5], up: [1, 0, 0], fov: PI / 2, near: 1, far: 200 }] },
      { call: 'add', args: [{ eye: [5, 5, 5], center: [1, 1, 1], halfHeight: 2 }] },
      { call: 'add', args: [{ eye: [5, 0, 5], halfHeight: 4, near: 2, far: 20 }] },
      { call: 'seek', args: [0.5, 0] }, { call: 'eval' },                            // both fov: lerped
      { call: 'seek', args: [0.5, 1] }, { call: 'eval' },                            // mixed lens kinds: the segment's first keyframe's lens
      { call: 'seek', args: [1, 1] }, { call: 'eval' },                              // … until the segment's end, then the second's
      { call: 'seek', args: [0.5, 2] }, { call: 'eval' },                            // both halfHeight: lerped
      { call: 'seek', args: [1] }, { call: 'eval' },
      { call: 'seek', args: [0] }, { call: 'play', args: [{ duration: 2 }] }, { call: 'tick' }, { call: 'eval' }, { call: 'info' },   // shared transport
    ] },
    { name: 'CameraTrack — samplers and interpolation modes', class: 'CameraTrack', steps: [
      { call: 'sampleEye', args: [Z3, 0, 0.5] }, { call: 'mat4Eye', args: [M16, 0, 0.5], tol: 'f32' },   // empty
      { call: 'add', args: [[{ eye: [0, 0, 5] }, { eye: [5, 0, 5], center: [1, 0, 0], eyeTanIn: [0, 3, 0] },
                            { eye: [5, 0, -5], center: [2, 0, 0], centerTanOut: [0, 0, 4] }, { eye: [0, 0, -5], center: [0, 0, 0], up: [0, 0, 1] }]] },
      { call: 'sampleEye', args: [Z3, 0, 0.5] }, { call: 'sampleEye', args: [Z3, 1, 0.5] }, { call: 'sampleEye', args: [Z3, 2, 0.5] },   // hermite
      { call: 'sampleCenter', args: [Z3, 0, 0.5] }, { call: 'sampleCenter', args: [Z3, 1, 0.5] }, { call: 'sampleCenter', args: [Z3, 2, 0.5] },   // linear (default)
      { call: '$set', args: ['centerInterp', 'hermite'] }, { call: 'sampleCenter', args: [Z3, 1, 0.5] }, { call: 'sampleCenter', args: [Z3, 2, 0.5] },
      { call: '$set', args: ['eyeInterp', 'step'] }, { call: 'sampleEye', args: [Z3, 1, 0.5] },
      { call: '$set', args: ['eyeInterp', 'linear'] }, { call: 'sampleEye', args: [Z3, 1, 0.5] },
      { call: '$set', args: ['eyeInterp', 'hermite'] },
      { call: 'eyeTangents', args: [Z3, Z3, 0], writes: [0, 1] }, { call: 'eyeTangents', args: [Z3, Z3, 1], writes: [0, 1] }, { call: 'eyeTangents', args: [Z3, Z3, 3], writes: [0, 1] },
      { call: 'centerTangents', args: [Z3, Z3, 2], writes: [0, 1] }, { call: 'centerTangents', args: [Z3, Z3, 3], writes: [0, 1] },
      { call: 'mat4Eye', args: [M16, 2, 0.5], tol: 'f32' },
      { call: 'seek', args: [0.5] }, { call: 'sampleEye', args: [Z3] }, { call: 'sampleCenter', args: [Z3] }, { call: 'mat4Eye', args: [M16], tol: 'f32' },   // cursor forms
      { call: 'eval' },                                                             // up nlerped between +Y and +Z
    ] },
  ],
};

// =========================================================================
// handle
// =========================================================================

const { SPHERE, PLANE, AXIS, DIAL, POINT, DIRECTION } = tree;
const Z2 = [0, 0];
const R2 = Math.SQRT1_2;
const C32 = Math.cos(PI / 32), S32 = Math.sin(PI / 32);          // the 32-chain's chord midpoint direction
// A custom proxy — the helix of handle-examples/10 as a capsule chain: one link from θ to θ + π/16 on
// p(θ) = (2cosθ, 2sinθ, θ/2π), tube 0.3, the ray aimed at the link's midpoint from outside, at three angles.
const HELIX = [0, PI / 2, PI].map(th => {
  const p = (t) => [2 * Math.cos(t), 2 * Math.sin(t), t / (2 * PI)];
  const m = th + PI / 32;
  return [5 * Math.cos(m), 5 * Math.sin(m), m / (2 * PI), -Math.cos(m), -Math.sin(m), 0, ...p(th), ...p(th + PI / 16), 0.3];
});

const handle = {
  functions: {
    rayHitSphere: f64([
      [0, 0, 5, 0, 0, -1, 0, 0, 0, 1],                          // direct: t = 4
      [0, 1, 5, 0, 0, -1, 0, 0, 0, 1],                          // grazing: disc = 0
      [0, 3, 5, 0, 0, -1, 0, 0, 0, 1],                          // miss
      [0, 0, 0, 0, 0, -1, 0, 0, 0, 1],                          // origin inside: the exit
      [0, 0, 5, 0, 0, 1, 0, 0, 0, 1],                           // pointing away: Infinity
      [3, 0, 3, -R2, 0, -R2, 1, 0, 0, 2],                       // oblique, off-centre sphere
      [1, 0, 0, 0, 0, -1, 1, 0, -10, 1],                        // ordering: the sphere at t = 9 (rayHitRing's last two cases)
    ]),
    rayHitCapsule: f64([
      [2, 0, 5, 0, 0, -1, 0, 0, 0, 4, 0, 0, 1],                 // direct: the wall
      [2, 1, 5, 0, 0, -1, 0, 0, 0, 4, 0, 0, 1],                 // grazing the wall
      [2, 3, 5, 0, 0, -1, 0, 0, 0, 4, 0, 0, 1],                 // miss
      [2, 0, 0, 0, 0, -1, 0, 0, 0, 4, 0, 0, 1],                 // origin inside: exits the wall
      [0, 0, 0, -1, 0, 0, 0, 0, 0, 4, 0, 0, 1],                 // origin inside, along the axis: exits cap A
      [-5, 0, 0, 1, 0, 0, 0, 0, 0, 4, 0, 0, 1],                 // along the axis: cap A
      [9, 0.5, 0, -1, 0, 0, 0, 0, 0, 4, 0, 0, 1],               // cap B
      [7, 2, 0, -R2, -R2, 0, 0, 0, 0, 4, 0, 0, 1],              // oblique onto cap B
      [-0.5, 0.5, 5, 0, 0, -1, 0, 0, 0, 4, 0, 0, 1],            // wall hit beyond the extent: falls to cap A
      [0, 0, 5, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1],                 // zero-length segment: the sphere at A
      ...HELIX,                                                 // a custom proxy: the helix link at θ = 0, π/2, π
    ]),
    rayHitRing: f64([
      [10, 0, 5, 0, 0, -1, 0, 0, 0, 0, 0, 1, 10, 0.5],          // face-on onto a vertex
      [0, 0, 5, 0, 0, -1, 0, 0, 0, 0, 0, 1, 10, 0.5],           // through the hole: miss
      [10 * C32, 10 * S32, 5, 0, 0, -1, 0, 0, 0, 0, 0, 1, 10, 0.5],   // face-on at a chord midpoint, on the true circle
      [10, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, 1, 10, 0.5],          // origin inside the tube
      [20, 0, 0, -1, 0, 0, 0, 0, 0, 0, 0, 1, 10, 0.5],          // edge-on onto a vertex
      [20 * C32, 20 * S32, 0, -C32, -S32, 0, 0, 0, 0, 0, 0, 1, 10, 0.5],   // edge-on at the chordal bound
      [20, 10.5, 0, -1, 0, 0, 0, 0, 0, 0, 0, 1, 10, 0.5],       // edge-on grazing a vertex
      [20, 0, 0, -1, 0, 0, 0, 0, 0, 0, 0, 3, 10, 0.5],          // normal not unit
      [20, 0, 0, -1, 0, 0, 0, 0, 0, 0, 0, 1, 10, 0.5, 4],       // detail 4: a vertex
      [20 * R2, 20 * R2, 0, -R2, -R2, 0, 0, 0, 0, 0, 0, 1, 10, 0.5, 4],   // detail 4 at the chordal bound
      [1, 0, 0, 0, 0, -1, 0, 0, -5, 0, 0, 1, 1, 0.2],           // ordering: the ring in front of the sphere
      [1, 0, 0, 0, 0, -1, 0, 0, -15, 0, 0, 1, 1, 0.2],          // ordering: behind it
    ]),
    raySphere: f64([
      [Z3, 0, 0, 5, 0, 0, -1, 0, 0, 0, 1],                     // hit from outside: near root
      [Z3, 0, 0, 0, 0, 0, -1, 0, 0, 0, 1],                     // origin inside: far root
      [Z3, 0, 3, 5, 0, 0, -1, 0, 0, 0, 1],                     // miss: closest approach projected onto the sphere
      [Z3, 0, 1, 5, 0, 0, -1, 0, 0, 0, 1],                     // tangent: disc = 0
      [Z3, 3, 4, 5, -R2, 0, -R2, 1, 0, 0, 2],                  // oblique hit, off-centre sphere
      [Z3, 0, 0, 5, 0, 0, 1, 0, 0, 0, 1],                      // pointing away: both roots negative → far root (still negative)
    ], { writes: [0] }),
    rayPlane: f64([
      [Z3, 0, 5, 0, 0, -1, 0, 0, 1, 0, 0, 1, 0],
      [Z3, 3, 4, 5, -R2, -R2, 0, 0, 0, 0, 0, 1, 0],            // oblique
      [Z3, 0, 5, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0],                // parallel: Infinity, out untouched
      [[7, 7, 7], 0, 5, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0],         // parallel: previous out kept
      [Z3, 0, 5, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],                // behind the origin: negative t
    ], { writes: [0] }),
    rayClosestPointOnAxis: f64([
      [Z3, 5, 1, 0, -1, 0, 0, 0, 0, 0, 0, 1, 0],               // skew: ray along −x at y = 1, line = y axis
      [Z3, 5, 0, 3, -1, 0, 0, 0, 0, 0, 0, 1, 0],               // skew, offset in z
      [Z3, 0, 0, 5, 0, 0, -1, 0, 0, 0, 1, 0, 0],               // intersecting
      [Z3, 2, 3, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0],                // parallel: origin projected onto the line
      [Z3, 1, 1, 1, R2, R2, 0, -1, 0, 0, 0, 0, 1],             // generic
    ], { writes: [0] }),
    dirFromAzEl: f64([[Z3, 0, 0], [Z3, PI / 2, 0], [Z3, 0, PI / 2], [Z3, PI, -PI / 2], [Z3, 0.7, -0.3]]),
    azElFromDir: f64([
      [Z2, 1, 0, 0], [Z2, 0, 0, 1], [Z2, 0, 1, 0], [Z2, -1, 0, 0],
      [Z2, ...tree.dirFromAzEl([0, 0, 0], 0.7, -0.3)],       // inverse of dirFromAzEl
      [Z2, 0, 1.5, 0],                                        // dy clamped to [−1, 1]
    ]),
  },
  transcripts: [
    { name: 'Constraint SPHERE — direction state, value modes, seed, azEl, live radius', class: 'Constraint', args: [SPHERE, { radius: 2, anchor: [1, 0, 0] }], steps: [
      { call: '$get', args: ['kind'] }, { call: '$get', args: ['anchor'] }, { call: '$get', args: ['dir'] }, { call: '$get', args: ['radius'] },
      { call: '$get', args: ['report'] }, { call: '$get', args: ['min'] }, { call: '$get', args: ['max'] },
      { call: 'scalar' },                                                           // not a scalar kind: NaN
      { call: 'value', args: [Z3] }, { call: 'value', args: [Z3, POINT] },
      { call: 'solve', args: [1, 0, 5, 0, 0, -1] }, { call: 'value', args: [Z3] }, { call: 'value', args: [Z3, POINT] }, { call: 'azEl', args: [Z2] },
      { call: 'solve', args: [4, 2, 5, -R2, 0, -R2] }, { call: 'value', args: [Z3] }, { call: 'value', args: [Z3, POINT] }, { call: 'azEl', args: [Z2] },
      { call: 'solve', args: [1, 3, 5, 0, 0, -1] }, { call: 'value', args: [Z3] },      // miss: tracks the limb
      { call: 'seed', args: [3, 0, 0] }, { call: 'value', args: [Z3] },                  // a point seeds its heading
      { call: 'seed', args: [1, 0, 0] }, { call: 'value', args: [Z3] },                  // at the anchor: unchanged
      { call: 'seed', args: [1, -4, 0] }, { call: 'azEl', args: [Z2] },
      { call: '$set', args: ['radius', 5] }, { call: 'value', args: [Z3, POINT] },       // POINT follows the live radius
      { call: '$set', args: ['radius', 'x'] }, { call: '$get', args: ['radius'] },       // non-number ignored
      { call: 'aim', args: [0, 1, 0] }, { call: '$get', args: ['dir'] },                  // no basis: no-op
      { call: '$get', args: ['pt'] },
      { call: 'proxy', args: [1, -5, 10, 0, 0, -1, 0.5] },                                 // the sphere at the POINT (1, −5, 0): t = 9.5
      { call: 'proxy', args: [1, 0, 10, 0, 0, -1, 0.5] },                                  // miss
    ] },
    { name: 'Constraint PLANE — point state, parallel ray keeps last, seed projects, aim re-projects', class: 'Constraint', args: [PLANE, { anchor: [0, 1, 0], normal: [0, 2, 0] }], steps: [
      { call: '$get', args: ['kind'] }, { call: '$get', args: ['n'] }, { call: '$get', args: ['pt'] }, { call: '$get', args: ['report'] },
      { call: 'solve', args: [0, 5, 0, 0, -1, 0] }, { call: 'value', args: [Z3] },
      { call: 'solve', args: [3, 4, 5, -R2, -R2, 0] }, { call: 'value', args: [Z3] }, { call: 'value', args: [Z3, DIRECTION] },   // PLANE always reports the point
      { call: 'solve', args: [0, 5, 0, 1, 0, 0] }, { call: 'value', args: [Z3] },        // parallel: last point kept
      { call: 'seed', args: [3, 7, -2] }, { call: 'value', args: [Z3] },
      { call: 'aim', args: [1, 0, 0] }, { call: '$get', args: ['n'] }, { call: 'value', args: [Z3] },   // point re-projected onto the new plane
      { call: 'aim', args: [0, 0, 0] }, { call: '$get', args: ['n'] },                   // zero-length: previous normal kept
      { call: 'aim', args: [0, 0, -3] }, { call: '$get', args: ['n'] }, { call: 'value', args: [Z3] },
      { call: 'scalar' },
      { call: 'seed', args: [2, 0, 0] }, { call: 'proxy', args: [2, 0, 5, 0, 0, -1, 0.25] },   // the sphere at the point: t = 4.75
      { call: 'proxy', args: [2, 1, 5, 0, 0, -1, 0.25] },                                     // miss
    ] },
    { name: 'Constraint AXIS — scalar t, extent clamp, parallel ray, seed, aim preserves t', class: 'Constraint', args: [AXIS, { axis: [0, 3, 0], extent: [-2, 4] }], steps: [
      { call: '$get', args: ['kind'] }, { call: '$get', args: ['u'] }, { call: '$get', args: ['min'] }, { call: '$get', args: ['max'] }, { call: 'scalar' },
      { call: 'solve', args: [5, 1, 0, -1, 0, 0] }, { call: 'scalar' }, { call: 'value', args: [Z3] },
      { call: 'solve', args: [5, 9, 0, -1, 0, 0] }, { call: 'scalar' }, { call: 'value', args: [Z3] },      // clamped to max
      { call: 'solve', args: [5, -9, 0, -1, 0, 0] }, { call: 'scalar' }, { call: 'value', args: [Z3] },     // clamped to min
      { call: 'solve', args: [2, 3, 0, 0, 1, 0] }, { call: 'scalar' }, { call: 'value', args: [Z3] },       // parallel: origin projected
      { call: 'solve', args: [1, 1, 1, R2, 0, -R2] }, { call: 'scalar' }, { call: 'value', args: [Z3] },
      { call: 'seed', args: [9, 2.5, 9] }, { call: 'scalar' }, { call: 'value', args: [Z3] },
      { call: 'seed', args: [0, 9, 0] }, { call: 'scalar' },                              // clamped
      { call: 'aim', args: [2, 0, 0] }, { call: '$get', args: ['u'] }, { call: 'scalar' }, { call: 'value', args: [Z3] },   // t preserved, point recomputed
      { call: 'aim', args: [0, 0, 0] }, { call: '$get', args: ['u'] },
      { call: '$set', args: ['max', 1] }, { call: 'solve', args: [5, 3, 0, -1, 0, 0] }, { call: 'scalar' },
      { call: 'proxy', args: [1, 0, 5, 0, 0, -1, 0.5] },                                   // the sphere at the clamped point (1, 0, 0): t = 4.5
      { call: 'proxy', args: [3, 0, 5, 0, 0, -1, 0.5] },                                   // miss
    ] },
    { name: 'Constraint DIAL — winding θ, face-on and edge-on solves, seed nearest winding, aim rebuilds the basis', class: 'Constraint', args: [DIAL, { axis: [0, 0, 1], radius: 2, zero: [1, 0, 0] }], steps: [
      { call: '$get', args: ['kind'] }, { call: '$get', args: ['u'] }, { call: '$get', args: ['r0'] }, { call: '$get', args: ['r1'] },
      { call: '$get', args: ['min'] }, { call: '$get', args: ['max'] }, { call: 'scalar' }, { call: 'value', args: [Z3] }, { call: 'value', args: [Z3, DIRECTION] },
      { call: 'solve', args: [0, 2, 5, 0, 0, -1] }, { call: 'scalar' }, { call: 'value', args: [Z3] }, { call: 'value', args: [Z3, DIRECTION] },   // θ = π/2
      { call: 'solve', args: [-2, 0, 5, 0, 0, -1] }, { call: 'scalar' },                 // π
      { call: 'solve', args: [0, -2, 5, 0, 0, -1] }, { call: 'scalar' },                 // 3π/2: the smaller arc, winding kept
      { call: 'solve', args: [2, 0, 5, 0, 0, -1] }, { call: 'scalar' },                  // 2π: a full turn accumulated
      { call: 'solve', args: [0, -2, 5, 0, 0, -1] }, { call: 'scalar' },                 // back to 3π/2
      { call: 'solve', args: [5, 0, 0, -1, 0, 0] }, { call: 'scalar' },                  // edge-on (d ⊥ u): tangent-line fallback
      { call: 'solve', args: [5, 1, 0, -0.9987523388778445, 0, 0.04993761694389223] }, { call: 'scalar' }, { call: 'value', args: [Z3] },   // |d·u| = 0.05 < edge threshold
      { call: 'seed', args: [0, -2, 0] }, { call: 'scalar' },                            // nearest winding to the current θ
      { call: 'seed', args: [0, 0, 0] }, { call: 'scalar' },                             // at the anchor: θ unchanged
      { call: '$set', args: ['radius', 3] }, { call: 'value', args: [Z3] }, { call: '$get', args: ['pt'] },
      { call: 'aim', args: [0, 1, 0] }, { call: '$get', args: ['u'] }, { call: '$get', args: ['r0'] }, { call: '$get', args: ['r1'] }, { call: 'scalar' }, { call: 'value', args: [Z3] },   // reference re-derived
      { call: 'aim', args: [0, 1, 0, 0, 0, 1] }, { call: '$get', args: ['r0'] }, { call: '$get', args: ['r1'] }, { call: 'value', args: [Z3] },   // explicit θ = 0 reference
      { call: 'aim', args: [0, 1, 0, 0, 5, 0] }, { call: '$get', args: ['r0'] },          // reference ∥ axis: re-derived
      { call: '$set', args: ['min', 0] }, { call: '$set', args: ['max', 1] }, { call: 'seed', args: [0, 0, 3] }, { call: 'scalar' },   // clamped
      { call: 'proxy', args: [3, 5, 0, 0, -1, 0, 0.3] },                                   // the ring (R = 3 about +Y) face-on at a vertex: t = 4.7
      { call: 'proxy', args: [0, 5, 0, 0, -1, 0, 0.3] },                                   // through the hole: miss
      { call: 'proxy', args: [10, 0, 0, -1, 0, 0, 0.3] },                                  // edge-on: t = 6.7
    ] },
    { name: 'Constraint DIAL via createConstraint — derived reference, default extent', class: 'createConstraint', args: [DIAL, { radius: 1 }], steps: [
      { call: '$get', args: ['kind'] }, { call: '$get', args: ['u'] }, { call: '$get', args: ['r0'] }, { call: '$get', args: ['r1'] }, { call: '$get', args: ['pt'] },
      { call: '$get', args: ['min'] }, { call: '$get', args: ['max'] }, { call: '$get', args: ['report'] },
      { call: 'solve', args: [0, 5, 1, 0, -1, 0] }, { call: 'scalar' }, { call: 'value', args: [Z3] },
    ] },
    { name: 'Constraint — opts parsing: {x,y,z} anchor, non-number radius, report override', class: 'Constraint', args: [SPHERE, { radius: 'x', anchor: { x: 1 }, report: POINT }], steps: [
      { call: '$get', args: ['radius'] }, { call: '$get', args: ['anchor'] }, { call: '$get', args: ['report'] }, { call: 'value', args: [Z3] },
    ] },
    { name: 'Constraint — opts parsing: zero normal defaults, partial extent, bad report', class: 'Constraint', args: [PLANE, { normal: [0, 0, 0], extent: [1], report: 7 }], steps: [
      { call: '$get', args: ['n'] }, { call: '$get', args: ['min'] }, { call: '$get', args: ['max'] }, { call: '$get', args: ['report'] },
    ] },
  ],
};

// =========================================================================
// helm
// =========================================================================

const POSE0  = { pos: [0, 0, 0], rot: [0, 0, 0, 1] };
const RATE0  = { lin: [0, 0, 0], ang: [0, 0, 0] };
const RAW = {                                                          // unit sens, in-order lanes, positive signs
  Tx: { sign: 1, sens: 1, lane: 0 }, Ty: { sign: 1, sens: 1, lane: 1 }, Tz: { sign: 1, sens: 1, lane: 2 },
  Rp: { sign: 1, sens: 1, lane: 0 }, Ry: { sign: 1, sens: 1, lane: 1 }, Rr: { sign: 1, sens: 1, lane: 2 },
};
// The lanes are eye-frame and the null basis is the identity EYE matrix (forward = −Z), so
// world-axis rates retrace only with the two Z channels flipped: the world-retracing profile.
const RETRACE = { ...RAW, Tz: { sign: -1, sens: 1, lane: 2 }, Rr: { sign: -1, sens: 1, lane: 2 } };
const poseA = { pos: [1, 2, 3], rot: Q.g }, poseB = { pos: [1.5, 2, 2], rot: tree.qMul([], aa(0, 1, 0, 0.2), Q.g) };
const rateAB = tree.poseDelta({ lin: [0, 0, 0], ang: [0, 0, 0] }, poseA, poseB, 0.25);   // fed back below: retraces poseB

const helm = {
  constants: ['HELM_CHANNELS'],
  functions: {
    poseDelta: f64([
      [RATE0, POSE0, POSE0, 0.1],                                              // at rest
      [RATE0, POSE0, { pos: [1, 2, 3], rot: Q.id }, 0.5],                      // translation only
      [RATE0, POSE0, { pos: [0, 0, 0], rot: Q.z90 }, 1],                       // rotation only: ω = axis · angle / dt
      [RATE0, POSE0, { pos: [0, 0, 0], rot: Q.z90 }, 0.5],
      [RATE0, POSE0, { pos: [0, 0, 0], rot: neg(Q.z90) }, 1],                  // double cover: −q is the same rotation
      [RATE0, { pos: [0, 0, 0], rot: Q.z90 }, POSE0, 1],                       // reverse: negative ω
      [RATE0, poseA, poseB, 0.25],
      [RATE0, { pos: [0, 0, 0], rot: Q.g }, { pos: [0, 0, 0], rot: neg(Q.h) }, 1],   // dot < 0: cur flipped first
      [RATE0, POSE0, { pos: [0, 0, 0], rot: [1e-9, 0, 0, 1] }, 1],             // below threshold: exact zero
      [null, POSE0, { pos: [2, 0, 0], rot: Q.id }, 2],                         // out omitted: a fresh object
    ]),
  },
  transcripts: [
    { name: 'PoseHelm — defaults, feed, activity, deadzone, step in WORLD, home', class: 'PoseHelm', steps: [
      { call: '$get', args: ['profile'] }, { call: '$get', args: ['deadzone'] }, { call: '$get', args: ['fullScale'] },
      { call: '$get', args: ['filter'] }, { call: '$get', args: ['from'] },
      { call: 'eval', args: [POSE0] }, { call: 'activity', args: [V6] },
      { call: 'feed', args: [[100, 0, 0]] }, { call: 'activity', args: [V6] },
      { call: 'step', args: [POSE0, 0.1, null] }, { call: 'step', args: [POSE0, 0.1, null] },   // rate persists until the next feed
      { call: 'feed', args: [[8, -8, 5], [0, 0, 0]] }, { call: 'activity', args: [V6] },       // |v| ≤ deadzone reads 0
      { call: 'step', args: [POSE0, 1, null] },
      { call: 'feed', args: [[0, 0, 0], [0, 0, 100]] }, { call: 'activity', args: [V6] },       // lane 2 drives Ry
      { call: 'step', args: [POSE0, 1, null] }, { call: 'step', args: [POSE0, 0.5, null] },
      { call: 'feed', args: [[0, 0, 100]] },                                                   // rotation half unchanged
      { call: 'activity', args: [V6] }, { call: 'step', args: [POSE0, 0.1, null] },
      { call: 'feed', args: [null, [50, 0, 0]] }, { call: 'activity', args: [V6] },            // translation half unchanged
      { call: 'step', args: [POSE0, 0.1, null] }, { call: 'eval', args: [POSE0] },
      { call: '$set', args: ['fullScale', 1] }, { call: 'step', args: [POSE0, 0.1, null] },     // display-only: no effect on the pose
      { call: 'home' }, { call: 'eval', args: [POSE0] }, { call: 'activity', args: [V6] },       // identity pose, pending rate cleared
      { call: 'home', args: [{ pos: [1, 2, 3], rot: Q.z90 }] }, { call: 'eval', args: [POSE0] },
      { call: 'home', args: [{ pos: [4, 5, 6] }] }, { call: 'eval', args: [POSE0] },            // partial: rot to identity
    ] },
    { name: 'PoseHelm — basis: rates rotated through an eye→world frame', class: 'PoseHelm', steps: [
      { call: '$set', args: ['from', 'WORLD'] }, { call: '$get', args: ['from'] },              // declarative only
      { call: 'feed', args: [[100, 0, 0], [0, 0, 0]] },
      { call: 'step', args: [POSE0, 1, tree.mat4Eye([], 3, 4, 5, 0, 1, 0, 0, 1, 0)] },           // +X → the camera's right
      { call: 'home' }, { call: 'feed', args: [[0, 0, 100]] },
      { call: 'step', args: [POSE0, 1, tree.mat4Eye([], 3, 4, 5, 0, 1, 0, 0, 1, 0)] },           // lane 2 → Ty, sign −1: a positive rate (the cap pushed down) moves down
      { call: 'home' }, { call: 'feed', args: [[0, 100, 0]] },
      { call: 'step', args: [POSE0, 1, tree.mat4Eye([], 3, 4, 5, 0, 1, 0, 0, 1, 0)] },           // lane 1 → Tz, sign −1: a positive rate moves back
      { call: 'home' }, { call: 'feed', args: [[0, 0, 0], [100, 0, 0]] },
      { call: 'step', args: [POSE0, 1, tree.qToMat4([], Q.z90)] },                              // pitch axis rotated by the basis
      { call: 'step', args: [POSE0, 1, tree.qToMat4([], Q.z90)] },
      { call: 'step', args: [POSE0, 1, I16] },                                                  // identity basis ≡ null
    ] },
    { name: 'PoseHelm — raw and world-retracing profiles: eye-frame lanes, poseDelta round trip', class: 'PoseHelm', steps: [
      { call: '$set', args: ['profile', RAW] }, { call: '$set', args: ['deadzone', 0] },
      { call: 'feed', args: [[1, 2, 3], [0, 0, 0.1]] }, { call: 'activity', args: [V6] },
      { call: 'step', args: [POSE0, 1, null] },                                                 // Tz and Rr drive −Z: pos.z = −3, roll about −Z
      { call: '$set', args: ['profile', RETRACE] },
      { call: 'home', args: [poseA] }, { call: 'feed', args: [rateAB.lin, rateAB.ang] },
      { call: 'step', args: [POSE0, 0.25, null] },                                              // = poseB: the round trip
      { call: 'feed', args: [[0, 0, 0], [0, 0, 1]] },
      { call: 'step', args: [POSE0, PI / 2, null] },                                            // quarter turn about world +Z
    ] },
    { name: 'PoseHelm — filter: 1€ before the deadzone, raw activity, reset on home', class: 'PoseHelm', steps: [
      { call: '$set', args: ['profile', RAW] }, { call: '$set', args: ['deadzone', 0] },
      { call: '$set', args: ['filter', { $oneEuro: { minCutoff: 1, beta: 0 } }] },
      { call: 'feed', args: [[60, 0, 0]] },
      { call: 'step', args: [POSE0, DT, null] },                                                // primes: full rate
      { call: 'feed', args: [[0, 0, 0]] }, { call: 'activity', args: [V6] },                     // raw reads 0
      { call: 'step', args: [POSE0, DT, null] }, { call: 'step', args: [POSE0, DT, null] },      // filtered rate decays: still moving
      { call: '$set', args: ['deadzone', 55] }, { call: 'feed', args: [[60, 0, 0]] },
      { call: 'step', args: [POSE0, DT, null] }, { call: 'step', args: [POSE0, DT, null] },      // filtered value still below the deadzone: gated, no motion
      { call: 'home' }, { call: 'feed', args: [[60, 0, 0]] },
      { call: 'step', args: [POSE0, DT, null] },                                                // filter reset: primes again
    ] },
  ],
};

// =========================================================================
// visibility
// =========================================================================

const P24  = new Array(24).fill(0);
const Fr   = frustum(PI / 3, 4 / 3, 0.1);                                        // [left, right, bottom, top]
const camO = [0, 0, 0, 0, 0, -1, 0, 1, 0, 1, 0, 0];                              // origin, looking −Z, up +Y, right +X
const Eg   = tree.mat4Eye([], 3, 4, 5, 0, 1, 0, 0, 1, 0);
const camG = [3, 4, 5, -Eg[8], -Eg[9], -Eg[10], Eg[4], Eg[5], Eg[6], Eg[0], Eg[1], Eg[2]];
const persp = tree.frustumPlanes(new Array(24).fill(0), ...camO, false, 0.1, 100, Fr[0], Fr[1], Fr[3], Fr[2]);
const ortho = tree.frustumPlanes(new Array(24).fill(0), ...camO, true, 0.1, 100, -2, 2, 1, -1);
const perspG = tree.frustumPlanes(new Array(24).fill(0), ...camG, false, 0.1, 100, Fr[0], Fr[1], Fr[3], Fr[2]);

const visibility = {
  constants: ['PLANE_LEFT', 'PLANE_RIGHT', 'PLANE_NEAR', 'PLANE_FAR', 'PLANE_TOP', 'PLANE_BOTTOM'],
  functions: {
    planes: f64([[]]),
    frustumPlanes: f64([
      [P24, ...camO, false, 0.1, 100, Fr[0], Fr[1], Fr[3], Fr[2]],
      [P24, ...camO, true, 0.1, 100, -2, 2, 1, -1],
      [P24, ...camO, false, 0.1, 50, -0.05, 0.15, 0.1, -0.1],                   // off-centre
      [P24, ...camG, false, 0.1, 100, Fr[0], Fr[1], Fr[3], Fr[2]],
    ]),
    distanceToPlane: f64([
      [persp, 2, 0, 0, -5], [persp, 3, 0, 0, -5], [persp, 0, 0, 0, -5], [persp, 4, 0, 0, -5],
      [persp, 2, 0, 0, 5],                                                       // behind the near plane: positive
      [ortho, 1, 3, 0, -5], [perspG, 2, 0, 1, 0],
    ]),
    pointVisibility: exact([
      [persp, 0, 0, -5], [persp, 0, 0, 5], [persp, -10, 0, -5], [persp, 0, 0, -200],
      [persp, 0, 0, -0.1],                                                       // on the near plane: inside (boundary inclusive)
      [persp, 0, 0, -100],                                                       // on the far plane
      [ortho, 1.5, 0, -50], [ortho, 2.5, 0, -50],
      [perspG, 0, 1, 0], [perspG, 3, 4, 5],
    ]),
    sphereVisibility: exact([
      [persp, 0, 0, -5, 0.5], [persp, 0, 0, -0.1, 0.5], [persp, 0, 0, 5, 1], [persp, 0, 0, -5, 1000],
      [persp, 0, 0, -5, 0],                                                      // a point
      [ortho, 1.5, 0, -50, 0.4], [ortho, 1.5, 0, -50, 0.6], [perspG, 0, 1, 0, 1],
    ]),
    boxVisibility: exact([
      [persp, -1, -1, -6, 1, 1, -4], [persp, -1, -1, -1, 1, 1, 1], [persp, -1, -1, 1, 1, 1, 3],
      [persp, -1000, -1000, -1000, 1000, 1000, 1000],
      [persp, 1, 1, -4, -1, -1, -6],                                             // corners given in either order
      [ortho, -1, -0.5, -50, 1, 0.5, -40], [ortho, 1, -0.5, -50, 3, 0.5, -40], [perspG, -1, 0, -1, 1, 2, 1],
    ]),
  },
};

// =========================================================================
// camera
// =========================================================================

const camDef   = tree.createCamera();
const camA     = tree.createCamera({ eye: [3, 4, 5], center: [0, 1, 0], up: [0, 2, 0], fov: PI / 4, near: 1, far: 50 });
const camOrtho = tree.createCamera({ eye: [3, 4, 5], center: [0, 1, 0], halfHeight: 2, near: 0.5, far: 20 });
const camZup   = tree.createCamera({ eye: [-2, 1, -3], center: [1, 2, 3], up: [0, 0, 1], fov: 1.2 });
const camPole  = tree.createCamera({ eye: [0, 5, 0], center: [0, 0, 0] });                  // up ∥ view direction: re-seeded
const camNone  = tree.createCamera({ fov: null });                                         // no lens
const camDeg   = tree.createCamera({ eye: [1, 1, 1], center: [1, 1, 1] });                  // degenerate gaze distance
const CAMS     = [camDef, camA, camOrtho, camZup, camPole];
const camE = (c) => tree.cameraEye([], c);
const camP = (c, ndc, ys) => tree.cameraProj([], c, 4 / 3, ndc, ys);

const camera = {
  functions: {
    createCamera: f64([
      [], [{}],
      [{ eye: [3, 4, 5], center: [0, 1, 0], up: [0, 2, 0], fov: PI / 4, near: 1, far: 50 }],
      [{ halfHeight: 2 }],                                                          // orthographic: fov null
      [{ fov: null, halfHeight: 2 }], [{ fov: 1, halfHeight: 2 }],                  // as given
      [{ eye: [1, 2, 3], near: '1', far: null }],                                   // non-number clip distances → defaults
    ]),
    cameraCopy: f64([[camDef, camA], [camA, camOrtho], [camOrtho, camNone]]),
    cameraView: f32(CAMS.map(c => [M16, c])),
    cameraEye:  f32(CAMS.map(c => [M16, c])),
    cameraProj: f32([
      ...CAMS.flatMap(c => [[M16, c, 4 / 3, WEBGL], [M16, c, 4 / 3, WEBGPU]]),
      [M16, camA, 1, WEBGL], [M16, camA, 4 / 3, WEBGL, -1], [M16, camOrtho, 4 / 3, WEBGL, -1],   // square; NDC y-down
      [M16, camNone, 4 / 3, WEBGL],                                                              // no lens: null, out untouched
    ], { writes: [0] }),
    cameraPlanes: f64([
      ...CAMS.map(c => [P24, c, 4 / 3]), [P24, camA, 1], [P24, camOrtho, 2],
      [P24, camNone, 4 / 3],                                                                     // no lens: null
    ]),
    cameraFromMat4: f32([
      ...[[camA, WEBGL, 1], [camA, WEBGPU, 1], [camOrtho, WEBGL, 1], [camOrtho, WEBGPU, 1],
          [camZup, WEBGL, 1], [camPole, WEBGL, 1], [camA, WEBGL, -1], [camOrtho, WEBGL, -1]]
        .map(([c, ndc, ys]) => [c, camE(c), camP(c, ndc, ys), ndc]),                            // round trips: the state reproduces itself
      [camDef, camE(camA), camP(camA, WEBGL, 1), WEBGL],                                         // gaze distance kept from the previous state
      [camDeg, camE(camA), camP(camA, WEBGL, 1), WEBGL],                                         // degenerate: distance 1
      [camA, I16, camP(camOrtho, WEBGL, 1), WEBGL],                                              // identity eye: forward −Z, up +Y
    ]),
    cameraFromPose: f64([
      [camA, POSE0],                                                                             // identity: forward −Z, distance kept
      [camA, { pos: [1, 2, 3], rot: Q.z90 }], [camOrtho, { pos: [0, 0, 0], rot: Q.g }],           // lens untouched
      [camDeg, { pos: [1, 2, 3], rot: Q.x90 }],                                                  // degenerate: distance 1
      ...CAMS.map(c => [c, tree.cameraToPose({ pos: [0, 0, 0], rot: [0, 0, 0, 1] }, c)]),       // cameraToPose → cameraFromPose reproduces eye and center
    ]),
    cameraToPose: f64(CAMS.map(c => [POSE0, c])),
  },
  transcripts: [
    { name: 'camera — orbit: azimuth about up, elevation to the guard, no roll', class: 'createCamera', args: [{ eye: [0, 0, 5], center: [0, 0, 0] }], steps: [
      { call: '$fn', args: ['cameraOrbit', PI / 2, 0] },                        // eye → +X
      { call: '$fn', args: ['cameraOrbit', 0, PI / 4] },
      { call: '$fn', args: ['cameraOrbit', 0, 10] },                            // clamped to maxEl
      { call: '$fn', args: ['cameraOrbit', 0, -10] },                           // and to −maxEl
      { call: '$fn', args: ['cameraOrbit', 0.3, 0] },                           // azimuth keeps the elevation and the distance
      { call: '$fn', args: ['cameraOrbit', 0, 5, { maxEl: PI / 4 }] },
      { call: '$fn', args: ['cameraOrbit', 0, 0] },                             // no-op
      { call: '$fn', args: ['cameraOrbit', -1.2, -0.4] },
    ] },
    { name: 'camera — orbit in a z-up world with a non-unit hint', class: 'createCamera', args: [{ eye: [3, 4, 5], center: [0, 1, 0], up: [0, 0, 2] }], steps: [
      { call: '$fn', args: ['cameraOrbit', 1.1, 0] }, { call: '$fn', args: ['cameraOrbit', 0, 0.2] }, { call: '$fn', args: ['cameraOrbit', -0.5, -0.9] },
    ] },
    { name: 'camera — orbit from the pole: the guard pulls the eye inside', class: 'createCamera', args: [{ eye: [0, 5, 0], center: [0, 0, 0] }], steps: [
      { call: '$fn', args: ['cameraOrbit', 0, 0] },                             // stays at the pole
      { call: '$fn', args: ['cameraOrbit', 0.1, 0] },
      { call: '$fn', args: ['cameraOrbit', 0, -0.5] },
    ] },
    { name: 'camera — dolly: gaze distance to the clamps under perspective, halfHeight under orthographic', class: 'createCamera', args: [{ eye: [0, 0, 10], center: [0, 0, 0] }], steps: [
      { call: '$fn', args: ['cameraDolly', 0.5] },
      { call: '$fn', args: ['cameraDolly', 0.1, { min: 2 }] },
      { call: '$fn', args: ['cameraDolly', 100, { max: 50 }] },
      { call: '$fn', args: ['cameraDolly', 0] }, { call: '$fn', args: ['cameraDolly', -1] },    // collapse: no-op
      { call: '$set', args: ['fov', null] }, { call: '$set', args: ['halfHeight', 3] },
      { call: '$fn', args: ['cameraDolly', 2] },                                // orthographic: halfHeight scales, the eye stays
      { call: '$fn', args: ['cameraDolly', 10, { max: 20 }] },
      { call: '$set', args: ['fov', 1] },
      { call: '$fn', args: ['cameraDolly', 0.5] },                              // fov wins: the eye moves
    ] },
    { name: 'camera — pan along the eye\'s right and up, then an orbit', class: 'createCamera', args: [{ eye: [3, 4, 5], center: [0, 1, 0] }], steps: [
      { call: '$fn', args: ['cameraPan', 1, 0] }, { call: '$fn', args: ['cameraPan', 0, 2] }, { call: '$fn', args: ['cameraPan', -1, -2] },   // back to the start
      { call: '$fn', args: ['cameraOrbit', 0.4, 0.3] }, { call: '$fn', args: ['cameraPan', 1.5, -0.5] },
    ] },
  ],
};

// =========================================================================
// main
// =========================================================================

// =========================================================================
// gizmo
// =========================================================================

// An arrays object of `cap` vertices as plain data (typed arrays decode to
// plain arrays, which the generators write the same way).
const A = (cap, o = {}) => {
  const out = { position: { numComponents: 3, data: new Array(3 * cap).fill(0) } };
  if (o.color)    out.color    = { numComponents: 4, data: new Array(4 * cap).fill(0) };
  if (o.texcoord) out.texcoord = { numComponents: 2, data: new Array(2 * cap).fill(0) };
  out.count = 0;
  if (o.labels) out.labels = [];
  return out;
};

const GZ24 = new Array(24).fill(0);
const GI16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// A camera 10 units up the z axis looking at the origin: a 90° lens over near 1, far 5,
// and an orthographic one of half-height 3 — corners at whole numbers.
const GCAM_P = { eye: [0, 0, 10], center: [0, 0, 0], up: [0, 1, 0], fov: PI / 2, halfHeight: null, near: 1, far: 5 };
const GCAM_O = { eye: [0, 0, 10], center: [0, 0, 0], up: [0, 1, 0], fov: null, halfHeight: 3, near: 1, far: 5 };
const GP_GL  = tree.mat4Persp(new Array(16).fill(0), -2, 2, -1, 1, 1, 5, -1);
const GP_GPU = tree.mat4Persp(new Array(16).fill(0), -2, 2, -1, 1, 1, 5, 0);
const GO_GL  = tree.mat4Ortho(new Array(16).fill(0), -3, 3, -3, 3, 1, 5, -1);
// Live subjects for pathLines / helmRigLines / locusLines, built by the codec.
const GT3  = { $track: { class: 'PoseTrack', add: [{ pos: [0, 0, 0] }, { pos: [10, 0, 0] }, { pos: [10, 10, 0] }] } };
const GT3L = { $track: { class: 'PoseTrack', add: [{ pos: [0, 0, 0] }, { pos: [10, 0, 0] }, { pos: [10, 10, 0] }], set: { posInterp: 'linear' } } };
const GT1  = { $track: { class: 'PoseTrack', add: [{ pos: [1, 2, 3] }] } };
const GC3  = { $track: { class: 'CameraTrack', add: [
  { eye: [0, 0, 10], center: [0, 0, 0], eyeTanOut: [5, 0, 0] }, { eye: [10, 0, 0], center: [0, 0, 0] }, { eye: [0, 0, -10], center: [1, 0, 0] },
] } };
const GH0 = { $helm: {} };
const GHF = { $helm: { feed: [[100, 0, 0], [0, 0, 50]] } };                     // lane 0 → Tx, lane 2 → Ry on the default profile
const GV16 = tree.mat4View(new Array(16).fill(0), 0, 0, 10, 0, 0, 0, 0, 1, 0);
const GCS = { $constraint: [tree.SPHERE, { radius: 2, anchor: [1, 0, 0] }] };
const GCP = { $constraint: [tree.PLANE,  { anchor: [0, 1, 0], normal: [0, 1, 0] }] };
const GCA = { $constraint: [tree.AXIS,   { axis: [0, 0, 1], extent: [-2, 3] }] };
const GCD = { $constraint: [tree.DIAL,   { axis: [0, 1, 0], radius: 3, zero: [1, 0, 0] }] };

const gizmo = {
  functions: {
    createArrays: exact([[0], [4], [4, { color: true }], [2, { texcoord: true, labels: true }], [-3]]),
    growArrays:   exact([[A(2, { color: true }), 5], [A(3, { texcoord: true, labels: true }), 1]], { writes: [0] }),
    capacityOf:   exact([[A(0)], [A(7)], [A(7, { color: true })]]),
    axesLines: f64([
      [A(30, { color: true }), {}],                                              // default: X | Y | Z + glyphs = 6 + 18 = 24
      [A(30), { size: 50, bits: tree.X | tree._X | tree.Y }],                   // three half-axes, no labels: 6
      [A(30, { color: true }), { semantic: false, color: [0, 0, 1] }],          // one colour throughout
      [A(4, { color: true }), {}],                                              // capacity: needs 24, writes 4
      [A(30), { bits: tree.NONE }],                                             // nothing: 0
      [A(30, { color: true }), { bits: tree.LABELS | tree._X | tree._Y | tree._Z }],
    ], { writes: [0] }),
    gridLines: f64([
      [A(44), {}],                                                              // 4 · 11
      [A(8), { size: 2, subdivisions: 1, color: [1, 0, 0] }],
      [A(20, { color: true }), { size: 10, subdivisions: 4, color: [0, 1, 0, 0.5] }],
      [A(4), { subdivisions: 0 }],                                              // clamps to 1: needs 8, writes 4
    ], { writes: [0] }),
    crossLines: f64([
      [A(4), { x: 10, y: 20, size: 8 }],
      [A(4, { color: true }), { color: [0, 1, 0, 0.5] }],
      [A(2), {}],                                                               // capacity: needs 4, writes 2
    ], { writes: [0] }),
    bullsEyeLines: f64([
      [A(104), { x: 5, y: 5, size: 20 }],                                       // 2 · 50 + 4
      [A(20), { x: 5, y: 5, size: 10, shape: tree.SQUARE }],                    // 16 + 4
      [A(12, { color: true }), { shape: tree.SQUARE, color: [1, 1, 0] }],       // capacity: needs 20, writes 12
      [A(20), { detail: 8 }],                                                   // 2 · 8 + 4
    ], { writes: [0] }),
    ringLines: f64([
      [A(96), 0, 0, 0, 2, [1, 0, 0], [0, 1, 0], {}],
      [A(8), 1, 2, 3, 1, [0, 0, 1], [1, 0, 0], { detail: 4 }],
      [A(16), 0, 0, 0, 1, [1, 0, 0], [0, 1, 0], { detail: 8, sweep: PI / 2 }],  // a quarter arc
      [A(4, { color: true }), 0, 0, 0, 1, [1, 0, 0], [0, 1, 0], { detail: 2, color: [1, 0, 1] }],
      [A(2), 0, 0, 0, 1, [1, 0, 0], [0, 1, 0], { detail: 3 }],                  // capacity: needs 6, writes 2
    ], { writes: [0] }),
    frustumCorners: f32([
      [GZ24, GCAM_P, 2],                                                        // perspective state: near (±2, ±1, 9), far (±10, ±5, 5)
      [GZ24, GCAM_O, 1],                                                        // orthographic state: (±3, ±3, 9) and (±3, ±3, 5)
      [GZ24, GCAM_P],                                                           // aspect omitted: 1
      [GZ24, { mat4Eye: GI16, mat4Proj: GP_GL, ndcZMin: -1 }, 1, -1],           // matrix form, WEBGL: the eye-space corners
      [GZ24, { mat4Eye: GI16, mat4Proj: GP_GPU }, 1, 0],                        // matrix form, WEBGPU, the convention from the argument
      [GZ24, { mat4Eye: GI16, mat4Proj: GO_GL, ndcZMin: -1 }],                  // orthographic matrix
      [GZ24, { eye: [0, 0, 10], center: [0, 0, 0], up: [0, 1, 0], fov: null, halfHeight: null, near: 1, far: 5 }, 1],   // lens unset: null
    ], { writes: [0] }),
    frustumLines: f32([
      [A(32), GCAM_P, { aspect: 2 }],                                           // all four bits: 32
      [A(32), GCAM_O, {}],                                                      // orthographic: APEX ignored, 24
      [A(8, { color: true }), GCAM_P, { aspect: 2, bits: tree.NEAR, color: [1, 0, 0] }],
      [A(32), { mat4Eye: GI16, mat4Proj: GP_GL, ndcZMin: -1 }, {}],
      [A(10), GCAM_P, { aspect: 2 }],                                           // capacity: needs 32, writes 10
      [A(32), { eye: [0, 0, 10], center: [0, 0, 0], up: [0, 1, 0], fov: null, halfHeight: null, near: 1, far: 5 }, {}],   // lens unset: 0
    ], { writes: [0] }),
    hermiteLines: f64([
      [A(64), [0, 0, 0], [3, 0, 0], [3, 3, 0], [0, 3, 0], {}],
      [A(8), [0, 0, 0], [3, 0, 0], [3, 3, 0], [0, 3, 0], { samples: 4 }],
      [A(4, { color: true }), [1, 2, 3], [0, 0, 1], [1, 2, 5], [0, 0, 1], { samples: 2, color: [0, 1, 1] }],
      [A(2), [0, 0, 0], [3, 0, 0], [3, 3, 0], [0, 3, 0], { samples: 4 }],       // capacity: needs 8, writes 2
    ], { writes: [0] }),
    pathLines: f64([
      [A(64), GT3, { samples: 4 }],                                             // PATH 16 + CONTROLS 4 + TANGENTS 12 = 32
      [A(64), GT3, { samples: 4, bits: tree.PATH }],                            // 16
      [A(64), GT3, { bits: tree.TANGENTS, tangentScale: 1 }],                   // 12, unscaled
      [A(64), GT3L, { samples: 2, bits: tree.PATH | tree.CONTROLS }],           // linear posInterp: 8 + 4
      [A(64), GC3, { samples: 2, bits: tree.PATH | tree.CENTER }],              // eye path 8 + CENTER 24 = 32
      [A(64), GC3, { samples: 2, bits: tree.PATH | tree.CONTROLS, target: 'center' }],   // center path 8 + 4
      [A(64), GC3, { bits: tree.TANGENTS_OUT, tangentScale: 1 }],               // the stored eye tangent at keyframe 0: 6
      [A(8), GT1, {}],                                                          // one keyframe: no segments; its tangents are zero-length
      [A(4), GT3, { samples: 4 }],                                              // capacity: needs 32, writes 4
    ], { writes: [0] }),
    helmRigLines: f64([
      [A(492, { color: true }), GH0, {}],                                       // at rest: dim arrows 30 + rings 288 = 318
      [A(492, { color: true }), GHF, {}],                                       // Tx and Ry active: + arrow 10 + arc 48 = 376
      [A(492, { color: true, labels: true }), GHF, { identify: true, size: 50 }],   // six labels
      [A(492), GH0, { bits: tree.TRANSLATE }],                                  // 30
      [A(492), GHF, { bits: tree.ROTATE }],                                     // 288 + 48
      [A(20, { color: true }), GHF, {}],                                        // capacity: needs 376, writes 20
    ], { writes: [0] }),
    locusLines: f32([
      [A(400), GCS, { point: [3, 0, 0], mat4View: GV16, bits: tree.AIM | tree.LOCUS | tree.RING }],   // 2 + 288 + 96
      [A(400), GCS, { point: [3, 0, 0], mat4View: GV16 }],                      // AIM | LOCUS: 290
      [A(16), GCP, { point: [2, 1, 2], bits: tree.AIM | tree.LOCUS }],          // 2 + 8
      [A(8), GCP, { bits: tree.LOCUS | tree.RING }],                            // the square once: 8
      [A(8), GCA, { point: [0, 0, 1], bits: tree.AIM | tree.LOCUS }],           // 2 + 2
      [A(200, { color: true }), GCD, { point: [3, 0, 0], color: [1, 0, 1] }],   // 2 + 96
      [A(16), { kind: 1, view: true }, { point: [1, 2, 3], mat4View: GV16, bits: tree.LOCUS }],   // the host's VIEW: 8
      [A(8), GCA, { bits: tree.AIM }],                                          // no point: 0
      [A(10), GCS, { bits: tree.LOCUS }],                                       // capacity: needs 288, writes 10
    ], { writes: [0] }),
    paneTris: f64([
      [A(6, { texcoord: true }), [-1, 1, 0], [1, 1, 0], [1, -1, 0], [-1, -1, 0], {}],
      [A(6, { texcoord: true, color: true }), [-1, 1, 0], [1, 1, 0], [1, -1, 0], [-1, -1, 0], { uvs: [0, 0, 1, 0, 1, 1, 0, 1], color: [1, 0, 0] }],
      [A(6), [0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0], {}],                   // no texcoord array: positions only
      [A(3, { texcoord: true }), [-1, 1, 0], [1, 1, 0], [1, -1, 0], [-1, -1, 0], {}],   // capacity: needs 6, writes 3
    ], { writes: [0] }),
  },
};

const coast = {
  functions: {
    coastStep: f64([
      [[0, 0, 0, 0, 0], [1, -2, 0.5, 0, 3], DT, 0.5],      // one frame of a five-lane rate
      [[0, 0], [1, -2], 1, 1],                              // one time constant: travel 1 − 1/e
      [[0, 0], [1, -2], 0, 0.5],                            // dt 0: no travel, the rate kept
      [[0, 0], [1, -2], DT, 0],                             // tau 0: exact — no travel, the rate zeroed
      [[0, 0], [1, -2], 10, 0.5],                           // a long dt: the whole travel v · tau
    ], { writes: [1] }),
    coastAlive: exact([
      [[0, 0, 0], 1e-4], [[0, 2e-4, 0], 1e-4], [[0, -1e-4, 0], 1e-4], [[0, 0.5e-4, 0], 1e-4], [[], 1e-4],
    ]),
  },
};

// A two-node chain: node 1 a child of node 0. Poses are t3 · q4 · s3 per node.
const SK_REST = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1,   0, 1, 0, 0, 0, 0, 1, 1, 1, 1];
const SK_BENT = [1, 2, 3, 0, 0, R2, R2, 2, 2, 2,   0, 1, 0, R2, 0, 0, R2, 1, 1, 1];   // R2 = sin 45°
const SK_ZERO = () => new Array(20).fill(0);
const SK_CLIP = {
  duration: 2,
  channels: [
    { node: 0, path: 'translation', interp: 'LINEAR', times: [0, 1, 2], values: [0, 0, 0, 2, 0, 0, 2, 4, 0] },
    { node: 1, path: 'rotation', interp: 'LINEAR', times: [0, 2], values: [0, 0, 0, 1, 0, 0, 1, 0] },
    { node: 1, path: 'scale', interp: 'STEP', times: [0.5, 1.5], values: [1, 1, 1, 3, 3, 3] },
    { node: 0, path: 'weights', interp: 'LINEAR', times: [0, 2], values: [0, 1] },   // not a pose path: skipped
  ],
};
const SK_CUBIC = {
  duration: 1,
  channels: [
    { node: 0, path: 'translation', interp: 'CUBICSPLINE', times: [0, 1],
      values: [0, 0, 0, 0, 0, 0, 3, 0, 0,   0, 3, 0, 1, 1, 0, 0, 0, 0] },
    { node: 0, path: 'rotation', interp: 'CUBICSPLINE', times: [0, 1],
      values: [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0,   0, 0, 0, 0, 0, 0, R2, R2, 0, 0, 0, 0] },
  ],
};
const SK_WORLD = () => tree.poseWorld(new Array(32).fill(0), SK_BENT, [-1, 0]);
const SK_IBM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,   1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1];

const skin = {
  constants: ['POSE_STRIDE'],
  functions: {
    clipSample: f64([
      [SK_ZERO(), SK_CLIP, 0.25, { rest: SK_REST }],          // linear, slerp, before the step's first key
      [SK_ZERO(), SK_CLIP, 1, { rest: SK_REST }],             // on a key
      [SK_ZERO(), SK_CLIP, 1.75, { rest: SK_REST }],          // second segment, the step's last key
      [SK_ZERO(), SK_CLIP, 2.5, { rest: SK_REST }],           // loop: wraps to 0.5
      [SK_ZERO(), SK_CLIP, -0.5, { rest: SK_REST }],          // loop: wraps to 1.5
      [SK_ZERO(), SK_CLIP, 2.5, { rest: SK_REST, loop: false }],   // clamped to the duration
      [SK_ZERO(), SK_CLIP, -1, { rest: SK_REST, loop: false }],    // clamped to 0
      [SK_ZERO(), SK_CLIP, 0.25],                             // no rest: only the animated lanes written
      [SK_ZERO(), SK_CUBIC, 0.5, { rest: SK_REST }],          // cubic spline, the rotation normalised
      [SK_ZERO(), SK_CUBIC, 0, { rest: SK_REST }],
      [SK_ZERO(), { duration: 0, channels: SK_CLIP.channels }, 1, { rest: SK_REST }],   // duration 0: t = 0
      [SK_ZERO(), { duration: 1, channels: [{ node: 0, path: 'scale', interp: 'LINEAR', times: [], values: [] }] }, 0, { rest: SK_REST }],
    ]),
    poseBlend: f64([
      [SK_ZERO(), SK_REST, SK_BENT, 0], [SK_ZERO(), SK_REST, SK_BENT, 1], [SK_ZERO(), SK_REST, SK_BENT, 0.3],
      [SK_ZERO(), SK_BENT, SK_BENT.map((v, i) => (i % 10 >= 3 && i % 10 < 7 ? -v : v)), 0.5],   // antipodal rotations: the same pose
      [{ $alias: 1 }, [...SK_REST], SK_BENT, 0.5],
    ]),
    poseWorld: f32([
      [new Array(32).fill(0), SK_REST, [-1, 0]],
      [new Array(32).fill(0), SK_BENT, [-1, 0]],
      [new Array(32).fill(0), SK_BENT, [-1, -1]],             // two roots
    ]),
    jointPalette: f32([
      [new Array(32).fill(0), SK_WORLD(), [0, 1], SK_IBM],
      [new Array(16).fill(0), SK_WORLD(), [1], SK_IBM.slice(16)],   // a skin over one joint
      [[], SK_WORLD(), [], []],
    ]),
  },
};

// A unit quad in XY as two triangles, and a tetrahedron corner.
const MS_QUAD = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
const MS_TETRA = [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2];
const MS_BOUNDS = () => ({ min: [9, 9, 9], max: [9, 9, 9], center: [9, 9, 9], diag: 9 });

const mesh = {
  functions: {
    meshNormals: f64([
      [new Array(12).fill(9), MS_QUAD, [0, 1, 2, 2, 3, 0]],                    // flat: every normal +z, the destination overwritten
      [new Array(12).fill(0), MS_TETRA, [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]], // area-weighted: each face adds its cross product
      [new Array(9).fill(0), [0, 0, 0, 1, 0, 0, 0, 0, -1]],                    // no indices: every three vertices a triangle
      [new Array(12).fill(0), MS_QUAD, [0, 1, 2]],                             // vertex 3 unreached: [0, 0, 0]
      [new Array(9).fill(0), [0, 0, 0, 1, 0, 0, 2, 0, 0], [0, 1, 2]],          // a degenerate triangle: zeros
      [[], [], []],
    ]),
    meshBounds: f64([
      [MS_BOUNDS(), [-1, 2, 3, 4, -5, 6, 0, 0, 0]],
      [MS_BOUNDS(), [1, 2, 3]],                                                // one vertex: a point box, diag 0
      [MS_BOUNDS(), []],                                                       // no positions: zeros
    ]),
  },
};

const MODULES = { constants, quat, filter, coast, skin, mesh, form, query, track, handle, helm, visibility, camera, gizmo };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [name, spec] of Object.entries(MODULES)) generate(name, spec);
}
