# `@nakednous/tree`

Pure numeric core for animation, rate-driven control, coordinate-space mapping, and visibility — **zero dependencies**, runs anywhere.

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

`@nakednous/tree` is the bottom layer of a stack. It knows nothing about renderers, the DOM, or p5 — it operates on plain arrays and `Float32Array` buffers throughout.

```
  application
      │
      ▼
  webgl.tree · p5.tree · webgpu.tree  ← bridges: draw, the GPU ceremony, a framework adapter
      │
      ├── @nakednous/host  ← DOM transport: pointer, view, players, handles, devices, labels, orbit
      │
      ├── @nakednous/ui    ← DOM param panels, transport controls
      │
      └── @nakednous/tree  ← this package: math, spaces, animation, visibility, gizmo geometry
```

The dependency direction is strict: `@nakednous/tree` never imports from the host, the bridges, or the DOM layer; `host` and `ui` depend on `tree` only; a bridge depends on `tree` and `host`, never on another bridge. `@nakednous/*` never renders — rendering lives in the `*.tree` bridges. This is what lets the same `PoseTrack` that drives a camera path also animate any object — headless, server-side, or in a future renderer — and the same gizmo arrays draw through twgl, p5, or WebGPU.

Source is organised into focused modules:

```
form.js   — you have specs, you want a matrix
query.js  — you have a matrix, you want information
quat.js   — quaternion algebra and mat4/mat3 conversions
track.js  — spline math and keyframe animation state machines
skin.js   — sampled clips, pose blending, world matrices and the joint palette of a skeleton
mesh.js   — vertex normals (smooth, grouped, flat), flattening and bounds of a triangle mesh
platonic.js — the five Platonic solids as meshes in the arrays shape
helm.js   — 6-DOF rate-stream integrator — the Track family's live-input sibling
filter.js — input conditioning: the 1€ filter + absolute→rate differencing
handle.js — constraint solver + ray primitives for interactive manipulators
visibility.js — frustum planes and visibility tests
camera.js — camera state (the CameraTrack keyframe shape) ↔ matrices, planes, and orbit edits
gizmo.js  — line generators in twgl's arrays shape: axes, grid, cross, bulls-eye, ring, frustum, hermite, path, helm rig, locus, pane
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
rot: { dir:[x,y,z], up?:[x,y,z] }        // look direction (−Z forward); up re-seeded when ∥ dir
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

`fov` and `halfHeight` are nullable because exactly one is meaningful per keyframe (perspective xor orthographic). Between keyframes of one kind the lens is lerped; across a perspective ↔ orthographic segment it steps — the segment's first keyframe's lens until its end, then the second's — so `eval` never reports both.

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

### PoseHelm — 6-DOF rate-driven pose

The rate-stream sibling of the Track family. Where a track produces a pose from keyframes over time, a `PoseHelm` produces one from a live 6-DOF delta stream — a SpaceNavigator, a tracked hand, an agent policy. It holds a profile plus the integrated pose; there is no timeline (no keyframes, no `play` / `seek` / `loop`), and it never learns about a camera — the host hands it a resolved `basis` each step.

```js
import { PoseHelm } from '@nakednous/tree'

const helm = new PoseHelm()
const out  = { pos: [0,0,0], rot: [0,0,0,1] }

// a transport feeds raw lane rates — either half may be omitted:
helm.feed([tx, ty, tz], [rx, ry, rz])

