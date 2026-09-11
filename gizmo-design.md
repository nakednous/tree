# `gizmo` — line generators in the arrays shape (design)

> Target: `@nakednous/tree` 0.0.28, a new `src/gizmo.js` plus the gizmo bit constants and
> the semantic palette in `src/constants.js`. Consumers: the bridges' line pipes
> (`twgl.tree` `gizmo.js`, its twin), and optionally `p5.tree`'s gizmos through
> `beginShape(LINES)`. Apex: `stack-design.md` §3.2. The reference for every ported gizmo
> is `p5.tree/src/{gizmos,handle,helm,track}.js`.
> Status: **design only** — no code. Names marked *(provisional)* are open to veto.

---

## 1 · Scope

A gizmo is geometry that explains: axes, a grid, a frustum, a path, a rig, a handle's
locus. In `p5.tree` each is a sequence of `line()` calls under ambient state; on a bare
GPU API a line is a pair of vertices in a buffer. This module generates those vertices —
renderer-free, into caller-owned arrays shaped the way twgl's `createBufferInfoFromArrays`
consumes them and a WebGPU vertex buffer is filled from — and nothing else. Drawing, colour
state, HUD mode, textures, the dot at a handle's point, text: all the bridge's or the host's.

What is geometry here that was text in p5: the `X` · `Y` · `Z` glyphs of `axes` `LABELS`
are drawn with lines in `p5.tree` already, so they stay lines. What is text and stays text:
the helm rig's `identify` lane labels — a generator writes their anchors, the host's DOM
overlay places them.

---

## 2 · The arrays shape

```js
out = {
  position: { numComponents: 3, data: Float32Array(3 · capacity) },
  color:    { numComponents: 4, data: Float32Array(4 · capacity) },   // optional
  texcoord: { numComponents: 2, data: Float32Array(2 · capacity) },   // optional — panes only
  count:    0,                                                        // vertices written, ≤ capacity
  labels:   [],                                                       // optional — { x, y, z, text }
}
```

twgl's `arrays` shape verbatim, so `createBufferInfoFromArrays(gl, out)` needs no
translation and `setAttribInfoBufferFromArray` re-uploads `data` in place. Line generators
write line **lists** — vertex pairs, no indices; `paneTris` writes two triangles, six
vertices, no indices. `capacity` is `position.data.length / 3`.

```js
createArrays(capacity, { color, texcoord, labels })   // the one allocating call — setup-time
growArrays(out, capacity)                             // reallocate data to a new capacity; keeps the flags
capacityOf(out)                                       // position.data.length / 3
```

**The contract — snprintf-style.** Every generator `gen(out, …) → n` returns the vertex
count it *needs*, writes `min(n, capacity)` vertices, and sets `out.count` to what it
wrote. A caller sizes once and grows never in steady state:

```js
let n = axesLines(out, opts)
if (n > capacityOf(out)) { growArrays(out, n); axesLines(out, opts) }
```

Per-frame this is one call and one comparison; the bridge does it inside each gizmo call.
Each generator's count formula is stated below so a caller can pre-size exactly.

**Colour.** If `out.color` exists, every vertex written gets a colour: a generator with
*semantic* colouring (axes, the helm rig) writes its palette; every other generator writes
`opts.color` (default white). If `out.color` is absent, nothing is written and the bridge
draws with a uniform colour. So the same generator serves a one-colour gizmo and a
semantic one, decided by the caller's array.

**Palette.** `COLOR_X` · `COLOR_Y` · `COLOR_Z` in `constants.js` — red, lime, dodger blue
as normalized RGBA, the `p5.tree` triple. `COLOR_DIM` is the alpha the helm rig uses for
its baseline (`110 / 255`).

**Bits.** The gizmo bit namespaces move from `p5.tree/constants.js` to `tree/constants.js`
unchanged — one `@constant` block each: `NONE`; `X` `_X` `Y` `_Y` `Z` `_Z` `LABELS`;
`NEAR` `FAR` `LEFT` `RIGHT` `BOTTOM` `TOP` `BODY` `APEX`; `PATH` `CENTER` `CONTROLS`
`TANGENTS_IN` `TANGENTS_OUT` `TANGENTS` `HANDLES`; `TRANSLATE` `ROTATE`; `HANDLE` `AIM`
`LOCUS` `RING`; `CIRCLE` `SQUARE`. Bit namespaces stay gizmo-local — the same value means
different things to different generators, and no generator reads another's bits.

---

## 3 · Generators

