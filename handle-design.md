# `handle` — interactive manipulator (design / implementation spec)

> Target: `@nakednous/tree` v0.0.27 + `p5.tree` v0.0.49. Bridge-portable to `three.tree`.
> Status: commits 1–7 shipped. 1–6: core + bridge (factory, grab, bind, draw, VIEW, examples, README) plus per-pointer multitouch (§4.11 "A"); a later simplification **removed the input `frame` (`EYE`) and the `HUD` dial** — `WORLD`/`EYE` survive only as `value({ to })` conversion targets, so the handle always solves in `WORLD` and an eye-relative reading (the headlight) is a read-time conversion (§4.10). Commit 7 (the formerly deferred set): **rotation (`DIAL`), snap, hover, cancel, the overlapping-handle coordinator (`createPointerRouter`, §4.11 "B"), and the custom-kind `drawLocus`/`pickProxy` seam (§9)** — shipped, **pending empirical validation** via `handle-experiments/` (e2 edge-on and e3 cluster are the release gates). `VIEW` renumbered 3→4 to make room for core `DIAL = 3` (pre-1.0). Names marked *(provisional)* are open to veto. **Commit 8** (the
> deferred constraint frame): core `Constraint.aim()` + bridge `from` opt
> (§4.13) — **validated** via `handle-examples/` 11 (direct manipulation +
> screen ring), 12 (third-frame hinge), 13 (screen rail — the AXIS `aim`
> branch), 14 (tilting table — the PLANE `aim` branch), with e1–e10 as the
> from-less regression set; releasing in the target
> versions above. A `direct()` API is decided OUT — §4.13.

---

## 1. Scope

A **handle** is a draggable 3D control that reports a value. It is defined by two
orthogonal axes:

- **constraint** — how the pointer ray maps to a value (the DOF model)
- **binding** — what the value drives (consumption)

The handle solves and stores in `WORLD`; `value({ to })` converts on read.

### In scope (v0.0.45)

| Constraint | DOF | Reports |
|---|---|---|
| `SPHERE`   | 2  | `DIRECTION` (unit) or `POINT` (dir·r) |
| `PLANE`    | 2  | `POINT` on a fixed world plane |
| `AXIS`     | 1  | scalar `t` + `POINT` on a line |
| `DIAL`     | 1  | accumulated angle `θ` (multi-turn) + `POINT` on a circle or `DIRECTION` (radial unit) |
| `VIEW`     | 2  | `POINT` (world position) on the camera-facing plane |

`VIEW` is a **bridge constraint backed by the core `PLANE` primitive** with a
per-frame, camera-derived plane. The core never learns about the camera.
`DIAL` is the rotation handle — a core kind (§3.6): pure circle geometry, no
camera, no quaternion in its state.

### Out of scope (deferred, not in core)

Scale, multi-target groups, and any **transform-on-object (TRS) gizmo**. TRS is
deferred to the host: `three.tree` defers to three's `TransformControls`; a
p5-only object gizmo is a possible future `p5.tree` addition, never core —
though `handle-experiments/e3` assembles a working cluster from N handles + the
router, which is the supported path. Core stays the value-handle semantics both
bridges share. An arcball is deliberately NOT a kind: it composes from `SPHERE`
deltas in sketch space (`handle-experiments/e1`). A **6-DOF rate device**
(SpaceNavigator — and any gesture / agent transport) is likewise NOT a handle: it
reports a *pose*, not a `vec3`, so it is a Track-family sibling — a *helm* — not a
constraint (its reference experiments are `handle-experiments/e7-*`).

---

## 2. Layering

```
@nakednous/tree   handle.js   constraint solver + canonical state + value
                              mapping + ray-primitive intersections.
                              Pure numbers. Frame-agnostic. No p5/DOM/GL/camera.

p5.tree           handle.js   createHandle factory + controller lifecycle,
                              pointer events, pixel→ray, mousePick/tag grab,
                              value-space conversion, binders, draw.

@nakednous/ui     (optional)  dial / readout widget. The manipulator core must
                              NOT depend on ui; readout is presentation only.
```

New modules: exactly one per package, parallel-named with `track` precedent
(`tree/src/track.js` ↔ `p5.tree/src/track.js`) →
`tree/src/handle.js` ↔ `p5.tree/src/handle.js`.

Ray-primitive intersections live in `tree/handle.js` (vector geometry serving
the constraints), **not** in `query.js` (which is matrix→information). Promote a
primitive to `query.js` only if a second consumer appears.

---

## 3. Core — `@nakednous/tree/handle.js`

```js
/**
 * @file Constraint solver, canonical handle state, and ray-primitive
 *       intersections. Renderer- and frame-agnostic. Zero dependencies.
 * @module tree/handle
 * @license AGPL-3.0-only
 *
 * Inputs are plain numbers in ONE working space chosen by the caller (the
 * bridge). The solver never knows world vs eye — it solves in whatever space
 * the ray and geometry are expressed in. Out-first throughout; no allocation
 * in solve/value. ArrayLike<number> in, ArrayLike<number> out (never p5.Vector).
 *
 * Storage convention (matches the rest of the core): mat4 is a 16-element
 * ArrayLike, typically Float32Array (it crosses the GL boundary); vec3/quat
 * state is plain number[] (f64) — the same shape as track.js keyframes and the
 * frozen basis-vector constants, which cannot be expressed as frozen typed
 * arrays. Handle state is therefore plain number[], not Float32Array.
 */
```

### 3.1 Constants

Core defines (re-exported through `tree/constants.js`):

```js
export const SPHERE = 0;
export const PLANE  = 1;
export const AXIS   = 2;
export const DIAL   = 3;
// report
export const POINT     = 0;
export const DIRECTION = 1;
```

`VIEW`, `WORLD`, `EYE` are **not** core handle concepts. `VIEW` is bridge-only;
`WORLD`/`EYE` already exist for `mapLocation`/`mapDirection`.

### 3.2 Ray-primitive intersections (pure, out-first)

`o`, `d`, `c`, `p`, `n`, `u` are length-3 `ArrayLike<number>`. `d` is assumed
unit. `out` is length-3, written in place; the scalar parameter is returned.

```js
/** Nearest ray–sphere hit; on miss, closest-approach point projected to r.
 *  @returns {number} ray parameter t at the written hit. */
export function raySphere(out, o, d, c, r);

/** Ray–plane hit. Parallel (|d·n| < EPS) returns Infinity; caller guards.
 *  @returns {number} ray parameter t. */
export function rayPlane(out, o, d, p, n);

/** Closest point on the infinite line (p, u) to the ray (o, d).
 *  @returns {number} signed parameter s along u (unclamped). */
export function rayClosestPointOnAxis(out, o, d, p, u);
```

Algorithms (reference):