// per-frame — host-driven, zero allocation:
helm.step(out, dt, basis)   // integrate dt seconds, write the new { pos, rot }
helm.eval(out)              // read the current pose without integrating
```

`feed` is the input (as `add` is a track's); `step` + `eval` parallel `tick` + `eval`. `step` is host-driven — the bridge calls it each frame, exactly as a sketch never calls `track.tick()`.

**Profile — sign · sens · lane.** The whole sign / sensitivity / axis-map question is one flat declarative object. Six channels — three translation (Tx Ty Tz), three rotation (Rp pitch, Ry yaw, Rr roll) — each `{ sign, sens, lane }`:

```js
helm.profile = {
  Tx: { sign: +1, sens: 0.30,   lane: 0 },   // lane = which fed channel drives +X
  Ty: { sign: +1, sens: 0.30,   lane: 2 },
  Tz: { sign: -1, sens: 0.30,   lane: 1 },
  Rp: { sign: -1, sens: 0.0025, lane: 0 },
  Ry: { sign: -1, sens: 0.0025, lane: 2 },
  Rr: { sign: +1, sens: 0.0018, lane: 1 },
}
```

- **sign** — per-app direction (camera-fly vs object-grab invert).
- **sens** — per-axis sensitivity (tame roll without touching the rest).
- **lane** — input-channel permutation: which fed channel drives this DOF. `T*` lanes index the translation triple, `R*` the rotation triple.

`sens` does all the scaling, so the same raw `feed()` suits any transport — only the profile changes. The default is SpaceNavigator-tuned and meant to be replaced wholesale for a different device. `HELM_CHANNELS` is the frozen order `['Tx','Ty','Tz','Rp','Ry','Rr']`.

**Frame — `from`.** `helm.from` names the space fed rates are interpreted in — a declaration the host reads to resolve the per-step `basis` (the core stays camera-agnostic):

```
WORLD    the world-aligned eye frame — the identity basis (forward −Z; step's basis is null)
EYE      a viewing camera's frame — screen-relative (default)
SELF     the helm's OWN evolving pose — body-relative
<mat4>   an explicit fixed frame
```

`step` rotates both linear and angular rates through `basis`, then composes the quaternion world-frame — one code path covering body-fly and screen-relative manipulation. `SELF` is body-relative (a per-frame-rebuilt pose matrix); it is a helm `from` value only, not a general mapping space.

**Rest of the surface.**

```js
helm.deadzone = 8       // rest-drift floor — |rate| ≤ deadzone reads as 0
helm.filter = oneEuro({ minCutoff: 1, beta: 0.5 })  // optional input conditioner (filter → deadzone)
helm.fullScale = 500    // raw full-deflection magnitude a read-out divides by
helm.activity(out6)     // six effective rates (post deadzone·sign·sens), channel order
helm.home([pose])       // re-home pos + rot (NOT reset — no keyframes); clears pending rate; resets filter
```

`filter` is an optional input conditioner (default `null`): when set, `step` runs it over the fed rate before the deadzone — filter then deadzone, the two orthogonal (the 1€ removes zero-mean jitter; the deadzone's exact zero is the only no-creep guarantee, since a low-pass passes DC). `fullScale` (default `500`) is the raw full-deflection magnitude a read-out divides by, so a transport on a different input scale declares its own and its meters read honestly. `activity()` reports the raw fed rate (pre-filter) by design.

The `p5.tree` bridge wraps this into `createCameraHelm` / `createPoseHelm` (transport, camera basis, draw-loop player) plus the `helmRig` gizmo and the `createPanel(helm)` profile editor.

---

### Input conditioning — `oneEuro` · `poseDelta`

Two helpers for the rate stream a helm feeds on — flat, out-first, zero-alloc (`filter.js`).

**`oneEuro({ minCutoff, beta, dCutoff })`** is the [1€ filter](https://gery.casiez.net/1euro/) (Casiez et al., CHI'12): a first-order low-pass whose cutoff rises with signal speed — heavy smoothing at rest, low lag under motion. It returns a stateful carrying function, dispatched on its first argument:

```js
import { oneEuro } from '@nakednous/tree'

const f = oneEuro({ minCutoff: 1, beta: 0.5 })   // params live-mutable: f.minCutoff, f.beta

// scalar form — returns the filtered number
const y = f(rawScalar, dt)

// vec form — out-first, zero-alloc after warm-up
const out = [0, 0, 0]
f(out, rawVec3, dt)

f.reset()   // drop state — next call re-seeds
```

It removes zero-mean **jitter**, not a DC **bias**: a low-pass passes a constant offset, so a resting bias survives it and still integrates to drift — pair it with a deadzone (the helm applies filter → deadzone in that order).

**`poseDelta(out, prev, cur, dt)`** differences two absolute poses into the `{ lin, ang }` rate a helm feeds on — the bridge from an absolute transport (a tracked hand, a marker, a played keyframe) to the rate stream.

```js
import { poseDelta } from '@nakednous/tree'

const rate = { lin: [0, 0, 0], ang: [0, 0, 0] }
poseDelta(rate, prevPose, curPose, dt)   // prev / cur: { pos:[x,y,z], rot:[x,y,z,w] }
helm.feed(rate.lin, rate.ang)
```

The angular half carries a **double-cover guard**: a quaternion and its negation are the same orientation, so a source that returns a canonicalised quaternion makes the stored value jump hemispheres as the true orientation sweeps through `w = 0`. When `dot(prev, cur) < 0`, `poseDelta` flips `cur` into `prev`'s hemisphere before differencing, so the relative rotation always takes the short arc — without it the angular rate spikes toward `2π/dt` at every crossing.

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

### Camera state

The camera is plain data — the `CameraTrack` keyframe shape — with pure functions between it and the matrices a draw uploads (`camera.js`). There is no camera object: a track evaluates into the state, a pose drives it, an orbit gesture edits it, and a renderer installs the matrices built from it.

```js
import { createCamera, cameraView, cameraEye, cameraProj, cameraPlanes, WEBGL } from '@nakednous/tree'

const cam = createCamera({ eye: [0, 0, 500], center: [0, 0, 0], fov: Math.PI / 3, near: 0.1, far: 1000 })
// { eye, center, up, fov | halfHeight, near, far } — fov xor halfHeight (perspective xor orthographic)

// per-frame — zero allocation; aspect belongs to the viewport, never to the state
cameraView(V, cam)                          // world → eye
cameraEye(E, cam)                           // eye → world
cameraProj(P, cam, width / height, WEBGL)   // mat4Persp from fov or mat4Ortho from halfHeight; null when both are null
cameraPlanes(planes, cam, width / height)   // the six frustum planes — visibility straight from the state
track.eval(cam)                             // a CameraTrack writes the state directly
```

Decomposers read the state back:

```js
cameraFromMat4(cam, E, P, WEBGL)   // eye, up, forward from E; the lens from P; the gaze distance |center − eye| is kept
cameraFromPose(cam, pose)          // { pos, rot } → lookat at constant gaze distance; the lens untouched
cameraToPose(pose, cam)            // lookat → { pos, rot } — the rotation of cameraEye, a helm's seed
cameraCopy(out, cam)               // one state into another
```

Edits are in place and chainable — the arithmetic behind an orbit gesture, callable from a script just the same:

```js
cameraOrbit(cam, dAz, dEl, { maxEl })   // azimuth about the up hint, elevation clamped short of the pole; never rolls
cameraDolly(cam, factor, { min, max })  // scales the gaze distance — or halfHeight under orthographic
cameraPan(cam, dx, dy)                  // along the eye's right and up, world units (pixelRatio converts pixels)
```

Every function that needs the camera frame derives it through `mat4Eye`, so planes, poses and edits agree with `cameraEye` exactly — including the up re-seed when the view direction is parallel to the hint.

---

### Manipulator constraints

`handle.js` is the renderer-agnostic core of an interactive manipulator: ray-primitive intersections, az/el utilities, and a `Constraint` state machine. The `p5.tree` bridge wraps these into a draggable handle; this package supplies the math and the **contract** that makes the handle extensible.

```js
import { createConstraint, SPHERE, PLANE, AXIS, DIAL, POINT, DIRECTION,
         raySphere, rayPlane, rayClosestPointOnAxis,
         rayHitSphere, rayHitCapsule, rayHitRing,
         dirFromAzEl, azElFromDir } from '@nakednous/tree'

const c = createConstraint(SPHERE, { radius: 1 })  // or PLANE / AXIS / DIAL
const out = [0, 0, 0]
c.solve(ox,oy,oz, dx,dy,dz)   // ray (working space) → canonical state; chainable
c.value(out, DIRECTION)       // write the reported value into out(3)
```

`SPHERE` stores a unit direction (gimbal-free); `PLANE` / `AXIS` store a constrained point; `DIAL` stores an accumulated angle θ (multi-turn winding preserved). `value` reports a `DIRECTION` (unit) or a `POINT` per kind. `aim(ax,ay,az[, zx,zy,zz])` re-aims the constraint basis in the working space — `PLANE` takes a new normal (point re-projected), `AXIS` a new direction (`t` preserved), `DIAL` a new plane normal plus optional θ=0 reference (θ preserved) — the seam the `p5.tree` bridge's deferred `from` frame drives. Ray primitives are out-first and assume a unit ray direction; `rayPlane` returns `Infinity` when the ray is parallel.

**Hit tests — the analytic pick.** Beside the solve primitives, which always write a point, three tests write nothing and return the ray parameter `t` of the nearest hit with `t ≥ 0`, or `Infinity`: `rayHitSphere(o, d, c, r)`, `rayHitCapsule(o, d, a, b, r)` (the segment `a→b` swept by `r`) and `rayHitRing(o, d, c, u, R, r, detail = 32)` (the circle of radius `R` about `c` in the plane ⊥ `u`, swept by tube radius `r`, as a capsule chain of `detail` links — chordal error `R · (1 − cos(π / detail))`, never degenerate edge-on). A ray starting inside hits at its exit, so a press from inside a proxy still grabs. These are what a host's controller picks with instead of a tagged render pass: unproject the pointer, convert the grab size to working units through `pixelRatio`, test every candidate, nearest `t` wins.

**Constraint contract (extension seam).** A constraint is any object exposing `kind`, `solve(ox,oy,oz, dx,dy,dz)`, `value(out, report)`, `seed(x,y,z)`, and optionally `scalar()` / `azEl(out2)` / `aim(ax,ay,az[, zx,zy,zz])` / `proxy(ox,oy,oz, dx,dy,dz, radius)` — the analytic pick: `t` or `Infinity` for a ray against the grab proxy of `radius` working units (built-in kinds: a sphere at the reported `POINT`; `DIAL`: the ring at the anchor with tube `radius`; a kind without one gets the sphere). The handle controller drives any conforming constraint, so a new kind — rotation, 6-DOF, or app-specific — implements this contract (portable, draw-free, its hit test included) plus a bridge-side locus draw, rather than forking the controller. The built-in `Constraint` is the reference implementation. Full design: [`handle-design.md`](./handle-design.md).

---

### Gizmo geometry

`gizmo.js` generates the vertices a gizmo is made of — renderer-free, into a caller-owned arrays object in twgl's `arrays` shape, line lists (and one triangle list) that `createBufferInfoFromArrays` uploads as they are and a WebGPU vertex buffer is filled from. Drawing, colour state, HUD mode, textures and text stay in the bridges.

```js
import { createArrays, growArrays, capacityOf,
         axesLines, gridLines, crossLines, bullsEyeLines, ringLines,
         frustumLines, frustumCorners, hermiteLines,
         pathLines, helmRigLines, locusLines, paneTris } from '@nakednous/tree'

const out = createArrays(64, { color: true })       // { position, color, count }, the one allocating call
let n = axesLines(out, { size: 100 })               // → the vertex count needed; writes min(n, capacity)
if (n > capacityOf(out)) { growArrays(out, n); axesLines(out, { size: 100 }) }
```

Every generator is snprintf-style: it returns the count it needs, writes what fits and sets `out.count`, and states its count formula so a caller can pre-size exactly. With an `out.color` array, `axesLines` and `helmRigLines` write the semantic palette (`COLOR_X` · `COLOR_Y` · `COLOR_Z`, `COLOR_DIM` alpha for a dimmed stroke) and every other generator writes `opts.color`. The bit namespaces (`X` … `LABELS`, `NEAR` … `APEX`, `PATH` … `HANDLES`, `TRANSLATE` · `ROTATE`, `HANDLE` … `RING`) are gizmo-local. `frustumCorners` writes a camera's eight world-space corners (near face counter-clockwise from bottom-left, then far) from a camera state or a matrix-captured `{ mat4Eye, mat4Proj, ndcZMin }`; `pathLines` walks a track's own samplers; `helmRigLines` reads a helm's profile and activity; `locusLines` dispatches on a constraint's kind (or its own `locus(out, opts)`); `paneTris` is the textured quad with one upright uv orientation. Full design: [`gizmo-design.md`](./gizmo-design.md).

---

### Skin — clips, poses and the joint palette

The numeric side of a skinned, animated skeleton. A pose is one flat buffer, `POSE_STRIDE` (10) numbers per node — translation, rotation `[x,y,z,w]`, scale, local to the parent; a hierarchy is a `parents` array, −1 for a root, parents first. A clip is `{ duration, channels }`, each channel `{ node, path, times, values, interp }` with `path` one of `'translation' | 'rotation' | 'scale'` and `interp` one of `'STEP' | 'LINEAR' | 'CUBICSPLINE'` — the animation model of glTF 2.0, which `@nakednous/host`'s `loadModel` delivers in this shape.

```js
import { clipSample, poseBlend, poseWorld, jointPalette, POSE_STRIDE } from '@nakednous/tree'

const pose    = new Float32Array(nodes.rest.length)
const next    = new Float32Array(nodes.rest.length)
const world   = new Float32Array(16 * nodes.parents.length)
const palette = new Float32Array(16 * skin.joints.length)

// per frame — nothing allocates
clipSample(pose, walk, t, { rest: nodes.rest })      // loops by default; { loop: false } clamps
clipSample(next, run,  t, { rest: nodes.rest })
poseBlend(pose, pose, next, fade)                    // a cross-fade: lerp · nlerp · lerp
poseWorld(world, pose, nodes.parents)                // world(i) = world(parent) · local(i)
jointPalette(palette, world, skin.joints, skin.inverseBind)   // world(joint) · inverseBind
```

The palette is what a linear-blend-skinning vertex stage sums, `Σ wᵢ · palette[jointᵢ]`; the world matrices also place rigid meshes and a bone overlay. The clip time is the caller's.

### Mesh — normals, groups, flattening, bounds

What a loaded model may lack or need changed. Positions are flat xyz, indices flat triangles.

```js
import { meshNormals, meshGroups, meshFlatten, meshBounds } from '@nakednous/tree'

// smooth: triangles share their vertices
meshNormals(normals, positions, indices)

// smooth across vertices that coincide — a faceted file, a texture seam
const groups = meshGroups(new Int32Array(positions.length / 3), positions, 1e-6 * bounds.diag)   // once
meshNormals(normals, positions, indices, { groups })                                            // per frame if the mesh deforms

// flat: every triangle owns its vertices
const flat = meshFlatten(mesh)                                     // a new mesh, every attribute expanded
flat.normal = { numComponents: 3, data: meshNormals(new Float32Array(flat.position.data.length), flat.position.data, flat.indices.data) }

const bounds = meshBounds({ min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], diag: 0 }, positions)
```

**One routine gives both looks**, because the difference is in the mesh, not in the formula. `meshNormals` sums on every vertex the cross product of each triangle that uses it — the face normal scaled by twice the face's area, so large faces weigh more — and normalises. Where triangles share vertices the sum is the smooth normal; where every triangle owns its three (`meshFlatten`) each sum has one term, the face normal. `meshGroups` finds the vertices that coincide — positions rounded to a grid of `eps`, hashed — and `meshNormals`, given the groups, sums per position and hands every member the result; the mesh is untouched, unlike a weld, which would merge vertices a seam duplicates on purpose. `meshBounds` writes the box corners, their midpoint and the diagonal's length — what a sketch frames and scales a model by: `s = size / bounds.diag` fits any file to `size`. `@nakednous/host`'s loaders run all of these.

**Limits.** No crease angle: grouping smooths every edge, so a box shades like a pillow — flatten it instead. Grouping is by grid cell: exact duplicates, what files hold, always meet; two points closer than `eps` but either side of a cell boundary do not. A vertex no triangle reaches, or whose triangles cancel, gets `[0, 0, 0]`. `meshFlatten` multiplies the vertex count by up to six, and allocates, as `meshGroups` does; `meshNormals` and `meshBounds` do not.

**Sources.** Area-weighted vertex normals from unnormalised face cross products, and de-indexing for flat shading, are standard practice; smoothing coincident vertices by position hashing is the usual alternative to welding. Keeping the groups as a reusable index array beside an untouched mesh is this module's arrangement.

### Platonic solids

The five regular polyhedra as meshes, in the arrays shape twgl's primitives and a loaded model's meshes share — `{ position, normal, texcoord, color, indices }` — so a bridge uploads one as it uploads those. A setup-time call; every face owns its vertices (flat normals), fan-triangulated through the indices.

```js
import { platonic, ICOSAHEDRON, HEXAHEDRON } from '@nakednous/tree'