Signatures: `out` first, the subject second where there is one, options last. Frames: a
generator writes in the frame the caller means — model space for scene gizmos (the bridge's
`M` places them), screen pixels for HUD gizmos. Nothing here consults a camera except
`locusLines` and `frustumLines`, which take what they need explicitly.

### 3.1 `axesLines(out, opts)`

`{ size = 100, bits = LABELS | X | Y | Z, semantic = true, color }`. Six half-axes from the
origin by bit; with `LABELS`, the `X` (2 lines) · `Y` (4) · `Z` (3) glyphs at `1.04 · size`,
sized `size / 40` × `size / 30`, exactly the `p5.tree` strokes. Semantic colour per axis and
its glyph, or `opts.color` when `semantic` is false. **Count:** `2 · axes + 18 · (LABELS ?
1 : 0)`, at most 30.

### 3.2 `gridLines(out, opts)`

`{ size = 100, subdivisions = 10, color }`. In the XY plane: `subdivisions + 1` lines each
way spanning `±size`. Orientation is the caller's `M` (a ground plane is a rotation about
X). **Count:** `4 · (subdivisions + 1)`.

### 3.3 `crossLines(out, opts)` · `bullsEyeLines(out, opts)`

HUD-space, `z = 0`, in target pixels: `{ x, y, size = 50, color }` and additionally `{ shape
= CIRCLE, detail = 50 }`. The cross is two lines through `(x, y)`. The bulls-eye is a
sampled circle of radius `size / 2` (`detail` segments) or the cornered square (8 lines),
plus the central cross at `0.6 · half`. The `p5.tree` model-origin form — size in world
units at the origin's depth, projected through `mapLocation` and `pixelRatio` — is the
bridge's two calls before this one. **Count:** cross 4; bulls-eye `2 · detail + 4`
(circle) or `20` (square).

### 3.4 `ringLines(out, cx, cy, cz, r, u, v, opts)`

The shared primitive: a sampled circle of radius `r` at a centre, spanned by orthonormal
`u`, `v`; `{ detail = 48, sweep = 2π, color }` — a partial `sweep` gives the rig's live
arc. Exported, because a custom constraint's locus wants it. **Count:** `2 · detail`.

### 3.5 `frustumLines(out, cam, opts)` · `frustumCorners(out24, cam, aspect, ndcZMin)`

`cam` is a camera state, or `{ mat4Eye, mat4Proj, ndcZMin }` for a matrix-captured camera
(the `pipeline_cull` route). `{ aspect, ndcZMin, bits = NEAR | FAR | BODY | APEX, color }`.
Corners come from `frustumCorners`: the near-plane extents `projLeft` … `projBottom` and
the far-plane extents by similar triangles (or equal, orthographic), placed in eye space
and carried to world by `mat4Eye` — the eight corners in the notebook's order (near face
0–3 counter-clockwise from bottom-left, then the far face), so a textured pane reads its
corners straight off. `APEX` (perspective only) draws eye-to-near-corner lines.
**Count:** `8 · (NEAR + FAR + BODY + APEX)`, at most 32.

`frustumCorners` is exported on its own: the bridge's `viewFrustum` passes corners 0–3 and
4–7 to `paneTris` for the textured planes, and a sketch drawing a projection figure wants
them.

### 3.6 `hermiteLines(out, p0, t0, p1, t1, opts)`

`{ samples = 32, color }`. The single segment through `hermiteVec3`, as a polyline of
`samples` steps. **Count:** `2 · samples`.

### 3.7 `pathLines(out, track, opts)`

`{ bits = PATH | CONTROLS | TANGENTS, samples = 32, tangentScale = 0.25, color }` for a
`PoseTrack` or `CameraTrack`, over the core's own samplers (`samplePos` / `sampleEye`,
`sampleCenter`, `tangents` / `eyeTangents` / `centerTangents`) — zero allocation, the
track's interpolation modes honoured:

- `PATH` — the sampled polyline, `samples` per segment;
- `CONTROLS` — the straight control polygon;
- `TANGENTS_IN` / `TANGENTS_OUT` — the tangent arrows at each keyframe, scaled;
- `CENTER` (camera tracks) — the gaze line eye → center per keyframe, and a small cross at
  the center.

Markers are **not** here: a per-keyframe marker (an `axes` at the pose, a small frustum at
the camera keyframe) is the bridge's composition — one `axesLines` / `frustumLines` per
keyframe under that keyframe's `M` — so `marker` stays a bridge option, pluggable as in
`p5.tree`. `HANDLES` likewise: the bridge draws each `track.handles` member. **Count:** `2 ·
samples · segments` (PATH) `+ 2 · segments` (CONTROLS) `+ 2 · keyframes` per tangent bit
`+ 6 · keyframes` (CENTER).

