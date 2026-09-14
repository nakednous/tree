# stack — the engine-free stack (design)

> Target: `@nakednous/tree` (core additions), `@nakednous/host` (DOM transport, new),
> `webgl.tree` (raw WebGL2 through twgl, new), `webgpu.tree` (the WebGPU twin through
> webgpu-utils — stated, not built), and a planned native twin in Rust. `@nakednous/ui` is
> unchanged. No p5 anywhere in this stack; `p5.tree` is the reference implementation the split
> is read from, stays a sibling bridge, and adopts `host` on its `0.1.0` branch (§5).
> Status: **design only** — no code. The apex of a set of package docs: `host-design.md`
> (host), `bridge-design.md` (webgl.tree), `twin-design.md` (webgpu.tree), and in this repo
> `camera-design.md`, `gizmo-design.md`, and a proxies section of `handle-design.md`. The apex
> owns the shape and the alignment; the package docs own the surfaces. Names marked
> *(provisional)* are open to veto. Written section by section; each section is a review gate.

---

## 1 · The question, and the shape

Remove p5. What is the smallest set of packages that recovers the key `p5.tree` features —
gizmos, handles with the pointer router, helms, tracks, picking, visibility, panels — on raw
WebGL2 now and raw WebGPU later, with **one** shared core and **one** shared host, and a bridge
per GPU API that is thin enough to be written twice — and, in Rust, a third time?

The answer is not a port of `p5.tree`. It is a **shape**: three packages whose boundaries
coincide with the three vocabularies of the visual-computing notebook's pseudo-host — the
neutral program every host language realizes. The JavaScript packages are the reference
realization of that shape; a Rust stack is its planned native twin; the notation sits above
both and is co-designed with them now, then frozen.

### 1.1 What p5 supplies today

Everything in `p5.tree` that is neither math nor DOM is p5 wiring. p5 hands the bridge: a
renderer with a camera and a matrix stack; immediate-mode draw (`line`, `box`, `sphere`,
`torus`, `image`) under ambient `stroke` / `fill` / `tint` state; framebuffers, shaders and
`filter`; textures from images; text; the draw loop with its lifecycles and `deltaTime`;
`mouseX` / `mouseY`; `orbitControl`. The core and ui already know none of it. The stack asks
what replaces each of those, and where — and the notebook's heroes lean on more of p5 than
`p5.tree` does (§4).

### 1.2 What the `p5.tree` bridge owns (inventory)

Read from the module headers. The last column is the destination this doc settles.

| `p5.tree` module | owns | leans on p5 for | destination |
|---|---|---|---|
| `gizmos.js` | `axes`, `grid`, `cross`, `bullsEye`, `pane`, `viewFrustum`, `hermite`, `trackPath` | line / quad draw, ambient `stroke` / `fill` / `tint`, text, HUD, framebuffer textures | geometry → **core**; draw → **bridge** |
| `handle.js` | `Handle` controller (grab · solve · snap · hover · cancel · bind · `from`), `VIEW`, `PointerRouter`, pick proxies, locus draw | canvas pointer events, `mapLocation`, `colorPick` with sphere / torus proxies, draw, `p5.Vector` | controller + router + `VIEW` → **host**; proxies + locus geometry → **core**; draw → **bridge** |
| `helm.js` | `createCameraHelm` / `createPoseHelm`, basis resolution, seeding, `helmRig` (in-scene + FBO HUD) | `p5.Camera` (`mat4Eye`, `capturePose`, `applyPose`), `deltaTime`, predraw players, framebuffer rig | factories + players → **host**; camera math + rig geometry → **core**; draw → **bridge** |
| `track.js` | player registry, `createPoseTrack` / `createCameraTrack`, `TrackHandles`, `rotateQuat` / `applyPose`, `capturePose` / `applyPose` | predraw lifecycle, `p5.Camera`, transform stack | players + factories + `TrackHandles` → **host**; camera state ↔ matrices → **core** |
| `picking.js` | `tag`, `colorPick`, `mousePick`, `pointerHit`, `mouseHit` | 1×1 framebuffer, `readPixels`, `mat4Pick`, `mouseX` / `mouseY` | id codec + `pointerHit` → **core**; GPU pick → **bridge**, async |
| `matrix.js` | `mat4Proj` / `mat4View` / `mat4PV` …, `mapLocation` / `mapDirection` with optional `out`, `pixelRatio`, `proj*`, `detectNDC` | renderer state, `p5.Matrix` / `p5.Vector`, context sniffing | camera state → **core**; NDC is a per-bridge constant, never detected |
| `visibility.js` | `computePlanes`, `visibility`, `bounds`, `distanceToBound` | renderer camera + live model matrix | → **core** entirely (planes from camera state) |
| `hud.js` | `beginHUD` / `endHUD` | camera swap, depth clear | → **bridge** (an ortho `mat4` + depth state) |
| `pipe.js` | `pipe` / `releasePipe` | `p5.Framebuffer`, `p5.Shader`, `filter`, `image` | → **bridge** (FBO pipe) |
| `panel.js` | `createPanel` wiring: parent, uniform target, camera for `+`, player | `setUniform`, canvas parent | parent + player → **host**; uniform sink → **bridge**; panels themselves stay **ui** |
| `constants.js` | `p5.Tree` namespace, gizmo bits, core re-exports | — | bits → **core** beside the geometry they select; no namespace object — ES modules |

### 1.3 The shape — three vocabularies, three packages

The notebook's pseudo-host writes every program in three vocabularies. Each is one package.

| notation vocabulary | what it is | package |
|---|---|---|
| **the math** — `V`, `P`, `E = V⁻¹`, `M`, `q`, `R(M)`, `R(q)`, `slerp`, `conj`, `T(…)`, `S(…)`, `⁻ᵀ`, `lookAt`, `viewport(·)`, `unproject(·)`, `E.col(i)`, `cursor()` | every `=` definition — what a snippet writes as one-line math | **`@nakednous/tree`** |
| **the render host's ceremony** — `program`, `bind`, `draw`, `drawInstanced`, `clear`, `renderTarget`, `beginPass` · `screen`, `filter`, `fullscreen`, `image`, `readPixel`, `upload`, `load`, `setCamera` / `camera` / `perspective`, `cullFace`, `width` · `height` | what the thin layers realize per language | **`webgl.tree`** over twgl · **`webgpu.tree`** over webgpu-utils |
| **the signal host** — `pointer`, `dt`, `clock()`, `state = init`, `measure() → condition() → apply()`, `interact()` | the shape sensing and direct manipulation take; host-invariant by design | **`@nakednous/host`** + the core's three constructs |

`@nakednous/ui` is a fourth, optional package: the notation's `[panel: …]`.

**`@nakednous/tree` — numbers in, numbers out.** Additions: camera state as plain data with
builders and decomposers in both directions (the notation's `cam`); gizmo geometry generated
into caller-owned arrays in twgl's `arrays` shape; analytic ray-vs-proxy picking for handles
(sphere, capsule, ring) and a `proxy` member on the constraint contract; `unproject` as one
call; `pointerHit` and the pick-id codec as pure numbers; **golden vectors** — deterministic
input → output fixtures for every function, the contract a port must reproduce (§2). Zero
dependencies stays. Nothing in it names twgl, WebGL, WebGPU, or the DOM.

**`@nakednous/host` — the DOM without a renderer.** A new package, depending on tree only.
A pointer source over a canvas element with per-pointer capture and logical canvas
coordinates; a frame loop with clamped `dt` and `clock()`, tickable from an external loop; the
player registry; the `Handle` controller and `PointerRouter`, picking analytically through the
core so the grab path never touches the GPU; the helm and track factories and `TrackHandles`;
rate streams for a WebHID SpaceNavigator and the Gamepad API; image decoding, video and camera
sources, Canvas2D raster to bitmap; a DOM label overlay for text; the orbit gesture; canvas
size observation. Every construct reads as `measure → condition → apply`.

**`webgl.tree` / `webgpu.tree` — the GPU, thinly.** The rule: supply exactly what the
notation says a framework supplies silently — the declared transforms a `draw(obj, M)`
uploads, the camera a `setCamera` installs, the composite verbs `filter`, `image`,
`readPixel`, `beginPass`, `renderTarget`, `upload` — and never re-wrap what the notation
writes explicitly: `createProgramInfo`, `createBufferInfoFromArrays`, `setUniforms`,
`drawBufferInfo`, `gl.cullFace`, `gl.clear` stay the thin layer's own verbs, visible in every
hero. Plus: a line pipe over the core's gizmo arrays, HUD mode, textured panes, the ping-pong
pipe, asynchronous colour-ID scene picking, two supplied programs (unlit, Phong) that a hero
binds and a snippet cuts, a uniform sink for ui panels, and the per-bridge conventions
(`ndcZMin`, the FBO UV layout, the viewport sign). Depends on tree, host, and its peer;
`@nakednous/ui` is an optional peer of the application, not of the bridge.

**Why a new package rather than `ui`.** ui is presentation: optional, mounted by the
application into any element, duck-typing its target — a page framework can host it beside
its own widgets. Host is transport: it owns the canvas element's input and the frame clock,
which is exactly what a page framework wants to *replace*, and the bridge *requires* it for
handles and helms. Folding transport into ui would force panels on every consumer that wants a
handle, and would make the one package a framework must swap out the same package it would
keep. Two packages, two contracts.

**The shape, realized.**

```
notation  (host.md · hosts.md)            the spec both stacks realize — co-designed, then frozen

JavaScript — the reference                Rust — the native twin (planned)
  tree  ←  host  ←  webgl.tree              tree-rs  ←  host-rs  ←  wgpu.tree
                    webgpu.tree
  tree  ←  ui
```

`tree ← host`, `tree ← ui`, `{ tree, host } ← bridge`; `ui ↛ host`, `host ↛ ui`; nothing
flows back into tree. The Rust twin realizes the same three packages — the core conformant to
the golden vectors, a host on winit · gilrs · hidapi with the same loop and player shape, a
bridge on wgpu realizing the same verbs as `webgpu.tree` — and is done when the notebook's
figures render in parity. It is named here so its brief is a port of a spec, not a rewrite.

### 1.4 Settled before this doc — inherited, not reopened

- **Scene picking is async from the first commit.** WebGPU readback is `mapAsync`; WebGL2 gets
  the same `Promise` surface over a PBO and a fence. A handle grab never waits on it: handles
  pick analytically in the core, synchronously, inside the frame.
- **No geometry package.** Standard primitives come from `twgl.primitives` in the bridge;
  gizmo line geometry is core; platonic solids extend twgl upstream or live in a sketch.
- **Models** load in host: `loadModel(url)` fetches an OBJ file and adapts `webgl-obj-loader`'s
  mesh into the arrays shape, no parser maintained in the stack; glTF follows through a parser
  package of its own, later.
- **The manipulator trio stays three mechanisms.** Handle (position control, `vec3`), Track
  (keyframes, pose), Helm (rate control, pose). The composite TRS gizmo is user space: N
  handles under one router.
- **No `direct()` API.** Widget-less direct manipulation is a sketch pattern.
- **Nothing flows back into tree.**

### 1.5 Out of scope

- GPU text. Labels (`axes` `LABELS`, `helmRig` `identify`, HUD readouts, the notebook's
  formula and matrix HUDs) are a DOM overlay in host, positioned through `mapLocation`. No
  glyph atlas, no font pipeline. Bitmaps for glyph strips come from the host's Canvas2D raster.
- A scene graph, a materials system, a lighting model — and no public built-in programs.
  The bridge draws gizmo lines and plain or textured meshes through programs it keeps
  internal (`image`, `pane`, the pick pass, the line pipe); a hero binds its own shaders,
  as the pseudo-host writes it. That is the point of the stack.
- A real WebXR session. The notebook's XR heroes are simulated; the seam a real session needs —
  the host loop accepting `session.requestAnimationFrame`, the bridge binding the XR layer's
  framebuffer — is recorded in the package docs, not built.
- `p5.tree` itself. It adopts `host` on its `0.1.0` branch once `host` is validated (§5).

---

## 2 · The pseudo-host as the spec

The notebook's pseudo-host (`host.md`, with `hosts.md` mapping its ceremony onto four thin
layers) is the specification this stack realizes. During this design the two are co-designed:
where the stack finds a cleaner cut, the notation moves (§2.3); once frozen, the notation is
upstream of every package the way `tree` is upstream of every bridge. Four rules make the
alignment exact.