const ico  = platonic(ICOSAHEDRON, { radius: 80 })
const dice = platonic(HEXAHEDRON, { radius: 60, colors: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], fuse: true })
// webgl.tree: buffer(gl, ico) — exactly as buffer(gl, twgl.primitives.createSphereVertices(80, 24, 16))
```

| Kind (its face count) | Vertices | Edge, for a circumradius of 1 |
|---|---|---|
| `TETRAHEDRON` 4 | 12 | √(8/3) |
| `HEXAHEDRON` 6 | 24 | 2/√3 |
| `OCTAHEDRON` 8 | 24 | √2 |
| `DODECAHEDRON` 12 | 60 | (√5 − 1)/√3 |
| `ICOSAHEDRON` 20 | 60 | 1/sin(2π/5) |

- `radius` (default 100) is the **circumradius**: all five inscribe in one sphere, so duals nest and a bound is the radius.
- `uvs: 'face'` (default) fits every face's polygon in the unit square, upright and unstretched — each face shows the whole texture, a hexahedron's exactly. `uvs: 'sphere'` is the equirectangular map, each face unwrapped around its own centre so none straddles the seam (u may leave [0, 1]: set the texture to repeat in u); a vertex at a pole takes its face's u.
- `colors`, a list of `[r, g, b, a?]`, is cycled per face — or per solid vertex with `fuse`, so faces blend at shared corners. Without it a face is coloured by its orientation, `nx² · COLOR_X + ny² · COLOR_Y + nz² · COLOR_Z`: a hexahedron shows the axis palette exactly.

**How it is built.** (1) Vertices are the classical coordinates on the unit sphere — alternate cube corners; (±1, ±1, ±1); the axis points; (±1, ±1, ±1) with the cyclic shifts of (0, ±φ, ±1/φ); the cyclic shifts of (0, ±1, ±φ). (2) Faces come from the **dual**: a face of a convex polyhedron is the set of vertices maximising `v · d` for its outward normal `d`, and a regular solid's face normals are its dual's vertex directions — so no face table is written by hand, and an error cannot produce an irregular solid. (3) Each face's vertices are sorted by angle in the face's own frame (up = world +y projected into the face, −z / +z on a face looking straight up / down), counter-clockwise from outside. (4) Each face is fanned into triangles, valid because it is convex. The routine underneath handles any convex polyhedron given as vertices plus face directions, faces of different sizes included; the export stays closed to the five.

**Limits.** Convex only; flat normals only; 16-bit indices; allocates (setup-time). `'sphere'` uvs: u leaves [0, 1] on seam-crossing faces, a face centred on a pole (the hexahedron's top and bottom) pinches as a latitude–longitude sphere does, and the map bends most across the largest faces (the tetrahedron). `'face'` uvs show the same texture on every face, a triangle or pentagon seeing the part its outline covers. The arrays are `{ numComponents, data }` objects, which twgl uploads; twgl's vertex helpers (`deindexVertices`, `flattenNormals`) expect its own augmented typed arrays instead — nothing here needs them, faces already own their vertices.

**Sources.** Coordinates and duality: H. S. M. Coxeter, *Regular Polytopes* (3rd ed., Dover, 1973), ch. 1–3. Faces as maximisers of a linear functional: G. M. Ziegler, *Lectures on Polytopes* (Springer, 1995), ch. 2. Fan triangulation, the equirectangular map and clearing the seam by whole turns of u are standard practice. Deriving the faces from the dual's directions in place of face tables, the face frame, the `'face'` fit and the orientation colour rule are this module's own arrangement of those facts. The API descends from [p5.platonic](https://github.com/VisualComputing/p5.platonic).

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
mat4Mul  mat4Invert  mat4MulPoint  mat4MulDir
mat3NormalFromMat4  mat4Location  mat3Direction
mat4PV  mat4MV
```