### 3.8 `helmRigLines(out, helm, opts)`

`{ size = 100, bits = TRANSLATE | ROTATE, identify = false }`; colour is always semantic.
Ported from `p5.tree/src/helm.js`: per translation channel, a dim baseline arrow whose
signed length is `sign · size · sens / 0.30`, and — when the channel's `activity` is
non-zero — a bright overlay arrow of length `∝ |activity| / (sens · fullScale)`; per rotation
channel, a dim ring of radius `size / 2 · sens / 0.0025` and a bright arc sweeping `π · f`
in the live direction. Arrow = shaft + 4 head lines; ring = 48 segments; arc = 24. The dim /
bright distinction is the alpha channel of the written colour. With `identify`, one anchor
per channel is written to `out.labels` as `{ x, y, z, text: 'L' + lane }` for the host's
overlay. Orientation (the resolved `from`) is the caller's `M`, as in `p5.tree`. **Count:**
`10 · 3 · 2` (arrows) `+ 96 · 3` (rings) `+ 48 · 3` (arcs), at most 492.

### 3.9 `locusLines(out, constraint, opts)`

The handle's stroked parts by bit: `{ bits = AIM | LOCUS, mat4View, point, color }`.

- `AIM` — anchor → `point` (the handle's current point, passed in by the caller, who reads
  it with `value`).
- `LOCUS` — by `constraint.kind`: `SPHERE` three great circles about the anchor; `PLANE` a
  square of half-extent 100 in the plane's basis; `AXIS` the segment `anchor + [min, max] ·
  u`; `DIAL` the ring in the dial plane; `VIEW` a screen-aligned square at `point`, its
  basis the camera's right and up read off `mat4View`.
- `RING` — `SPHERE`: the view-facing limb, a ring perpendicular to `anchor − eye` (eye from
  `mat4View`); `PLANE`: the border of the locus square.

A custom kind supplies `locus(out, opts)` on its constraint object; the bridge calls it in
place of this dispatch. The `HANDLE` dot is not a line and not generated here: the bridge
draws a sphere primitive at `point`, scaled by `pixelRatio` to a constant pixel radius.
**Count:** at most `2 · 48 · 3 + 8 + 2`.

`SPHERE`'s locus differs visibly from `p5.tree` (a wire sphere mesh): three rings are the
line-list equivalent — a gate below.

### 3.10 `paneTris(out, p0, p1, p2, p3, opts)`

`{ uvs, color }`. Two triangles `(p0, p1, p2)` `(p0, p2, p3)` — counter-clockwise from the
front face for outward normals — with `texcoord` written when the array exists. Default
`uvs` follow the bridge's single orientation rule: `p0` (top-left) → `(0, 1)`, `p1` →
`(1, 1)`, `p2` → `(1, 0)`, `p3` → `(0, 0)`, so a texture in GL's bottom-up space reads
upright with no flip; `opts.uvs` overrides, four pairs in corner order. **Count:** 6.

---

## 4 · What stays in the bridge

Everything with a camera or a GPU in it: choosing `M`, `color`, `depth`; the HUD projection
for `cross` / `bullsEye`; projecting a model origin and converting a world size to pixels
before a HUD gizmo; the per-keyframe markers and `HANDLES` composition in `trackPath`; the
textured planes of `viewFrustum` and the helm rig's HUD overload; the dot of a handle;
forwarding `out.labels` to the host. The generators know none of it.

---

## 5 · Golden vectors

`golden/gizmo.json`: for each generator, a small option set → the returned count and the
full `position` (and `color` where semantic) data; `frustumCorners` for a perspective and an
orthographic state under both `ndcZMin`; `pathLines` on a three-keyframe pose track and a
camera track with stored tangents; `helmRigLines` with a fed activity; `locusLines` for
each kind with a fixed `mat4View`. The capacity contract is a case too: a too-small `out`
returns the full count and writes `capacity` vertices.

---

## 6 · Gates

- **Line-glyph parity.** `axesLines` `LABELS` beside `p5.tree`'s `axes` at the same size —
  the strokes are transcribed, the test is visual.
- **`SPHERE` locus as three rings.** Against the wire mesh; if three rings read wrong, the
  generator grows a `detail` option for more meridians — still lines.
- **The capacity contract in a growing gizmo** (apex §6.1): `pathLines` with keyframes
  added at run time; whether the bridge's grow-and-recall is invisible.
- **Panes with the single orientation.** `frustumLines` corners 0–3 handed to `paneTris`
  with default `uvs` must show the frustum-camera's image upright on the near plane — the
  `portal_projection` rerun (bridge gate) closes both.
