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

// Handle report modes
export const POINT     = 0;
export const DIRECTION = 1;