**TRS ↔ mat4 (track.js):** `transformToMat4`, `mat4ToTransform`

**Matrix construction from specs** (`form.js`):
```
mat4FromBasis        — rigid frame from orthonormal basis + translation
mat4View             — view matrix (world→eye) from lookat params (up re-seeded when ∥ view direction)
mat4Eye              — eye matrix (eye→world) from lookat params  (same rule)
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

**Viewport matrix:** `mat4Viewport(out, vp, ndcZMin)` — the matrix `W` taking NDC to screen coordinates, so world → screen is `(W · P · V · p) / w` through `mat4MulPoint` and screen → world the inverse of that composition

**Pick matrix:** `mat4Pick(proj, px, py, vp)` — mutates a projection matrix in-place so that the pixel at `(px, py)` maps to the full NDC square, making a 1×1 FBO render contain exactly that pixel. Takes the same signed viewport `vp` as `mapLocation` — the y-convention is preserved automatically.

**Pointer ray:** `unproject(outO, outD, sx, sy, m, vp, ndcZMin)` — a screen point as a world ray: origin on the near plane, unit direction toward the far plane. Same bag and signed viewport as `mapLocation` (`mat4PVInv` filled by the caller); `null` when the bag has no inverse. The point-at-depth form stays `mapLocation(SCREEN → WORLD)` with a depth in `z`.

**Pointer hit:** `pointerHit(px, py, x, y, z, radius, m, vp, ndcZMin, shape = CIRCLE)` — is the pointer within `radius` px of the projected world point? `CIRCLE` (Euclidean) or `SQUARE` (Chebyshev), boundary inclusive; a point whose screen depth falls outside `[0, 1]` never hits.

**Pick-id codec:** `idToRgba(out, id)` packs a 24-bit id into `[r, g, b, 1]` normalised floats, R the low byte; `rgbaToId(r, g, b)` decodes the bytes of a readback. Id `0` is the background; ids run `1 … 2²⁴ − 1`.

**Camera state** (`camera.js`):
```
createCamera  cameraCopy
cameraView  cameraEye  cameraProj  cameraPlanes
cameraFromMat4  cameraFromPose  cameraToPose
cameraOrbit  cameraDolly  cameraPan
```

---

### Constants

```js
// Coordinate spaces
WORLD, EYE, NDC, SCREEN, MODEL, MATRIX

