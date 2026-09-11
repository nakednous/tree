# `camera` — camera state ↔ matrices (design)

> Target: `@nakednous/tree` 0.0.28, a new `src/camera.js` plus three additions to
> `src/query.js` (`unproject`, `pointerHit`, the id codec). Consumers: `@nakednous/host`
> (tracks and helms write the state, the orbit edits it, handles unproject through it),
> the bridges (`setCamera(cam)` installs it), and the `p5.tree` adapter (`capturePose` /
> `applyPose` become reads and writes of it). Apex: `stack-design.md` §3.2.
> Status: **design only** — no code. Names marked *(provisional)* are open to veto.

---

## 1 · Scope

The stack has no camera *object*: no class that owns a renderer, no matrices cached on an
instance. It has a camera **state** — plain data, the lookat-plus-lens spec `CameraTrack`
already keyframes — and pure functions between that state and the matrices a draw uploads.
That is the whole module: builders (state → `V` · `E` · `P` · frustum planes), decomposers
(`E` + `P` → state; a TRS pose ↔ state), and edits (orbit · dolly · pan) that a gesture or
a script applies. What it is not: an orbit *gesture* (host), an install (bridge), a track
(track.js — the state is its keyframe shape, so `track.eval(cam)` already writes it).

The state is the notation's `cam`: `setCamera(cam)` installs it, `camera(eye, center, up)` ·
`perspective(fov, near, far)` are writes into it, `E.col(3)` is `cam.eye`.

---

## 2 · The state

```js
cam = {
  eye:        [x, y, z],        // number[3]
  center:     [x, y, z],        // number[3] — the lookat target; |center − eye| is the gaze distance
  up:         [x, y, z],        // number[3] — the up hint, need not be unit
  fov:        number | null,    // vertical field of view, radians — perspective
  halfHeight: number | null,    // world-unit half-height at the near plane — orthographic
  near:       number,           // > 0
  far:        number,           // > near
}
```

Exactly the `CameraTrack` keyframe shape, with the same rules: `fov` and `halfHeight` are
nullable because exactly one is meaningful (perspective xor orthographic); when a track
evaluates `null` into both, the projection is "unchanged" and a builder keeps the last
projection it was given. `near` and `far` always carry real values. Vectors are plain
`number[]` (f64, authoring state) per the core's storage convention; matrices are
`Float32Array(16)`.

**`createCamera(opts)`** *(provisional)* — the one allocating call, setup-time: returns a
state with defaults `eye [0, 0, 500]` · `center [0, 0, 0]` · `up [0, 1, 0]` · `fov π/3` ·
`halfHeight null` · `near 0.1` · `far 1000`, each overridable. **`cameraCopy(out, cam)`**
copies one state into another (the orbit's home, a track's capture) — zero-alloc.

The state carries no `aspect`: the viewport owns it, and every builder that needs it takes
it as an argument. A state is therefore portable between targets of different sizes — a
1×1 pick target, an FBO, the canvas — which is what `mat4Pick` and the helm's HUD rig need.

---

## 3 · Builders — state → matrices

```js
cameraView(out, cam)                                  // V  = mat4View(eye, center, up)
cameraEye(out, cam)                                   // E  = mat4Eye(eye, center, up)
cameraProj(out, cam, aspect, ndcZMin, ndcYSign = 1)   // P  — mat4Persp from fov, or mat4Ortho from halfHeight
cameraPlanes(planes, cam, aspect)                     // the six frustum planes, Float64Array(24)
```

`cameraProj` derives the symmetric extents: perspective `top = near · tan(fov / 2)`, `right
= top · aspect`; orthographic `top = halfHeight`, `right = top · aspect`; both hand `near`,
`far`, `ndcZMin`, `ndcYSign` straight to `form.js`. With both `fov` and `halfHeight` null
it returns `null` and leaves `out` untouched — the "unchanged" contract a track's null
passthrough relies on.

`cameraPlanes` builds the basis (`vd = normalize(center − eye)`, `rt = normalize(vd × up)`,
`up' = rt × vd`) and the extents as above and calls `frustumPlanes` — so visibility needs no
bridge at all: `sphereVisibility(planes, …)` against a camera state is core to core. The
sign contract is `frustumPlanes`'s (`top > 0`, `bottom < 0`, `right > 0`, `left < 0`).

Composition stays the caller's: `mat4Mul(PV, P, V)`, `mat4Invert(PVInv, PV)` — the matrices
bag `mapLocation` takes is assembled by the host's view bag or the bridge, not here.

---

## 4 · Decomposers — matrices and poses → state

```js
cameraFromMat4(cam, mat4Eye, mat4Proj, ndcZMin)   // read a state back from an eye matrix + projection
cameraFromPose(cam, pose)                         // { pos, rot } → lookat at constant gaze distance
cameraToPose(pose, cam)                           // lookat → { pos, rot }
```

**`cameraFromMat4`** — the `capturePose` read as numbers: `eye ← col 3` of `mat4Eye`, `up ←
col 1`, `forward ← −col 2`; `center ← eye + forward · d` where `d` is the state's current
gaze distance (`|center − eye|`, or `1` when degenerate) — a lookat needs a center and a
matrix has only a direction, so the distance is preserved across the round trip. The lens
from `query.js`: `projIsOrtho` picks `fov ← projFov` or `halfHeight ← projTop`; `near ←
projNear(…, ndcZMin)`, `far ← projFar`. A state written by `cameraFromMat4(cameraEye(cam),
cameraProj(cam, …))` reproduces `cam` to tolerance — a golden-vector round trip.