### 2.1 The four rules

1. **The notation is upstream of the bridge.** After the freeze, `notation ← webgl.tree`,
   one-way. An operation the bridge needs that the table lacks is added to `host.md` first,
   then `hosts.md`, then the layers — the rule Archetypes already imposes on `vc.hpp` and
   `vc.rs`.
2. **One symbol, one call.** Where the notation names an operation the core realizes only as
   a chain, the core adds the single call under a name that fits its own conventions
   (`unproject` is the first). Settled names are not renamed to the notation's; the
   realization table (§2.2) pairs them.
3. **The signal host's slots are the constructs' seams, by name.** `measure → condition →
   apply` is how every walkthrough is written; the API keeps the family's own names (`feed`,
   `snap`, `bind`, `eval`), because those are the settled spine.
4. **The explicit APIs are already in the notation.** "`bind` is bare names; on WebGPU the
   values are fields of a uniform buffer bound as a group; `program` is a pipeline with baked
   state" — `webgpu.tree` realizes the same verbs, and a Rust bridge on wgpu the same again.

The framework line, stated once. `host.md` separates a *framework* — what "fills the
built-in transforms from its camera and model state, so a bare `scene()` supplies them
silently" — from a no-framework host that "uploads each by hand." The bridge sits exactly on
that line: it supplies what the notation says a framework supplies silently, and nothing the
notation writes explicitly. *Silently* is measured against the Archetypes: what every
archetype column (raw twgl, moderngl, `vc.hpp`, `vc.rs`) writes by hand and the notation
leaves out is what a bridge may supply; what a column writes and the notation omits too is a
notation gap, closed in the notation, never in the bridge. So a `webgl.tree` hero reads as the pseudo-host with the thin
layer's own verbs still visible, and what remains of dissolution is the two things the
notebook's audit already isolates — cut the overlay, drop the framework's silences. The
Archetypes JavaScript column stays raw twgl; `webgl.tree` is the hero substrate *on* that
column, never a fifth column.

### 2.2 The realization table

Every symbol of `host.md`'s *Notation at a glance*, by vocabulary. The JavaScript column is
the reference realization; names in the host and bridge columns are *(provisional)* until
their package docs settle them. Calls are written without `out` and `gl` leading parameters
for brevity — every core call is out-first, every bridge call takes `gl` first, mirroring
twgl, with state per context held in a registry keyed by `gl`.

**The math — `@nakednous/tree`.**

| symbol | package | realization |
|---|---|---|
| `V` · `lookAt(eye, center, up)` | tree | `mat4View`; from camera state, `cameraView(cam)` (`camera.js`) |
| `P` | tree | `mat4Persp` · `mat4Ortho`; from camera state, `cameraProj(cam, aspect, ndcZMin, ndcYSign)` |
| `E = V⁻¹` | tree | `mat4Eye`; from camera state, `cameraEye(cam)` |
| `E.col(i)` | tree | flat indices `E[4i … 4i+2]`; `mat4ToTranslation` for `i = 3` — no call minted |
| `M` | tree | `mat4FromTRS` · `transformToMat4` (a pose) |
| `q` · `R(q)` · `slerp` · `conj` | tree | `[x, y, z, w]` · `qToMat4` · `qSlerp` · `qConjugate` |
| `R(θ, n̂)` · `R_x` · `R_y` · `R_z` | tree | `qFromAxisAngle` then `qToMat4`; the axis constants `i` · `j` · `k` for the subscripted forms |
| `R(M)` | tree | `mat3Direction` (the rotation block applied to a direction) |
| `T(…)` · `S(…)` | tree | `mat4FromTranslation` · `mat4FromScale` |
| `⁻¹` · `inverse()` | tree | `mat4Invert` |
| `⁻ᵀ` | tree | `mat3NormalFromMat4` |
| `·` | tree | `mat4Mul` · `mat4MulPoint` · `mat4MulDir` · `qMul` |
| `/` | tree | the divide inside `mat4MulPoint` and `mapLocation` |
| `→` (`WORLD → EYE`, …) | — | prose in a comment above the math it names (`// WORLD → SCREEN`); `mapLocation` · `mapDirection` stay in tree as the host's and bridges' machinery, off the teaching surface |
| `W` · `viewport(·)` | tree | `mat4Viewport(vp, ndcZMin)` — the S · T that seats NDC in the viewport; world → screen is `(W · P · V · p) / w` through `mat4MulPoint`, screen → world the same with `(W · P · V)⁻¹` |
| `unproject(·)` | tree | `unproject(outOrigin, outDir, sx, sy, m, vp, ndcZMin)` — new, one call; the point-at-depth form stays `mapLocation(SCREEN → WORLD)` |
| `\|v\|` · `v̂` · `normalize(·)` | — | inline arithmetic; `qNormalize` for a quaternion. Not a core call |
| `cursor()` | tree | `track.seg` · `track.f` (`track.info()`) |
| `camera(eye, center, up)` · `perspective(fov, near, far)` | tree | writes into the camera state `cam` (`camera.js`) — the seam a measured pose fills; installed by the bridge's `setCamera(cam)` |

**The render host's ceremony — `webgl.tree`, over twgl.**