// Helm integrator frame (helm `from` only — body-relative, not a mapping space)
SELF

// NDC Z convention
WEBGL   // −1  (z ∈ [−1, 1])
WEBGPU  //  0  (z ∈ [0, 1])

// Visibility results
INVISIBLE, VISIBLE, SEMIVISIBLE

// Manipulator constraint kinds & report modes
SPHERE, PLANE, AXIS, DIAL
POINT, DIRECTION

// Pointer-hit shapes
CIRCLE, SQUARE

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

## Golden vectors

`golden/` holds one JSON fixture per source module — `{ args, out }` cases for every exported function and `{ call, args, expect }` transcripts for the stateful classes — generated from this core and committed with the repo (not shipped in the package). They are both the regression suite and the port contract: a port is conformant when it reproduces them within the stated tolerances (exact for ints and enums, `1e-6` for `f64` state, `1e-5` for `f32` matrices).

```bash
npm run golden   # regenerate every fixture from src/
npm test         # assert src/ against golden/, and that every export has a fixture
```

The fixture format is specified in `tools/golden.js`. A function without a fixture is not exported.

---

## Relationship to the bridges

The bridges are where rendering lives. [p5.tree](https://github.com/VisualComputing/p5.tree) reads live p5 renderer state (camera matrices, viewport, NDC convention) into the host's view bag and draws the gizmo arrays with p5's own strokes; `webgl.tree` installs the camera, uploads the declared transforms and draws the same arrays through a line pipe on raw WebGL2; `webgpu.tree` realizes the same surface on WebGPU. Between them sits [`@nakednous/host`](https://github.com/nakednous/host): the pointer, the players, the handles, helms and tracks, the device streams, labels and the orbit — DOM transport, no renderer — which every bridge drives and which computes only through this package.

`@nakednous/tree` provides the algorithms, `@nakednous/host` the transport, `@nakednous/ui` the panels. The bridges provide the drawing.

---

## Acknowledgements

- [glTF 2.0](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html) (Khronos Group) — the animation model `skin.js` samples (channel paths, `STEP` / `LINEAR` / `CUBICSPLINE` interpolation, the cubic spline key layout), the joint-matrix equation, and the `[x,y,z,w]` quaternion layout.
- [three.js](https://threejs.org/) — `qFromUnitVectors` follows its `setFromUnitVectors`; the camera keyframes' `near` / `far` defaults follow its conventions.
- [twgl](https://twgljs.org/) — the arrays shape the gizmo generators and `platonic` write.
- [p5.platonic](https://github.com/VisualComputing/p5.platonic) (JP Charalambos) — `platonic.js` descends from it: the five solids, colouring per face or per fused vertex.

---

## License

AGPL-3.0-only  
© JP Charalambos
