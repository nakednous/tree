# `@nakednous/tree`

Pure numeric core for animation, coordinate-space mapping, and visibility — **zero dependencies**, runs anywhere.

---

## Installation

```bash
npm install @nakednous/tree
```

```js
import * as tree from '@nakednous/tree'
```

---

## Architecture

`@nakednous/tree` is the bottom layer of a three-package stack. It knows nothing about renderers, the DOM, or p5 — it operates on plain arrays and `Float32Array` buffers throughout.

```
  application
      │
      ▼
  p5.tree.js        ← bridge: wires tree + ui into p5.js v2
      │
      ├── @nakednous/ui    ← DOM param panels, transport controls
      │
      └── @nakednous/tree  ← this package: math, spaces, animation, visibility
```

The dependency direction is strict: `@nakednous/tree` never imports from the bridge or the DOM layer. This is what lets the same `PoseTrack` that drives a camera path also animate any object — headless, server-side, or in a future renderer.

Source is organised into five focused modules:

```
form.js   — you have specs, you want a matrix
query.js  — you have a matrix, you want information
quat.js   — quaternion algebra and mat4/mat3 conversions
track.js  — spline math and keyframe animation state machines
handle.js — constraint solver + ray primitives for interactive manipulators
```

---

## What it does

### PoseTrack — TRS keyframe animation

A renderer-agnostic state machine for `{ pos, rot, scl }` keyframe sequences. Rotation is stored as `[x,y,z,w]` quaternions (w-last, glTF layout).

```js
import { PoseTrack } from '@nakednous/tree'

const track = new PoseTrack()
track.add({ pos: [0, 0, 0],    rot: [0,0,0,1], scl: [1,1,1] })
track.add({ pos: [100, 50, 0], rot: [0,0,0,1], scl: [2,1,1] })
track.play({ duration: 60, loop: true })

// per-frame — zero allocation
const out = { pos: [0,0,0], rot: [0,0,0,1], scl: [1,1,1] }
track.tick()
track.eval(out)   // writes interpolated TRS into out
```

Interpolation modes:

```js
track.posInterp = 'hermite'  // default — cubic Hermite; auto-computes centripetal
                             //           Catmull-Rom tangents when none are stored
track.posInterp = 'linear'
track.posInterp = 'step'     // snap to k0; useful for discrete state changes

track.rotInterp = 'slerp'    // default — constant angular velocity
track.rotInterp = 'nlerp'    // normalised lerp; cheaper, slightly non-constant speed
track.rotInterp = 'step'     // snap to k0 quaternion
```

Playback features: signed `rate` (negative reverses), `loop`, `bounce`, `seek(t)` scrubbing, and lifecycle hooks (`onPlay`, `onEnd`, `onStop`). `_onActivate` / `_onDeactivate` are lib-space hooks for the host layer's draw-loop registry — not for user code.

`add()` accepts flexible specs. Top-level forms:

```js
track.add({ pos, rot, scl })                 // explicit TRS — rot accepts any form below
track.add({ pos, rot, scl, tanIn, tanOut })  // with Hermite tangents (vec3, optional)
track.add({ mat4Model: mat4 })               // decompose a column-major model matrix into TRS
track.add([ spec, spec, ... ])               // bulk
```

`tanIn` is the incoming position tangent at this keyframe; `tanOut` is the outgoing tangent. When only one is given, the other mirrors it. When neither is given, centripetal Catmull-Rom tangents are auto-computed from neighboring keyframes.

```js
track.add({ pos:[0,0,0] })                                      // auto tangents
track.add({ pos:[100,0,0], tanOut:[0,50,0] })                   // leave heading +Y
track.add({ pos:[200,0,0], tanIn:[0,50,0], tanOut:[-30,0,0] })  // arrive from +Y, leave heading -X
track.add({ pos:[300,0,0] })                                    // auto tangents
```

`rot` sub-forms — all normalised internally:

```js
rot: [x,y,z,w]                           // raw quaternion
rot: { axis:[x,y,z], angle }             // axis-angle
rot: { dir:[x,y,z], up?:[x,y,z] }        // look direction (−Z forward)
rot: { euler:[rx,ry,rz], order?:'YXZ' }  // intrinsic Euler angles (radians)
                                         // orders: YXZ (default), XYZ, ZYX,
                                         //         ZXY, XZY, YZX
                                         // extrinsic ABC = intrinsic CBA
rot: { from:[x,y,z], to:[x,y,z] }        // shortest-arc between directions
rot: { mat3: Float32Array|Array }        // column-major 3×3 rotation matrix
rot: { mat4Eye: mat4 }                   // rotation block of an eye matrix
```