| symbol | package | realization |
|---|---|---|
| `program(vert, frag)` | twgl | `twgl.createProgramInfo(gl, [vert, frag])` — not re-wrapped |
| `program(frag)` | webgl.tree | `program(frag)` — the fixed NDC pass-through vertex stage is what the bridge supplies |
| geometry noun (`triangle`, `sphere`, …) | twgl · tree | `twgl.createBufferInfoFromArrays` over `twgl.primitives.*` or the core's gizmo arrays — not re-wrapped |
| `bind(prog)` · `bind(prog, { … })` | webgl.tree | `bind(prog, uniforms)` = `gl.useProgram` + `twgl.setUniforms`; bare names are JavaScript's shorthand properties |
| `draw(obj)` · `draw(obj, M)` | webgl.tree | `draw(obj, M)` — `setBuffersAndAttributes`, the declared transforms uploaded, `drawBufferInfo` |
| `drawInstanced(obj, n)` | webgl.tree | `drawInstanced(obj, n, M)` |
| `scene()` | — | application code |
| `clear()` | twgl | `gl.clear` — not re-wrapped |
| `cullFace(FRONT)` | twgl | `gl.cullFace` — render state stays raw |
| `depthTest(on)` | twgl | `gl.enable(DEPTH_TEST)` · `gl.disable(DEPTH_TEST)` — render state stays raw; written per pass as the archetype columns write it (§7 #42) |
| `setCamera(V, P)` · `setCamera(cam)` | webgl.tree | `setCamera(V, P)` · `setCamera(cam)` — installs the transform state `draw` reads |
| `renderTarget()` · `(width, height)` · `(depth)` · `(color: [a, b])` | webgl.tree | `renderTarget(opts)` over `twgl.createFramebufferInfo` — resolves the four shapes, `drawBuffers` for the multi-target one, `fbo.depth` · `fbo.a` as named attachments; `format` per target or per attachment (§7 #50); sampling follows one fixed rule the notation never writes — colour linear and clamp, depth nearest — with bridge options beside it, and a bridge-only multisampled form (§7 #48, #49) |
| `beginPass(target)` · `screen` | twgl | `twgl.bindFramebufferInfo(gl, fbo)` · `bindFramebufferInfo(gl, null)` — not re-wrapped; a `SCREEN` constant names `null` |
| `filter(prog)` · `filter(prog, { … })` | webgl.tree | `filter(prog, uniforms)` — `bind` + `draw(fullscreen)`; the input arrives as `tex0` |
| `fullscreen` | webgl.tree | `fullscreen()` — the cached covering quad |
| `image(buf)` · `image(buf, mask = RED)` | webgl.tree | `image(tex, { rect, mask, tint, blend })` |
| `readPixel(fbo)` | webgl.tree | `readPixel(fbo, x, y) → Promise` (PBO + fence); `pick(x, y, drawFn) → Promise<id>` on top, via `mat4Pick` |
| `load(file)` | host · webgl.tree | image: host decodes to `ImageBitmap`, `twgl.createTexture` uploads; model: host `loadModel` returns the arrays shape, `twgl.createBufferInfoFromArrays` uploads |
| `upload(frame)` | host · webgl.tree | host supplies the video / camera element; `upload(tex, source)` over `twgl.setTextureFromElement` |
| `width` · `height` | host | the canvas observer; also the signed viewport `vp` every core call takes |

**The signal host — `@nakednous/host`, over the core's constructs.**

| symbol | package | realization |
|---|---|---|
| `pointer` | host | the pointer source over the canvas: per-pointer id, logical canvas px, capture |
| `dt` · `clock()` | host | the loop's clamped frame period and elapsed seconds; an external loop passes `dt` in |
| `state = init` | host · tree | a construct's own state — a helm's pose, a filter's memory, a handle's constraint — or an application global |
| `interact()` | host | the host-driven update the application calls first in the frame — `handle.update(m, vp)` / `router.update(m, vp)` — whose result gates the orbit |
| `measure()` — pointer-gated | host | the grab: analytic pick through the core's `proxy`, then `unproject` of the claimed pointer |
| `measure()` — subscribe-into-buffer | host · tree | a stream (WebHID, Gamepad) writes `lin` / `ang`; `helm.feed` is the buffer |
| `measure()` — poll | host · tree | `track.tick()` (the cursor advance) or a polled source into `poseDelta` |
| `condition()` — snap | host | `handle.snap`, applied at the solve seam |
| `condition()` — 1€ + deadzone · deadzone | tree | `helm.filter = oneEuro(…)` · `helm.deadzone` |
| `apply()` — bind one field | host | `handle.bind(target)` |
| `apply()` — drive a whole frame | host · tree | `helm.bind(cam)` · `track.eval(cam)` — the camera state *is* the pose the draw consumes |
| `[panel: …]` | ui | `createPanel(schema, { target })`, the target writing into the uniforms bag `bind` reads |

### 2.3 Notation deltas

What the stack proposes back to `host.md` / `hosts.md`. Each is a sentence or a row, none a
restructuring; carried here until the freeze, then closed.

- **`readPixel` lands a frame late.** Its value is a definition whose dependency resolves on
  a later frame — `mapAsync` on WebGPU, a fence on WebGL2. The notation's "order is a data
  dependency, not a thread sequence" clause already covers it; a sentence where picking is
  taught should say so, so a reader does not expect a synchronous read.
- **`draw(obj, M)` uploads only what the program declares.** The notation's silence about the
  built-in transforms has a mechanical reading: the bridge reads the program's uniform list
  and sets the declared ones under the fixed names `uModelViewMatrix` ·
  `uProjectionMatrix` · `uNormalMatrix`. Stating this makes "read it off the listing" a
  guarantee rather than a convention.
- **`unproject` has two forms.** A ray (origin, direction) for a handle's solve, and a point
  at a given screen depth for a brush. The notation names the ray; the audit's brush hero
  uses the point. One line distinguishing them.
- **`pointer` is in canvas pixels, not window pixels.** A CSS-scaled canvas makes the two
  differ; the host maps through the element's rectangle. The notation should say canvas.
- **`hosts.md`'s thin-layer table stops at the single-call verbs.** `filter`, `image`,
  `readPixel`, `upload`, `setCamera`, `drawInstanced`, and the `renderTarget` shapes are
  composites the row programs write out by hand. A note that these are the framework's —
  realized by `webgl.tree` in the heroes, spelled out in the columns — keeps the two tables
  consistent without adding a column.
- **`E.col(i)` is index arithmetic.** No layer mints a call for it; the table can say so.
- **The pseudo-code is math and uniform definitions.** A space change is written as the
  product it is — `V · p`, `R(V) · d`, `M_B⁻¹ · M_A · p` — with the named spaces kept as a
  comment above it (`// WORLD → EYE`); the arrow is prose, never a call. The viewport step
  is the matrix `W` the pipeline chapter already derives row by row, so world → screen is
  one composition, `(W · P · V · p) / w`, and screen → world its inverse — compose and
  inverse, the foundations story, with nothing new.
- **Every shader input is a `u*` name.** The filtered image arrives as `uSource` (§7 #45),
  not p5's `tex0`; `uTexelSize` · `uResolution` already follow the rule.
  The p5 realization reaches p5's filter names through a `#define` the ground inserts after
  `#version`, so no listing ever shows `tex0`.
- **Uniforms are definitions `bind` reads by name.** `uWorldLightMatrix = B · P_light ·
  V_light` defines a value; `bind(prog, { uWorldLightMatrix, … })` consumes it. Listings keep
  the per-bind list — it teaches which uniforms a pass consumes, as the archetype columns'
  one `setUniforms` object per bind does; a bag of definitions handed to every `bind`
  appears only behind a `[panel: …]`, which already writes one (§7 #46).
- **The depth test is render state the listing writes.** Every archetype column spells it
  out (`local-lighting.md`'s *What differs* table) and switches it per pass — on for the
  scene, off before a fullscreen pass — while no listing names it. `depthTest(on)` joins
  `cullFace(FRONT)` in the render-state row; the composites (`filter`, `image`, the gizmos)
  keep switching it inside themselves (§7 #42).
- **`uSource` is the implicit input only.** It names the one image a framework hands a
  shader unasked — the input of `filter` and of each `pipe` stage. Every sampler a hero binds
  itself keeps its own name (`uDepth`, `uScene`, `uScreenTex`, `uMedia`, the G-buffer's);
  a pass that reads its input by such a name binds it in the listing (`uMedia = source`).
- **The heroes' audit (2026-09-13) — pseudo blocks to correct.** The notation's target
  shapes cover every hero; these listings are wrong as written: *noise* draws `source`
  where the sketch binds `uMedia = source`; *dof* calls `filter` after `beginPass(screen)`
  with no `image(fbo)`, so the target never reaches the shader; the *pipe* page shows two
  targets where the sketch needs three (the scene's depth must survive the chain);
  *mirrors* and *portals* write `uResolution = [width, height]`, and *convolution* and
  *post_effects* compute `uTexelSize` from CSS size — both off by the pixel density on HiDPI
  screens (§7 #51). *mosaic*'s `bake(…)` is spelled out (§7 #53).

### 2.4 Golden vectors — the port contract

A port of the core is conformant when it reproduces the reference's outputs. The reference
ships them:

- **What.** For every exported function, a fixture of `{ args, out }` cases; for every
  stateful class (`Track`, `PoseHelm`, `Constraint`), a transcript of `{ call, args, expect }`
  steps run against one instance. Generated from the JavaScript core by a script, committed
  under `golden/` in this repo, one file per module, plain JSON. The format's details —
  a tolerance class per function, `writes` for buffers a call fills beside its return,
  `$get` / `$set` pseudo-calls in transcripts, the `$num` / `$alias` / `$hook` encodings — are
  specified in `tools/golden.js`, the one place a port reads them from.
- **Tolerance.** Exact for integers and enumerations; `1e-6` relative for `f64` state
  (`vec3`, `quat`, keyframes); `1e-5` for `f32` matrices. Degeneracies (`null` returns,
  `Infinity` from a parallel ray) are cases, not omissions.
- **Coverage rule.** A function without a fixture is not exported — the fixture is part of
  adding it. The same fixtures run against the JavaScript core as its own regression suite,
  so the port contract and the reference's tests are one artifact.
- **What it proves.** The notebook's claim that the signal host "ports unchanged across
  frameworks" becomes a measured property of `tree-rs`: the 1€ recurrence, Hermite with
  centripetal tangents, slerp, the constraint solver, and the helm integrator produce the
  reference's numbers.

The bridges have no golden vectors; their conformance test is the notebook's own — parity
of rendered figures.

---

## 3 · The packages

Outline depth: modules, contracts, and the seams between packages. Each package's own doc
owns its surface at implementation depth. Names are *(provisional)* until that doc settles
them.

### 3.1 The seams

Five objects cross package boundaries. They are plain data, defined once, in the package
lowest in the dependency order that needs them.

| seam | shape | defined in | flows |
|---|---|---|---|
| **camera state** `cam` | `{ eye, center, up, fov \| halfHeight, near, far }` — the `CameraTrack` keyframe shape | tree | tree ↔ host ↔ bridge: a track evaluates into it, a helm drives it, the orbit edits it, `setCamera(cam)` installs it |
| **view bag** | `{ mat4Proj, mat4View, mat4PV, mat4PVInv, vp, ndcZMin }` — the matrices bag `mapLocation` takes, plus the signed viewport and the NDC convention | tree (the bag), host (adds `vp` · `ndcZMin`) | bridge → host: `setCamera` fills it; handles, routers and labels read it each frame. A p5 adapter fills it from renderer state |
| **gizmo arrays** | `{ position: { numComponents: 3, data }, color?: { numComponents: 4, data }, count }` — twgl's `arrays` shape, line lists; a triangle list for panes | tree | tree → bridge: generated into caller-owned buffers, uploaded by `createBufferInfoFromArrays`, drawn by the line pipe |
| **uniforms bag** | a plain object of bare `u*` names | — (the application's) | ui → bridge: a panel's `target` writes into it; `bind(prog, bag)` reads it |
| **rate stream** | `lin[3]`, `ang[3]` per poll | tree (`feed`'s arguments) | host → tree: a device stream writes, `helm.feed` buffers |

### 3.2 `@nakednous/tree` — additions

The existing seven modules stay. Four grow or appear; every addition is out-first,
zero-alloc, flat-scalar, and shipped with golden vectors.

- **`camera.js` (new) — camera state ↔ matrices.** An allocator for the state shape;
  `cameraView` · `cameraEye` · `cameraProj(cam, aspect, ndcZMin, ndcYSign)` from state;
  `cameraFromMat4(cam, mat4Eye, mat4Proj, ndcZMin)` back from matrices; `cameraFromPose(cam,
  pose)` — a TRS pose to a lookat at constant gaze distance; `cameraOrbit` · `cameraDolly` ·
  `cameraPan` as pure edits of the state; `cameraPlanes(planes, cam, aspect)` so visibility
  needs no bridge. `aspect` is always an argument — the viewport owns it. Doc:
  `camera-design.md`.
- **`gizmo.js` (new) — line generators.** One generator per gizmo, snprintf-style: it
  writes up to the buffer's capacity and returns the count needed, so the caller grows once
  and never allocates per frame. `axesLines`, `gridLines`, `crossLines`, `bullsEyeLines`,
  `frustumLines`, `hermiteLines`, `pathLines` (path · control polygon · tangents),
  `helmRigLines`, `locusLines` (a handle's locus by kind), `paneTris`. Semantic colour only
  where the gizmo carries meaning (axes, rig), written per vertex when `out.color` exists.
  The gizmo bit constants move here beside the geometry they select. `axes` `LABELS` are
  line glyphs in `p5.tree` already and stay lines; the one text a gizmo carries — the rig's
  `identify` lane labels — is written as anchors into an optional `out.labels`, and the
  host's overlay places them. Doc: `gizmo-design.md`.
- **`handle.js` — analytic proxies.** Three hit tests returning the ray parameter `t` or
  `Infinity` — `rayHitSphere`, `rayHitCapsule`, `rayHitRing` (a capsule chain along the
  circle — edge-on safe, the analytic form of the torus) — distinct from the H2 solve
  primitives, which write a point even on a miss. The constraint contract gains an optional
  `proxy(ox,oy,oz, dx,dy,dz, radius) → t`; the built-in kinds get defaults (a sphere at the
  point; the ring for `DIAL`). The host converts a constant-pixel grab size to `radius`
  through `pixelRatio` before the test. §10 of `handle-design.md`.
- **`query.js` — the round trip's endpoints.** `unproject(outO, outD, sx, sy, m, vp,
  ndcZMin)` — one call for the pointer ray; `pointerHit(px, py, x, y, z, radius, m, vp,
  ndcZMin)` — the screen-proximity test as numbers; `idToRgba(out, id)` · `rgbaToId(r, g, b)`
  — the pick-id codec both bridges and the p5 adapter share.
- **`golden/`** — the fixtures of §2.4 and the script that regenerates them.

### 3.3 `@nakednous/host`

The DOM without a renderer. Depends on tree only. Modules:

- **`pointer.js`** — a source over one canvas element: `pointerdown` · `move` · `up` ·
  `cancel` and Esc, queued and consumed inside the frame; per-pointer capture; logical
  canvas coordinates through the element's rectangle. One instance per canvas, shared by
  every handle, router and orbit on it.
- **`loop.js`** — `createLoop({ onFrame, raf })`: a raf loop with clamped `dt` and elapsed
  time, the raf function overridable (a WebXR session's later); and **players** — the
  registry that ticks tracks and steps helms, with `players.tick(dt)` callable from an
  external loop so a p5 adapter can drive it from `predraw`.
- **`handle.js`** — the controller (grab · solve · snap · hover · cancel · bind · `from`) and
  `VIEW`; **`router.js`** — the shared pick across members, nearest `t` wins, claimed
  pointers, shared hover. `update(view)` takes the view bag; `value(out, opts)` is
  out-first. No draw here — `locusLines` is the core's, the pipe is the bridge's.
- **`helm.js`** — `createCameraHelm(cam, opts)` · `createPoseHelm(opts)` with the
  polymorphic `bind`; basis resolution against the camera state; seeding.
- **`track.js`** — `createPoseTrack` · `createCameraTrack(cam, opts)` wired to players, and
  `TrackHandles`.
- **`stream.js`** — `createHidStream(opts)` (WebHID; `connect()` from a user gesture,
  report decoding by `reportId`) and `createGamepadStream(opts)`, each polling or
  subscribing into `lin` / `ang` and optionally bound straight to a helm.
- **`media.js`** — `loadImage(url) → ImageBitmap`; `createVideoSource(opts)` for a file or
  `getUserMedia`, yielding the element the bridge uploads from; `raster(draw, w, h) →
  ImageBitmap` — a Canvas2D callback rendered to a bitmap, for glyph strips and tags.
- **`labels.js`** — a DOM overlay: `createLabels(canvas)`, `labels.set(id, text, x, y, z)`
  placed through `mapLocation` each frame from the view bag; real text shaping for free.
- **`orbit.js`** — the fall-through gesture: one-pointer rotate, two-pointer dolly and pan
  with the y sign right, over `cameraOrbit` · `cameraDolly` · `cameraPan`. `update(cam)`
  returns whether it consumed the pointer, so the gate reads
  `if (!handle.update(view)) orbit.update(cam)`.
- **`canvas.js`** — `observeCanvas(canvas, onSize)`: `ResizeObserver` + device pixel ratio
  → `width` · `height` and the signed `vp`.

Doc: `host-design.md`.

### 3.4 `webgl.tree`

**Rationale.** `webgl.tree` is an experimental implementation of the notebook's pseudo-code
design on WebGL2, expected to rest on the foundations: `tree`'s math, twgl's calls, and only
what the archetype columns write by hand and the notation leaves out. A hero that ports line for line confirms a
piece of the notation; a hero that cannot is where the notation changes, not the bridge.
The bridge is named for the API it realizes, beside `webgpu.tree`; twgl is its thin layer,
replaceable without a rename (#55).

The render host's ceremony over twgl. Depends on tree and host; `twgl.js` is a peer. Every
call takes `gl` first; per-context state (installed camera, current target, cached quad,
supplied programs, pick resources) lives in a registry keyed by `gl`. Modules:

- **`camera.js`** — `setCamera(V, P)` · `setCamera(cam)`; fills the view bag the host reads.
- **`draw.js`** — `bind(prog, uniforms)`; `draw(obj, M)` · `drawInstanced(obj, n, M)`
  uploading the declared transforms under `uModelViewMatrix` · `uProjectionMatrix` ·
  `uNormalMatrix`.
- **`target.js`** — `renderTarget(opts)` in the four shapes; `SCREEN`.
- **`pass.js`** — `program(frag)`, `fullscreen()`, `filter(prog, uniforms)`, `image(tex,
  opts)`, `pipe(source, passes, opts)` — the ping-pong chain with cached targets, `tex0`
  and `uResolution` · `uTexelSize` on the notebook's conventions.
- **`pick.js`** — `readPixel(fbo, x, y) → Promise` over a PBO and a fence sync polled per
  frame; `pick(x, y, drawFn) → Promise<id>` over a 1×1 target and `mat4Pick`.
- **`texture.js`** — `upload(tex, source)` for bitmaps, video and elements; cubemaps.
- **`gizmo.js`** — the line pipe over core arrays (position + optional colour, a uniform
  colour otherwise), `beginHUD` · `endHUD`, textured panes; the gizmo calls `axes`, `grid`,
  `cross`, `bullsEye`, `viewFrustum`, `trackPath`, `helmRig`, `handle.draw` as thin
  generator-then-draw wrappers taking `{ M, color, bits }`.
- **`programs.js`** — internal only: the flat colour / texture program behind `image`,
  `pane` and the pick pass, the line pipe's, and the pass-through vertex stage. Not
  exported (pending decision #12).
- **`constants.js`** — `ndcZMin = WEBGL`; one texture orientation (GL's, bottom-up — images
  flipped at upload, never when compositing); the y-down viewport `[0, h, w, −h]`.

Doc: `bridge-design.md`.

### 3.5 `webgpu.tree`

The twin. Same module list and verbs; `bind` writes a structured uniform view
(`makeStructuredView`), `program` builds a pipeline with baked blend and depth state,
`readPixel` is `mapAsync`, `ndcZMin = WEBGPU`, the UV layout top-down. Doc: `twin-design.md`
— the differences table only, until it is built.

### 3.6 `@nakednous/ui`

Unchanged. Its `target` contract already is the uniforms-bag sink; its README's architecture
block gains `host` when the stack ships.

### 3.7 The Rust twin

Planned; the student's brief. `tree-rs` conformant to `golden/`; `host-rs` with the same
module shape on winit (pointer), gilrs (gamepad), hidapi (SpaceNavigator) and a frame loop
with `dt`; `wgpu.tree` realizing the bridge verbs on wgpu — the same explicit-API shape as
`webgpu.tree`. Done when the notebook's figures render in parity. Not specified further here.

---

## 4 · Notebook coverage

The notebook's heroes and figurines (≈190 sketches, 22 chapter helpers, 4 shared
primitives) lean on p5 the *engine* well beyond what `p5.tree` wraps. This section is the
claim that every one of them is expressible on the stack, stated as a table of engine
features against the seams of §3 — so the claim is checked row by row rather than asserted.
Notebook-side changes (assets, grounds, methodology) are listed after it; they are the
notebook's, not the stack's.

### 4.1 Engine features → seams

| p5 engine feature the figures use | where | seam |
|---|---|---|
| **WEBGL text** — `mathLabel`, `drawMat4`, `drawPills`, billboard tags, `identify` | every affine / projection / barys figurine; pipeline; most HUDs | host `labels.js` over the view bag; anchors from `gizmo.js`'s `out.labels`; glyph strips from `media.raster`. Real shaping, so the combining-mark and ⊥ gotchas disappear. (`axes` labels are line glyphs and need none of this) |
| **built-in material + primitives** — `lights()`, `specularMaterial`, `box` / `sphere` / `cone` / `torus` / `plane`, `model(buildGeometry(…))` | nearly every scene | `twgl.primitives` for the nouns; a notebook-side Phong helper on the local-lighting archetype's shader for lit props (`twoLight()` becomes its uniform values) — the bridge ships no public program; a subdivided quad is a twgl primitive, not a `buildGeometry` |
| **OBJ models** — `loadModel` (bunny, budha, …) | masking, procedural, lod | host `loadModel(url)` over `webgl-obj-loader` → the arrays shape → `twgl.createBufferInfoFromArrays`. The teapot is analytic already (`teapot.js`) and ports as arrays |
| **media** — `loadImage`, `createCapture`, `createVideo`, cubemap sets | imaging, skybox / envmap, webcam, marker, landmark | host `media.js` (decode, video / camera source) → bridge `texture.upload`; cubemaps in `texture.js` |
| **`orbitControl`** | almost every 3D figure | host `orbit.js`, on pointer events — one-finger rotate, two-finger dolly / pan with the y sign right (the iOS issues fixed at construction) |
| **framebuffers with a depth attachment; multiple render targets** | dof; deferred (raw WebGL2 today) | bridge `target.js` — `renderTarget(depth)` · `renderTarget(color: […])` from the first commit. Closes the MRT gap the notebook flags |
| **`filter` / `createFilterShader`; the `pipe`** | all imaging | bridge `pass.js` — `program(frag)`, `filter`, `pipe`; `tex0` · `uResolution` · `uTexelSize` unchanged |
| **`createGraphics(WEBGL)` over a P2D composite** | webcam_ar | one GL canvas: the backdrop is a textured `image`, the object drawn over it |
| **`image(fbo.color)` compositing, `tint`, `blendMode`** | stereo (anaglyph), portal, mirror | bridge `pass.image(tex, { mask, tint, blend })` |
| **`p5.quadrille` glyph strip** | mosaic | host `media.raster` (Canvas2D) → `texture.upload`; quadrille is not needed on the GL side |
| **`p5.Matrix` builders** (`_buildT` / `_buildR` / `_buildS`) | affine series | core `mat4FromTranslation` · `qFromAxisAngle` + `qToMat4` · `mat4FromScale` |
| **`CameraTrack` scripted views** (`makeView` / `applyView`) | projection series | core track → `cam` → bridge `setCamera(cam)`; the `view` slider is a `seek` |
| **WebXR** | webxr_* | nothing now — the heroes are simulated. A real session: host `loop.raf` ← `session.requestAnimationFrame`, bridge binds the XR layer's framebuffer. Recorded in `host-design.md` / `bridge-design.md` as a seam, not built |
| **mediapipe / aruco** | landmark, marker | external; fed by host `media.createVideoSource`, conditioned by core `oneEuro`, `poseDelta` |
| **HUD readouts, pills, insets** | pipeline, projection, immersive | host labels for text; bridge `beginHUD` · `endHUD` + `gizmo.js` lines and panes for the drawn parts |
| **DOM controls** (`createButton`, `createSlider`, `createDiv`, theme buttons) | everywhere | already DOM; `@nakednous/ui` where a panel fits, plain DOM otherwise — unchanged |
| **strands figures** (`*_strands.js`) | annex material | stay on p5 — excluded from reader-facing chapters by the notebook's own rule |
| **three.js figures** (`morph_three`, `skinning_three`) | annex | `three.tree` territory; untouched |

Nothing in the table needs a fourth package. The two seams the stack would not otherwise
have carried — the label overlay and the Canvas2D raster — are the price of the foundations
figurines, and both are host-side DOM.

### 4.2 What the notebook changes on its side

- **Grounds become modules.** Figures load closures as classic scripts (`ground=`); the
  `twgl` shortcode is already ESM with an importmap and `tree` / `ui` flags. Migrated figures
  take the importmap route, gaining `host` and `webgl.tree` entries; `shared/` and `helpers/`
  become ES modules. A notebook-side change with a precedent in place.
- **The substrate.** `DESIGN.md` names `p5.tree` the proof-of-concept substrate. A migrated
  hero runs on `webgl.tree`, which sits on the Archetypes JavaScript column itself, so hero and
  column share one stack and dissolution shrinks to cut-the-overlay (§2.1). The Archetypes
  rule is unchanged: `webgl.tree` idioms stay out of the columns exactly as `p5.tree`'s do.
- **Cost and order.** The apps heroes port cheaply — their technique path is already the
  notation. The foundations figurines are the expensive tail: text-dense HUDs, `p5.Matrix`,
  fixed palettes. Order follows cost: imaging first (already planned there), then the apps
  parts, foundations last. `p5.tree` keeps running the unported figures throughout — nothing
  breaks in the interim.

---

## 5 · Sequencing, and the `p5.tree` consequence

### 5.1 Build order

Dependency order is build order; each step is validated in Chromium before the next starts,
and each package doc precedes its code.

1. **`tree` additions** — `camera.js`, `gizmo.js`, the handle proxies, the `query.js`
   endpoints, `golden/`. Renderer-free, so testable headless against the fixtures. Published
   as `0.0.28`+ from the `0.1.0` branch as they land — and **consumed by `p5.tree` as each
   lands** (`unproject`, the id codec, `cameraFromPose` / `cameraFromMat4`, the analytic
   pick behind a flag beside the rasterized one), so the parity gates of §6.1 close on the
   current implementation.
2. **`host`** — in dependency order inside the package: `canvas`, `pointer`, `loop` +
   players, then `handle` + `router`, `helm`, `track`, then `stream`, `media`, `labels`,
   `orbit`. **Validated by incremental adoption in `p5.tree`** (§5.2): each host module
   replaces its `p5.tree` counterpart the session it lands, and the JSDoc examples and
   experiments are the test. `p5.tree` is a validated consumer; `webgl.tree` later proves
   the host renderer-independent.
3. **`webgl.tree`** — `camera`, `draw`, `target`, `pass`, then `gizmo`, then `pick`,
   `texture`. Validated by re-rendering the imaging heroes first (§4.2), with `p5.tree`'s
   gizmos and picking beside it for parity.
4. **Notebook migration** in the §4.2 order; the notation freeze (§2.3) once the imaging
   heroes and one apps part read as the pseudo-host with only the overlay cut.
5. **`webgpu.tree`** when WebGPU ships by default on Linux stable — the notebook's own gate
   for its compute paradigm.

The Rust twin can start at the end of step 1: `tree-rs` needs only `golden/`; `host-rs` and
`wgpu.tree` follow the JavaScript package docs as they settle.

Publish order: `tree → host → ui → p5.tree`, `webgl.tree` after `host`. Pins are `^0.0.x`
(exact minor); bump every dependent's pin before publishing the dependency's successor.

### 5.2 What the design does to `p5.tree`

Two premises. p5 is a framework, so `p5.tree` stays a sibling bridge and never becomes a
pseudo-host realization — heroes on it keep dissolving as today. And the design forces
nothing on it; it creates one decision and a set of core additions it consumes by its own
rule ("do not re-implement math or visibility logic in the bridge").

**The decision — adopt `host`.** Adopting makes the dependency `tree ← host ← p5.tree` and
lets the controller, router and players exist once for every bridge (`webgl.tree`,
`webgpu.tree`, `p5.tree`, `three.tree`). Not adopting keeps `p5.tree` byte-identical and
duplicates the controller logic, which then drifts. Adopt. Two host requirements follow and
are already in §3.3: players tickable from an external loop, and a pointer source that
attaches to any canvas element.

**Module by module, after adoption.**

| `p5.tree` module | after adoption | impact |
|---|---|---|
| `handle.js` | a thin `Handle` *inheriting* the host controller, carrying only the p5 parts: `value()` → `p5.Vector` when `out` is omitted, the `p5.Camera` field binder, `draw()` in ambient state, a zero-arg `update()` that fills the view bag from renderer state; `createPointerRouter` returns the host router bound to the p5 canvas | large shrink. Pick becomes analytic — no `colorPick` on the grab path, hover costs no readback. One API change: the custom-kind `pickProxy(h, pos, rad)` draw seam becomes the core's `proxy(ray) → t`. `VIEW` moves to host; `p5.Tree.VIEW` re-exports it |
| `track.js` | registry → host players ticked from `predraw`; factories → host factories with a `p5.Camera` adapter as bind target; `TrackHandles` → host; **keeps** `rotateQuat` / `applyPose` on the stack, the camera adapter, the `{ camera }` interception | medium; sketch surface unchanged. `applyPose`'s TRS branch uses `cameraFromPose` (drops its per-call allocation) |
| `helm.js` | factories → host with the camera adapter; `helmRig` stays p5 draw | medium; sketch surface unchanged |
| `picking.js` | `tag` → core codec; `pointerHit` → core; `colorPick` stays p5's framebuffer path, now scene-pick only | small. Separately: p5's WEBGPU renderer cannot read pixels synchronously, so `colorPick` wants an async form regardless of this design |
| `matrix.js` | unchanged — it *is* the p5 adapter; `unproject` replaces the two-call ray build | trivial |
| `visibility.js` | unchanged; the p5 eye-matrix read convention stays | none |
| `gizmos.js` | *optional*: draw the core's arrays through `beginShape(LINES)`, pixel parity expected; ambient philosophy unchanged | not required |
| `hud.js` · `pipe.js` · `panel.js` · `constants.js` · `index.js` | unchanged; `predraw` → `players.tick`, `remove` → dispose host objects | trivial |

**What does not change.** The sketch-level API documented on the `0.1.0` branch —
`createHandle`, `createPointerRouter`, the track and helm factories, `h.update()` /
`h.value()` / `h.draw()`, `track.handles`, the orbit gate, the hooks — and the `p5.Tree`
namespace. The docs pipeline is untouched: the examples are p5 sketches and live in
`p5.tree`'s JSDoc on the inheriting wrapper, so the generator keeps parsing `p5.tree/src`.

**Timing.** On the current `0.1.0` branch (pending decision #3), **incrementally**: the core
additions as they land in `tree`, then each host module the session it lands — pointer
source and players first (the current controller reading from them), then the controller
and router, then the factories. Every step keeps the sketch surface and every JSDoc example
running; the docs pipeline is the test, so it is unaffected by construction.

**Behavioural deltas to verify in Chromium at adoption.** The analytic sphere at constant
pixels against the rasterized proxy; the `DIAL` ring as a capsule chain against the torus;
overlap resolved by nearest `t` instead of the depth buffer (same ordering); hover free;
multitouch and iOS pointer semantics identical — same events, same capture.

`three.tree` follows the same path on its own schedule.

---

## 6 · Gates

What is decided is above. What is open is below, each item paired with the experiment that
closes it — in the `p5.tree.exp` / `handle-experiments` manner: one sketch, one question,
validated in Chromium. An item stays open until its experiment is named *done* here.

### 6.1 Core

- **Analytic pick parity.** Does the sphere proxy at a constant pixel radius, tested by
  `raySphere` after `pixelRatio`, grab where the rasterized proxy grabbed — at the canvas
  edge, under extreme aspect, in orthographic? Does the capsule-chain ring match the torus
  edge-on? *Experiment:* one sketch, both paths side by side, a miss counter across a
  scripted sweep of pointer positions. Also decides the chain's segment count.
  **Done** (2026-09-11, `p5.tree.exp/handle-experiments/e12`): in the default,
  orthographic, 1280×240 and grazing views the two paths disagree only on a pixel-wide
  outline around each proxy; the ring's chain matches the torus at **detail 32**, which
  stays the default; the grab feels identical by hand.
- **Nearest-`t` versus depth-buffer ordering.** Overlapping members resolved by `t` must
  match the rasterized winner, including a ring in front of a sphere at grazing angles.
  *Experiment:* the clustered TRS gizmo (`e3`) rerun on the analytic router. **Done**
  (2026-09-11, `e12`): the cluster's overlaps and the ring in front of and behind the
  sphere at the grazing view name the same nearest member on both paths; no ordering
  miss away from a proxy edge.
- **Snprintf-style generators.** Is the capacity-and-return contract comfortable in
  practice, or does every caller want a sizing call first? *Experiment:* `trackPath` with a
  growing keyframe count — the one gizmo whose size changes at run time.
- **Golden-vector tolerance.** Are `1e-6` (f64) and `1e-5` (f32) tight enough to catch a
  wrong convention and loose enough to survive a different `Math` implementation?
  *Experiment:* regenerate the fixtures under a second JavaScript engine and diff.

### 6.2 Host

- **Label overlay under CSS scaling and device pixel ratio.** Labels placed through
  `mapLocation` in logical canvas px must land on their anchors when the canvas is scaled by
  CSS, on a high-DPI display, and inside a scrolled iframe (the notebook's embed).
  *Experiment:* the axes gizmo with `LABELS` in a scaled, framed page.
- **WebHID on Wayland / Chromium.** `requestDevice` from a user gesture, the report decode,
  and the Permissions-Policy gate (top-level only — no iframe). *Experiment:* the `e7`
  transport rewritten on `stream.js`, run standalone. Also settles the Gamepad polling
  cadence against the frame loop.
- **Two-finger orbit.** Pinch → dolly, together → pan, y correct, identical on Chromium,
  Firefox, and an iOS WebKit. *Experiment:* the landing-page hero's gesture on `orbit.js`,
  checked against the notebook's recorded issues.
- **External tick.** `players.tick(dt)` driven from a foreign loop (a p5 sketch's
  `predraw`) with the host's own loop absent — no double-tick, no `dt` drift.
  *Experiment:* a p5 sketch driving a host track without `p5.tree`.

### 6.3 Bridge

- **Declared-transform upload.** Reading `programInfo.uniformSetters` for the three names
  covers every notebook shader — including the split model / view of the shadow capture,
  which declares a light matrix the bridge must *not* touch. *Experiment:* the shadow hero
  on `draw(obj, M)`; the frag declares what it needs and nothing else is set.
- **Async readback latency.** PBO + fence polled per frame: how many frames late is a pick
  on Chromium / Mesa, and does polling ever stall the loop? *Experiment:* the GPU picking
  hero with a frame-stamp on each resolved id.
- **Multi-target on twgl.** `createFramebufferInfo` with several colour attachments plus
  `drawBuffers`, sampled by name (`fbo.a`). *Experiment:* the deferred hero's g-buffer on
  `renderTarget(color: […])`.
- **Line pipe quality.** Single-pixel GL lines are what twgl gives; the frustum and the path
  beside their p5 renderings read markedly thinner and rougher (2026-09-13), so the pipe grew
  a `width` option — a screen-space quad per segment, in the bridge, never in the generators —
  ruled experimental (§7 #2): the W toggle in the gizmo harness compares the two, and the read
  decides whether width stays or the pipe reverts to raw lines over multisampled targets.

### 6.4 Notation

- **The freeze milestone** (§5.1 step 4) — the imaging heroes and one apps part reading as
  the pseudo-host with only the overlay cut. Until then §2.3 stays open and grows.
- **`interact()` versus the orbit gate.** The notation marks `interact()` present "only when
  input is the technique"; the stack's gate line appears in every figure with a handle.
  Whether the gate is `interact()` or cut overlay is a notation call, made at the freeze.

### 6.5 Named, not gated

- WebXR sessions (§1.5): the raf hook and the XR framebuffer bind are seams in the package
  docs; no experiment until a real-device hero exists.
- glTF models (§1.4): a host loader over a parser package, beside `loadModel`, when a hero
  needs one.
- The Rust twin (§3.7): its gate is parity, owned by its own repos.

---

## 7 · Pending decisions

Author's calls, as distinct from the experiment-gated items of §6. Every decision the
design took provisionally is listed here with where it sits and what the alternative was;
a row is closed by writing the ruling in its last column and, where the ruling differs
from the text, amending the section. Package docs add their own rows here rather than
keeping separate lists, so this is the one place to look.

| # | decision | where | as written | alternative | ruling |
|---|---|---|---|---|---|
| 1 | Golden-vector coverage rule | §2.4 | a function without a fixture is not exported | fixtures required for new additions only; existing surface back-filled over time | **as written** — the whole surface, so `tree-rs` can start at step 1 |
| 2 | Line-pipe width | §6.3 | a gate: decide after `trackPath` / `viewFrustum` render beside p5 | decide now: raw 1-px GL lines, no width option | **width mode, experimental** (Pierre, 2026-09-13, from the gizmo harness: raw lines read markedly worse than p5's shader-expanded strokes, and the `strokeWeight(3)` figures need a width) — the pipe's `width` option in pixels expands each segment into a screen-space quad through a second internal program, the generators untouched; raw `gl.LINES` stay the default; flagged experimental because the next harness read may send it the other way, to raw lines with multisampled targets |
| 3 | `p5.tree` adopts `host` | §5.2 | adopt, in a later minor after the docs pipeline ships | keep `p5.tree`'s own controller / router / players and accept the duplication | **adopt, on the current `0.1.0` branch** (provisional — "for now") |
| 4 | Host entry point | host §3 | one context per canvas, `createHost(canvas, opts)`, constructs as factories on it | free factories, each taking pointer + view + players | **context** — three shared dependencies per construct; modules stay separable for the p5 adapter |
| 5 | `value(out, opts)` in host | host §6 | `out` mandatory; the allocating form is the p5 adapter's | `out` optional, allocating a fresh `[0, 0, 0]` when omitted | **mandatory** — the tree contract |
| 6 | Bridge call shape | §2.2, §3.4 | free functions, `gl` first, per-context state in a `gl`-keyed registry | a bridge context object mirroring `createHost` | **free functions** — one call shape beside twgl's own verbs; `draw(gl, obj, M)` dissolves by dropping the prefix |
| 7 | `program(frag)` | §2.2 | the bridge's one-argument form only; `program(vert, frag)` stays twgl's `createProgramInfo` | a distinctly named `filterProgram(frag)` | **`program(frag)`** — literal match with the notation |
| 8 | Label layer placement | host §11, §16 | a sibling `<div>`, the canvas parent set `position: relative` | a `position: fixed` element tracking the canvas rectangle | **sibling**, gated on the Hextra column and the docs iframe; the fixed element is the named fallback |
| 9 | Notation deltas | §2.3 | six sentence-sized changes to `host.md` / `hosts.md`, carried until the freeze | — (yours at the freeze) | **deferred to the freeze** |
| 10 | Transform-uniform names | §2.3 | the fixed set `uModelViewMatrix` · `uProjectionMatrix` · `uNormalMatrix`, p5-aligned as the notebook's shaders are | a configurable name map on `setCamera` | **the six of bridge §5** (`uModelMatrix` · `uViewMatrix` · `uModelViewMatrix` · `uProjectionMatrix` · `uModelViewProjectionMatrix` · `uNormalMatrix`); extensible only with quantities derived from `M`, `V`, `P` |
| 11 | Camera-track `add()` shapes | host §8 | no-arg captures `cam`; `{ camera }` accepts a camera-state object; no lookat-scalar duck typing | keep the p5-style `eyeX` … duck typing for foreign cameras | **as written** — the duck typing only ever served `p5.Camera`; the adapter keeps it |
| 12 | Supplied programs | §1.5, §3.4 | `flat` and `phong` shipped by the bridge | none — every hero binds its own | **none public.** The bridge keeps internal programs it cannot do without (the flat one behind `image` / `pane` / the pick pass, the line pipe, the pass-through vertex stage) and exports none; the notebook's `twoLight()` becomes a notebook helper on its own shader |
| 13 | The handle gizmo's name | bridge §10 | `handleLocus(gl, h, opts)` — a free gizmo taking the producer, like `trackPath(track)` | `handleRig` · `handleMarks` · a `draw` method on the host handle that takes the bridge | **`handleLocus`**, provisional until implementation shows how it reads |
| 14 | Texture orientation | bridge §9 | one orientation, GL's: images flipped at upload, targets untouched, no flip switch anywhere else | keep a per-call `flip` / `uvs` override as p5.tree's `pane` has | **as written**; `pane`'s `uvs` stays as a UV-mapping option (cropping, tiling), never as an orientation lever |
| 15 | Hit-test naming | handle §10.2 | `rayHitSphere` · `rayHitCapsule` · `rayHitRing` — `Hit` marks a test (no `out`, `Infinity` on miss) beside the H2 solve primitives that always write a point | give `raySphere` an `Infinity`-on-miss mode instead of a second family | **the family** — solves always write, tests never do |
| 16 | Golden tolerance semantics | §2.4 | `1e-6` / `1e-5` relative, classed by the output's shape | absolute; class by shape only | **pending** — implemented as the hybrid `\|a − b\| ≤ tol · max(1, \|a\|, \|b\|)`: relative above 1, absolute below, so an entry that is exactly 0 in one engine and 1e-17 in another needs no second rule; and classed by **provenance**: `f32` whenever a matrix is an input or an output (all of `query.js` — a vec3 read through an `f32` matrix carries `f32` error), `f64` for state computed without one. Evidence from the p5 parity fixture (2026-09-11): a lookat centered at the origin, read back through p5's f32 eye matrix at a 353-unit gaze distance, lands 2e-5 off on one center entry — twice the absolute floor — so `golden/camera.p5.json` pins the returned values rather than the sketch's lookat; a provenance-scaled floor would let it pin the lookat |
| 17 | Lookat with `up ∥ view direction` | quat.js, form.js (surfaced by the quat and form fixtures) | — | leave the degenerate frame to the caller (gl-matrix, glam) | **re-seed** — `qFromLookDir`, `mat4View` and `mat4Eye` replace the up hint with the world axis least aligned with the view direction, the seed `qFromUnitVectors` already uses: one rule for the three lookat constructors, always a proper rotation, deterministic roll at the pole, `qFromLookDir(center − eye, up)` and `mat4Eye` agreeing bit-for-bit |
| 18 | `CameraTrack.eval` across a perspective ↔ ortho segment | track.js (surfaced by the track fixture) | JSDoc and README: a segment whose keyframes disagree on `fov` / `halfHeight` passes `null` through, so the bridge leaves the projection unchanged | the code: the non-null value of either keyframe passes through, so both `fov` and `halfHeight` can be set at once and the bridge must pick | **pending** — the fixture pins the code; note the doc's reading never applies the ortho at the track's last keyframe (the final cursor still sits on the mixed segment), so a third option is a step at the segment's end |
| 19 | The helm's `WORLD` frame | helm.js (surfaced by the helm fixture) | the README's "world axes"; `poseDelta`'s claim that an identity profile retraces a pose | the code: the null basis is the identity *eye* matrix, so the `Tz` / `Rr` lanes drive −Z and a world-axis rate retraces only with those two signs flipped | **pending** — the fixture pins the code (a raw profile sends `lin.z = 3` to `pos.z = −3`; the retrace holds with `Tz` / `Rr` signs of −1) and the README / JSDoc now say so; the alternative is `WORLD` meaning world axes (`fZ = +1` for a null basis), which changes `step`'s documented null ≡ identity-eye-matrix contract and every `WORLD` helm in p5.tree |
| 20 | `cameraOrbit` axes and guard | camera.js (surfaced by the camera fixture) | azimuth about `up'`, elevation clamped so `vd` never reaches `±up'` | the eye's own `up'` as the azimuth axis | **pending** — implemented with the *hint* as the reference: azimuth rotates the eye about the normalised up hint, elevation is the eye's angle above the plane through the center perpendicular to the hint, clamped to ±`maxEl` (default π/2 − 1e-3); `up` is untouched, so no roll; a state at the pole (hint ∥ view direction) is pulled inside the guard by its first non-zero edit; `(0, 0)` is a no-op. The alternative accumulates roll against a fixed hint |
| 21 | `cameraDolly` clamps and lens | camera.js | `opts.min` / `opts.max` clamp the gaze distance; orthographic scales `halfHeight` | a positive default floor | **pending** — implemented: the clamps apply to whichever quantity is scaled (the distance under perspective, `halfHeight` under orthographic; defaults 0 / ∞); an edit that would make it non-positive is a no-op, so no floor constant is invented; a both-null lens dollies the eye |
| 22 | The p5 parity fixture | §2.4, camera-design §7 | one fixture generated from `p5.tree`'s renderer reads | fold the p5 numbers into `golden/camera.json` | **pending** — implemented as a hand-authored `golden/camera.p5.json` (`<module>.<source>.json`): the same shape, replayed by `npm test`, never regenerated by `tools/golden.js`; `cameraPlanes` and `cameraFromMat4` cases, filled from the p5 sketch on 2026-09-11 (a perspective and an orthographic lookat): both agree with `computePlanes` and the renderer's matrices at f32, so camera-design §8's parity gate holds |
| 23 | Gaze distance across the decomposers | camera.js §4, camera-design §8 (surfaced by p5.tree's `capturePose` / `applyPose`) | `\|center − eye\|` of the state given, `1` when degenerate | `opts.distance` as the fresh-state default | **pending** — implemented as written: p5.tree seeds the state's `eye` and `center` from the p5.Camera's lookat scalars before every `cameraFromMat4` / `cameraFromPose` read, so the distance is always the live lookat's and the `1` default never reaches a keyframe; a bare core caller decomposing into a fresh `createCamera()` still gets a center one unit ahead |
| 24 | How `locusLines` recognises `VIEW` | gizmo.js §3.9 (surfaced by the generator: `VIEW` is not a core kind) | dispatch "by `constraint.kind`", `VIEW` among the kinds | a `view` option on the call | **pending** — implemented as a flag on the constraint object, `constraint.view === true`, which the host's `VIEW` constraint sets on itself; the core needs no `VIEW` constant and a kind number stays whatever the host chose |
| 25 | Corner order across `frustumCorners` and `paneTris` | gizmo.js §3.5, §3.10 | corners 0–3 counter-clockwise from bottom-left; `paneTris` takes `p0` top-left, then clockwise | one order for both | **pending** — implemented as written on both sides: a pane reads corners 3, 2, 1, 0 (the near face reversed) as its `p0`–`p3`, which the JSDoc states; the alternative re-orders one of the two seams |
| 26 | `pathLines` `CENTER` count | gizmo.js §3.7 | `6 · keyframes`: the gaze line and "a small cross" | — | **pending** — implemented as `8 · keyframes`: the gaze line plus a three-axis star of half-size `centerSize` (default 4) at the center, since a two-line cross needs a plane the generator has no basis for; the JSDoc carries the formula |
| 27 | `mat3Direction`'s convention | query.js (surfaced auditing p5.tree's matrix examples, 2026-09-12) | `out = to₃ · inv(from₃)`: the world direction whose coordinates in `to` equal a world direction's coordinates in `from` | `inv(to₃) · from₃`, the coordinate conversion `from → to` that `mat4Location` and `mapDirection(MATRIX → MATRIX)` perform | **coherent** (Pierre, 2026-09-12) — `inv(to₃) · from₃`, the same conversion as the other two; code, README, fixture, the p5 doclet and its example (a direction drawn inside each frame, the two lines parallel) updated together |
| 28 | The bridge camera behind a host camera construct | host §8 (surfaced building `cameraHelm` / `cameraTrack`, 2026-09-12) | a lib-space `_onApply(cam)` seam on the helm and the track, fired after each write into the camera state (and the track's rest-on-stop write), which the p5 adapter points at `p5.Camera.applyPose` | a follow player the adapter registers after the construct's own, relying on the players' insertion order | **pending** — implemented as `_onApply`, the same shape as `_onActivate` / `_onRelease`; a second player would tie correctness to iteration order |
| 29 | Whose handles `TrackHandles` builds | host §8.1 (2026-09-12) | overridable `_makeHandle(opts)` / `_makeRouter(opts)` on the class, defaulting to `host.handle` / `host.router`, so a bridge subclass makes members it can draw | the adapter swapping `host.handle` on its host instance | **pending** — implemented as the two seams; mutating the host is invisible to a reader |
| 30 | Label layer creation | host §11 (surfaced adopting labels in p5.tree, 2026-09-12) | `host.labels` present on every context | — | **pending** — implemented lazily: the layer, and the parent's `position: relative`, exist only after the first `host.labels` access; `host.hasLabels` probes without creating, so a sketch that never labels gets no DOM intrusion and the p5 adapter ticks the layer in postdraw only when it exists |
| 31 | Transient labels | host §11 (2026-09-12) | labels persist until `remove(id)` | — | **pending** — a `frame: true` option: the label lives for the frame it was set in and `tick()` removes it once a frame passes without a re-set; `helmRig`'s `identify` labels use it, so a rig that stops drawing takes its labels with it |
| 32 | Reaching the host from a sketch | p5.tree, stage 10 (2026-09-12) | — | `p5.Tree.hostOf(p)` on the namespace, or a p5.tree `createOrbit` verb | **pending** — `treeHost()`, a sketch-level accessor, for the host constructs p5.tree has no verb for (`labels`, `orbit`); an orbit verb would compete with `orbitControl`, which stays |
| 33 | Touch-action for the orbit | host §12 (2026-09-12) | — | the pointer source sets `touch-action: none` on every canvas | **pending** — the orbit sets `canvas.style.touchAction = 'none'` while it lives and restores it on dispose, the ORBIT_TOUCH_ISSUES workaround; handles on a phone still want the sketch's CSS |
| 34 | `hid` reattach | host §9 (2026-09-12) | `connect()` from a gesture | — | **pending** — `resume()`, run at creation unless `resume: false`, attaches a device the origin already granted through `getDevices()` without a prompt, the e7 behaviour |
| 35 | The orbit's vertical sense | host §12 (surfaced by the e13 phone run, 2026-09-12: the drag and the pan were inverted under p5) | screen-down is the eye's −up | an `ndcYSign` option on the orbit | **pending** — implemented by reading the sign off the view bag's `mat4Proj[5]` each update: negative (p5's y-flipped projection) reverses the elevation and the pan's vertical term, so a drag down brings the scene down under either projection and no option is needed |
| 36 | Inertia on the orbit | host §12 (surfaced by the e13 phone and desktop runs, 2026-09-12) | none — direct manipulation wants exactness | an opt-in `inertia`: a decayed replay of the gesture's last step for orbit, pan and dolly alike, cancelled by the next touch | **deferred** (Pierre, 2026-09-12) — the exact orbit stays; e13 keeps the working user-space coast (a decay slider, the seed the flick's largest recent step) as the departure point, and the ruling waits on a wider discussion of which other constructs (handles, helms, tracks) should gain the same shape |
| 37 | Packaging of host and the bridges | webgl.tree docs (2026-09-13: the examples loaded tree and host twice, once inside `webgl.tree.js` and again as their own modules) | each ES build bundles its @nakednous dependencies | ESM only, dependencies external | **ESM with externals, plus a UMD** (Pierre, 2026-09-13) — host's ES build leaves tree external; webgl.tree's ES build (`module`, `exports.import`) leaves twgl.js, tree and host external, so each loads once; a UMD (`main`, `exports.require`, `jsdelivr`: `dist/webgl.tree.umd.cjs`) bundles tree and host as `webglTree.tree` and `webglTree.host`, reads the global `twgl`, and serves script-tag pages |
| 38 | webgl.tree docs shape | webgl.tree docs (2026-09-13) | module examples: an import map sends twgl.js to the CDN and webgl.tree, tree, host to site-local ES builds | UMD examples as p5.tree's: two script tags, the `webglTree` global, no imports | **deferred** (Pierre, 2026-09-13) — the site keeps the module examples until ruled |
| 39 | tree and host through the bridge | webgl.tree (2026-09-13) | applications import `@nakednous/tree` and `@nakednous/host` beside the bridge | a flat `export *` of both from webgl.tree | **namespaced re-exports** (Pierre, 2026-09-13) — webgl.tree exports `tree` and `host` (`export * as tree`, `export * as host`), the shape of the UMD's `webglTree.tree` / `webglTree.host` and of p5.tree's `p5.Tree`; a flat re-export would let clashing names (`SCREEN`, the bridge's `null` target, against tree's space constant) resolve silently; the ES build keeps both external, so direct imports of the packages stay valid and share the one instance; examples and the harness import the stack from `webgl.tree` alone |
| 40 | Loading models | §1.4, host media (2026-09-13) | glTF through `@gltf-transform/core` behind a bridge adapter, later; OBJ assets converted to glTF once | — | **host `loadModel` over `webgl-obj-loader`** (Pierre, 2026-09-13) — an adapter only: fetch, `new OBJ.Mesh(text)`, the mesh copied into the arrays shape `{ position, normal?, texcoord?, indices }` with no `count` or `labels`, so `createBufferInfoFromArrays` takes it as it is; no parser in the stack; glTF follows through a parser package of its own |
| 41 | Packaging the OBJ parser | host (2026-09-13) | — | a runtime dependency, external in the ES build | **pending** — a devDependency bundled into host's dist through `@rollup/plugin-commonjs` (the package ships a webpack UMD only), so host's runtime dependencies stay tree alone and no import map gains an entry |
| 42 | The depth test as a framework silence | webgl.tree harness, the toon and shadow heroes (2026-09-13) | the notation never writes a depth test; `clear()` and `beginPass` stay raw (§2.2), so a webgl.tree hero enables `gl.DEPTH_TEST` itself | `init(gl)` enables the depth test once, as p5 does silently | **a notation symbol, raw in the bridge** (Pierre, 2026-09-13) — measured against the Archetypes (§2.1) the depth test is no silence: every column writes it and switches it per pass, so the gap is the notation's. `depthTest(on)` joins the render-state row beside `cullFace(FRONT)`; webgl.tree realizes it as `gl.enable` / `gl.disable`, nothing in `init`; `filter`, `image` and the gizmos keep switching it inside and restoring it |
| 43 | The viewport as a matrix | §2.2, pipeline chapter (2026-09-13) | `viewport(·)` realized by `mapLocation(…, WORLD, SCREEN, …)` | a `viewport(out, ndc, vp)` point function | **`mat4Viewport(out, vp, ndcZMin)`** (Pierre, 2026-09-13) — the S · T of the pipeline chapter's viewport rows, signed `vp` for y-down, `ndcZMin` for the depth row; world → screen composes it, screen → world inverts the composition; a core export with its golden case |
| 44 | Named spaces off the teaching surface | §2.2 (2026-09-13) | the `→` row realized by `mapLocation` · `mapDirection` | the arrow as a notation symbol | **math with the spaces as comments** (Pierre, 2026-09-13) — pseudo-code and examples write the product (`V · p`, `M_B⁻¹ · M_A · p`) under a `// FROM → TO` comment; `mapLocation` · `mapDirection` stay exported for host, the bridges and debugging, but leave the notation, the webgl.tree examples and, when p5.tree next revises its docs, its rendered reference |
| 45 | The filtered image's uniform name | §2.3, the heroes (2026-09-13: 17 notebook files read `tex0`, 14 already `uTexelSize` / `uResolution`) | `tex0`, p5's filter convention | keep both conventions in the book | **`u*` in the book, a hidden door for p5** (Pierre, 2026-09-13) — shaders say the `u*` name; the p5 ground inserts `#define <name> tex0` (and `uTexelSize` → `texelSize`, `uResolution` → `canvasSize` where a hero needs them) after `#version`; webgl.tree's `filter` and `pipe` fill the `u*` name, and `tex0` beside it while heroes migrate. the name is **`uSource`** (Pierre, 2026-09-13), matching `pipe`'s `source` argument in both bridges |
| 46 | A uniforms bag | §2.3 (2026-09-13) | per-bind object literals of bare names | one bag of definitions handed to every `bind` | **per-bind lists; a bag only behind a panel** (Pierre, 2026-09-13) — `bind(prog, { uA, uB })` stays the listing's form because it teaches what a pass consumes, as the archetype columns' one `setUniforms` object per bind does; where a `[panel: …]` drives many uniforms its bag may be handed to `bind` whole, which twgl already allows (`setUniforms` ignores undeclared names). The code stays imperative, one tree or twgl call per definition into preallocated values — no reactive layer, nothing to implement |
| 47 | What stays on p5 | the notebook (2026-09-13) | every hero ports to the stack | — | **figure-only sketches stay on p5** (Pierre, 2026-09-13) unless porting one sharpens the design; the notebook keeps a `p5` branch as the backup of every sketch on p5 and `tex0`, created from `main` before the migration |
| 48 | Sampling a render target | webgl.tree `target.js` (2026-09-13) | attachments fixed at linear filtering, clamp to edge | a notation argument (`renderTarget(filter: NEAREST)`) | **options with today's defaults, silent in the notation** (Pierre, 2026-09-13) — `renderTarget(gl, { minMag, wrap })`, linear and clamp by default; the heroes' audit found no hero asking for nearest or repeat on a target (depth textures are nearest by a GL ES rule), so the notation states one fixed rule — colour linear and clamp, depth nearest — as `vc.hpp` and `vc.rs` already follow |
| 49 | Multisampled render targets | webgl.tree `target.js` (2026-09-13) | single-sampled targets | `renderTarget(samples: n)` with a resolve step in the notation | **a bridge-only option at 1 sample** (Pierre, 2026-09-13) — `{ samples }` draws into multisampled renderbuffers and `resolve()` blits them into the textures (`pipe` and `readPixel` resolve a target they are handed). The heroes' audit corrected the premise: p5 v2's `createFramebuffer` does not antialias by default — it inherits the canvas's `antialias`, off except in Safari, and resolves on first read — and no hero asks for a multisampled target (picking needs one off). The notation stays silent; line quality stays deferred with §7 #2 |
| 50 | A target's pixel format | the heroes' audit (2026-09-13) | 8-bit colour; `float: true` as a bridge flag | — | **`format` in the notation** (Pierre, 2026-09-13) — `renderTarget(format: FLOAT)` and per attachment `color: [position: HALF_FLOAT, …]`; it changes results in *post_effects* (8-bit clips the HDR chain) and *deferred* (half-float positions). webgl.tree: `renderTarget(gl, { format })` with `gl.UNSIGNED_BYTE` · `gl.HALF_FLOAT` · `gl.FLOAT`, and `color: { name: format, … }`; `float: true` stays shorthand for half-float |
| 51 | What `width · height` measures | the heroes' audit (2026-09-13) | unstated; p5 sketches pass CSS size | — | **device pixels** (Pierre, 2026-09-13) — the drawing buffer, what `gl_FragCoord` counts and what native hosts get; `uResolution` and `uTexelSize` follow. webgl.tree already reads `gl.drawingBufferWidth` / `Height` for targets and passes |
| 52 | A texture from generated pixels | the heroes' audit (2026-09-13: the panorama, normal and height maps, the colour-ops test card, the texture archetype's pattern) | `hosts.md` has the row, the notation no symbol | reuse `load(file)` | **`texture(pixels)`** (Pierre, 2026-09-13) — realized by webgl.tree's `texture(gl, { data, width, height })` |
| 53 | Baking a palette strip | *mosaic* (2026-09-13) | `uPalette = bake(sort(tiles, by: luma))`, an undefined symbol | `bake(images, cell:, format:)` · `strip(…)` | **spelled out, no symbol** (Pierre, 2026-09-13) — `palette = renderTarget(cell · count, cell, format: FLOAT)` · `beginPass(palette)` · `for i, img in sort(tiles, by: luma): image(img, x: i · cell)` · `uPalette = palette.color`; in webgl.tree the same four lines port one call each, and a live re-bake is those lines run again |
| 54 | Line quality: a line shader | webgl.tree gizmos (2026-09-13: with the wide-line program fixed — it never compiled while it used the reserved `half` — W in `testing/gizmos.html` shows wider but plain quads, far from p5's strokes) | 1-px `gl.LINES`, or `width` quads with no caps, joins or antialiasing (§7 #2) | — | **pending, to discuss** — Pierre leans to a proper line shader for the gizmos and every other line webgl.tree draws (all of them already pass through one draw path, so the choice applies to all at once), plus an opt-in for a user's own line program, which would fix an attribute and uniform contract (endpoints, side, viewport, width, colour). Open: caps and joins, screen-space antialiasing, dashes, the default width, whether p5.tree's strokes are the parity target, and how the opt-in reads in the notation |
| 55 | The WebGL2 bridge's name | §3.4 (2026-09-14) | named for its thin layer, twgl | keep the name while twgl stays underneath | **`webgl.tree`** (Pierre, 2026-09-14) — named for the API it realizes, beside `webgpu.tree`; twgl.js is the current thin layer and may be dropped in a later release without a rename. Package, repository, directory and UMD global (`webglTree`, `dist/webgl.tree.umd.cjs`) follow; twgl.tree 0.0.1–0.0.2 stay on the registry, deprecated |

Thirty-six rows; sixteen ruled (September 2026), #16, #18–#26 and #28–#35 pending, #36 deferred;
the table stays as the record. New rows are added here as implementation surfaces them.