**`cameraFromPose`** — the TRS branch of the p5 `applyPose`, allocation-free: `R = qToMat4
(rot)` into scratch, `up ← R col 1`, `forward ← −R col 2`, `eye ← pos`, `center ← pos +
forward · d` with `d` the current gaze distance. The lens is untouched (`scl` ignored). This
is how a `PoseHelm` drives a camera and how a `PoseTrack` animates one like an object.

**`cameraToPose`** — the helm's seed: `pos ← eye`, `rot ← qFromLookDir(center − eye, up)`.
Under `EYE` the seeded rotation equals the eye matrix's, the invariant body-fly needs.

---

## 5 · Edits — the orbit's arithmetic

Pure edits of the state; the gesture that produces the deltas is the host's.

```js
cameraOrbit(cam, dAz, dEl, opts)   // rotate eye about center: azimuth about up, elevation clamped
cameraDolly(cam, factor, opts)     // scale the gaze distance; opts.min / opts.max clamp it
cameraPan(cam, dx, dy)             // translate eye and center along the eye's right and up, world units
```

`cameraOrbit` works on the eye-to-center vector in the basis `(rt, up', vd)`: azimuth
rotates it about `up'`, elevation about `rt`, with the elevation clamped so `vd` never
reaches `±up'` (the pole guard, `opts.maxEl` default `π/2 − 1e-3`); `up` is left as the hint
it was, so an orbit never rolls. `cameraDolly` moves `eye` along `vd` — perspective — or
scales `halfHeight` — orthographic, where moving the eye changes nothing on screen — the
one place the two lenses diverge. `cameraPan` uses the same basis, and the caller converts
pixels to world units with `pixelRatio` at the center's depth so a pan tracks the pointer.

All three are in place, chainable, and free of trigonometric allocation; they are the
core's, not the orbit's, so a script can fly a camera with the same calls a finger does.

---

## 6 · The round trip's endpoints — `query.js` additions

```js
unproject(outO, outD, sx, sy, m, vp, ndcZMin)   // screen point → world ray: origin on the near plane, unit direction
pointerHit(px, py, x, y, z, radius, m, vp, ndcZMin, shape = CIRCLE)   // is the pointer within radius px of the projected point?
idToRgba(out, id)                               // 24-bit id → [r, g, b, 1] normalized floats, R the low byte
rgbaToId(r, g, b)                               // bytes → id
```

**`unproject`** is the two-`mapLocation` ray build the p5 handle performs, as one call: the
point at screen depth `0` is the origin, the point at depth `1` minus it is the direction,
normalized into `outD`; returns `outD`, or `null` when the bag is singular. The depth
convention rides `ndcZMin` through `mapLocation`, so nothing is hardcoded. The
point-at-depth form a brush wants stays `mapLocation(SCREEN → WORLD)` with a depth in `z`.

**`pointerHit`** projects `(x, y, z)` to the screen and tests the pointer against a circle
or a square of `radius` px around it — `CIRCLE` and `SQUARE` join `constants.js`. A point
behind the camera (screen depth outside `[0, 1]`) never hits.

**The id codec** is what both bridges and the p5 adapter share: the bridge sets `uColor`
from `idToRgba`, decodes a readback with `rgbaToId`; the adapter formats `idToRgba` as the
CSS hex string `fill()` wants. Id `0` is reserved for the background; the range is `1 …
2²⁴ − 1`.

---

## 7 · Golden vectors

`golden/camera.json` and the `query.json` additions:

- builders: a set of states × aspects × both `ndcZMin` × both `ndcYSign`, with `V`, `E`, `P`
  and the six planes;
- round trips: `cameraFromMat4(cameraEye, cameraProj)` reproducing the state; `cameraToPose`
  then `cameraFromPose` reproducing eye and center; both at `1e-6`;
- edits as transcripts: an orbit sweep through the pole guard, a dolly to the clamps, a
  pan, each step's state recorded;
- `unproject` at the canvas corners and center under perspective and orthographic, both
  conventions; `pointerHit` at the radius boundary; the codec at `1`, `255`, `256`, `2²⁴ − 1`.

One fixture is generated from `p5.tree`'s renderer reads — a lookat set through `camera()`
and `perspective()`, `mat4Eye` / `mat4Proj` read back, planes from `computePlanes` — with
`ndcYSign = −1`: the parity case that closes the gate below.

---

## 8 · Gates

- **p5 parity of `cameraPlanes`.** The `p5.tree` annex records that a textbook eye matrix
  fed to its plane math classifies everything invisible, while a renderer-read eye matrix
  works. `cameraPlanes` builds from the lookat directly; it must agree with `computePlanes`
  on the same lookat and lens under p5's `ndcYSign = −1`. *Experiment:* the golden fixture
  above, generated in a p5 sketch and asserted in the core.
- **Gaze distance across `cameraFromMat4`.** Preserving `|center − eye|` from the previous
  state is the right default for a live camera; for a fresh state it is `1`, which makes
  the first `center` sit one unit ahead. *Experiment:* a track captured from a
  freshly-created state — if the first keyframe's center is unusable, the default becomes
  `opts.distance`.
- **Orthographic dolly.** Scaling `halfHeight` instead of moving the eye: verify the
  `pixelRatio` at the center stays consistent so a pan under orthographic still tracks the
  pointer. *Experiment:* the projection series' scripted views, dollied.