---

### CameraTrack — lookat keyframe animation

A renderer-agnostic state machine for `{ eye, center, up, fov?, halfHeight?, near, far }` lookat keyframes. Each field is independently interpolated — eye and center along their own paths, up nlerped on the unit sphere, `near` / `far` lerped linearly.

```js
import { CameraTrack } from '@nakednous/tree'

const track = new CameraTrack()
track.add({ eye:[0,0,500], center:[0,0,0] })
track.add({ eye:[300,-150,0], center:[0,0,0] })
track.play({ loop: true, duration: 90 })

// per-frame — zero allocation
const out = { eye:[0,0,0], center:[0,0,0], up:[0,1,0],
              fov:null, halfHeight:null, near:0.1, far:1000 }
track.tick()
track.eval(out)
// apply: cam.camera(out.eye[0],out.eye[1],out.eye[2],
//                   out.center[0],out.center[1],out.center[2],
//                   out.up[0],out.up[1],out.up[2])
```

Interpolation modes:

```js
track.eyeInterp    = 'hermite'  // default — auto-CR tangents when none stored
track.eyeInterp    = 'linear'
track.eyeInterp    = 'step'

track.centerInterp = 'linear'   // default — suits fixed lookat targets
track.centerInterp = 'hermite'  // smoother when center is also moving freely
track.centerInterp = 'step'
```

`add()` accepts explicit lookat specs or a bulk array:

```js
track.add({ eye, center?, up?, fov?, halfHeight?, near?, far?,
            eyeTanIn?, eyeTanOut?, centerTanIn?, centerTanOut? })
                                   // fov — vertical fov (radians) for perspective
                                   // halfHeight — world-unit half-height for ortho
                                   // fov / halfHeight are nullable — omit to leave projection unchanged
                                   // near / far — clip distances; default 0.1 / 1000
                                   // eyeTanIn/Out — Hermite tangents for eye path
                                   // centerTanIn/Out — Hermite tangents for center path
track.add([ spec, spec, ... ])     // bulk
```

For matrix-based capture use `track.add({ mat4Model: mat4Eye })` for full-fidelity TRS including roll, or `cam.capturePose()` (p5.tree bridge) for lookat-style capture.

`fov` and `halfHeight` are lerped between keyframes only when both adjacent keyframes carry a non-null value for that field. Mixed or null entries pass `null` through — the bridge leaves the projection unchanged. They are nullable because exactly one is meaningful per keyframe (perspective xor orthographic).

`near` and `far` carry real defaults on every keyframe (`0.1` / `1000`, matching the three.js / Bevy conventions) and are therefore lerped linearly between every adjacent pair — no null-passthrough. `cam.capturePose()` extracts them from the camera's own projection matrix (not the renderer's live state), so a round-trip through `add(cam.capturePose())` is exact regardless of which camera is currently active on the renderer.

---

### Path sampling

The interpolated path of a track can be sampled without advancing the transport cursor or firing hooks. All samplers are zero-alloc — the caller owns the output buffers — and honour the track's interpolation mode (`hermite` / `linear` / `step`) and the same stored-tangent → auto-CR fallback chain used by `eval()`.

Two shapes of method, each playing a different role:

* **Continuous samplers** — evaluate a path-evolving quantity at any point along the path. Accept either a cursor form (reads `track.seg` / `track.f`) or an explicit `(seg, t)` form, with `seg ∈ [0, segments−1]` and `t ∈ [0, 1]` local to that segment.
* **Keyframe-indexed queries** — give a property of a specific keyframe. Tangents at a junction, or the per-keyframe projection matrix.

**`PoseTrack`:**

```js
track.samplePos(out)                  // cursor form
track.samplePos(out, seg, t)          // explicit

track.mat4Model(out)                  // cursor form — TRS as model mat4
track.mat4Model(out, seg, t)          // explicit

track.tangents(outIn, outOut, i)      // effective in/out pos-tangents at keyframe i
```

**`CameraTrack`:**

```js
track.sampleEye(out)                  track.sampleEye(out, seg, t)
track.sampleCenter(out)               track.sampleCenter(out, seg, t)

track.mat4Eye(out)                    // cursor form — lookat eye matrix
track.mat4Eye(out, seg, t)            // explicit

track.eyeTangents(outIn, outOut, i)
track.centerTangents(outIn, outOut, i)
```