```
raySphere:  L=o-c; b=L·d; cc=L·L-r*r; disc=b*b-cc;
            disc>=0 ? (t=-b-sqrt(disc), t<0 && (t=-b+sqrt(disc)), hit=o+t d)
                    : (t=-b, hit=o+t d, hit=c + r*normalize(hit-c));
rayPlane:   den=d·n; |den|<EPS ? return Inf : (t=((p-o)·n)/den, hit=o+t d);
rayAxis:    w=o-p; b=d·u; e=u·w; dd=d·w; den=1-b*b (d,u unit);
            s=(e-b*dd)/den; pt=p+s u;
```

### 3.3 Angular utilities (readout / author convenience)

Right-handed convention: `az` about +Y, `el` from the XZ plane. The solver does
**not** depend on this — it stores the unit hit direction directly. These exist
for authors who want angular control and for readout.

```js
/** out = [cos el·cos az, sin el, cos el·sin az]. @returns out */
export function dirFromAzEl(out, az, el);
/** out2 = [az, el] from a unit dir. @returns out2 */
export function azElFromDir(out2, dir);
```

### 3.4 Constraint object (stateful, minimal — mirrors `Track` being a class)

The core owns the **canonical state** and the value mapping. Canonical reps are
chosen to avoid degeneracy:

- `SPHERE` stores a **unit direction** (plain `number[3]`, the core's vec3
  convention — see header; renormalized every solve) + `radius` + `report`.
  az/el are derived only on request — no stored Euler angles, no gimbal poles.
- `PLANE` stores the hit `point` + a constant `normal` + plane anchor.
- `AXIS` stores scalar `s` + derived `point` + line `(anchor, dir)` + optional
  `[min,max]` extent.
- `DIAL` stores an **accumulated angle `θ`** (in `s`) + an in-plane basis
  `(r0, r1)` derived once at construction + `radius` — see §3.6.

```js
/** @returns {Constraint} */
export function createConstraint(kind, opts);
//  SPHERE opts: { radius = 1, report = DIRECTION }
//  PLANE  opts: { anchor = [0,0,0], normal = [0,1,0], extent? }
//  AXIS   opts: { anchor = [0,0,0], dir = [1,0,0], extent = [-1,1] }
//  DIAL   opts: { anchor = [0,0,0], axis = [0,1,0], radius = 1, zero?,
//                 extent = [-∞,∞] }   // axis = plane normal; zero = θ=0 ref;
//                                      // extent clamps θ (rad), unbounded default

class Constraint {
  kind;                       // SPHERE | PLANE | AXIS | DIAL
  solve(ox,oy,oz, dx,dy,dz);  // update state from a ray in working space; chainable
  value(out, report);         // write value into out(3); report overrides default
  scalar();                   // AXIS: current t · DIAL: accumulated θ (multi-turn)
  azEl(out2);                 // SPHERE only: derive [az, el]
  seed(v);                    // set state from a value (used by bind: get() → state)
  aim(ax,ay,az, zx?,zy?,zz?); // re-aim the basis in the working space: PLANE normal
                              // (pt re-projected) · AXIS dir (t preserved) · DIAL
                              // axis + optional zero (θ preserved) · SPHERE no-op —
                              // the deferred-frame seam (§4.13)
  set radius(r); get radius;  // SPHERE / DIAL live radius (scroll-to-zoom, push/pull)
}
```

`solve`/`value` allocate nothing. `value` for `SPHERE`+`DIRECTION` writes the
unit dir; `+POINT` writes `dir·radius`. `PLANE`/`VIEW`/`AXIS` write the point.

The bridge owns `VIEW` by calling `createConstraint(PLANE, …)` and feeding a
fresh camera-facing `normal`+`anchor` into a `solve` each frame (the plane
re-derives from the camera; the core stays oblivious).

### 3.5 Port & thread-safety

`Constraint` is **one tagged class** (a `kind` discriminant + internal switch),
never per-constraint subclasses. This ports 1:1 to a Rust `enum Constraint` +
`impl` (`fn solve(&mut self, o, d)`, `fn value(&self, out, report)`) — more
idiomatic in Rust than in JS. State is POD (`[f32;3]`, `f32`, enum tags), so the
struct is `Send + Sync` for free, and `&mut self` on `solve` makes concurrent
mutation a compile error — it slots into a Bevy system's scheduled `&mut`
access. The invariant that preserves this: **no closures, handles, or external
references in core state.** Binding (`{ get, set }`) lives in the bridge for
exactly this reason — a `Box<dyn FnMut>` in core would forfeit `Send`/`Sync`.
(JS truncates f64→f32 on store while Rust stays f32; bit-exact cross-port parity
is not guaranteed and not required for an interactive manipulator.)

### 3.6 `DIAL` — the rotation constraint

A 1-DOF angle on a circle of `radius` in the plane `(anchor, axis)`. Canonical
state is the **accumulated** angle `θ` (stored in `s`, so `scalar()` covers
`AXIS | DIAL` with one rule): each solve applies the **smaller signed arc**
between the previous wrapped angle and the new raw one, so `θ` preserves
**multi-turn winding** — "rotate this 720°" is representable, and a bind target
never sees an unwound jump. `θ = 0` sits at `zero` (projected onto the plane and
normalized; derived from the axis via the least-aligned-axis basis when absent),
and grows right-handed about `axis`. `extent` clamps `θ` in radians — unbounded
by default. `value(POINT)` is the point on the circle (derived from `θ` + live
`radius`, like `SPHERE`); `value(DIRECTION)` is the radial unit at `θ`.

