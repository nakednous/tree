/**
 * @file Core constants — zero dependencies.
 * @module tree/constants
 * @license AGPL-3.0-only
 */

// Coordinate spaces
export const WORLD  = 'WORLD';
export const EYE    = 'EYE';
export const NDC    = 'NDC';
export const SCREEN = 'SCREEN';
export const MODEL  = 'MODEL';
export const MATRIX = 'MATRIX';

// Integrator frame source (helm `from` only): the construct's own current pose
// — body-relative; not a general mapDirection space.
export const SELF   = 'SELF';

// NDC Z convention (only difference between backends)
export const WEBGL  = -1;   // z ∈ [−1, 1]
export const WEBGPU =  0;   // z ∈ [0, 1]

// Visibility results
export const INVISIBLE   = 0;
export const VISIBLE     = 1;
export const SEMIVISIBLE = 2;

// Basis vectors (frozen plain arrays — duck-typed Vec3)
export const ORIGIN = Object.freeze([0, 0, 0]);
export const i  = Object.freeze([1, 0, 0]);
export const j  = Object.freeze([0, 1, 0]);
export const k  = Object.freeze([0, 0, 1]);
export const _i = Object.freeze([-1, 0, 0]);
export const _j = Object.freeze([0, -1, 0]);
export const _k = Object.freeze([0, 0, -1]);

// Handle constraint kinds
export const SPHERE = 0;
export const PLANE  = 1;
export const AXIS   = 2;
export const DIAL   = 3;

// Handle report modes
export const POINT     = 0;
export const DIRECTION = 1;

// Pointer-hit shapes (pointerHit); bullsEyeLines' shape
export const CIRCLE = 0;
export const SQUARE = 1;

// Gizmo bits — one namespace per generator. The same value means different
// things to different generators, and no generator reads another's bits.
export const NONE = 0;

// axesLines
export const X      = 1 << 0;
export const _X     = 1 << 1;
export const Y      = 1 << 2;
export const _Y     = 1 << 3;
export const Z      = 1 << 4;
export const _Z     = 1 << 5;
export const LABELS = 1 << 6;

// frustumLines (LEFT … TOP also key a bounds object's planes)
export const NEAR   = 1 << 0;
export const FAR    = 1 << 1;
export const LEFT   = 1 << 2;
export const RIGHT  = 1 << 3;
export const BOTTOM = 1 << 4;
export const TOP    = 1 << 5;
export const BODY   = 1 << 6;
export const APEX   = 1 << 7;

// pathLines
export const PATH         = 1 << 0;
export const CENTER       = 1 << 1;
export const CONTROLS     = 1 << 2;
export const TANGENTS_IN  = 1 << 3;
export const TANGENTS_OUT = 1 << 4;
export const TANGENTS     = TANGENTS_IN | TANGENTS_OUT;
export const HANDLES      = 1 << 5;

// helmRigLines
export const TRANSLATE = 1 << 0;
export const ROTATE    = 1 << 1;

// locusLines (HANDLE is the bridge's dot, not a line)
export const HANDLE = 1 << 0;
export const AIM    = 1 << 1;
export const LOCUS  = 1 << 2;
export const RING   = 1 << 3;

// Semantic palette — normalised RGBA: red, lime, dodger blue; COLOR_DIM is
// the alpha of a dimmed stroke (the helm rig's baseline).
export const COLOR_X   = Object.freeze([1, 0, 0, 1]);
export const COLOR_Y   = Object.freeze([0, 1, 0, 1]);
export const COLOR_Z   = Object.freeze([30 / 255, 144 / 255, 1, 1]);
export const COLOR_DIM = 110 / 255;