Tangent samplers mirror the missing side at boundary keyframes so the first and last keyframes produce visible tangent vectors.

**Projection matrices are not a track method.** Each `CameraTrack` keyframe stores `fov` (perspective) or `halfHeight` (orthographic) as a raw scalar on `track.keyframes[i]` — callers wanting a projection build one from those scalars using `mat4Persp` / `mat4Ortho` directly:

```js
const kf = track.keyframes[i]
if (kf.fov != null) {
  const hh = near * Math.tan(kf.fov * 0.5), hw = hh * aspect
  mat4Persp(out, -hw, hw, -hh, hh, near, far, ndcZMin)
} else if (kf.halfHeight != null) {
  const hh = kf.halfHeight, hw = hh * aspect
  mat4Ortho(out, -hw, hw, -hh, hh, near, far, ndcZMin)
}
```

Animated `fov` or `halfHeight` in sketches flows through the bridge's camera-binding: `p5.tree` reads `eval().fov` / `eval().halfHeight` each frame and calls `cam.perspective()` / `cam.ortho()` accordingly — none of this touches matrix construction.

Callers who want an interpolated projection matrix at mid-segment `(seg, t)` lerp the raw scalars from adjacent keyframes before building:

```js
import { mat4Persp, mat4Ortho } from '@nakednous/tree'

function mat4ProjAt(out, track, seg, t, near, far, aspect, ndcZMin, ndcYSign = 1) {
  const k0 = track.keyframes[seg]
  const k1 = track.keyframes[seg + 1] ?? k0

  if (k0.fov != null && k1.fov != null) {
    const fov = k0.fov + t * (k1.fov - k0.fov)
    const hh = near * Math.tan(fov * 0.5), hw = hh * aspect
    return mat4Persp(out, -hw, hw, -hh, hh, near, far, ndcZMin, ndcYSign)
  }
  if (k0.halfHeight != null && k1.halfHeight != null) {
    const hh = k0.halfHeight + t * (k1.halfHeight - k0.halfHeight)
    const hw = hh * aspect
    return mat4Ortho(out, -hw, hw, -hh, hh, near, far, ndcZMin, ndcYSign)
  }
  return null
}
```

Intended uses of the samplers: custom rendering of the path (polyline overlays, arclength-based placement), pedagogical visualisations of Hermite / Catmull-Rom, and gizmos — `p5.tree`'s `trackPath` is built on top of these.

---

### Shared Track transport

Both `PoseTrack` and `CameraTrack` extend `Track`, which holds all transport machinery:

```js
track.play({ duration, loop, bounce, rate, onPlay, onEnd, onStop })
track.stop([rewind])   // rewind=true seeks to origin on stop
track.reset()          // clear all keyframes and stop
track.seek(t)          // normalised position [0, 1]
track.time()           // → number ∈ [0, 1]
track.info()           // → { keyframes, segments, seg, f, playing, loop, ... }
track.tick()           // advance cursor by rate — returns playing state
track.add(spec)        // append keyframe(s)
track.set(i, spec)     // replace keyframe at index
track.remove(i)        // remove keyframe at index

track.playing          // boolean
track.loop             // boolean
track.bounce           // boolean
track.rate             // get/set — never starts/stops playback
track.duration         // frames per segment
track.keyframes        // raw array
```

**Loop modes** — `loop` and `bounce` are fully independent flags:

| `loop` | `bounce` | behaviour |
|--------|----------|-----------|
| false  | false    | play once — stop at end (fires `onEnd`) |
| true   | false    | repeat — wrap back to start |
| true   | true     | bounce forever — reverse direction at each boundary |
| false  | true     | bounce once — flip at far boundary, stop at origin |

The internal `_dir` field (±1) tracks bounce travel direction — `rate` is never mutated at boundaries.

Hook firing order:
```
play()  → onPlay → _onActivate
tick()  → onEnd  → _onDeactivate   (once mode, at boundary)
stop()  → onStop → _onDeactivate
reset() → onStop → _onDeactivate
```

One-keyframe behaviour: `play()` with exactly one keyframe snaps `eval()` to that keyframe without setting `playing = true` and without firing hooks.

---

### Coordinate-space mapping

`mapLocation` and `mapDirection` convert points and vectors between any pair of named spaces. All work is done in flat scalar arithmetic — no objects created per call.

**Spaces:** `WORLD`, `EYE`, `SCREEN`, `NDC`, `MODEL`, `MATRIX` (custom frame).