**Edge-on robustness (the classic rotate-gizmo failure).** Viewed edge-on the
dial plane is nearly parallel to the pick ray; the plane hit races to infinity
and dθ-per-pixel diverges (three.js `TransformControls` #13806). Below
`|d·axis| < DIAL_EDGE` (`0.08` ≈ 4.6°, a core constant tuned by
`handle-experiments/e2`) the solve switches to the **tangent line** of the
circle at the current `θ`: `rayClosestPointOnAxis` against the tangent, and the
signed tangent parameter over the radius IS `dθ` — bounded, monotone, still pure
ray geometry, and continuous with the plane path at the threshold (both reduce
to arc-length over radius for small motions). Blender's dial gizmo does the
moral equivalent.

`seed` projects the value onto the dial plane, derives the wrapped angle, and
picks the **winding nearest the current `θ`** — an external `sync()` doesn't
unwind accumulated turns. (Cancel restores `θ` exactly, bridge-side, for the
same reason — §4.12.)

---

## 4. Bridge — `p5.tree/handle.js`

```js
/**
 * @file Interactive manipulator handle. Wraps a tree Constraint with pointer
 *       transport, pixel→ray unprojection, color-ID grab, value-space
 *       conversion, binding, and draw. Constructed like a track; draws like a gizmo.
 * @module p5.tree/handle
 * @license AGPL-3.0-only
 */
```

### 4.1 Constants (bridge)

```js
// p5.Tree.SPHERE / PLANE / AXIS / DIAL  (re-exported from core)
// p5.Tree.VIEW   = 4             (bridge-only; was 3 — renumbered for core DIAL = 3, pre-1.0)
// p5.Tree.POINT / DIRECTION      (re-exported)
// p5.Tree.WORLD / EYE            (existing — value({ to }) conversion targets, not an input frame)
// draw bits (orthogonal, mirrors trackPath bits):
//   p5.Tree.HANDLE   1   the draggable dot (default on)
//   p5.Tree.AIM      2   anchor→handle line / gaze / dial spoke
//   p5.Tree.LOCUS    4   constraint surface (locus of allowed positions): sphere wire | plane quad | axis | dial ring | view square
//   p5.Tree.RING     8   sphere limb / plane border highlight
```

### 4.2 Factory

```js
const h = createHandle(opts);
// opts:
//   constraint : SPHERE | PLANE | AXIS | DIAL | VIEW | <contract object>  (required; object form — §9)
//   report     : POINT | DIRECTION                     (default per constraint)
//   anchor     : p5.Vector | [x,y,z]                    (constraint origin; default origin)
//   radius     : number                                (SPHERE / DIAL; default 1)
//   axis       : p5.Vector | [x,y,z]                    (AXIS dir, default +X; DIAL plane normal, default +Y)
//   normal     : p5.Vector | [x,y,z]                    (PLANE normal; default +Y)
//   zero       : p5.Vector | [x,y,z]                    (DIAL θ=0 reference; derived when absent)
//   from       : WORLD | EYE | mat4                     (deferred basis frame for axis/normal/zero — §4.13; default WORLD ≡ resolution-free)
//   extent     : [min,max]                              (AXIS clamp; DIAL θ clamp in rad, unbounded default)
//   grabPx     : number                                 (pick proxy radius in px; default 12)
//   snap       : number | [x,y,z]                       (angular step rad (SPHERE az/el, DIAL θ) or world grid (PLANE/AXIS/VIEW); null = off; settable live — §4.12)
//   hover      : boolean                                (lone-handle pick-on-move; default false — the router provides hover shared; §4.12)
//   enabled    : boolean                                (default true; gate without disposing)
//   bind       : <bind target>                          (optional; see 4.7)
//   drawLocus  : (h, opts) => {}                        (custom-kind locus draw — §9)
//   pickProxy  : (h, pos, rad) => {}                    (custom-kind tagged pick geometry — §9)
//   onGrab / onChange / onRelease / onCancel : Function (optional hooks; see 4.3, 4.12)
//   (no draw-style opts here — draw() uses ambient p5 stroke/fill; dot radius is draw({ size }) in px)
```

`enabled` and the hooks are also settable on the controller after construction
(see 4.3).

`createHandle` returns a **controller** (stateful, like `createCameraTrack`),
not a draw call. There is no stateless `fn.handle()` forwarder — nothing
stateless to forward.

### 4.3 Controller API

```js
h.update();                 // FIRST in draw(): resolve grab + re-solve; RETURNS grabbed (bool)
h.draw(opts);               // render visuals; opts: { bits, size, marker } (ambient stroke/fill; options last)
h.value(opts);              // { to = WORLD | EYE | … | mat4, report?, out, mat4Eye?, mat4Proj?, mat4View?, mat4PV? } → p5.Vector (fresh if no out)
h.scalar();                 // AXIS: current t · DIAL: accumulated θ (multi-turn)
h.azEl(out2?);              // SPHERE: [az, el] for readout / HUD
h.grabbed();                // bool — true between grab and release
h.hovered();                // bool — pointer on the proxy (opt-in / router-fed; §4.12)
h.cancel();                 // revert the drag in flight to its grab-time value; chainable (§4.12)
h.snap = 25;                // settable live — gate on a modifier for the Ctrl idiom (§4.12)
h.bind(target, ...);        // polymorphic; see 4.7 (chainable)
h.sync();                   // re-read the bound target into state after an external change; chainable
h.anchor(v);                // move the constraint origin (chainable)
h.enabled = true;           // settable gate — false suspends grab/solve without disposing (cf. three .enabled)
h.dispose();                // remove pointer listeners

// Hooks — mirror Track's onPlay/onEnd/onStop (+ lib-space _on* for the bridge/UI):
h.onGrab    = (h) => {};       // press landed on the handle
h.onChange  = (value, h) => {}; // fires each solve while held (value = current value(), post-snap)
h.onRelease = (h) => {};       // pointer up (a committed drag)
h.onCancel  = (h) => {};       // drag reverted — Esc / pointercancel / cancel(); onRelease does NOT fire
```

`value` mirrors `mapLocation`: `out` opt-in, fresh `p5.Vector` when omitted,
zero-alloc when supplied. `DIRECTION` routes through `mapDirection`, `POINT`
through `mapLocation`, using the matrices bag (`mat4PVInv`, `mat4View`, …).
Default `to` is `WORLD` — so `h.value()` reads clean. Override with
`value({ to })` — any `mapLocation` space (`EYE` for an eye-relative reading —
the headlight, §4.10) or a raw mat4 (a model matrix → that object's local
coordinates), with the same `mat4Eye`/`mat4Proj`/`mat4View`/`mat4PV` overrides;
`report` overrides POINT/DIRECTION for that read.

The hooks are the change/commit seam every DCC manipulator exposes (three's
`dragging-changed`/`objectChange`, Blender's modal states, Godot/Unreal's
commit-on-release). `onChange` drives reactive readouts; capturing `value()` in
`onGrab` and acting in `onRelease` is the undo/redo pattern (Godot `_commit_handle`,
Unreal `StateTarget`). Firing order mirrors `Track`: user hook then `_on*`.

### 4.4 Lifecycle & ordering contract

Host-driven, exactly the prototype's ordering — **not** a predraw hook, because
the orbit gate depends on `grabbed()` resolving before `orbitControl`:

```js
function draw() {
  background(10)
  if (!h.update()) orbitControl()  // update() returns grabbed; grab wins over orbit
  // ... scene ...
  h.draw()
}
```

Internals:

- Pointer listeners (attached at construction to the p5 canvas) set flags only:
  `pressed@(x,y)`, `moved@(x,y)`, `released`.
- `update()`: if disabled, no-op returning false. If a press is pending →
  `mousePick` the tagged proxy(es) to set `grabbed` + which sub-handle (fire
  `onGrab`). If `grabbed` and moved → build the world ray, `constraint.solve(o,d)`
  in `WORLD`, `set(value)` if bound, fire `onChange`. On release fire
  `onRelease`. Returns the post-update `grabbed` state.
- The handle always solves in `WORLD`; an eye-relative reading (the headlight)
  is `value({ to: EYE })`, a read-time conversion (§4.10).

### 4.5 Pixel → ray

Reuse existing machinery, no new unproject. Two `mapLocation` calls
(`SCREEN`/`NDC` → `WORLD`) at near and far NDC z (read via `getNdcZ()`, never
hardcoded), forming `O` (near) and `D = normalize(far − near)`. The matrices bag
supplies `mat4PVInv`; the signed-`vp[3]` convention already in `query.js`
handles screen-y.

### 4.6 Picking (grab)

`mousePick` + `tag(id)`: in the pick callback, render one tagged proxy sphere per
sub-handle (single sphere for `SPHERE`/`PLANE`/`VIEW`; the axis cap for `AXIS`;
future: 3 axis + 3 plane proxies, each its own id). The returned id selects the
grabbed sub-handle. No new FBO — `mousePick` owns the FBO and its
`uPMatrix`/`uViewMatrix` save/restore; the handle must not re-implement either.
Visual `draw()` goes to the main canvas like every gizmo (shared depth);
**no** separate overlay buffer by default.

### 4.7 Binding (polymorphic `bind`, accessor floor)

Floor contract — an accessor pair `{ get, set }` (`get → value`, `set(value)`):

```js
h.bind({ get: () => v, set: (out) => { /* write */ } })
```

Sugar — `bind()` dispatches on unambiguous shapes (mirrors polymorphic
`viewFrustum({ camera })`):

```js
h.bind(vec)                  // p5.Vector — mutated in place (zero-alloc)
h.bind(cam, 'eye')           // p5.Camera field: 'eye' | 'center' | 'up'; re-applies camera
```

Dispatch keys on `instanceof p5.Vector` / `p5.Camera`, else the accessor floor —
no positional ambiguity. On `bind`, `get()` seeds the constraint
(`constraint.seed(get())`) so the handle starts at the bound value. While held,
`update()` calls `set(value)` each solve (and fires `onChange`). `sync()` re-runs
the seed from `get()` when the target changed externally. Unbound handles are
pull-only via `value()`.

Keyframe authoring (`bind(track, i, field)`) is deferred sugar — the accessor
floor already expresses it today:

```js
h.bind({ get: () => track.keyframes[i].eye,
         set: (v) => track.set(i, { eye: [v.x, v.y, v.z] }) })
```

### 4.8 Draw

```js
h.draw()                                  // default bits: HANDLE | AIM | LOCUS
h.draw({ bits: p5.Tree.HANDLE })          // dot only
h.draw({ bits: p5.Tree.HANDLE | p5.Tree.LOCUS, size })   // size = dot radius (px)
h.draw({ marker: null })                  // suppress entirely (parity with trackPath)
```

Options-last, bit-flags, dark-bg/bright-stroke example aesthetic — identical
conventions to `gizmos.js`. Draw uses the **ambient p5 state** like every gizmo:
`stroke()` for the stroked parts (AIM/LOCUS/RING), `fill()` for the dot (HANDLE) —
no `color`/`style` override; split the call to colour parts independently. The
handle composes existing primitives
(`pane` for the view square, axis lines, a ring) rather than re-implementing
them. `textureMode`/shader state caveats from the gizmo layer apply unchanged.

The dot and pick proxy draw at **constant screen size** regardless of depth via
the bridge's `pixelRatio(camera, eyeZ)` (world-units-per-pixel) — matching three's
gizmo `size` and Unreal's constant-screen-space handle dimensions. `draw({ size })`
and `grabPx` are pixel units.

### 4.9 Interaction-metaphor parity

Where the design sits against three (`TransformControls`/`DragControls`), Godot,
Bevy `transform-gizmo`, Unreal ITF, Blender:

- **Matches:** axis-translate (`AXIS`) and plane-translate (`PLANE`) handles;
  camera-plane free drag (`VIEW` ≡ three `DragControls` / Blender grab);
  constrained rotation (`DIAL` ≡ three rotate gizmo / Blender dial / Bevy arcs)
  with ring-grab (torus proxy) and edge-on robustness (§3.6 — where three #13806
  fails); per-handle `snap` (Blender Ctrl idiom via the live setter); hover
  (shared through the router, like Blender's one select pass per region);
  cancel-in-flight (Esc / `pointercancel` ≡ Blender modal CANCELLED, three
  `reset()`); drag-follow + grab-pick + constant screen size; target binding by
  accessor (Blender `target_set_handler`) and by object/field (three `attach`);
  change/commit hooks; a runtime `enabled` toggle (three `.enabled`); the
  overlapping-cluster coordinator (`createPointerRouter` ≡ Blender's gizmo-group
  select pass / Unreal's priority arbitration); world/local constraint frames
  (`from` ≡ three `setSpace('world'|'local')`, declaratively per handle — §4.13).
- **Ahead / fills the gap:** interactive direction-on-sphere (the headlight, via
  a `value({ to: EYE })` read) — none ship this as a first-class manipulator;
  treating *report type* as a flag on one constraint decoupled from any scene
  object; per-finger concurrent gestures over a shared surface (§4.11);
  multi-turn `θ` as the canonical rotation state; constraint frames beyond
  world/local — `from` accepts `EYE` (the screen ring, the screen rail) and ANY
  mat4 frame (a hinge on another object's axis), where the DCC gizmos hardcode a
  two-value toggle (§4.13).
- **Deferred:** scale handles, a packaged TRS composite (app-level assembly —
  §9; `handle-experiments/e3` is the reference assembly), snap *visualization*
  (tick marks on the locus), constraint-aware cursor shapes.

### 4.10 Direction readouts (the dropped `HUD` dial)

An earlier cut shipped a `display: SCENE | HUD` flag: `HUD` drew a 2D dial whose
polar position seeded the `SPHERE` heading (pointer → `(az, el)` → `dirFromAzEl`
→ `seed`). It was **removed**. A direction is 3 components but 2 DOF — it lives
on the sphere — and mapping two flat dial inputs onto the sphere is an arbitrary
projection (az/el vs orthographic vs plane-normalize); every choice felt wrong
because the dial-as-*input* is ill-posed. The honest direction input is the 3D
sphere pick itself (`SCENE`, the only surface), where the 2 DOF fall out of the
ray–sphere geometry for free.

A 2D dial survives only as a **passive readout**, drawn by the sketch from
`h.azEl()` (or the projected `value()`), never read back as input — exactly what
`lightgizmo` does in the notebook, and what examples 02 and 08 draw. So there is
no `display` flag and no `HUD` input path: `draw()` is always `SCENE`; the dial
is author chrome.

The headlight (an eye-fixed heading) is likewise not a mode: hold the eye vector
in the sketch and rebuild the world heading each frame via
`mapDirection(EYE→WORLD)`, `sync()`-ing the handle so its dot tracks (example
08). That is precisely what an input `frame: EYE` did internally — now explicit,
in the sketch, with no hidden frame on the handle.

A genuinely draggable flat control is still possible, but only as a 2-DOF pad
reporting raw `(x, y)` that the sketch maps — a `PLANE` shown flat, never a
`SPHERE` on a dial. Deferred; not needed by any current example.

**Relation to `from` (§4.13).** The removed input `frame` was *continuous*: the
handle's geometry re-derived from the camera every frame, including mid-drag —
hidden state that moved the constraint under the cursor. The §4.13 `from` opt
is *press-resolved*: the symbolic basis is mapped into `WORLD` once per drag
(at grab) and merely previewed while idle, so a drag always solves a stationary
constraint. The headlight — an anchor riding the eye — therefore stays a
sketch pattern; `from` resolves directions only and `from: EYE` does not
reintroduce the cut feature.

### 4.11 Multitouch — per-pointer capture (`A`) and the shared-pick coordinator (`B`, deferred)

Two needs hide under "many handles," and they want different machinery:

- **`A` — several *independent*, non-overlapping handles, one finger each** (the
  tabletop case). No new type. The controller keys its whole gesture to a single
  `pointerId`: a press is adopted only while the handle is idle; from then on
  `move`/`up`/`cancel` are filtered to that pointer, the pick and the solve read
  *that pointer's* coords, and `setPointerCapture` keeps its events flowing off
  the dot. Capture is on the shared canvas, so co-existing handles each hold
  their own `pointerId` without conflict, and every handle ignores every other
  finger — two fingers on two handles drag in parallel. **Shipped.** Drive N
  with a plain loop (a verb, not a constructor):

  ```js
  let grabbed = false
  for (const h of hs) grabbed = h.update() || grabbed
  if (!grabbed) orbitControl()
  hs.forEach(h => h.draw())
  ```

- **`B` — *overlapping* handles sharing arbitration** (a clustered TRS gizmo: 3
  axes + 3 planes at one origin). Here `A`'s per-handle self-pick breaks: two
  proxies under one finger each render only themselves into their own pick pass,
  both read "hit," both adopt the same pointer → double-grab. Overlap forces a
  **single depth-resolved pick** — one pass rendering every proxy with a distinct
  id, one readback, winner-by-id — the same mechanism a single handle already
  needs for its own sub-parts (§4.6: "future: 3 axis + 3 plane proxies, each its
  own id"), scaled one level up. Only this needs a stateful coordinator: it owns
  the one pick, the `id → handle` map, and the claimed-pointer set (and on a
  tabletop, "unclaimed pointers go to the camera gesture"). **Shipped** as
  `createPointerRouter(...handles, { hover })` — a coordinator over one kind,
  not a new kind. Adoption is routed through the handle's `_routed` flag + an
  injected `_adopt(pointerId, x, y)`: routed handles skip their own pointerdown,
  and from the first move on the per-pointer machinery runs verbatim. The
  router's listeners stay flag-setting — presses are **queued** and resolved in
  `router.update()`, one shared pick each — and hover (default on) reuses the
  same shared pick once per moved frame. `add`/`remove`/`hovered()`/`dispose()`
  round it out; routers register in the same teardown set as handles.

`A` is a strict subset of `B`: a drag is `down → moves → up`, and `A` already
makes the moves/up read the captured pointer; `B` changes only the *down* step
(one shared pick instead of N self-picks) and then drives the identical
move/solve path — so `B` reuses `A` verbatim and does not unwind it.

**Invariant (the seam that makes both correct).** *The solve reads the captured
event's coords, never the globals (`mouseX`/`mouseY`).* That one rule is
simultaneously what makes per-finger correct and what lets a future coordinator
drive a handle — they point the same way. (Coords go through the element rect →
logical canvas space, which also sidesteps the `mouseX`/`mouseY` CSS-scale skew,
processing/p5.js#8669.)

**Honest limit of `A` alone (lifted by `B`).** Two presses landing on
*different* handles within one animation frame share the single candidate slot,
so one is dropped (a re-press resolves it); and each press costs one 1×1
readback per handle (per *press*, not per frame — non-overlapping handles
correctly see at most one hit). The router's press **queue** removes the first
limit — every queued down resolves against its own shared pick — and its single
shared pass removes the second; `handle-experiments/e4` exercises both.

### 4.12 Snap, hover, cancel

Three small affordances, all at established seams; none touches the core solve.

**Snap — quantize at the solve seam.** Applied bridge-side, post-`solve()`,
pre-`set()`/`onChange` — so the binding and the hooks only ever see snapped
values, and the canonical state IS the snapped state (no visual-only snap that
drifts on release). Per kind: `SPHERE` quantizes az/el (an angular step, rad)
and rebuilds the direction; `DIAL`/`AXIS` quantize the scalar (`θ`/`t`)
directly — no winding loss; `PLANE`/`VIEW` quantize the value point on a world
grid (`number` uniform or `[x,y,z]`), `PLANE` re-seeding so an off-plane grid
lands on the nearest on-plane point. `snap` is **settable live** — the Blender
convention (quantized only while Ctrl is held) is two sketch lines:
`h.snap = keyIsDown(CONTROL) ? step : null`. Custom kinds get no generic snap
(quantize in their own `solve` or in `onChange`).

**Hover — a state, not a style.** `hovered()` is a readout; highlight styling
stays in the sketch at the ambient-state philosophy (set `stroke()` before
`draw()`), exactly like `grabbed()`. The router feeds it for free from its
shared pick (default `hover: true` — one 1×1 readback per frame with unclaimed
pointer motion, Blender's one-select-pass-per-region economics); a **lone**
handle opts in with `hover: true` on the factory, paying the same one readback
per moved frame. Grabbed implies hovered.

**Cancel — revert, don't commit.** Every DCC manipulator distinguishes
commit (release) from abort (Esc): the grab captures the value (and the exact
`θ`, so a multi-turn dial reverts its true winding — `seed` alone would pick the
nearest turn), and Esc / `pointercancel` / `h.cancel()` restores it, re-sets the
binding, and fires `onCancel` — `onRelease` does **not** fire, so the
commit-on-release undo pattern (§4.3) composes cleanly: push the `onGrab`
capture on `onRelease`, drop it on `onCancel`. `pointercancel` (the OS stealing
the pointer mid-gesture — a palm rejection, an alert) reverts rather than
committing a half-made edit.

### 4.13 `from` — the deferred constraint frame *(commit 8)*

The basis opts (`axis` / `normal` / `zero`) are **symbolic**: `[0, 1, 0]` means
"Y — but whose Y?". `from` names the space they resolve FROM into `WORLD` — it
is literally `mapDirection`'s `from`, deferred. Accepted values are whatever
`mapDirection` accepts: `WORLD` (the default — identical, code-path included,
to a from-less handle), `EYE` (the camera's basis), or a raw mat4 frame
(another object's basis). `LOCAL` is not a constant: it is `from: <that
object's model matrix>` — the lattice column falls out of the value domain.

```js
createHandle({ constraint: DIAL, radius: 80, from: EYE })          // screen rotation ring
createHandle({ constraint: AXIS, axis: [1, 0, 0], from: EYE })     // screen-horizontal rail
createHandle({ constraint: DIAL, axis: [0, 1, 0], from: frameM })  // hinge on another frame's axis
createHandle({ constraint: PLANE, normal: [0, 1, 0], from: tableM }) // drag on a tilting surface
```

**Degenerate authoring (don't).** An `AXIS` nearly parallel to the view ray —
`axis: [0, 0, 1], from: EYE`, the "dolly" — is foreshortened to a single
screen point: the pick ray runs almost parallel to the rail and the
closest-point solve's `1 − (d·u)²` denominator collapses (the AXIS cousin of
the DIAL edge-on failure, with no fallback because the configuration itself
is unusable as a drag). A draggable rail wants to live roughly IN the screen
plane; depth input belongs to the wheel.

**Resolution rule (the whole semantics, one sentence).** One `mapDirection`
per symbolic vector into `WORLD`, then `Constraint.aim()` — re-run every idle
frame (live preview: the locus, the pick proxy, and a `bind` seed all see the
current frame) and implicitly frozen for the drag at grab (snapshot-at-press:
the gesture solves a stationary constraint, well-posed under camera motion;
cancel coherently restores into the same frozen basis).

**Directions only.** The anchor stays a `WORLD` location — a frame that
carries the origin moves it sketch-side via the existing `anchor()`. Two
reasons: resolving the anchor through `from: EYE` would be the removed
headlight (§4.10), and "the basis is a direction, the anchor a location"
keeps `from` exactly co-extensive with `mapDirection`.

**Kind coverage.** `PLANE` / `AXIS` / `DIAL` (core `aim()`); a custom kind
participates iff it exposes the optional `aim` contract member (§9). `SPHERE`
has no basis (its state is the heading itself) and rejects `from`. `VIEW`
rejects it too — deliberately NOT unified: `VIEW` re-aims its plane every
solve, mid-drag (the continuous screen-parallel translate every DCC ships),
whereas `PLANE` + `from: EYE` freezes the plane at press. Two legitimate,
distinct semantics; the pair is documented, not collapsed.

**DIAL continuity.** With `from` and no `zero`, the θ=0 reference is derived
once at construction IN the from-space and resolved alongside the axis ever
after — axis and zero co-rotate, so a turning frame cannot flip the basis
across the least-aligned-axis branch (no θ jump).

**Cost.** Zero on the default path (`from` absent ≠ a branch in solve — the
symbolic machinery isn't even allocated); one–two `mapDirection` + one `aim`
per idle frame otherwise. Existing sketches are unaffected byte-for-byte.

**Direct manipulation — decided: a pattern, never an API.** Widget-less,
nub-style manipulation (GPU-pick the object itself, drag it, no gizmo) is
fully expressible over the existing seams — `pickProxy` as the grab surface
(it wins over the built-in proxy for EVERY kind), an accessor `bind` carrying
the grab offset captured in `onGrab`, and the handle simply never `draw()`n.
`handle-examples/11` ships the complete pattern (VIEW translate on the object
body + the `from: EYE` screen ring, one router over the overlap); the offset
compensation is ~8 sketch lines and is everything a packaged `direct()` layer
would have added. Per the arrow-gizmo principle, it stays a documented example
pattern — a `direct()` API is explicitly OUT, now and later. (Absoluteness is
the design's identity: state IS the value; incremental composition lives at
the hooks when a sketch wants it, as 11's quaternion accumulate shows.)

---

## 5. Diagnostics

`throw` reserved for environment misconfiguration only (none expected here).
All runtime diagnostics use `console.error('[p5.tree] …')`:

- `bind` target shape unrecognized → error, leave unbound (pull-only).
- `value({ to: EYE })` with no camera matrices available → error, return `WORLD`.
- invalid `constraint` → error, `createHandle` returns `null`.

---

## 6. Worked example (no-semicolon style)

The light, rewritten. Direction on a sphere, read in eye space for a view-space
shader uniform via a pull read — no input frame, just `value({ to: EYE })`.

```js
let h

function setup() {
  createCanvas(720, 480, WEBGL)
  h = createHandle({ constraint: SPHERE, report: DIRECTION, radius: 1 })
}

function draw() {
  background(10)
  h.update()
  if (!h.grabbed()) orbitControl()

  const dir = h.value({ to: EYE })            // fresh p5.Vector, eye space
  noStroke()                                   // p5 v2 WEBGL: explicit
  myShader.setUniform('uLightDir', [dir.x, dir.y, dir.z])
  shader(myShader)
  sphere(80)
  resetShader()

  h.draw({ bits: p5.Tree.HANDLE | p5.Tree.AIM | p5.Tree.LOCUS })
}
```

Object translation on the ground, bound to a model position vector:

```js
const pos = createVector(0, 0, 0)
const g = createHandle({ constraint: PLANE, normal: [0, 1, 0] }).bind(pos)
// draw(): g.update(); box translated by pos; g.draw()
```

Camera dolly on an axis, authoring a keyframe via the accessor floor:

```js
createHandle({ constraint: AXIS, axis: [0, 0, 1], extent: [-200, 200] })
  .bind({ get: () => camTrack.keyframes[0].eye,
          set: (v) => camTrack.set(0, { eye: [v.x, v.y, v.z] }) })
```

---

## 7. `three.tree` portability note

Same core `Constraint`. The `three.tree/handle.js` bridge re-derives:
pixel→ray via `Raycaster` / `Vector3.unproject`; grab via `Raycaster` against
proxy meshes (no color-ID module — consistent with the design doc deferring
picking to three); frame conversion via `camera.matrixWorldInverse`; draw via
`Line`/`Mesh`. It **defers TRS-on-object to `TransformControls`** and ships only
the value-handle gap. An author's "drag a light direction" sketch reads the same
in both bridges — the consistency payoff.

---

## 8. Build order (suggested commits)

1. ✓ `tree/handle.js`: primitives (`raySphere`/`rayPlane`/`rayClosestPointOnAxis`)
   + angular utils + `Constraint` (SPHERE/PLANE/AXIS). Core constants.
   **Shipped, headless-tested (14 checks).**
2. ✓ `p5.tree/handle.js`: factory + lifecycle (`update()` → grabbed) + pixel→ray +
   frame conversion; pull-only (`value`).
3. ✓ Grab: `mousePick`/`tag` + `grabbed()` gate + `onGrab`/`onRelease` hooks.
4. ✓ `bind()` polymorphism (Vector, camera-field) + accessor floor + `sync()` + `onChange`.
5. ✓ `draw()` bits (ambient stroke/fill, constant screen size); `VIEW` (bridge
   PLANE w/ camera plane). (Shipped also a `display: HUD` dial + `frame: EYE`,
   both **later removed** — §4.10.)
6. ✓ `enabled` toggle (landed in 3); example sketches (`handle-examples/`,
   eight covering every kind, world/eye readout, and bind form); README registry
   entry. **Shipped.** Per-pointer multitouch (§4.11 `A`) landed as a follow-on
   patch (one finger per independent handle; the solve reads the captured
   pointer, never mouseX/mouseY). A later simplification removed the input
   `frame` and the `HUD` dial in favour of `value({ to })` (§4.10).
7. ✓ The formerly deferred set, one go: core `DIAL` (§3.6: accumulated θ,
   tangent-fallback edge-on solve, nearest-winding seed) + bridge `DIAL`
   (ring locus, torus ring-grab proxy, `scalar()` θ); `_drawScene` refactored
   into a `_drawLocus` dispatch + the custom-kind `drawLocus`/`pickProxy` seam
   (§9, now implemented); `snap` (live-settable, §4.12); `hover` (router-fed +
   lone opt-in); cancel (Esc / `pointercancel` / `cancel()`, `onCancel`);
   `createPointerRouter` (§4.11 `B` — queued downs, shared depth-resolved pick,
   shared hover). `VIEW` renumbered 3→4. New `09-dial-angle` example;
   **`handle-experiments/` e1–e6** added as the validation suite — e2 (edge-on,
   tunes `DIAL_EDGE`) and e3 (cluster arbitration) gate the release.
   **Shipped, pending validation.**

8. ✓ `from` — the deferred constraint frame (§4.13): core `Constraint.aim()`
   (PLANE re-projects `pt`; AXIS preserves `t`; DIAL preserves `θ` and rebuilds
   its in-plane basis — `_dialBasis` factored out of the constructor; SPHERE
   no-op) + the optional `aim` member on the §9 contract; bridge `from` opt
   (symbolic basis copies at construction, `_resolveFrame()` = one
   `mapDirection` per vector + `aim`, refreshed at the top of `update()` while
   idle and inside `_proxyPrep` so routed picks see a live basis, frozen during
   the drag, resolved before a `bind` seed). `VIEW` deliberately NOT unified
   with `PLANE` + `from: EYE` — continuous vs press-frozen are distinct
   semantics (§4.13). New examples: `11-eye-ring` (now the DIRECT-MANIPULATION
   pair: VIEW translate on the object's own geometry via `pickProxy` +
   grab-offset, no gizmo, plus the DIAL × EYE screen ring, routed),
   `12-hinge` (DIAL on a third frame's axis — the mat4-by-reference idiom,
   anchor and basis frozen together at grab), `13-eye-rail` (AXIS × EYE —
   covers the AXIS branch of `aim`: the rail re-aims while `s` holds; replaced
   a first-cut "dolly" whose view-parallel rail was degenerate by
   foreshortening — now documented in §4.13), and `14-tilt-plane` (PLANE ×
   mat4 — covers the PLANE branch: re-aim re-projects the point onto the
   moving surface).
   Validation found and fixed two latent exp-repo bugs in passing: p5 v2's
   `createCamera()` does not activate (e2's sweep, 09/11/12 framing —
   `setCamera` added) and e6's `viewFrustum` was passed `viewer:` instead of
   `camera:`. **Validated; releasing in the target versions.**

Names still provisional — `LOCUS`/`RING`/`AIM` bit names, `seed`, `scalar`.
Commit 1 shipped with `seed`/`scalar`/`Constraint`; renaming now is a small patch.

---

## 9. Extension seam — the constraint contract

The bridge controller is built around a **constraint object**, not a closed kind
switch. Any object satisfying the contract is driven by `createHandle`'s full
machinery, so adding rotation, a custom constraint, or a path toward 6-DOF is
**additive** — implement the contract, don't fork the controller. Same pattern as
`Track`: many concretes over one transport.

Two layers, matching the package split.

**Core contract (`@nakednous/tree`) — portable, draw-free.** A constraint is any
object exposing:

```
kind                       // integer discriminant (pick an unused value)
solve(ox,oy,oz, dx,dy,dz)  // update canonical state from a ray in the working space; chainable
value(out, report)         // write the reported value (vec3) into out
seed(x,y,z)                // set state from a value (bind() calls this)
scalar?()                  // optional — a 1-D parameter, if the constraint has one
azEl?(out2)                // optional — angular readout, if meaningful
aim?(ax,ay,az, zx?,zy?,zz?) // optional — re-aim the basis in the working space;
                            // implementing it opts the kind into the bridge's
                            // deferred `from` frame (§4.13)
```

That is the whole portable surface: POD-stated, renderer-agnostic, so a custom
constraint ports to the Rust/Bevy core exactly like the built-ins (a new `enum`
variant). `Constraint` in `handle.js` is the reference implementation for
`SPHERE`/`PLANE`/`AXIS`.

**Bridge surface (`p5.tree`) — what a conforming constraint gets for free.** The
controller drives any contract-conforming constraint with: pixel→ray (always in
`WORLD`), the host-driven `update()`→grabbed lifecycle and orbit-gate,
`value({to,out,report})` (with `to` converting to any space), polymorphic
`bind()` + `sync()`, the
`onGrab`/`onChange`/`onRelease` hooks, and `SCENE` picking via a proxy at the
reported point. None of it is kind-specific.

**What the extender supplies (bridge side).** Drawing a novel *locus* and its
*pick proxy* is p5-specific, so it cannot live in the core constraint. A custom
kind provides a bridge-side `drawLocus(handle, opts)` (and the tagged pick proxy
it renders), passed to `createHandle` or via a small subclass. Built-in kinds
draw their own loci; an unknown kind with no `drawLocus` draws only the dot + aim
and warns.

**Boundary (honest).** One added constraint is additive and cheap. A full **TRS
gizmo composite** — 3 translate axes + 3 rotate rings + center, grouped onto one
target, with cross-handle occlusion, hover, and snapping — is app-level assembly
on top of N handles, not a single drop-in. The contract makes it *possible and
pleasant*; it does not ship the composite. `@nakednous/ui` is for the surrounding
editor chrome (numeric readouts, reset buttons), not the in-canvas manipulation.

**Status.** Implemented in commit 7: `_drawScene`'s closed switch is now a
`_drawLocus` dispatch; `createHandle` accepts a contract-conforming constraint
*object* as `constraint:` (duck-checked on `solve`/`value`/`seed`) alongside the
built-in kind numbers, with `drawLocus(h, opts)` and `pickProxy(h, pos, rad)`
opts as the bridge-side seams — `pos`/`rad` are the prepped constant-px proxy
values, because `pixelRatio` is invalid inside the pick pass (the pick
projection is installed). An unknown kind with neither draws dot + aim and warns
once. `DIAL` was the forcing function, exactly as planned; the router renders
every member's proxy through the same `_proxyPrep`/`_renderProxy(id)` split, so
a custom kind participates in cluster arbitration for free.

**First consumer.** `p5.tree/handle-examples/10-custom-helix` exercises the
contract end to end: a screw constraint (1-DOF θ coupling rotation and lift,
~70 lines of pure geometry, solve = ray vs the helix tangent at the current θ —
the DIAL fallback generalized into the whole solve) plus a 12-line `drawLocus`
coil, default dot proxy. To make this possible from a CDN sketch, the bridge
surfaces the core building blocks on `p5.Tree`: the ray primitives
(`raySphere`, `rayPlane`, `rayClosestPointOnAxis`), the angular utilities
(`dirFromAzEl`, `azElFromDir`), and the quaternion module (`q*`, w-last glTF
arrays). The surfacing criterion — written into `p5.tree/src/constants.js` and
the README — is: **expose a core symbol when p5 has no adequate native
equivalent AND a sketch-level consumer exists; map at seams where p5 has an
adequate type** (vec3 → `p5.Vector`, matrices → the matrix seams). Flat
out-first functions, never wrapper classes: the explicit form is the pseudocode
tier. (`form.js` builders — `mat4Bias`, reflections, convention-parametrized
projections — currently fail the consumer clause; first shadow-mapping /
reflection notebook chapter flips them in under the same rule.)

---

## 10. Analytic proxies — the pick without a pass

> Target: `@nakednous/tree` 0.0.28. Consumers: the `@nakednous/host` controller and
> router (`host-design.md` §6–§7) and, at adoption, the `p5.tree` bridge. Apex:
> `stack-design.md` §3.2. Status: design only.

### 10.1 Why

The pick proxy is the controller's one GPU dependency: a tagged sphere or torus rendered
into a 1×1 target and read back. Everything else in the controller is numbers. Replacing
the pass with a ray test makes the controller renderer-free — one host serving every bridge
— makes hover cost nothing, and removes the synchronous readback WebGPU cannot offer. The
semantics are unchanged: a press grabs iff the pointer's ray meets the proxy; among
overlapping members the nearest wins.

### 10.2 Three hit tests

Beside the solve primitives of H2 — which write a point and return a parameter even on a
miss, because a solve must always produce a value — three **tests**, which write nothing
and return the ray parameter `t` of the nearest hit or `Infinity`:

```
rayHitSphere(ox,oy,oz, dx,dy,dz, cx,cy,cz, r)                       → t | Infinity
rayHitCapsule(ox,oy,oz, dx,dy,dz, ax,ay,az, bx,by,bz, r)            → t | Infinity
rayHitRing(ox,oy,oz, dx,dy,dz, cx,cy,cz, ux,uy,uz, R, r, detail)    → t | Infinity
```

- **`rayHitSphere`** — the quadratic with a unit `d`; the nearest non-negative root, or
  `Infinity` when the discriminant is negative or both roots lie behind the origin.
- **`rayHitCapsule`** — a segment `AB` swept by radius `r`: the ray against the infinite
  cylinder about `AB`, the hit accepted only within the segment's extent, then the two end
  spheres; the nearest of the three. Scalar arithmetic throughout; no allocation.
- **`rayHitRing`** — the circle of radius `R` about `c` in the plane perpendicular to unit
  `u`, swept by tube radius `r`: the analytic form of the torus proxy, as a **capsule
  chain** — the circle polygonised into `detail` segments (default 32) in the plane's
  basis, each tested with `rayHitCapsule`, the nearest `t` kept. A chain has volume in every
  direction, so it is exact where the torus is exact and never degenerates edge-on — the
  same reason the `DIAL` solve falls back to the tangent line there. The chordal error is
  `R · (1 − cos(π / detail))`, under half a percent of `R` at 32, well inside a grab
  radius. The ring and the endpoints are computed in scalars from `u`'s in-plane basis
  (`_basis`), so a chain costs `detail` capsule tests and nothing else.

### 10.3 The `proxy` contract member

The constraint contract of §9 gains one optional member:

```
proxy?(ox,oy,oz, dx,dy,dz, radius)   // → t | Infinity: does this ray, in the working
                                     //   space, meet the grab proxy of radius `radius`?
```

`radius` is the grab size **in working-space units** — the caller has already converted a
constant pixel size through `pixelRatio` at the proxy's depth, exactly as the p5 bridge's
`_proxyPrep` did before its pass. For the built-in kinds the member exists with these
defaults, so nothing changes for a sketch:

| kind | proxy | depth for `pixelRatio` |
|---|---|---|
| `SPHERE` · `PLANE` · `AXIS` | `rayHitSphere` at the reported `POINT` | the point |
| `DIAL` | `rayHitRing(anchor, u, radius, r)` — grab anywhere on the ring | the anchor; `radius` is the tube |
| `VIEW` (host) | `rayHitSphere` at `pt` | the point |

A custom kind omits `proxy` and gets the sphere at its `POINT`, or supplies one — the helix
of `handle-examples/10` becomes a capsule chain along its coil, some fifteen lines of the
same arithmetic. The member replaces the bridge-side `pickProxy(h, pos, rad)` draw seam:
the proxy is now part of the portable contract, so a kind ports to the Rust core with its
hit test, and `drawLocus` remains the only bridge-side seam (as `locus`, a generator —
`gizmo-design.md` §3.9).

### 10.4 In the controller and the router

The controller's `_pickAt(x, y)` becomes `unproject` → `pixelRatio` → `proxy`, a hit being a
finite `t`. The router's shared pick becomes the same test per enabled member with the
**nearest `t`** as the winner — the depth buffer's choice, computed; ties (coincident
dots) resolve to the first member, as the pass resolved by draw order. Hover is the same
test on a moved pointer. The working space is `WORLD`, the solve's, so the ray built once
for the grab is the ray the solve uses — no second unprojection.

### 10.5 Golden vectors

`golden/handle.json` grows: each test at a direct hit, a grazing hit, a miss, and an
origin-inside case; the ring edge-on (the ray in the dial plane) hitting, and at the
chordal error bound; the ordering case — a ring in front of a sphere and behind it — as
the router would see it; a custom `proxy` (the helix) at three angles.

### 10.6 Gates

- **Parity with the rasterized proxy** (apex §6.1): the sphere at a constant pixel radius
  and the ring against the torus, side by side across a scripted pointer sweep; also fixes
  `detail`.
- **Nearest-`t` versus depth order** (apex §6.1): the `e3` cluster on the analytic router.
- **Inside-the-proxy presses.** A pointer whose ray *starts* inside a sphere proxy (a
  handle at the near plane) must still grab: the nearest non-negative root rule covers it;
  verify against the pass, which grabbed there too.