#### Conventions

Three independent conventions are controlled by caller-supplied parameters:

**NDC Z** — passed as `ndcZMin`:
```
WEBGL  = −1   z ∈ [−1,  1]
WEBGPU =  0   z ∈ [ 0,  1]
```

**Viewport** — `vp = [x, y, w, h]` with signed `h`:
```
h < 0  screen y-down (DOM / p5 mouseX·mouseY)  →  [0, canvasH, canvasW, −canvasH]
h > 0  screen y-up   (OpenGL gl_FragCoord)     →  [0, 0, canvasW, canvasH]
```
The sign of `h` is the only thing that differs — no branching, no flags.

**NDC Y** — controlled by `ndcYSign` in the projection constructors (`form.js`):
```
+1  NDC y-up   (default) — OpenGL / WebGL / WebGPU / Three.js / p5v2
−1  NDC y-down           — native Vulkan clip space
```

#### Usage

```js
import { mapLocation, mapDirection, WORLD, SCREEN, WEBGL } from '@nakednous/tree'

const out = new Float32Array(3)
const m = {
  mat4Proj:   /* Float32Array(16) — projection (eye → clip) */,
  mat4View:   /* Float32Array(16) — view (world → eye) */,
  mat4PV?:    /* mat4Proj × mat4View — optional, computed if absent */,
  mat4PVInv?: /* inv(mat4PV)         — optional, computed if absent */,
}
const vp = [0, height, width, -height]  // signed h = screen y-down

mapLocation(out, worldX, worldY, worldZ, WORLD, SCREEN, m, vp, WEBGL)
```

The matrices bag `m` is assembled by the host. All pairs are supported:
WORLD↔EYE, WORLD↔SCREEN, WORLD↔NDC, EYE↔SCREEN, SCREEN↔NDC, WORLD↔MATRIX, and their reverses.

---

### Visibility testing

[Frustum culling](https://learnopengl.com/Guest-Articles/2021/Scene/Frustum-Culling) against six planes. All functions take scalar inputs and a pre-filled `Float64Array(24)` planes buffer — zero allocations per test.

```js
import { frustumPlanes, pointVisibility, sphereVisibility, boxVisibility,
         VISIBLE, SEMIVISIBLE, INVISIBLE } from '@nakednous/tree'

const planes = new Float64Array(24)
frustumPlanes(planes, posX, posY, posZ, vdX, vdY, vdZ,
              upX, upY, upZ, rtX, rtY, rtZ,
              ortho, near, far, left, right, top, bottom)

sphereVisibility(planes, cx, cy, cz, radius)  // → VISIBLE | SEMIVISIBLE | INVISIBLE
boxVisibility(planes, x0,y0,z0, x1,y1,z1)
pointVisibility(planes, px, py, pz)
```

Three-state result: `VISIBLE` (fully inside), `SEMIVISIBLE` (intersecting), `INVISIBLE` (fully outside).

**Sign contract:** `top > 0`, `bottom < 0`, `right > 0`, `left < 0` for standard y-up camera.

---

### Manipulator constraints

`handle.js` is the renderer-agnostic core of an interactive manipulator: ray-primitive intersections, az/el utilities, and a `Constraint` state machine. The `p5.tree` bridge wraps these into a draggable handle; this package supplies the math and the **contract** that makes the handle extensible.

```js
import { createConstraint, SPHERE, PLANE, AXIS, POINT, DIRECTION,
         raySphere, rayPlane, rayClosestPointOnAxis,
         dirFromAzEl, azElFromDir } from '@nakednous/tree'

const c = createConstraint(SPHERE, { radius: 1 })  // or PLANE / AXIS
const out = [0, 0, 0]
c.solve(ox,oy,oz, dx,dy,dz)   // ray (working space) → canonical state; chainable
c.value(out, DIRECTION)       // write the reported value into out(3)
```

`SPHERE` stores a unit direction (gimbal-free); `PLANE` / `AXIS` store a constrained point. `value` reports a `DIRECTION` (unit) or a `POINT` per kind. Ray primitives are out-first and assume a unit ray direction; `rayPlane` returns `Infinity` when the ray is parallel.

**Constraint contract (extension seam).** A constraint is any object exposing `kind`, `solve(ox,oy,oz, dx,dy,dz)`, `value(out, report)`, `seed(x,y,z)`, and optionally `scalar()` / `azEl(out2)`. The handle controller drives any conforming constraint, so a new kind — rotation, 6-DOF, or app-specific — implements this contract (portable, draw-free) plus a bridge-side locus draw, rather than forking the controller. The built-in `Constraint` is the reference implementation. Full design: [`handle-design.md`](./handle-design.md).

---

### Quaternion and matrix math

Exported individually for use in hot paths.

**Quaternions** — `[x,y,z,w]` w-last (`quat.js`):

```
qSet  qCopy  qDot  qNormalize  qNegate  qMul
qSlerp  qNlerp
qFromAxisAngle  qFromLookDir  qFromRotMat3x3  qFromMat4  qToMat4
qToAxisAngle
```

**Spline / vector:** `hermiteVec3`, `lerpVec3`

**Mat4 arithmetic** (`query.js`):
```
mat4Mul  mat4Invert  mat4Transpose  mat4MulPoint  mat4MulDir
mat3NormalFromMat4  mat4Location  mat3Direction
mat4PV  mat4MV
```

**TRS ↔ mat4 (track.js):** `transformToMat4`, `mat4ToTransform`

**Matrix construction from specs** (`form.js`):
```
mat4FromBasis        — rigid frame from orthonormal basis + translation
mat4View             — view matrix (world→eye) from lookat params
mat4Eye              — eye matrix (eye→world) from lookat params
mat4FromTRS          — column-major mat4 from flat TRS scalars
mat4FromTranslation  — translation-only mat4
mat4FromScale        — scale-only mat4
mat4Persp            — perspective projection, general frustum (ndcZMin, ndcYSign)
mat4Ortho            — orthographic projection                 (ndcZMin, ndcYSign)
mat4Bias             — NDC→texture/UV remap [0,1] for shadow mapping
mat4Reflect          — reflection across a plane
```

**Mat4 decomposition** (`query.js`):
```
mat4ToTranslation    — extract translation (col 3)
mat4ToScale          — extract scale (column lengths)
mat4ToRotation       — extract rotation as unit quaternion
```

**Projection queries** — read scalars from an existing projection mat4 (`query.js`):
```
projIsOrtho  projNear  projFar  projFov  projHfov
projLeft  projRight  projTop  projBottom
```

**Pixel ratio:** `pixelRatio(proj, vpH, eyeZ, ndcZMin)` — world-units-per-pixel at a given depth, handles both perspective and orthographic.

**Pick matrix:** `mat4Pick(proj, px, py, vp)` — mutates a projection matrix in-place so that the pixel at `(px, py)` maps to the full NDC square, making a 1×1 FBO render contain exactly that pixel. Takes the same signed viewport `vp` as `mapLocation` — the y-convention is preserved automatically.

---

### Constants

```js
// Coordinate spaces
WORLD, EYE, NDC, SCREEN, MODEL, MATRIX

// NDC Z convention
WEBGL   // −1  (z ∈ [−1, 1])
WEBGPU  //  0  (z ∈ [0, 1])

// Visibility results
INVISIBLE, VISIBLE, SEMIVISIBLE

// Manipulator constraint kinds & report modes
SPHERE, PLANE, AXIS
POINT, DIRECTION

// Basis vectors (frozen)
ORIGIN, i, j, k, _i, _j, _k
```

---

## Performance contract

All functions in this package follow an **out-first, zero-allocation** contract:

- `out` is the first parameter — the caller owns the buffer
- the function writes into `out` and returns it
- `null` is returned on degeneracy (singular matrix, etc.)
- no heap allocations per call

```js
// allocate once
const out       = new Float32Array(3)
const mat4PV    = new Float32Array(16)
const mat4PVInv = new Float32Array(16)

// per frame — zero allocation
mat4Mul(mat4PV, proj, view)
mat4Invert(mat4PVInv, mat4PV)
mapLocation(out, px, py, pz, WORLD, SCREEN,
  { mat4Proj: proj, mat4View: view, mat4PV, mat4PVInv }, vp, WEBGL)
```

---

## Relationship to `p5.tree`

[p5.tree](https://github.com/VisualComputing/p5.tree) is the bridge layer. It reads live renderer state (camera matrices, viewport dimensions, NDC convention) and passes it to `@nakednous/tree` functions. It wires `PoseTrack` and `CameraTrack` to the p5 draw loop, exposes `createPoseTrack` / `createCameraTrack` / `getCamera`, and provides `createPanel` for transport and parameter UIs.

`@nakednous/tree` provides the algorithms. The bridge provides the wiring.

---

## License

AGPL-3.0-only  
© JP Charalambos
